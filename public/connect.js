/**
 * Linking an account from the browser.
 *
 * Shared by Build mode (a pass on an agent) and Buy mode (the world's
 * accounts), so the awkward parts live in one place:
 *
 *  - The popup must be opened INSIDE the click. Chrome forgets the user
 *    gesture across an await, so a window opened after the fetch is blocked
 *    silently - which looks exactly like a dead button.
 *  - AWS owns the OAuth callback and never redirects back to us, so the only
 *    way to learn the sign-in finished is to keep asking the server.
 */

function closeQuietly(win) {
  try { win.close(); } catch { /* gone, or on an origin we cannot touch */ }
}

const status = (userId, id) =>
  fetch(`/api/connect/status?userId=${encodeURIComponent(userId)}&connector=${encodeURIComponent(id)}`)
    .then((r) => r.json());

/**
 * Waits for the user to finish signing in at `win`.
 * Three minutes is generous for a consent screen and short enough that an
 * abandoned window stops costing anything.
 * @returns {Promise<object>} the world's connections once linked
 */
export async function pollConsent(userId, id, win) {
  const deadline = Date.now() + 180000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 2000));
    let data;
    try { data = await status(userId, id); } catch { continue; }
    if (data?.linked) { closeQuietly(win); return data.connections; }
    // A closed window usually means they gave up, but they may also have
    // closed it a second after consenting. Ask once more before believing it.
    if (win.closed) {
      await new Promise((r) => setTimeout(r, 1500));
      const late = await status(userId, id).catch(() => null);
      if (late?.linked) return late.connections;
      throw new Error('sign-in cancelled - click to retry');
    }
  }
  closeQuietly(win);
  throw new Error('timed out - click to retry');
}

/**
 * Link one account. Call it directly from a click handler.
 * @param {(msg: string) => void} [onStatus] progress text for the button
 * @returns {Promise<object>} the world's connections afterwards
 */
export async function connectAccount(userId, id, onStatus) {
  const win = window.open('', 'connect-' + id, 'width=520,height=700');
  if (!win) throw new Error('allow pop-ups for this site, then click again');
  win.document.write(
    '<title>Connecting</title><body style="margin:0;display:grid;place-items:center;'
    + 'height:100vh;background:#14121a;color:#e8e4f0;font:14px ui-monospace,monospace">'
    + 'Opening sign-in...</body>',
  );
  onStatus?.('connecting...');
  try {
    const res = await fetch('/api/connect', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId, connector: id, linked: true }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error ?? 'Could not connect.');
    if (!data.pending) { closeQuietly(win); return data.connections; }   // nothing to consent to
    win.location.href = data.authorizationUrl;
    onStatus?.('waiting for sign-in...');
    return await pollConsent(userId, id, win);
  } catch (err) {
    closeQuietly(win);
    throw err;
  }
}
