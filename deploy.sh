#!/usr/bin/env bash
# Deploy this agent to Bedrock AgentCore Runtime.
#
#   ./deploy.sh              build, push, create-or-update the runtime
#   ./deploy.sh invoke "hi"  call the deployed agent
#
# Requires: docker running, and real IAM credentials (aws sts get-caller-identity
# must succeed). A Bedrock API key is NOT enough - it cannot push to ECR.
set -euo pipefail

AWS_REGION="${AWS_REGION:-us-east-1}"
ECR_REPO="${ECR_REPO:-my-agent}"
RUNTIME_NAME="${RUNTIME_NAME:-my_agent_service}"
ROLE_NAME="${ROLE_NAME:-MyAgentAgentCoreRole}"
ARTIFACT_BUCKET="${ARTIFACT_BUCKET:-my-agent-artifacts-$(aws sts get-caller-identity --query Account --output text)}"
# Gmail. Unset GMAIL_PROVIDER_NAME to ship with the demo inbox instead.
GMAIL_PROVIDER_NAME="${GMAIL_PROVIDER_NAME:-my-agent-gmail}"
WORKLOAD_IDENTITY_NAME="${WORKLOAD_IDENTITY_NAME:-my-agent-app}"
# Only used if a user has not consented yet, to build the sign-in link. It has
# to be on the workload identity's allowed-return-url list.
OAUTH_RETURN_URL="${OAUTH_RETURN_URL:-$(aws apprunner list-services --region "${AWS_REGION:-us-east-1}" \
  --query "ServiceSummaryList[?ServiceName=='my-agent-ui'].ServiceUrl | [0]" --output text 2>/dev/null \
  | sed 's|^|https://|;s|$|/connected|;s|^https://None/connected$|http://localhost:3000/connected|')}"

# One comma-separated argument: --environment-variables is a map, and space
# separated pairs are read as unknown options.
# The runtime also runs jobs on its own (routines, triggers) and delivers
# them to Telegram, so it needs the bot token and the jobs table too.
JOBS_TABLE="${JOBS_TABLE:-my-agent-jobs}"
DAILY_TOKEN_BUDGET="${DAILY_TOKEN_BUDGET:-2000000}"
if [[ -z "${TELEGRAM_BOT_TOKEN:-}" && -f .env ]]; then
  TELEGRAM_BOT_TOKEN="$(grep -E '^TELEGRAM_BOT_TOKEN=' .env | cut -d= -f2- || true)"
fi
RUNTIME_ENV="ARTIFACT_BUCKET=${ARTIFACT_BUCKET},GMAIL_PROVIDER_NAME=${GMAIL_PROVIDER_NAME},WORKLOAD_IDENTITY_NAME=${WORKLOAD_IDENTITY_NAME},OAUTH_RETURN_URL=${OAUTH_RETURN_URL},JOBS_TABLE=${JOBS_TABLE},DAILY_TOKEN_BUDGET=${DAILY_TOKEN_BUDGET},TELEGRAM_BOT_TOKEN=${TELEGRAM_BOT_TOKEN:-}"

log() { printf '\n\033[1m==> %s\033[0m\n' "$1"; }

require_creds() {
  if ! aws sts get-caller-identity >/dev/null 2>&1; then
    echo "ERROR: no usable AWS IAM credentials." >&2
    echo "AWS_BEARER_TOKEN_BEDROCK only works for model calls, not for ECR or AgentCore." >&2
    echo "Run 'aws configure' with an access key/secret, or 'aws sso login'." >&2
    exit 1
  fi
}

# ---------------------------------------------------------------- invoke mode
if [[ "${1:-}" == "invoke" ]]; then
  require_creds
  PROMPT="${2:-Hello}"
  ARN=$(aws bedrock-agentcore-control list-agent-runtimes --region "$AWS_REGION" \
        --query "agentRuntimes[?agentRuntimeName=='${RUNTIME_NAME}'].agentRuntimeArn | [0]" --output text)
  [[ "$ARN" == "None" || -z "$ARN" ]] && { echo "Runtime '${RUNTIME_NAME}' not found. Deploy it first."; exit 1; }
  OUT=$(mktemp)
  # AgentCore requires a session id of at least 33 characters.
  # Note: avoid `tr ... | head -c` here - head exits early, SIGPIPEs tr, and
  # `set -o pipefail` then aborts the whole script.
  SESSION_ID="cli-$(date +%s)-$(python3 -c 'import secrets; print(secrets.token_hex(12))')"
  PAYLOAD=$(PROMPT="$PROMPT" python3 -c 'import json,os; print(json.dumps({"prompt": os.environ["PROMPT"]}))')
  aws bedrock-agentcore invoke-agent-runtime \
    --region "$AWS_REGION" \
    --agent-runtime-arn "$ARN" \
    --runtime-session-id "$SESSION_ID" \
    --payload "$PAYLOAD" \
    --cli-binary-format raw-in-base64-out \
    "$OUT" >/dev/null
  cat "$OUT"; echo; rm -f "$OUT"
  exit 0
fi

require_creds
ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
REGISTRY="${ACCOUNT_ID}.dkr.ecr.${AWS_REGION}.amazonaws.com"
IMAGE="${REGISTRY}/${ECR_REPO}:latest"

log "Account ${ACCOUNT_ID} / region ${AWS_REGION}"

# ------------------------------------------------------------------ IAM role
log "Ensuring IAM role ${ROLE_NAME}"
if ! aws iam get-role --role-name "$ROLE_NAME" >/dev/null 2>&1; then
  aws iam create-role --role-name "$ROLE_NAME" \
    --assume-role-policy-document file://iam/trust-policy.json >/dev/null
  echo "created role"
else
  aws iam update-assume-role-policy --role-name "$ROLE_NAME" \
    --policy-document file://iam/trust-policy.json
  echo "role exists, trust policy refreshed"
fi
aws iam put-role-policy --role-name "$ROLE_NAME" \
  --policy-name AgentCoreExecution \
  --policy-document file://iam/execution-policy.json
ROLE_ARN=$(aws iam get-role --role-name "$ROLE_NAME" --query 'Role.Arn' --output text)
echo "$ROLE_ARN"

# The role EventBridge Scheduler assumes to invoke the runtime for routines.
SCHEDULER_ROLE_NAME="${SCHEDULER_ROLE_NAME:-MyAgentSchedulerRole}"
log "Ensuring scheduler role ${SCHEDULER_ROLE_NAME}"
if ! aws iam get-role --role-name "$SCHEDULER_ROLE_NAME" >/dev/null 2>&1; then
  aws iam create-role --role-name "$SCHEDULER_ROLE_NAME" \
    --assume-role-policy-document file://iam/scheduler-trust.json >/dev/null
fi
aws iam put-role-policy --role-name "$SCHEDULER_ROLE_NAME" \
  --policy-name run-routines --policy-document file://iam/scheduler-policy.json

# ---------------------------------------------------------------------- ECR
log "Ensuring ECR repo ${ECR_REPO}"
aws ecr describe-repositories --repository-names "$ECR_REPO" --region "$AWS_REGION" >/dev/null 2>&1 \
  || aws ecr create-repository --repository-name "$ECR_REPO" --region "$AWS_REGION" >/dev/null
aws ecr get-login-password --region "$AWS_REGION" | docker login --username AWS --password-stdin "$REGISTRY"

# -------------------------------------------------------------------- build
log "Building linux/arm64 image"
docker build --platform linux/arm64 -t "$ECR_REPO" .
docker tag "${ECR_REPO}:latest" "$IMAGE"

log "Pushing ${IMAGE}"
docker push "$IMAGE"

# ------------------------------------------------------------------ runtime
log "Creating or updating AgentCore runtime ${RUNTIME_NAME}"
EXISTING=$(aws bedrock-agentcore-control list-agent-runtimes --region "$AWS_REGION" \
  --query "agentRuntimes[?agentRuntimeName=='${RUNTIME_NAME}'].agentRuntimeId | [0]" --output text 2>/dev/null || echo "None")

if [[ "$EXISTING" == "None" || -z "$EXISTING" ]]; then
  aws bedrock-agentcore-control create-agent-runtime \
    --region "$AWS_REGION" \
    --agent-runtime-name "$RUNTIME_NAME" \
    --agent-runtime-artifact "{\"containerConfiguration\":{\"containerUri\":\"${IMAGE}\"}}" \
    --role-arn "$ROLE_ARN" \
    --network-configuration '{"networkMode":"PUBLIC"}' \
    --protocol-configuration '{"serverProtocol":"HTTP"}' \
    --environment-variables "$RUNTIME_ENV"
else
  echo "updating existing runtime ${EXISTING}"
  aws bedrock-agentcore-control update-agent-runtime \
    --region "$AWS_REGION" \
    --agent-runtime-id "$EXISTING" \
    --agent-runtime-artifact "{\"containerConfiguration\":{\"containerUri\":\"${IMAGE}\"}}" \
    --role-arn "$ROLE_ARN" \
    --network-configuration '{"networkMode":"PUBLIC"}' \
    --protocol-configuration '{"serverProtocol":"HTTP"}' \
    --environment-variables "$RUNTIME_ENV"
fi

log "Done. Test it with:  ./deploy.sh invoke \"what time is it in Tokyo?\""
