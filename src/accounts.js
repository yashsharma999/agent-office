/**
 * Linked accounts: getting a usable access token for any connector.
 *
 * Everything vendor-specific lives in `connectors.js`; this file only knows
 * that a connector has a provider, some scopes, and maybe some extra authorize
 * parameters. Adding a vendor should never mean touching this file.
 *
 * The sign-in is three steps, and the middle one is easy to miss:
 *
 *   1. ask for a token, get an authorization URL and a session back
 *   2. the user consents; the vendor hands its code to the AWS callback, which
 *      redirects onward with that session id
 *   3. `completeAuth` turns the session into a stored credential
 *
 * Step 3 is not optional. The callback redirects to the return URL identically
 * whether the exchange worked or failed, so nothing about landing there means
 * success, and without the completion call the session stays IN_PROGRESS
 * forever while every poll reports no token.
 */
import { resourceToken, completeAuth } from './identity.js';
import { CONNECTORS, isMock } from './connectors.js';

export { completeAuth };

/** Thrown when the user has not linked this account yet. */
export class NeedsConsent extends Error {
  constructor(connectorId, authorizationUrl, sessionUri) {
    super(`${CONNECTORS[connectorId]?.label ?? connectorId} is not connected yet.`);
    this.name = 'NeedsConsent';
    this.connectorId = connectorId;
    this.authorizationUrl = authorizationUrl;
    this.sessionUri = sessionUri;
  }
}

function specFor(id) {
  const spec = CONNECTORS[id];
  if (!spec) throw new Error(`Unknown connector "${id}".`);
  if (!spec.provider) throw new Error(`No OAuth provider configured for "${id}".`);
  return spec;
}

/**
 * @throws {NeedsConsent} when nobody has linked the account.
 * @returns {Promise<string>} a bearer token.
 */
export async function tokenFor(userId, id, { force = false, sessionUri } = {}) {
  const spec = specFor(id);
  const out = await resourceToken(userId, spec.provider, spec.scopes, {
    force,
    sessionUri,
    authParams: spec.authParams,
  });
  if (out.accessToken) return out.accessToken;
  throw new NeedsConsent(id, out.authorizationUrl, out.sessionUri);
}

/**
 * One authenticated call, retried once with a fresh consent on a 401.
 *
 * AWS warns that a vaulted token is not proof of anything: the user may have
 * revoked access at the vendor and AgentCore cannot see that.
 */
export async function authedFetch(userId, id, url, init = {}, retried = false) {
  const token = await tokenFor(userId, id, { force: retried });
  const res = await fetch(url, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...(init.headers ?? {}),
    },
  });
  if (res.status === 401 && !retried) return authedFetch(userId, id, url, init, true);
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`${CONNECTORS[id]?.label ?? id} ${res.status}: ${body.slice(0, 200)}`);
  }
  return res.json();
}

/**
 * Does the vault hold a usable token?
 * @param {string} [sessionUri] a sign-in under way. Pass it while polling, or
 *   the answer describes a session nobody has visited.
 */
export async function isConnected(userId, id, sessionUri) {
  if (isMock(id)) return true;
  try {
    await tokenFor(userId, id, { sessionUri });
    return true;
  } catch (err) {
    if (err instanceof NeedsConsent) return false;
    throw err;
  }
}

/**
 * Starts a sign-in.
 * @param {string} [customState] echoed back to the return URL, so the landing
 *   page can tell whose sign-in it is looking at.
 * @returns {Promise<{authorizationUrl: string|null, sessionUri?: string}>}
 *   A null url means the vault already holds a token.
 */
export async function consentUrl(userId, id, customState) {
  if (isMock(id)) return { authorizationUrl: null };
  const spec = specFor(id);
  const out = await resourceToken(userId, spec.provider, spec.scopes, {
    customState,
    authParams: spec.authParams,
  });
  return out.accessToken
    ? { authorizationUrl: null }
    : { authorizationUrl: out.authorizationUrl, sessionUri: out.sessionUri };
}

/**
 * Turns a NeedsConsent into an answer a model can relay.
 *
 * A tool must not blow up because nobody has signed in yet; every other
 * failure should surface.
 */
export async function orAskToConnect(work) {
  try {
    return await work();
  } catch (err) {
    if (err?.name !== 'NeedsConsent') throw err;
    const label = CONNECTORS[err.connectorId]?.label ?? err.connectorId;
    return {
      error: 'not_connected',
      note: `The user has not connected their ${label} account yet. Tell them to open `
        + `the Foundry and press CONNECT ACCOUNT on the ${label} pass. Do not retry.`,
    };
  }
}
