/**
 * AgentCore Identity: getting an OAuth token for a specific user.
 *
 * Two hops. First mint a workload identity token that says "this app, acting
 * for this user". Then exchange it for an access token to a linked account.
 *
 * The second call has two outcomes, and both are normal:
 *  - `accessToken` - the vault already holds a valid token (it refreshes them
 *    silently, so this is the common case after the first consent).
 *  - `authorizationUrl` - nobody has consented yet. The user must visit it,
 *    and the `sessionUri` alongside it identifies that particular sign-in.
 *    AWS terminates the callback itself and files the token in the vault.
 *
 * That `sessionUri` matters more than it looks. Asking again without it starts
 * a fresh authorization from scratch, so a poll that omits it can never see the
 * sign-in the user just finished - it invents a new one every time and reports
 * no token forever.
 *
 * AWS flags a real caveat: a returned token is not guaranteed to still work,
 * because the user may have revoked access upstream and AgentCore cannot see
 * that. Callers should retry once with `forceAuthentication` on a 401.
 *
 * After consent AWS bounces the browser to `OAUTH_RETURN_URL`, which has to be
 * on the workload identity's allow-list or the call is rejected before the
 * user ever sees a sign-in page:
 *
 *   aws bedrock-agentcore-control update-workload-identity --name my-agent-app \
 *     --allowed-resource-oauth2-return-urls "http://localhost:3000/connected" ...
 */
const REGION = process.env.AWS_REGION || 'us-east-1';
const WORKLOAD = process.env.WORKLOAD_IDENTITY_NAME || 'my-agent-app';
/** Where the user lands once they have consented. Must be allow-listed above. */
const RETURN_URL = process.env.OAUTH_RETURN_URL || 'http://localhost:3000/connected';


let client = null;
async function agentcore() {
  if (!client) {
    const { BedrockAgentCoreClient } = await import('@aws-sdk/client-bedrock-agentcore');
    client = new BedrockAgentCoreClient({ region: REGION });
  }
  return client;
}

/** A token identifying this app acting on behalf of one user. */
async function workloadToken(userId) {
  const { GetWorkloadAccessTokenForUserIdCommand } =
    await import('@aws-sdk/client-bedrock-agentcore');
  const out = await (await agentcore()).send(new GetWorkloadAccessTokenForUserIdCommand({
    workloadName: WORKLOAD,
    userId: String(userId),
  }));
  return out.workloadAccessToken;
}

/**
 * @param {string} [opts.sessionUri] a sign-in already under way, from a previous
 *   call. Without it every request starts a new one.
 * @param {object} [opts.authParams] extra parameters for the vendor's authorize
 *   request, such as Google's access_type=offline.
 * @returns {Promise<{accessToken?: string, authorizationUrl?: string,
 *   sessionUri?: string, sessionStatus?: string}>}
 *   Exactly one of accessToken and authorizationUrl is set.
 */
export async function resourceToken(userId, providerName, scopes,
  { force = false, sessionUri, customState, authParams } = {}) {
  const { GetResourceOauth2TokenCommand } = await import('@aws-sdk/client-bedrock-agentcore');
  const out = await (await agentcore()).send(new GetResourceOauth2TokenCommand({
    workloadIdentityToken: await workloadToken(userId),
    resourceCredentialProviderName: providerName,
    scopes,
    // Three-legged: the user themselves consents, rather than the app acting
    // as itself.
    oauth2Flow: 'USER_FEDERATION',
    resourceOauth2ReturnUrl: RETURN_URL,
    // Continue an in-flight sign-in, unless we are deliberately restarting one.
    ...(sessionUri && !force ? { sessionUri } : {}),
    // Echoed back to the return URL, so the landing page knows whose sign-in
    // it is looking at.
    ...(customState ? { customState } : {}),
    // Vendor-specific authorize parameters, from the connector catalogue.
    ...(authParams ? { customParameters: authParams } : {}),
    ...(force ? { forceAuthentication: true } : {}),
  }));
  return {
    accessToken: out.accessToken,
    authorizationUrl: out.authorizationUrl,
    sessionUri: out.sessionUri,
    sessionStatus: out.sessionStatus,
  };
}

/**
 * Finishes a sign-in.
 *
 * Consent alone is not enough. Google hands its code to the AWS callback, which
 * redirects the browser onward with a `session_id` and reports nothing - it
 * redirects the same way when the exchange fails. This call is what turns that
 * session into a stored credential; without it the session stays IN_PROGRESS
 * forever and no amount of polling will ever see a token.
 */
export async function completeAuth(userId, sessionUri) {
  const { CompleteResourceTokenAuthCommand } = await import('@aws-sdk/client-bedrock-agentcore');
  return (await agentcore()).send(new CompleteResourceTokenAuthCommand({
    userIdentifier: { userId: String(userId) },
    sessionUri,
  }));
}
