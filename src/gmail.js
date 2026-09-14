/**
 * The Gmail API. Nothing about OAuth lives here - `accounts.js` supplies the
 * token, so this file is only the shape of Google's mail endpoints.
 *
 * There is no send. `gmail.compose` lets us create drafts; the human presses
 * send. That is a product decision, not a limit of the scope.
 */
import { authedFetch } from './accounts.js';

const API = 'https://gmail.googleapis.com/gmail/v1/users/me';

const call = (userId, path, init) => authedFetch(userId, 'gmail', `${API}${path}`, init);

const header = (payload, name) =>
  payload?.headers?.find((h) => h.name.toLowerCase() === name)?.value ?? '';

/** Walks the MIME tree for the first text/plain part. */
function plainText(payload) {
  if (!payload) return '';
  if (payload.mimeType === 'text/plain' && payload.body?.data) {
    return Buffer.from(payload.body.data, 'base64url').toString('utf8');
  }
  for (const part of payload.parts ?? []) {
    const found = plainText(part);
    if (found) return found;
  }
  if (payload.body?.data) {
    return Buffer.from(payload.body.data, 'base64url').toString('utf8');
  }
  return '';
}

export async function profile(userId) {
  const me = await call(userId, '/profile');
  return { address: me.emailAddress, mock: false };
}

export async function search(userId, query = '', limit = 5) {
  const params = new URLSearchParams({ maxResults: String(Math.min(limit, 20)) });
  if (query) params.set('q', query);
  const list = await call(userId, `/messages?${params}`);
  const ids = (list.messages ?? []).slice(0, limit).map((m) => m.id);

  // metadata format keeps these cheap; the body comes from read().
  return Promise.all(ids.map(async (id) => {
    const m = await call(
      userId,
      `/messages/${id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`,
    );
    return {
      id,
      from: header(m.payload, 'from'),
      subject: header(m.payload, 'subject'),
      date: header(m.payload, 'date'),
      snippet: (m.snippet ?? '').slice(0, 160),
    };
  }));
}

export async function read(userId, id) {
  const m = await call(userId, `/messages/${id}?format=full`);
  return {
    id,
    from: header(m.payload, 'from'),
    to: header(m.payload, 'to'),
    subject: header(m.payload, 'subject'),
    date: header(m.payload, 'date'),
    body: plainText(m.payload).slice(0, 8000),
  };
}

export async function draft(userId, { to, subject, body }) {
  // RFC 2822, base64url encoded - what the Gmail API expects.
  const mime = [
    `To: ${to}`,
    `Subject: ${subject}`,
    'Content-Type: text/plain; charset="UTF-8"',
    '',
    body,
  ].join('\r\n');
  const created = await call(userId, '/drafts', {
    method: 'POST',
    body: JSON.stringify({ message: { raw: Buffer.from(mime).toString('base64url') } }),
  });
  return {
    draftId: created.id,
    to,
    subject,
    words: String(body).trim().split(/\s+/).filter(Boolean).length,
    note: 'Saved to your Gmail Drafts, ready for you to review and send.',
  };
}

/** Rough sizes, for the inbox tray on the desk. Never throws. */
export async function counts(userId) {
  try {
    const [me, drafts] = await Promise.all([
      call(userId, '/profile'),
      call(userId, '/drafts?maxResults=1'),
    ]);
    return { messages: me.messagesTotal ?? 0, drafts: drafts.resultSizeEstimate ?? 0 };
  } catch {
    return { messages: 0, drafts: 0 };
  }
}
