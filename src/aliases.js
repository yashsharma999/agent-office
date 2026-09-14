/**
 * One person, several ways in.
 *
 * A Cognito `sub` is the real identity. Everything else - a Telegram chat, a
 * browser's old anonymous id - is an alias that maps onto it. Aliases and
 * short-lived link codes live on the prefs table under reserved key prefixes,
 * so no new infrastructure is needed.
 *
 *   link:<CODE>     -> { chatId, expiresAt }      issued by the bot, typed into the web app
 *   alias:<handle>  -> { userId }                 e.g. alias:tg-123456 -> the Cognito sub
 */
import { readPrefs, writePrefs } from './prefs.js';
import { storageFor, chatsEnabled } from './chats.js';

const CODE_TTL = 10 * 60 * 1000;
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';   // no 0/O/1/I

export async function issueLinkCode(chatId) {
  let code = '';
  for (let i = 0; i < 6; i++) code += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
  const { stored } = await writePrefs(`link:${code}`, { chatId: String(chatId), expiresAt: Date.now() + CODE_TTL });
  if (!stored) throw new Error('Could not issue a link code.');
  return code;
}

/** Binds the chat behind `code` to `userId`. */
export async function redeemLinkCode(code, userId) {
  const key = `link:${String(code).toUpperCase().trim()}`;
  const { prefs } = await readPrefs(key);
  if (!prefs?.chatId || prefs.expiresAt < Date.now()) throw new Error('That code is not valid any more. Ask the bot for a new one with /link.');
  await writePrefs(`alias:tg-${prefs.chatId}`, { userId });
  await writePrefs(key, { expiresAt: 0 });
  return prefs.chatId;
}

/** The user behind an alias, or the alias itself when nobody has claimed it. */
export async function resolveAlias(handle) {
  const { prefs } = await readPrefs(`alias:${handle}`);
  return prefs?.userId ?? handle;
}

/**
 * Brings a browser's anonymous world into a signed-in account: the agents
 * and theme, and every chat transcript. Account links are not copied - the
 * token vault keys them by user, so those are consented again.
 */
export async function claimLegacy(legacyId, userId) {
  if (!/^c-[a-z0-9]{6,40}$/.test(legacyId)) throw new Error('Not a browser id.');
  const { prefs: old } = await readPrefs(legacyId);
  const { prefs: mine } = await readPrefs(userId);
  if (mine?.agents?.length) throw new Error('This account already has agents; nothing was changed.');
  let agents = 0, chats = 0;
  if (old?.agents?.length || old?.theme) {
    await writePrefs(userId, {
      ...(old.agents ? { agents: old.agents } : {}),
      ...(old.theme ? { theme: old.theme } : {}),
    });
    agents = old.agents?.length ?? 0;
  }
  if (chatsEnabled()) {
    const from = storageFor(legacyId), to = storageFor(userId);
    for (const key of await from.list('')) {
      const bytes = await from.read(key);
      if (bytes) { await to.write(key, bytes); if (key.endsWith('snapshot_latest.json')) chats++; }
    }
  }
  return { agents, chats };
}
