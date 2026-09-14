#!/usr/bin/env bash
# Deploy the web UI to AWS App Runner, pointed at the deployed AgentCore agent.
#
#   ./deploy-ui.sh          build, push, create-or-update the service, print the URL
#   ./deploy-ui.sh url      just print the public URL
#   ./deploy-ui.sh delete   tear the service down (stops the hourly charge)
#
# The UI cannot live inside AgentCore: that runtime only exposes /ping and
# /invocations through the AWS API, never a public web page. App Runner hosts
# the page and signs the AgentCore calls with its instance role.
set -euo pipefail

AWS_REGION="${AWS_REGION:-us-east-1}"
UI_REPO="${UI_REPO:-my-agent-ui}"
SERVICE_NAME="${SERVICE_NAME:-my-agent-ui}"
ACCESS_ROLE="${ACCESS_ROLE:-MyAgentAppRunnerECRAccess}"
INSTANCE_ROLE="${INSTANCE_ROLE:-MyAgentAppRunnerInstance}"
RUNTIME_NAME="${RUNTIME_NAME:-my_agent_service}"
PREFS_TABLE="${PREFS_TABLE:-my-agent-prefs}"
ARTIFACT_BUCKET="${ARTIFACT_BUCKET:-my-agent-artifacts-$(aws sts get-caller-identity --query Account --output text)}"
# Sign-in. The Cognito settings live in .env (created with the pool); read
# them so production gets the same pool, with its own APP_URL below.
if [[ -f .env ]]; then
  while IFS='=' read -r k v; do
    [[ "$k" =~ ^COGNITO_[A-Z_]+$ ]] && export "$k=$v"
  done < <(grep -E '^COGNITO_[A-Z_]+=' .env)
fi
COGNITO_USER_POOL_ID="${COGNITO_USER_POOL_ID:-}"
COGNITO_CLIENT_ID="${COGNITO_CLIENT_ID:-}"
COGNITO_CLIENT_SECRET="${COGNITO_CLIENT_SECRET:-}"
COGNITO_DOMAIN="${COGNITO_DOMAIN:-}"

# Gmail. Unset GMAIL_PROVIDER_NAME to ship with the demo inbox instead.
GMAIL_PROVIDER_NAME="${GMAIL_PROVIDER_NAME:-my-agent-gmail}"
WORKLOAD_IDENTITY_NAME="${WORKLOAD_IDENTITY_NAME:-my-agent-app}"
# Telegram switches on when TELEGRAM_BOT_TOKEN is set - in the shell, or in
# .env next to the other secrets (the runtime deploy reads it the same way).
if [[ -f .env ]]; then
  while IFS='=' read -r k v; do
    [[ "$k" =~ ^TELEGRAM_[A-Z_]+$ && -z "${!k:-}" ]] && export "$k=$v"
  done < <(grep -E '^TELEGRAM_[A-Z_]+=' .env)
fi
TELEGRAM_BOT_TOKEN="${TELEGRAM_BOT_TOKEN:-}"
TELEGRAM_WEBHOOK_SECRET="${TELEGRAM_WEBHOOK_SECRET:-}"
if [[ -n "$TELEGRAM_BOT_TOKEN" ]]; then echo "Telegram: on (token ${#TELEGRAM_BOT_TOKEN} chars)"; else echo "Telegram: off (no TELEGRAM_BOT_TOKEN)"; fi

log() { printf '\n\033[1m==> %s\033[0m\n' "$1"; }

require_creds() {
  aws sts get-caller-identity >/dev/null 2>&1 || {
    echo "ERROR: no usable AWS IAM credentials. Run 'aws configure'." >&2; exit 1; }
}

service_arn() {
  aws apprunner list-services --region "$AWS_REGION" \
    --query "ServiceSummaryList[?ServiceName=='${SERVICE_NAME}'].ServiceArn | [0]" --output text 2>/dev/null
}

service_url() {
  local arn; arn=$(service_arn)
  [[ "$arn" == "None" || -z "$arn" ]] && return 1
  aws apprunner describe-service --region "$AWS_REGION" --service-arn "$arn" \
    --query 'Service.ServiceUrl' --output text
}

# Blocks until the service is RUNNING and no operation is in flight.
# App Runner reports RUNNING while still serving the OLD image mid-update,
# so the operation status is the one that actually matters.
wait_idle() {
  local arn="$1" label="${2:-settling}" st op
  for _ in $(seq 1 90); do
    st=$(aws apprunner describe-service --region "$AWS_REGION" --service-arn "$arn" \
          --query 'Service.Status' --output text 2>/dev/null || echo UNKNOWN)
    op=$(aws apprunner list-operations --region "$AWS_REGION" --service-arn "$arn" \
          --max-results 1 --query 'OperationSummaryList[0].Status' --output text 2>/dev/null || echo UNKNOWN)
    printf '\r  %s: %-16s %-14s' "$label" "$st" "$op"
    if [[ "$st" == "RUNNING" && "$op" != "IN_PROGRESS" && "$op" != "PENDING" ]]; then echo; return 0; fi
    if [[ "$st" == "CREATE_FAILED" || "$st" == "DELETE_FAILED" ]]; then echo; return 1; fi
    sleep 10
  done
  echo
  return 1
}

require_creds

# ------------------------------------------------------------------- url
if [[ "${1:-}" == "url" ]]; then
  URL=$(service_url) || { echo "Service '${SERVICE_NAME}' not found."; exit 1; }
  echo "https://${URL}"
  exit 0
fi

# ---------------------------------------------------------------- delete
if [[ "${1:-}" == "delete" ]]; then
  ARN=$(service_arn)
  [[ "$ARN" == "None" || -z "$ARN" ]] && { echo "Nothing to delete."; exit 0; }
  aws apprunner delete-service --region "$AWS_REGION" --service-arn "$ARN" >/dev/null
  echo "Deleting ${SERVICE_NAME}. Billing stops once it disappears from 'aws apprunner list-services'."
  echo "The DynamoDB table '${PREFS_TABLE}' is left alone; delete it separately if you want."
  exit 0
fi

ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
REGISTRY="${ACCOUNT_ID}.dkr.ecr.${AWS_REGION}.amazonaws.com"
IMAGE="${REGISTRY}/${UI_REPO}:latest"

RUNTIME_ARN=$(aws bedrock-agentcore-control list-agent-runtimes --region "$AWS_REGION" \
  --query "agentRuntimes[?agentRuntimeName=='${RUNTIME_NAME}'].agentRuntimeArn | [0]" --output text)
[[ "$RUNTIME_ARN" == "None" || -z "$RUNTIME_ARN" ]] && {
  echo "ERROR: AgentCore runtime '${RUNTIME_NAME}' not found. Run ./deploy.sh first." >&2; exit 1; }

log "Account ${ACCOUNT_ID} / region ${AWS_REGION}"
echo "agent runtime: ${RUNTIME_ARN}"

# ------------------------------------------------------------------ roles
log "Ensuring IAM roles"
ensure_role() {  # name, trust-file
  aws iam get-role --role-name "$1" >/dev/null 2>&1 \
    && aws iam update-assume-role-policy --role-name "$1" --policy-document "file://$2" \
    || aws iam create-role --role-name "$1" --assume-role-policy-document "file://$2" >/dev/null
}
ensure_role "$ACCESS_ROLE"   iam/apprunner-access-trust.json
aws iam attach-role-policy --role-name "$ACCESS_ROLE" \
  --policy-arn arn:aws:iam::aws:policy/service-role/AWSAppRunnerServicePolicyForECRAccess

ensure_role "$INSTANCE_ROLE" iam/apprunner-instance-trust.json
aws iam put-role-policy --role-name "$INSTANCE_ROLE" \
  --policy-name InvokeAgentCore --policy-document file://iam/apprunner-instance-policy.json

ACCESS_ROLE_ARN=$(aws iam get-role --role-name "$ACCESS_ROLE" --query 'Role.Arn' --output text)
INSTANCE_ROLE_ARN=$(aws iam get-role --role-name "$INSTANCE_ROLE" --query 'Role.Arn' --output text)
echo "$ACCESS_ROLE_ARN"
echo "$INSTANCE_ROLE_ARN"

# ------------------------------------------------------------- preferences
log "Ensuring DynamoDB table ${PREFS_TABLE}"
if aws dynamodb describe-table --table-name "$PREFS_TABLE" --region "$AWS_REGION" >/dev/null 2>&1; then
  echo "table exists"
else
  aws dynamodb create-table --region "$AWS_REGION" \
    --table-name "$PREFS_TABLE" \
    --attribute-definitions AttributeName=clientId,AttributeType=S \
    --key-schema AttributeName=clientId,KeyType=HASH \
    --billing-mode PAY_PER_REQUEST >/dev/null
  aws dynamodb wait table-exists --table-name "$PREFS_TABLE" --region "$AWS_REGION"
  echo "table created"
fi

# -------------------------------------------------------------------- ecr
log "Ensuring ECR repo ${UI_REPO}"
aws ecr describe-repositories --repository-names "$UI_REPO" --region "$AWS_REGION" >/dev/null 2>&1 \
  || aws ecr create-repository --repository-name "$UI_REPO" --region "$AWS_REGION" >/dev/null
aws ecr get-login-password --region "$AWS_REGION" | docker login --username AWS --password-stdin "$REGISTRY"

# ------------------------------------------------------------------ build
log "Building linux/amd64 UI image (App Runner does not run arm64)"
docker build --platform linux/amd64 -f Dockerfile.ui -t "$UI_REPO" .
docker tag "${UI_REPO}:latest" "$IMAGE"

log "Pushing ${IMAGE}"
docker push "$IMAGE"

# ------------------------------------------------------------- app runner
ARN=$(service_arn)

# Telegram's webhook has to point back at this service, so the URL is baked
# into the environment - which means resolving it before the config is built.
# On the very first deploy the service has no URL yet; re-run once to fill it in.
PUBLIC_URL="${PUBLIC_URL:-}"
if [[ -z "$PUBLIC_URL" && "$ARN" != "None" && -n "$ARN" ]]; then
  PUBLIC_URL="https://$(service_url)"
fi

SOURCE_CFG=$(cat <<JSON
{
  "ImageRepository": {
    "ImageIdentifier": "${IMAGE}",
    "ImageRepositoryType": "ECR",
    "ImageConfiguration": {
      "Port": "8080",
      "RuntimeEnvironmentVariables": {
        "AGENT_TARGET": "agentcore",
        "AGENT_RUNTIME_ARN": "${RUNTIME_ARN}",
        "AWS_REGION": "${AWS_REGION}",
        "PREFS_TABLE": "${PREFS_TABLE}",
        "ARTIFACT_BUCKET": "${ARTIFACT_BUCKET}",
        "GMAIL_PROVIDER_NAME": "${GMAIL_PROVIDER_NAME}",
        "WORKLOAD_IDENTITY_NAME": "${WORKLOAD_IDENTITY_NAME}",
        "OAUTH_RETURN_URL": "${PUBLIC_URL}/connected",
        "APP_URL": "${PUBLIC_URL}",
        "COGNITO_USER_POOL_ID": "${COGNITO_USER_POOL_ID}",
        "COGNITO_CLIENT_ID": "${COGNITO_CLIENT_ID}",
        "COGNITO_CLIENT_SECRET": "${COGNITO_CLIENT_SECRET}",
        "COGNITO_DOMAIN": "${COGNITO_DOMAIN}",
        "JOBS_TABLE": "${JOBS_TABLE:-my-agent-jobs}",
        "SCHEDULER_ROLE_ARN": "arn:aws:iam::${ACCOUNT_ID}:role/MyAgentSchedulerRole",
        "DAILY_TOKEN_BUDGET": "${DAILY_TOKEN_BUDGET:-2000000}",
        "TELEGRAM_BOT_TOKEN": "${TELEGRAM_BOT_TOKEN}",
        "TELEGRAM_WEBHOOK_SECRET": "${TELEGRAM_WEBHOOK_SECRET}",
        "PUBLIC_URL": "${PUBLIC_URL}"
      }
    }
  },
  "AutoDeploymentsEnabled": false,
  "AuthenticationConfiguration": { "AccessRoleArn": "${ACCESS_ROLE_ARN}" }
}
JSON
)
INSTANCE_CFG="{\"Cpu\":\"0.5 vCPU\",\"Memory\":\"1 GB\",\"InstanceRoleArn\":\"${INSTANCE_ROLE_ARN}\"}"

if [[ "$ARN" == "None" || -z "$ARN" ]]; then
  log "Creating App Runner service ${SERVICE_NAME}"
  # IAM role creation is eventually consistent; App Runner may not see it yet.
  for attempt in 1 2 3 4 5 6; do
    if ARN=$(aws apprunner create-service --region "$AWS_REGION" \
      --service-name "$SERVICE_NAME" \
      --source-configuration "$SOURCE_CFG" \
      --instance-configuration "$INSTANCE_CFG" \
      --health-check-configuration '{"Protocol":"HTTP","Path":"/healthz","Interval":10,"Timeout":5,"HealthyThreshold":1,"UnhealthyThreshold":5}' \
      --query 'Service.ServiceArn' --output text 2>/dev/null); then
      break
    fi
    echo "  waiting for IAM to propagate (attempt ${attempt})..."
    sleep 10
  done
  [[ -z "${ARN:-}" || "$ARN" == "None" ]] && { echo "ERROR: create-service failed." >&2; exit 1; }
else
  log "Updating App Runner service ${SERVICE_NAME}"
  aws apprunner update-service --region "$AWS_REGION" --service-arn "$ARN" \
    --source-configuration "$SOURCE_CFG" \
    --instance-configuration "$INSTANCE_CFG" >/dev/null

  # update-service only applies CONFIGURATION. The image tag never changes, so
  # it does not re-pull and the old container keeps serving. Only
  # start-deployment forces a pull - and it is rejected while the update is
  # still in flight, so let that land first.
  wait_idle "$ARN" "config" || true
  log "Forcing a redeploy so the new image is pulled"
  for attempt in 1 2 3 4 5 6; do
    if aws apprunner start-deployment --region "$AWS_REGION" --service-arn "$ARN" >/dev/null 2>&1; then
      break
    fi
    echo "  service busy, retrying (${attempt})..."
    sleep 10
  done
fi

log "Waiting for the deployment to finish (a few minutes)"
wait_idle "$ARN" "deploy" || { echo "Deployment did not settle. Check CloudWatch."; exit 1; }

URL=$(service_url)
log "Live at  https://${URL}"
echo "Health:  https://${URL}/healthz"
echo
echo "Costs run hourly while the service exists. Tear it down with: ./deploy-ui.sh delete"
