/**
 * Chat history, kept by the Strands SDK's own session machinery.
 *
 * The boss agent carries a `SessionManager` plugin. After every invocation the
 * SDK snapshots the agent - messages, state, model state - into S3, and when an
 * agent is built for a session that already has a snapshot, it restores it
 * before the first model call. Reopening an old chat is therefore not a replay
 * of text: the agent genuinely remembers.
 *
 * Layout in the artifacts bucket, one prefix per user:
 *
 *   chats/<userId>/session/<chatId>/scopes/agent/<agentId>/snapshots/snapshot_latest.json
 *
 * Everything below the user prefix is the SDK's; this file only chooses the
 * prefix, hands out managers, and reads the snapshots back for the history
 * list. Chat ids must match the SDK's rule: lowercase letters, digits, - and _.
 */
import { SessionManager } from '@strands-agents/sdk';
import { S3Storage } from '@strands-agents/sdk/storage';

const BUCKET = process.env.ARTIFACT_BUCKET || '';
const REGION = process.env.AWS_REGION || 'us-east-1';
const MAX_LIST = 30;

export const chatsEnabled = () => Boolean(BUCKET);
export const isChatId = (id) => /^[a-z0-9_-]{3,64}$/.test(String(id ?? ''));

const safeUser = (u) => String(u || 'anon').replace(/[^\w.@-]/g, '_').slice(0, 96);

const stores = new Map();
/** One storage per user, rooted at that user's prefix so a list never crosses users. */
export function storageFor(userId) {
  const key = safeUser(userId);
  if (!stores.has(key)) stores.set(key, new S3Storage(BUCKET, { prefix: `chats/${key}`, region: REGION }));
  return stores.get(key);
}

/** The plugin that makes an agent remember this chat. Null when there is nowhere to keep it. */
export function sessionManagerFor(userId, chatId) {
  if (!chatsEnabled() || !isChatId(chatId)) return null;
  return new SessionManager({ sessionId: chatId, storage: storageFor(userId) });
}

const LATEST = /^session\/([a-z0-9_-]+)\/scopes\/agent\/([^/]+)\/snapshots\/snapshot_latest\.json$/;

async function readJson(storage, key) {
  const bytes = await storage.read(key);
  if (!bytes) return null;
  try { return JSON.parse(new TextDecoder().decode(bytes)); } catch { return null; }
}

/** Text of a message's text blocks, joined. */
const textOf = (m) => (m?.content ?? []).map((b) => b?.text).filter(Boolean).join('\n').trim();
/** A user message that only carries tool results is the loop talking to itself, not the person. */
const isPersonTurn = (m) => m?.role === 'user' && textOf(m) && !(m.content ?? []).some((b) => b?.toolResult);

function titleOf(messages = []) {
  const first = messages.find(isPersonTurn);
  const t = textOf(first).replace(/\s+/g, ' ');
  return t ? (t.length > 60 ? t.slice(0, 57) + '...' : t) : 'Untitled chat';
}

/**
 * Every chat this user has, newest first.
 *
 * Reads each latest snapshot to get a title and a time - fine at tens of chats,
 * which is what one person accumulates in a demo. Past that, keep an index.
 */
export async function listChats(userId, limit = MAX_LIST) {
  if (!chatsEnabled()) return [];
  const storage = storageFor(userId);
  const keys = (await storage.list('session/')).filter((k) => LATEST.test(k));
  const byChat = new Map();
  for (const key of keys) {
    const [, id] = key.match(LATEST);
    byChat.set(id, [...(byChat.get(id) ?? []), key]);
  }
  const out = [];
  for (const [id, ks] of byChat) {
    // An agent renamed mid-history leaves one snapshot per name; the newest wins.
    let best = null;
    for (const k of ks) {
      const snap = await readJson(storage, k);
      if (snap && (!best || snap.createdAt > best.createdAt)) best = snap;
    }
    if (!best) continue;
    const messages = best.data?.messages ?? [];
    out.push({
      id,
      title: titleOf(messages),
      updatedAt: best.createdAt,
      turns: messages.filter(isPersonTurn).length,
    });
  }
  return out.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1)).slice(0, limit);
}

/**
 * A chat as the console shows it: who said what, and which tools ran between.
 * Consecutive assistant messages (text, tool call, text...) fold into one turn.
 * @returns {Promise<{id, transcript: Array<{role:'you'|'agent', text, tools:string[]}>}|null>}
 */
export async function readChat(userId, chatId) {
  if (!chatsEnabled() || !isChatId(chatId)) return null;
  const storage = storageFor(userId);
  const keys = (await storage.list(`session/${chatId}/`)).filter((k) => LATEST.test(k));
  let best = null;
  for (const k of keys) {
    const snap = await readJson(storage, k);
    if (snap && (!best || snap.createdAt > best.createdAt)) best = snap;
  }
  if (!best) return null;

  const transcript = [];
  for (const m of best.data?.messages ?? []) {
    if (m.role === 'user') {
      if (isPersonTurn(m)) transcript.push({ role: 'you', text: textOf(m), tools: [] });
      continue;
    }
    const tools = (m.content ?? []).map((b) => b?.toolUse?.name).filter(Boolean);
    const text = textOf(m);
    const last = transcript[transcript.length - 1];
    if (last?.role === 'agent') {
      last.tools.push(...tools);
      if (text) last.text = last.text ? `${last.text}\n\n${text}` : text;
    } else {
      transcript.push({ role: 'agent', text, tools });
    }
  }
  return { id: chatId, title: titleOf(best.data?.messages), updatedAt: best.createdAt, transcript };
}

export async function deleteChat(userId, chatId) {
  const sm = sessionManagerFor(userId, chatId);
  if (sm) await sm.deleteSession();
}
