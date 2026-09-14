/**
 * Who is talking to us: Cognito sign-in for the web UI.
 *
 * The hosted UI does the form; we do the code exchange on the server, verify
 * the ID token against the pool's JWKS, and keep it in an httpOnly cookie
 * with the refresh token beside it. Every API request then derives the user
 * from the cookie - the browser never gets to say who it is.
 *
 * Everything is off until the Cognito variables are set, in which case the
 * app falls back to its original anonymous browser id. That keeps local
 * development possible without a pool, and it is the only mode the AgentCore
 * runtime needs, since App Runner is its only caller and passes the user id.
 */
import { CognitoJwtVerifier } from 'aws-jwt-verify';

const POOL = process.env.COGNITO_USER_POOL_ID || '';
const CLIENT = process.env.COGNITO_CLIENT_ID || '';
const SECRET = process.env.COGNITO_CLIENT_SECRET || '';
const DOMAIN = (process.env.COGNITO_DOMAIN || '').replace(/\/$/, '');
const APP_URL = (process.env.APP_URL || 'http://localhost:3000').replace(/\/$/, '');

export const authEnabled = () => Boolean(POOL && CLIENT && SECRET && DOMAIN);

const verifier = authEnabled()
  ? CognitoJwtVerifier.create({ userPoolId: POOL, tokenUse: 'id', clientId: CLIENT })
  : null;

const REDIRECT = `${APP_URL}/auth/callback`;
const ID_COOKIE = 'ao_id';
const RT_COOKIE = 'ao_rt';
const SECURE = APP_URL.startsWith('https://');

export function loginUrl(state = '') {
  const q = new URLSearchParams({
    client_id: CLIENT, response_type: 'code', scope: 'openid email profile', redirect_uri: REDIRECT, state,
  });
  return `${DOMAIN}/login?${q}`;
}

export function logoutUrl() {
  const q = new URLSearchParams({ client_id: CLIENT, logout_uri: `${APP_URL}/` });
  return `${DOMAIN}/logout?${q}`;
}

async function tokenRequest(params) {
  const res = await fetch(`${DOMAIN}/oauth2/token`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: `Basic ${Buffer.from(`${CLIENT}:${SECRET}`).toString('base64')}`,
    },
    body: new URLSearchParams({ client_id: CLIENT, ...params }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error_description ?? data.error ?? `token endpoint ${res.status}`);
  return data;
}

/** Turns the callback's code into tokens. */
export const exchangeCode = (code) =>
  tokenRequest({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT });

/** A fresh ID token from a refresh token. */
export const refreshTokens = (refreshToken) =>
  tokenRequest({ grant_type: 'refresh_token', refresh_token: refreshToken });

/** @returns {Promise<{sub: string, email?: string, name?: string}>} */
export async function verifyIdToken(token) {
  const p = await verifier.verify(token);
  return { sub: p.sub, email: p.email, name: p.name ?? p['cognito:username'] };
}

// ---------------------------------------------------------------- cookies
function parseCookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function cookie(name, value, maxAge) {
  return `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${SECURE ? '; Secure' : ''}`;
}

export function setSession(res, { idToken, refreshToken }) {
  const jar = [cookie(ID_COOKIE, idToken, 3600)];
  if (refreshToken) jar.push(cookie(RT_COOKIE, refreshToken, 30 * 24 * 3600));
  res.append('Set-Cookie', jar);
}

export function clearSession(res) {
  res.append('Set-Cookie', [cookie(ID_COOKIE, '', 0), cookie(RT_COOKIE, '', 0)]);
}

/**
 * The signed-in user for a request, or null. Refreshes a stale ID token
 * transparently and re-sets the cookie when it does.
 */
export async function currentUser(req, res) {
  if (!authEnabled()) return null;
  const jar = parseCookies(req);
  if (jar[ID_COOKIE]) {
    try { return await verifyIdToken(jar[ID_COOKIE]); } catch { /* expired or bad: try the refresh token */ }
  }
  if (jar[RT_COOKIE]) {
    try {
      const t = await refreshTokens(jar[RT_COOKIE]);
      setSession(res, { idToken: t.id_token });
      return await verifyIdToken(t.id_token);
    } catch { /* refresh token gone too: signed out */ }
  }
  return null;
}
