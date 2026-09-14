/**
 * Web UI for the agent.
 *
 *   npm run ui        local agent, streams straight from the SDK
 *   npm run ui:cloud  proxies to the deployed AgentCore runtime
 *
 * Serves public/ and streams the agent's real activity to the browser as
 * newline-delimited JSON, so the UI animates what is actually happening
 * rather than guessing on a timer.
 *
 * Why a proxy at all: AgentCore is an AWS API, not a public URL. Every call
 * must be SigV4-signed, and a browser cannot hold AWS credentials safely.
 * This server holds them and signs on the browser's behalf.
 */
import express from 'express';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createTeam } from './src/team.js';
import { agentEvents, makeSseParser } from './src/stream-events.js';
import { readPrefs, writePrefs } from './src/prefs.js';
import { TelegramBot } from './src/telegram.js';
import * as library from './src/library.js';
import { readWorld, writeWorld, setConnection } from './src/world.js';
import { connectorCatalogue, CONNECTORS, allMock, isMock } from './src/connectors.js';
import { isConnected, consentUrl, completeAuth } from './src/accounts.js';
import { rigCatalogue, SKINS, MAX_AGENTS } from './src/rigs.js';
import { chatsEnabled, isChatId, listChats, readChat, deleteChat } from './src/chats.js';
import { authEnabled, loginUrl, logoutUrl, exchangeCode, setSession, clearSession, currentUser } from './src/auth.js';
import { issueLinkCode, redeemLinkCode, resolveAlias, claimLegacy } from './src/aliases.js';
import { readPrefs as readPrefsRaw } from './src/prefs.js';
import { readUsage, assertBudget, recordUsage } from './src/usage.js';
import { listJobs, getJob, deleteJob, isJobId } from './src/jobs.js';
import { listRoutines, saveRoutine, deleteRoutine, jobPayload, dueNow, routineOwners, schedulerEnabled, describeWhen } from './src/routines.js';
import { runJob, resumeJob } from './src/runner.js';
import { setTelegramChat, outboxEnabled } from './src/outbox.js';
import { roleCatalogue } from './src/roles.js';
import { mimeFor } from './src/artifacts.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || process.env.UI_PORT || 3000;
const PRESET = process.env.MODEL_PRESET || 'dev';
// Extended thinking costs tokens, so it is opt-in. It feeds the thought clouds.
const REASONING = process.env.REASONING !== 'false';

/** 'local' runs the agent in this process; 'agentcore' calls the deployed runtime. */
const TARGET = process.env.AGENT_TARGET || 'local';
const RUNTIME_ARN = process.env.AGENT_RUNTIME_ARN || '';
const REGION = process.env.AWS_REGION || 'us-east-1';

const app = express();
app.use(express.json({ limit: '25mb' }));
app.use(express.static(join(__dirname, 'public'), {
  // A cached client against a changed server is an unpleasant way to lose an
  // hour, and locally there is nothing to gain by caching.
  etag: TARGET === 'local' ? false : true,
  setHeaders: (res) => { if (TARGET === 'local') res.setHeader('Cache-Control', 'no-store'); },
}));

// --------------------------------------------------------------- local mode
/** One agent per browser session, so separate tabs keep separate history. */
const sessions = new Map();
const MAX_SESSIONS = 100;

async function teamFor(sessionId, userId = 'anon', user = {}) {
  const existing = sessions.get(sessionId);
  if (existing) return existing;

  // The browser's session id doubles as the chat id the transcript is kept under.
  const team = await createTeam({ preset: PRESET, userId, sessionId, user });
  sessions.set(sessionId, team);
  if (sessions.size > MAX_SESSIONS) {
    const [oldestId, oldest] = sessions.entries().next().value;
    // Rigs bill per second, so stop their VMs when the session is evicted.
    oldest?.close?.().catch(() => {});
    sessions.delete(oldestId);
  }
  return team;
}

/** Editing an agent must take effect on the next message, not the next deploy. */
function dropCachedTeams(userId) {
  for (const [id, team] of sessions) {
    if (team.userId !== userId) continue;
    team.close?.().catch(() => {});
    sessions.delete(id);
  }
}

// ----------------------------------------------------------- agentcore mode
let agentcore = null;
async function getAgentCore() {
  if (agentcore) return agentcore;
  const { BedrockAgentCoreClient, InvokeAgentRuntimeCommand } =
    await import('@aws-sdk/client-bedrock-agentcore');
  agentcore = {
    client: new BedrockAgentCoreClient({ region: REGION }),
    InvokeAgentRuntimeCommand,
  };
  return agentcore;
}

/** AgentCore rejects session ids shorter than 33 characters. */
function runtimeSessionId(browserSessionId) {
  const base = `ui-${browserSessionId}`.replace(/[^A-Za-z0-9_-]/g, '');
  return base.length >= 33 ? base.slice(0, 128) : base.padEnd(33, '0');
}

// ----------------------------------------------------------------- routes
app.get('/api/info', async (_req, res) => {
  if (TARGET === 'agentcore') {
    res.json({ model: 'agentcore', target: 'agentcore', runtime: RUNTIME_ARN.split('/').pop() || 'unknown' });
    return;
  }
  res.json({
    model: 'local',
    target: 'local',
  });
});

app.get('/healthz', (_req, res) => res.json({ ok: true, target: TARGET }));

// ------------------------------------------------------------------- auth
/**
 * With sign-in configured, the user is whoever the session cookie says, and
 * nothing the browser sends can change that. Without it (local development,
 * no pool) the browser's anonymous id is accepted as before.
 */
const userOf = (req, fallback) =>
  req.user?.sub ?? String(fallback ?? req.query?.userId ?? req.query?.clientId ?? '');

app.use('/api', async (req, res, next) => {
  if (!authEnabled()) return next();
  const user = await currentUser(req, res);
  if (user) { req.user = user; return next(); }
  if (req.path === '/me') return next();      // answers "signed out" itself
  res.status(401).json({ error: 'Sign in first.', signIn: '/auth/login' });
});

app.get('/api/me', (req, res) => {
  if (!authEnabled()) return res.json({ ok: true, auth: false });
  if (!req.user) return res.status(401).json({ ok: false, auth: true, signIn: '/auth/login' });
  res.json({ ok: true, auth: true, userId: req.user.sub, email: req.user.email ?? null });
});

app.get('/auth/login', (_req, res) => {
  if (!authEnabled()) return res.redirect('/');
  res.redirect(loginUrl());
});

app.get('/auth/callback', async (req, res) => {
  if (!authEnabled()) return res.redirect('/');
  try {
    const t = await exchangeCode(String(req.query.code ?? ''));
    setSession(res, { idToken: t.id_token, refreshToken: t.refresh_token });
    res.redirect('/');
  } catch (err) {
    console.warn('auth: callback failed -', err.message);
    res.status(400).type('html').send(
      '<body style="font:14px ui-monospace,monospace;background:#14121a;color:#e8e4f0;padding:32px">'
      + 'Sign-in did not complete. <a style="color:#6ee7d7" href="/auth/login">Try again</a>.</body>',
    );
  }
});

app.get('/auth/logout', (_req, res) => {
  clearSession(res);
  res.redirect(authEnabled() ? logoutUrl() : '/');
});

/** Is there an old anonymous world in this browser worth bringing across? */
app.get('/api/claimable', async (req, res) => {
  const legacyId = String(req.query.legacyId ?? '');
  if (!req.user || !/^c-[a-z0-9]{6,40}$/.test(legacyId)) return res.json({ agents: 0, chats: 0 });
  try {
    const { prefs } = await readPrefsRaw(legacyId);
    const agents = prefs?.agents?.length ?? 0;
    const chats = chatsEnabled() ? (await listChats(legacyId, 50)).length : 0;
    res.json({ agents, chats });
  } catch { res.json({ agents: 0, chats: 0 }); }
});

app.post('/api/claim', async (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Sign in first.' });
  try {
    const moved = await claimLegacy(String(req.body?.legacyId ?? ''), req.user.sub);
    dropCachedTeams(req.user.sub);
    res.json({ ok: true, ...moved });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

/** Bind a Telegram chat to this account with the code the bot issued. */
app.post('/api/telegram/link', async (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Sign in first.' });
  try {
    const chatId = await redeemLinkCode(String(req.body?.code ?? ''), req.user.sub);
    await setTelegramChat(req.user.sub, chatId);
    res.json({ ok: true, chatId });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// -------------------------------------------------------------- the world
/** The shop: what computers exist and what they unlock. */
app.get('/api/roles', (_req, res) => res.json({ roles: roleCatalogue() }));

// ------------------------------------------------------------ energy, jobs
app.get('/api/usage', async (req, res) => {
  try { res.json(await readUsage(userOf(req))); } catch (err) { res.status(500).json({ error: err.message }); }
});

/**
 * Starts an unattended run. Locally the runner is called right here in the
 * background; against AgentCore the runtime is asked and answers at once.
 */
async function startJob(spec) {
  if (TARGET !== 'agentcore') {
    runJob(spec, { preset: PRESET }).catch((err) => console.error('job:', err.message));
    return { accepted: true };
  }
  const { client, InvokeAgentRuntimeCommand } = await getAgentCore();
  const out = await client.send(new InvokeAgentRuntimeCommand({
    agentRuntimeArn: RUNTIME_ARN,
    runtimeSessionId: runtimeSessionId(`job-${randomUUID()}`),
    contentType: 'application/json',
    accept: 'application/json',
    payload: new TextEncoder().encode(JSON.stringify({ job: spec })),
  }));
  const text = new TextDecoder().decode(await out.response.transformToByteArray?.() ?? new Uint8Array());
  try { return JSON.parse(text); } catch { return { accepted: true }; }
}

async function answerJob({ userId, jobId, approved }) {
  if (TARGET !== 'agentcore') {
    resumeJob({ userId, jobId, approved }, { preset: PRESET }).catch((err) => console.error('resume:', err.message));
    return { accepted: true };
  }
  const { client, InvokeAgentRuntimeCommand } = await getAgentCore();
  await client.send(new InvokeAgentRuntimeCommand({
    agentRuntimeArn: RUNTIME_ARN,
    runtimeSessionId: runtimeSessionId(`resume-${randomUUID()}`),
    contentType: 'application/json',
    accept: 'application/json',
    payload: new TextEncoder().encode(JSON.stringify({ resume: { userId, jobId, approved } })),
  }));
  return { accepted: true };
}

app.get('/api/jobs', async (req, res) => {
  try { res.json({ jobs: await listJobs(userOf(req)), outbox: outboxEnabled() ? 'telegram' : 'none' }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/jobs', async (req, res) => {
  const prompt = String(req.body?.prompt ?? '').trim();
  if (!prompt) return res.status(400).json({ error: 'Say what the job is.' });
  try { res.json(await startJob({ userId: userOf(req), prompt, source: 'manual' })); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/jobs/:id/:decision', async (req, res) => {
  const uid = userOf(req);
  if (!['approve', 'deny'].includes(req.params.decision)) return res.status(404).json({ error: 'Unknown action.' });
  if (!isJobId(req.params.id)) return res.status(400).json({ error: 'Not a job id.' });
  try {
    const job = await getJob(uid, req.params.id);
    if (!job) return res.status(404).json({ error: 'No such job.' });
    if (job.status !== 'needs_approval') return res.status(409).json({ error: `That job is ${job.status}.` });
    res.json(await answerJob({ userId: uid, jobId: job.jobId, approved: req.params.decision === 'approve' }));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/jobs/:id', async (req, res) => {
  if (!isJobId(req.params.id)) return res.status(400).json({ error: 'Not a job id.' });
  try { await deleteJob(userOf(req), req.params.id); res.json({ ok: true }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

// --------------------------------------------------------------- routines
app.get('/api/routines', async (req, res) => {
  try {
    const routines = (await listRoutines(userOf(req))).map((r) => ({ ...r, whenText: describeWhen(r.when), lastSeen: undefined }));
    res.json({ routines, scheduler: schedulerEnabled() ? 'eventbridge' : 'local' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/routines', async (req, res) => {
  try {
    const r = await saveRoutine(userOf(req), req.body ?? {});
    res.json({ ...r, whenText: describeWhen(r.when), lastSeen: undefined });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

app.delete('/api/routines/:id', async (req, res) => {
  try { await deleteRoutine(userOf(req), String(req.params.id)); res.json({ ok: true }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

/** Run it now, whatever the clock says. */
app.post('/api/routines/:id/run', async (req, res) => {
  const uid = userOf(req);
  try {
    const r = (await listRoutines(uid)).find((x) => x.id === String(req.params.id));
    if (!r) return res.status(404).json({ error: 'No such routine.' });
    res.json(await startJob(jobPayload(uid, r).job));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/rigs', (_req, res) => {
  res.json({
    rigs: rigCatalogue(),
    skins: Object.entries(SKINS).map(([id, s]) => ({ id, label: s.label, body: s.body })),
    maxAgents: MAX_AGENTS,
  });
});

/** The connector shop: which accounts can be linked, and what each allows. */
app.get('/api/connectors', (_req, res) => {
  res.json({ connectors: connectorCatalogue(), mock: allMock() });
});

/**
 * A recorded link is only worth what the vault can back up.
 *
 * Anyone who linked Gmail while the inbox was a stub has `linked: true` with no
 * token behind it, and a revoked account looks the same. Either way the Foundry
 * would show a connected account and never offer to connect it. Check once, and
 * correct the record rather than reporting something we cannot honour.
 */
async function withVerifiedLinks(userId, world) {
  const FRESH = 5 * 60 * 1000;
  let out = world;

  for (const [id, link] of Object.entries(world.connections ?? {})) {
    if (!CONNECTORS[id] || !link?.linked || isMock(id)) continue;
    // A token can take a moment to be filed. Trust a fresh link rather than
    // undoing a sign-in the user just finished.
    if (Date.now() - Date.parse(link.linkedAt ?? 0) < FRESH) continue;
    try {
      if (await isConnected(userId, id)) continue;
    } catch (err) {
      // Could not reach the vault. Leave the record alone - a network blip
      // must not look like a revoked account.
      console.warn(`world: could not verify ${id} for ${userId} -`, err.message);
      continue;
    }
    console.log(`world: clearing stale ${id} link for ${userId}`);
    out = {
      ...out,
      connections: await setConnection(userId, id, false),
      agents: out.agents.map((a) => ({ ...a, grants: a.grants.filter((g) => g !== id) })),
    };
  }
  return out;
}

/**
 * When each user's links were last checked against the vault. Two vault
 * round-trips on every page load left the room empty for seconds, so the
 * check runs in the background and no more than once in a while per user;
 * a stale link is corrected in the store for the next load rather than
 * holding up this one.
 */
const linksChecked = new Map();
const LINK_CHECK_EVERY = 10 * 60 * 1000;

function verifyLinksLater(uid, world) {
  const last = linksChecked.get(uid) ?? 0;
  if (Date.now() - last < LINK_CHECK_EVERY) return;
  linksChecked.set(uid, Date.now());
  withVerifiedLinks(uid, world).catch((err) =>
    console.warn(`world: background link check failed for ${uid} -`, err.message));
}

/** The user's roster and linked accounts. An empty world is valid. */
app.get('/api/world', async (req, res) => {
  const uid = userOf(req);
  try {
    const world = await readWorld(uid);
    res.json(world);
    verifyLinksLater(uid, world);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * Link or unlink an account.
 *
 * Linking is two steps once real credentials exist. We ask the Identity vault
 * for a token; if nobody has consented it hands back a URL instead, and the
 * account stays unlinked until the user has been through it. AWS terminates
 * the callback itself and files the token - we never see it, and there is no
 * redirect back to us, which is why the client has to poll.
 *
 * With the stub inbox there is nothing to consent to, so it is one step.
 */
/**
 * Sign-ins waiting on a user, keyed by user and connector.
 *
 * AWS hands back a handle when it issues an authorization URL, and wants it
 * again to say whether that sign-in finished. Ask without it and you start a
 * new authorization instead of hearing about the old one - so a poll that
 * forgets the handle waits forever while the user stares at "connected".
 *
 * In memory on purpose: it is worth nothing five minutes later, and losing it
 * to a restart costs one retry.
 */
const pendingConsent = new Map();
const CONSENT_TTL = 10 * 60 * 1000;

/** Reachable two ways: by who is waiting, and by the state AWS echoes back. */
function rememberConsent(entry) {
  for (const [k, v] of pendingConsent) {
    if (Date.now() - v.at > CONSENT_TTL) pendingConsent.delete(k);
  }
  const record = { ...entry, at: Date.now() };
  pendingConsent.set(`${entry.userId}:${entry.connector}`, record);
  pendingConsent.set(`state:${entry.state}`, record);
  return record;
}

app.post('/api/connect', async (req, res) => {
  const { userId, connector, linked } = req.body ?? {};
  const uid = userOf(req, userId);
  if (!uid || !connector) return res.status(400).json({ error: 'userId and connector are required.' });
  const id = String(connector);
  try {
    if (!CONNECTORS[id]?.available) {
      return res.status(400).json({ error: `${id} is not available yet.` });
    }
    if (linked !== false) {
      const state = randomUUID();
      const { authorizationUrl, sessionUri } = await consentUrl(uid, id, state);
      // Not linked yet: the user has to sign in to Google first.
      if (authorizationUrl) {
        rememberConsent({ userId: uid, connector: id, sessionUri, state });
        console.log(`connect: ${id} needs consent for ${uid} (session ${String(sessionUri).slice(-8)})`);
        return res.json({ pending: true, authorizationUrl, mock: isMock(id) });
      }
    }
    const connections = await setConnection(uid, id, linked !== false);
    console.log(`connect: ${id} ${linked !== false ? 'linked' : 'unlinked'} for ${uid}`);
    res.json({ connections, mock: isMock(id) });
  } catch (err) {
    console.error(`connect: ${id} failed for ${uid} -`, err.message);
    res.status(400).json({ error: err.message });
  }
});

/**
 * Turns a consented sign-in into a stored credential.
 *
 * Landing back on the return URL does not mean it worked - AWS redirects there
 * identically when the exchange fails - and the credential is not filed until
 * this call is made. Everything downstream reads the vault without a session,
 * so that is what we check afterwards.
 */
async function finishSignIn(pending, sessionUri) {
  if (pending.done) return true;
  await completeAuth(pending.userId, sessionUri);
  pending.done = true;
  const ok = await isConnected(pending.userId, pending.connector);
  console.log(`connected: completed sign-in for ${pending.userId}; vault holds a token? ${ok}`);
  if (ok) await setConnection(pending.userId, pending.connector, true);
  return ok;
}

/**
 * Where AWS drops the user after they consent - and where the sign-in is
 * actually completed.
 *
 * Reaching this page is not evidence of anything: AWS redirects here the same
 * way when the exchange with the provider failed, carrying no error. The
 * `session_id` names the sign-in and the `state` says whose it is, which is
 * everything needed to finish it and find out.
 */
app.get('/connected', async (req, res) => {
  // Everything AWS chose to tell us. If a sign-in is failing this is where it
  // says so, so it goes in the log verbatim before anything else happens.
  console.log('connected: query', JSON.stringify(req.query));

  const pending = pendingConsent.get(`state:${req.query.state ?? ''}`);
  const sessionUri = String(req.query.session_id ?? pending?.sessionUri ?? '');
  if (pending && sessionUri) {
    try {
      await finishSignIn(pending, sessionUri);
    } catch (err) {
      console.error('connected: could not finish the link -', err.name, err.message);
    }
  } else {
    console.warn(`connected: no pending sign-in matches state=${req.query.state ?? '(none)'}`);
  }

  res.type('html').send(
    '<!doctype html><meta charset="utf-8"><title>Connected</title>'
    + '<body style="margin:0;display:grid;place-items:center;height:100vh;'
    + 'background:#14121a;color:#e8e4f0;font:14px ui-monospace,monospace">'
    + '<div style="text-align:center"><div style="font-size:32px">&#9989;</div>'
    + '<p>Account connected.</p>'
    + '<p style="opacity:.6">You can close this window.</p></div>',
  );
});

/**
 * Polled while the consent window is open. The moment the vault holds a token
 * we record the link, which is the only signal we get that it worked.
 */
app.get('/api/connect/status', async (req, res) => {
  const uid = userOf(req);
  const id = String(req.query.connector || '');
  if (!uid || !id) return res.status(400).json({ error: 'userId and connector are required.' });
  const key = `${uid}:${id}`;
  try {
    // The handle from the sign-in we started. Without it AWS answers about a
    // brand new authorization nobody has visited, which is never complete.
    const pending = pendingConsent.get(key);
    // If the landing page never ran - window closed too early, say - try to
    // finish it here. Harmless before consent: AWS just says the session is
    // not ready.
    if (pending && !pending.done) {
      try {
        if (await finishSignIn(pending, pending.sessionUri)) {
          pendingConsent.delete(key);
          return res.json({ linked: true, connections: await setConnection(uid, id, true) });
        }
      } catch { /* not consented yet, or already spent - the check below decides */ }
    }
    if (!(await isConnected(uid, id, pending?.sessionUri))) {
      console.log(`connect status: ${id} not linked yet for ${uid}`
        + ` (session ${pending ? String(pending.sessionUri).slice(-8) : 'NONE REMEMBERED'})`);
      return res.json({ linked: false });
    }
    pendingConsent.delete(key);
    const connections = await setConnection(uid, id, true);
    console.log(`connect: ${id} consent completed for ${uid}`);
    res.json({ linked: true, connections });
  } catch (err) {
    console.error(`connect status: ${id} failed for ${uid} -`, err.message);
    res.status(400).json({ error: err.message });
  }
});

app.put('/api/world', async (req, res) => {
  const { userId, agents } = req.body ?? {};
  const uid = userOf(req, userId);
  if (!uid) return res.status(400).json({ error: 'userId is required.' });
  try {
    const saved = await writeWorld(uid, agents ?? []);
    // writeWorld reports whether the store actually accepted it. Returning 200
    // regardless is how a failed write ends up looking like a saved agent: the
    // room shows it, nothing is persisted, and the next message cannot find it.
    if (!saved.stored) {
      return res.status(503).json({
        error: 'Could not save - the agent store is unreachable. Nothing was changed.',
      });
    }
    // The next message must use the new configuration, not a cached team.
    dropCachedTeams(uid);
    res.json(saved);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ------------------------------------------------------------------ chats
/** Past conversations, newest first. Empty - never an error - when nothing is configured. */
app.get('/api/chats', async (req, res) => {
  const uid = userOf(req);
  if (!uid || !chatsEnabled()) return res.json({ chats: [], enabled: chatsEnabled() });
  try {
    res.json({ chats: await listChats(uid), enabled: true });
  } catch (err) {
    console.warn('chats: list failed -', err.message);
    res.status(500).json({ error: 'Could not read your chats.' });
  }
});

app.get('/api/chats/:id', async (req, res) => {
  const uid = userOf(req);
  if (!uid || !isChatId(req.params.id)) return res.status(400).json({ error: 'Bad chat id.' });
  try {
    const chat = await readChat(uid, req.params.id);
    if (!chat) return res.status(404).json({ error: 'No such chat.' });
    res.json(chat);
  } catch (err) {
    console.warn('chats: read failed -', err.message);
    res.status(500).json({ error: 'Could not read that chat.' });
  }
});

app.delete('/api/chats/:id', async (req, res) => {
  const uid = userOf(req);
  if (!uid || !isChatId(req.params.id)) return res.status(400).json({ error: 'Bad chat id.' });
  try {
    await deleteChat(uid, req.params.id);
    // A cached team for that chat would write the snapshot straight back.
    const team = sessions.get(req.params.id);
    if (team && team.userId === uid) { team.close?.().catch(() => {}); sessions.delete(req.params.id); }
    res.json({ ok: true });
  } catch (err) {
    console.warn('chats: delete failed -', err.message);
    res.status(500).json({ error: 'Could not delete that chat.' });
  }
});

// ------------------------------------------------------------------ prefs
const VALID_THEMES = new Set(['office', 'home', 'arcade']);

app.get('/api/prefs', async (req, res) => {
  const { prefs, stored } = await readPrefs(userOf(req));
  res.json({ prefs, stored });
});

app.put('/api/prefs', async (req, res) => {
  const { clientId, theme } = req.body ?? {};
  const cid = userOf(req, clientId);
  if (!cid) return res.status(400).json({ error: 'clientId is required.' });
  if (theme != null && !VALID_THEMES.has(theme)) {
    return res.status(400).json({ error: `Unknown theme "${theme}".` });
  }
  const { stored } = await writePrefs(cid, { ...(theme ? { theme } : {}) });
  res.json({ stored });
});

/**
 * Runs one turn and pushes every protocol event to `onEvent`.
 * Both the browser and Telegram go through here, so the two channels can
 * never drift apart.
 */
async function runTurn({ prompt, sessionId, userId = 'anon', files = [], user = {} }, onEvent) {
  if (TARGET === 'agentcore') {
    if (!RUNTIME_ARN) throw new Error('AGENT_RUNTIME_ARN is not set.');
    const { client, InvokeAgentRuntimeCommand } = await getAgentCore();
    const out = await client.send(new InvokeAgentRuntimeCommand({
      agentRuntimeArn: RUNTIME_ARN,
      runtimeSessionId: runtimeSessionId(sessionId),
      contentType: 'application/json',
      accept: 'text/event-stream',
      // sessionId rides along too: the runtime only sees a padded header id,
      // and the transcript must be filed under the id the browser will ask for.
      payload: new TextEncoder().encode(JSON.stringify({ prompt, files, userId, sessionId, user })),
    }));
    const feed = makeSseParser((ev) => {
      // 'result' is the convenience frame for non-streaming callers; the
      // browser already has the text deltas, so drop it.
      if (ev.type !== 'result') onEvent(ev);
    });
    const decoder = new TextDecoder();
    for await (const chunk of out.response) feed(decoder.decode(chunk, { stream: true }));
    return;
  }

  await assertBudget(userId);
  const team = await teamFor(sessionId, userId, user);
  console.log(`chat: user=${userId} session=${sessionId} roster=${team.roster.length}`);
  if (!team.boss) {
    throw new Error(`No agent found for this browser (id ${userId}). Open AGENTS and build one.`);
  }
  let finalPrompt = prompt;
  const primary = team.workspaces?.[0]?.workspace;
  if (files.length && primary) {
    const written = [];
    for (const f of files.slice(0, 5)) {
      if (!f?.name || !f?.base64) continue;
      const safe = String(f.name).replace(/[^\w.\-]/g, '_').slice(0, 80);
      try {
        const bytes = new Uint8Array(Buffer.from(f.base64, 'base64'));
        await primary.writeFile(safe, bytes);
        written.push(safe);
        // A document someone hands over should still be there tomorrow.
        if (library.libraryEnabled()) {
          library.put(userId, safe, bytes, mimeFor(safe))
            .catch((e) => console.warn(`library: could not file ${safe} -`, e.message));
        }
      } catch (err) {
        console.warn(`attachment ${safe} failed -`, err.message);
      }
    }
    if (written.length) {
      finalPrompt += `\n\n[The user attached these files to your workspace: ${written.join(', ')}]`;
    }
  }
  for await (const ev of agentEvents(team.boss, finalPrompt, {
    workspaces: team.workspaces,
    webs: team.webs,
    sessionId,
    userId,
    agentNames: team.agentToolNames,
    main: team.roster[0].toolName,
  })) onEvent(ev);
  await recordUsage(userId, team.measure());
}

app.post('/api/chat', async (req, res) => {
  const { prompt, sessionId = 'default' } = req.body ?? {};
  if (!prompt || !prompt.trim()) return res.status(400).json({ error: 'Empty prompt.' });

  res.setHeader('Content-Type', 'application/x-ndjson');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('X-Accel-Buffering', 'no');

  const send = (obj) => {
    res.write(JSON.stringify(obj) + '\n');
    // Without an explicit flush the first chunks can sit in a buffer and the
    // animation lags behind the real work.
    res.flush?.();
  };

  try {
    await runTurn({
      prompt,
      sessionId,
      userId: userOf(req, req.body?.userId || sessionId),
      files: req.body?.files ?? [],
      user: req.user ? { email: req.user.email } : {},
    }, send);
  } catch (err) {
    console.error('chat error:', err);
    send({ type: 'error', message: err?.message ?? 'Something went wrong.' });
  } finally {
    res.end();
  }
});

// ---------------------------------------------------------------- telegram
const telegram = new TelegramBot({
  token: process.env.TELEGRAM_BOT_TOKEN || '',
  secret: process.env.TELEGRAM_WEBHOOK_SECRET || '',
  /** Collects a whole turn, because Telegram cannot stream. */
  link: issueLinkCode,
  commands: {
    async jobs(chatId) {
      const jobs = await listJobs(await resolveAlias(`tg-${chatId}`), 6);
      if (!jobs.length) return 'Nothing has run on its own yet.';
      return jobs.map((j) => `${j.status === 'needs_approval' ? 'WAITING' : j.status.toUpperCase()} ${j.jobId}\n${j.title}`).join('\n\n');
    },
    async approve(chatId, arg) {
      if (!isJobId(arg)) return 'Which job? /approve job-xxxx-xxxx';
      await answerJob({ userId: await resolveAlias(`tg-${chatId}`), jobId: arg, approved: true });
      return 'Approved. Carrying on; the result comes here when it is done.';
    },
    async deny(chatId, arg) {
      if (!isJobId(arg)) return 'Which job? /deny job-xxxx-xxxx';
      await answerJob({ userId: await resolveAlias(`tg-${chatId}`), jobId: arg, approved: false });
      return 'Declined. The agent will finish without doing that.';
    },
  },
  run: async (prompt, sessionId, onEvent, attachments = []) => {
    // On Telegram the chat is an alias: for whoever linked it, or, until then,
    // a person of its own.
    const userId = await resolveAlias(sessionId);
    const files = attachments.map((a) => ({
      name: a.name,
      base64: Buffer.from(a.bytes).toString('base64'),
    }));

    let text = '';
    const artifactUrls = [];
    await runTurn({ prompt, sessionId, userId, files }, (ev) => {
      if (ev.type === 'text') text += ev.value;
      else if (ev.type === 'artifact') artifactUrls.push(ev);
      else if (ev.type === 'error') text += `\n\n[error] ${ev.message}`;
      onEvent(ev);
    });

    // Artifacts arrive as presigned links; Telegram wants the bytes.
    const artifacts = [];
    for (const a of artifactUrls) {
      try {
        const res = await fetch(a.url);
        if (res.ok) artifacts.push({ name: a.name, bytes: new Uint8Array(await res.arrayBuffer()) });
      } catch (err) {
        console.warn(`telegram: could not fetch artifact ${a.name} -`, err.message);
      }
    }
    return { text: text.trim(), artifacts };
  },
});

app.post('/telegram/webhook', (req, res) => {
  if (telegram.secret && req.get('x-telegram-bot-api-secret-token') !== telegram.secret) {
    return res.sendStatus(401);
  }
  // Answer immediately: Telegram retries any webhook that is slow to reply,
  // and an agent turn takes far longer than its patience.
  res.sendStatus(200);
  telegram.handle(req.body);
});

// ------------------------------------------------------------ local clock
/**
 * With no EventBridge (local dev, or a deployment without a scheduler role)
 * this ticker is the clock: once a minute, every routine that is due starts
 * a job. In production the schedules invoke the runtime directly and this
 * stays off.
 */
if (!schedulerEnabled()) {
  const tick = async () => {
    let owners = [];
    try { owners = await routineOwners(); } catch (err) { return console.warn('routines: tick skipped -', err.message); }
    for (const uid of owners) {
      for (const r of await listRoutines(uid).catch(() => [])) {
        if (!dueNow(r)) continue;
        console.log(`routines: ${r.name} is due for ${uid}`);
        startJob(jobPayload(uid, r).job).catch((err) => console.warn('routines: start failed -', err.message));
      }
    }
  };
  setInterval(tick, 60_000).unref();
  setTimeout(tick, 5_000).unref();
}

app.listen(PORT, () => {
  const where = TARGET === 'agentcore'
    ? `agentcore ${RUNTIME_ARN.split('/').pop() || '(no ARN set!)'}`
    : `local (${PRESET})`;
  console.log(`\n  Agent UI:  http://localhost:${PORT}`);
  console.log(`  Target:    ${where}`);
  console.log(`  Telegram:  ${telegram.enabled ? 'enabled' : 'off (no TELEGRAM_BOT_TOKEN)'}\n`);

  // Register the webhook once we know our own public address.
  const publicUrl = process.env.PUBLIC_URL;
  if (telegram.enabled && publicUrl) {
    telegram.setWebhook(publicUrl).catch((err) => console.warn('telegram:', err.message));
  }
});
