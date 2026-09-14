/**
 * The outbox: where a job's result goes when nobody is in the chat.
 *
 * Telegram, if the account has linked a chat (`/link` in the bot writes
 * `telegram.chatId` onto the user record). Files go as real documents.
 * With no Telegram, the result simply waits in JOBS in the browser - the job
 * record and the chat transcript hold everything.
 */
import { readPrefs, writePrefs } from './prefs.js';
import { TelegramBot } from './telegram.js';

const TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const bot = TOKEN ? new TelegramBot({ token: TOKEN, run: async () => ({ text: '', artifacts: [] }) }) : null;

export const outboxEnabled = () => Boolean(bot);

/** Remembers which Telegram chat belongs to this account. */
export async function setTelegramChat(userId, chatId) {
  await writePrefs(userId, { telegram: { chatId: String(chatId), linkedAt: new Date().toISOString() } });
}

export async function telegramChatFor(userId) {
  const { prefs } = await readPrefs(userId);
  return prefs?.telegram?.chatId ?? null;
}

/**
 * @param {string} userId
 * @param {object} m
 * @param {string} m.text
 * @param {Array<{name:string,url?:string,bytes?:Uint8Array}>} [m.artifacts]
 * @returns {Promise<'telegram'|'none'>}
 */
export async function deliver(userId, { text, artifacts = [] }) {
  if (!bot) return 'none';
  const chatId = await telegramChatFor(userId);
  if (!chatId) return 'none';
  await bot.send(chatId, text);
  for (const a of artifacts) {
    try {
      let bytes = a.bytes;
      if (!bytes && a.url) {
        const res = await fetch(a.url);
        if (res.ok) bytes = new Uint8Array(await res.arrayBuffer());
      }
      if (bytes) await bot.sendDocument(chatId, a.name, bytes);
    } catch (err) {
      console.warn(`outbox: could not send ${a.name} -`, err.message);
    }
  }
  return 'telegram';
}
