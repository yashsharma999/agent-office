/**
 * Bedrock AgentCore Runtime entrypoint.
 *
 * AgentCore requires exactly two HTTP endpoints on port 8080:
 *   GET  /ping         health check
 *   POST /invocations  the prompt, raw bytes in the body
 *
 * /invocations answers with Server-Sent Events so tool activity reaches the
 * caller as it happens. AgentCore streams a response back to the client only
 * when the container replies with `text/event-stream`.
 *
 * Run locally:  npm run serve
 */
import express from 'express';
import { createTeam } from './src/team.js';
import { describeModel } from './src/model.js';
import { agentEvents, SSE_HEADERS, sseLine } from './src/stream-events.js';
import * as library from './src/library.js';
import { mimeFor } from './src/artifacts.js';
import { runJob, resumeJob, busy } from './src/runner.js';
import { assertBudget, recordUsage } from './src/usage.js';

const PORT = process.env.PORT || 8080;

// In the container the only credentials available are the AgentCore task role,
// so Bedrock is the sensible default regardless of what .env says locally.
const PRESET = process.env.MODEL_PRESET || 'dev';
// Extended thinking costs tokens, so it is opt-in. It feeds the thought clouds.
const REASONING = process.env.REASONING !== 'false';

/**
 * AgentCore sends a session id header. Keeping one Agent per session gives
 * multi-turn memory without leaking one caller's history into another's.
 * A single module-level Agent would share history across every user.
 */
const SESSION_HEADER = 'x-amzn-bedrock-agentcore-runtime-session-id';
const MAX_SESSIONS = 500;
const sessions = new Map();

/**
 * `sessionId` is AgentCore's header - the cache key. `chatId` is the caller's
 * own id for the conversation, which is what the transcript is filed under;
 * it survives this VM and can be reopened from anywhere.
 */
async function teamForSession(sessionId, userId, chatId, user = {}) {
  if (!sessionId) return createTeam({ preset: PRESET, userId, sessionId: chatId, user });

  const existing = sessions.get(sessionId);
  if (existing) {
    // Refresh recency for the LRU eviction below.
    sessions.delete(sessionId);
    sessions.set(sessionId, existing);
    return existing;
  }

  const team = await createTeam({ preset: PRESET, userId, sessionId: chatId, user });
  sessions.set(sessionId, team);
  if (sessions.size > MAX_SESSIONS) {
    const [oldestId, oldest] = sessions.entries().next().value;
    // Rigs bill per second; stop their VMs when the session is evicted.
    oldest?.close?.().catch(() => {});
    sessions.delete(oldestId);
  }
  return team;
}

/**
 * Reads the request body straight off the stream.
 *
 * Do NOT use express.raw() here: it only parses when a Content-Type header is
 * present, and AgentCore sends none. Express 5 then leaves req.body undefined,
 * which decodes to '' and looks like an empty prompt.
 */
function readRawBody(req, limitBytes = 10 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limitBytes) {
        reject(new Error('Request body too large.'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/**
 * Accepts a bare string, or JSON with `prompt`/`input` and optional `files`
 * (base64), so a caller can drop attachments straight into the sandbox.
 */
function extractRequest(raw) {
  const parse = (text) => { try { return JSON.parse(text); } catch { return undefined; } };
  let parsed = parse(raw);
  // EventBridge Scheduler hands the Payload blob over base64-encoded.
  if (parsed === undefined && /^[A-Za-z0-9+/=\s]+$/.test(raw)) {
    parsed = parse(Buffer.from(raw, 'base64').toString('utf8'));
  }
  if (typeof parsed === 'string') return { prompt: parsed, files: [], userId: null, chatId: null, user: {} };
  if (parsed && typeof parsed === 'object') {
    return {
      prompt: parsed.prompt ?? parsed.input ?? '',
      files: Array.isArray(parsed.files) ? parsed.files : [],
      userId: parsed.userId ?? null,
      chatId: parsed.sessionId ?? null,
      user: parsed.user && typeof parsed.user === 'object' ? parsed.user : {},
      /** An unattended run: answered at once, worked on in the background. */
      job: parsed.job && typeof parsed.job === 'object' ? parsed.job : null,
      /** An answer to a parked job's approval request. */
      resume: parsed.resume && typeof parsed.resume === 'object' ? parsed.resume : null,
    };
  }
  return { prompt: raw, files: [], userId: null, chatId: null, user: {} };
}

/**
 * Drops user-supplied files into the sandbox, and files a durable copy.
 * A document someone hands the agent should still be there tomorrow, without
 * anyone having to ask for it to be saved.
 */
async function applyAttachments(workspace, files, userId) {
  if (!workspace || !files?.length) return [];
  const written = [];
  for (const f of files.slice(0, 5)) {
    if (!f?.name || !f?.base64) continue;
    const safe = String(f.name).replace(/[^\w.\-]/g, '_').slice(0, 80);
    try {
      const bytes = new Uint8Array(Buffer.from(f.base64, 'base64'));
      await workspace.writeFile(safe, bytes);
      written.push(safe);
      if (userId && library.libraryEnabled()) {
        library.put(userId, safe, bytes, mimeFor(safe))
          .catch((err) => console.warn(`library: could not file ${safe} -`, err.message));
      }
    } catch (err) {
      console.warn(`attachment ${safe} failed -`, err.message);
    }
  }
  return written;
}

const app = express();

app.get('/ping', (_req, res) => {
  // HealthyBusy keeps AgentCore from reclaiming the container mid-job.
  res.json({ status: busy() ? 'HealthyBusy' : 'Healthy', time_of_last_update: Math.floor(Date.now() / 1000) });
});

app.post('/invocations', async (req, res) => {
  const sessionId = req.get(SESSION_HEADER);
  let started = false;

  try {
    const body = await readRawBody(req);
    const raw = body.toString('utf8');
    console.log(
      `invocations: session=${sessionId ?? 'none'} content-type=${req.get('content-type') ?? 'none'} bytes=${body.length}`,
    );

    const { prompt: rawPrompt, files, userId, chatId, user, job, resume } = extractRequest(raw);

    // Detached work: answer now, run in the background, deliver to the outbox.
    if (job) {
      runJob(job, { preset: PRESET }).catch((err) => console.error('job failed to start:', err));
      return res.json({ accepted: true, kind: 'job' });
    }
    if (resume) {
      resumeJob(resume, { preset: PRESET }).catch((err) => console.error('resume failed:', err));
      return res.json({ accepted: true, kind: 'resume' });
    }

    let prompt = rawPrompt;
    if (!prompt || !prompt.trim()) {
      console.error(`empty prompt. raw body was: ${JSON.stringify(raw.slice(0, 200))}`);
      return res.status(400).json({ error: 'Empty prompt.' });
    }

    res.writeHead(200, SSE_HEADERS);
    started = true;

    try {
      await assertBudget(userId);
    } catch (err) {
      res.write(sseLine({ type: 'error', message: err.message }));
      res.write(sseLine({ type: 'end' }));
      return res.end();
    }

    const team = await teamForSession(sessionId, userId, chatId, user);
    if (!team.boss) {
      res.write(sseLine({ type: 'error', message: 'No agent exists yet. Build one first.' }));
      res.write(sseLine({ type: 'end' }));
      return res.end();
    }

    const attached = await applyAttachments(team.workspaces?.[0]?.workspace, files, userId);
    if (attached.length) {
      prompt += `\n\n[The user attached these files to your workspace: ${attached.join(', ')}]`;
    }

    let answer = '';
    for await (const ev of agentEvents(team.boss, prompt, {
      workspaces: team.workspaces,
      webs: team.webs,
      sessionId,
      userId,
      agentNames: team.agentToolNames,
      main: team.roster[0].toolName,
    })) {
      if (ev.type === 'text') answer += ev.value;
      res.write(sseLine(ev));
      res.flush?.();
    }
    // Final frame carries the whole answer, so non-streaming callers can read
    // one line instead of stitching the deltas back together.
    res.write(sseLine({ type: 'result', response: answer }));
    res.end();
    await recordUsage(userId, team.measure());
  } catch (err) {
    console.error('Error processing request:', err);
    const message = err?.message ?? 'Internal server error';
    if (started) {
      res.write(sseLine({ type: 'error', message }));
      res.end();
    } else {
      res.status(500).json({ error: message });
    }
  }
});

app.listen(PORT, () => {
  console.log(`AgentCore runtime listening on ${PORT} (preset: ${PRESET})`);
  console.log('  GET  /ping');
  console.log('  POST /invocations  (text/event-stream)');
});
