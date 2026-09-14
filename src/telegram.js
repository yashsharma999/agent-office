/**
 * Telegram channel.
 *
 * App Runner already gives us a public HTTPS URL, so this is a webhook rather
 * than long polling: Telegram POSTs each update to /telegram/webhook and we
 * answer out-of-band with the Bot API.
 *
 * Telegram has no notion of a streaming reply, so the shape of a turn is:
 *   1. send a placeholder ("thinking...")
 *   2. edit it as the agent works, throttled - Telegram rate-limits edits
 *   3. final edit with the answer, then any files as real documents
 *
 * Each chat is its own conversation, so chat_id maps to a session id, which
 * is also what namespaces the sandbox and any published artifacts.
 */
const API = 'https://api.telegram.org';

/** Telegram starts rejecting edits past roughly one per second per chat. */
const EDIT_INTERVAL_MS = 1400;
const MAX_MESSAGE = 4000;

export class TelegramBot {
  /**
   * @param {object} options
   * @param {string} options.token         bot token from @BotFather
   * @param {string} [options.secret]      shared secret Telegram echoes back
   * @param {(prompt: string, sessionId: string, onEvent: Function) => Promise<{text: string, artifacts: Array}>} options.run
   */
  constructor({ token, secret = '', run, link = null, commands = {} }) {
    this.link = link;
    /** `/name arg` handlers: (chatId, arg) => reply text. */
    this.commands = commands;
    this.token = token;
    this.secret = secret;
    this.run = run;
  }

  get enabled() { return Boolean(this.token); }

  async _call(method, body) {
    const res = await fetch(`${API}/bot${this.token}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!data.ok) console.warn(`telegram: ${method} failed -`, data.description ?? res.status);
    return data.result;
  }

  send(chatId, text) {
    return this._call('sendMessage', { chat_id: chatId, text: clip(text) });
  }

  edit(chatId, messageId, text) {
    return this._call('editMessageText', { chat_id: chatId, message_id: messageId, text: clip(text) });
  }

  /** Uploads a file as a real Telegram document, so it lands in the chat. */
  async sendDocument(chatId, name, bytes, caption = '') {
    const form = new FormData();
    form.append('chat_id', String(chatId));
    if (caption) form.append('caption', clip(caption, 1000));
    form.append('document', new Blob([bytes]), name);
    const res = await fetch(`${API}/bot${this.token}/sendDocument`, { method: 'POST', body: form });
    const data = await res.json().catch(() => ({}));
    if (!data.ok) console.warn('telegram: sendDocument failed -', data.description ?? res.status);
    return data.ok;
  }

  /** Pulls a file the user attached, so it can be dropped into the sandbox. */
  async download(fileId) {
    const file = await this._call('getFile', { file_id: fileId });
    if (!file?.file_path) return null;
    const res = await fetch(`${API}/file/bot${this.token}/${file.file_path}`);
    if (!res.ok) return null;
    return {
      name: file.file_path.split('/').pop(),
      bytes: new Uint8Array(await res.arrayBuffer()),
    };
  }

  /** Points Telegram at this deployment. Idempotent, safe to call on boot. */
  async setWebhook(publicUrl) {
    const url = `${publicUrl.replace(/\/$/, '')}/telegram/webhook`;
    const out = await this._call('setWebhook', {
      url,
      ...(this.secret ? { secret_token: this.secret } : {}),
      allowed_updates: ['message'],
      drop_pending_updates: true,
    });
    console.log(`telegram: webhook -> ${url} (${out ? 'ok' : 'failed'})`);
    return out;
  }

  /**
   * Handles one update. Returns immediately; the reply is sent out-of-band,
   * because Telegram retries any webhook that takes too long to answer.
   */
  handle(update) {
    const msg = update?.message;
    if (!msg?.chat?.id) return;
    // Errors here must never reject: the webhook has already been answered.
    this._turn(msg).catch((err) => console.error('telegram: turn failed -', err));
  }

  async _turn(msg) {
    const chatId = msg.chat.id;
    const sessionId = `tg-${chatId}`;
    const attachments = [];

    // Telegram sends photos as a size ladder; the last entry is the largest.
    const fileId = msg.document?.file_id ?? msg.photo?.[msg.photo.length - 1]?.file_id;
    if (fileId) {
      const file = await this.download(fileId);
      if (file) attachments.push({ name: msg.document?.file_name ?? file.name, bytes: file.bytes });
    }

    const text = (msg.text ?? msg.caption ?? '').trim();

    if (text === '/link') {
      // Binds this chat to a signed-in web account, so the same person has
      // the same agents, memory and history here and in the browser.
      if (!this.link) { await this.send(chatId, 'Linking is not set up on this server.'); return; }
      try {
        const code = await this.link(chatId);
        await this.send(chatId,
          `Your link code is ${code}\n\nIn the web app open AGENTS and type it into LINK TELEGRAM. It expires in 10 minutes.`);
      } catch (err) {
        await this.send(chatId, `Could not make a code: ${err.message}`);
      }
      return;
    }
    if (text === '/start' || text === '/help') {
      await this.send(chatId,
        'I am your agent. Ask me anything, or ask for a file - a PDF, a deck, a spreadsheet - ' +
        'and I will build it in my workspace and send it back. You can attach files for me to work on too.\n\n' +
        '/link - tie this chat to your web account\n' +
        '/jobs - what has run on its own lately\n' +
        '/approve <job> or /deny <job> - answer a job that is waiting on you');
      return;
    }
    const cmd = text.match(/^\/([a-z]+)(?:@\w+)?\s*(.*)$/i);
    if (cmd && this.commands[cmd[1].toLowerCase()]) {
      try {
        await this.send(chatId, await this.commands[cmd[1].toLowerCase()](chatId, cmd[2].trim()));
      } catch (err) {
        await this.send(chatId, err.message);
      }
      return;
    }
    if (!text && !attachments.length) return;

    const prompt = text || `The user sent a file: ${attachments[0].name}. Ask what they want done with it.`;

    const placeholder = await this.send(chatId, 'thinking...');
    const messageId = placeholder?.message_id;
    let lastEdit = 0;
    let lastShown = '';

    const onEvent = (ev) => {
      if (!messageId) return;
      let line = null;
      if (ev.type === 'agent' && ev.phase === 'start') line = `handing this to ${ev.name}...`;
      else if (ev.type === 'tool' && ev.phase === 'start') line = `${ev.name}...`;
      if (!line || line === lastShown) return;

      const now = Date.now();
      if (now - lastEdit < EDIT_INTERVAL_MS) return;
      lastEdit = now;
      lastShown = line;
      this.edit(chatId, messageId, line).catch(() => {});
    };

    const { text: answer, artifacts } = await this.run(prompt, sessionId, onEvent, attachments);

    if (messageId) await this.edit(chatId, messageId, answer || '(no answer)');
    else await this.send(chatId, answer || '(no answer)');

    for (const a of artifacts ?? []) {
      if (!a.bytes) continue;
      await this.sendDocument(chatId, a.name, a.bytes);
    }
  }
}

function clip(text, max = MAX_MESSAGE) {
  const t = String(text ?? '');
  return t.length > max ? `${t.slice(0, max - 3)}...` : t;
}
