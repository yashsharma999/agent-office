/**
 * A real Chrome, in the cloud, that the agent can drive.
 *
 * AgentCore Browser gives each session a headless Chrome in its own microVM
 * and exposes two WebSockets: an automation stream that speaks genuine Chrome
 * DevTools Protocol, and a live-view stream.
 *
 * The automation stream needs SigV4. Node's built-in WebSocket cannot send
 * custom headers, so the signature goes in the query string instead
 * (`presign`) - which means no `ws` package and no Playwright, just CDP
 * messages over the native client.
 *
 * Screenshots never enter a tool result - a base64 image in the model's
 * context would cost a fortune in tokens. They travel on their own event to
 * the UI, which paints them onto the monitor in the room. They are sent
 * inline as JPEG data URLs: frames are ephemeral, a few tens of kilobytes
 * each, and going via S3 would add a round trip, CORS, and a pile of objects
 * nobody ever reads.
 */
import { SignatureV4 } from '@smithy/signature-v4';
import { defaultProvider } from '@aws-sdk/credential-provider-node';
import { Sha256 } from '@aws-crypto/sha256-js';

const BROWSER_ID = process.env.BROWSER_ID || 'aws.browser.v1';
const REGION = process.env.AWS_REGION || 'us-east-1';
const SESSION_TTL = Number(process.env.BROWSER_TTL_SECONDS || 900);
const NAV_TIMEOUT_MS = 25_000;

export class CloudBrowser {
  constructor({ label = 'agent' } = {}) {
    this._label = label;
    this._sessionId = null;
    this._ws = null;
    this._target = null;      // CDP session id for the attached page
    this._nextId = 0;
    this._pending = new Map();
    this._starting = null;
    this._capturing = false;
    /** Serialises navigations: there is one tab, so two at once clobber each other. */
    this._queue = Promise.resolve();
    /** Latest screenshot URL, picked up by the event stream and shown in the UI. */
    this._frame = null;
  }

  get started() { return Boolean(this._sessionId); }

  /** Hands over the newest frame exactly once, so it is not re-sent every turn. */
  takeFrame() {
    const f = this._frame;
    this._frame = null;
    return f;
  }

  // ------------------------------------------------------------- lifecycle
  async _start() {
    if (this._ws) return;
    if (this._starting) return this._starting;

    this._starting = (async () => {
      const { BedrockAgentCoreClient, StartBrowserSessionCommand } =
        await import('@aws-sdk/client-bedrock-agentcore');
      const client = new BedrockAgentCoreClient({ region: REGION });
      const out = await client.send(new StartBrowserSessionCommand({
        browserIdentifier: BROWSER_ID,
        name: `${this._label}-${Date.now()}`.slice(0, 100),
        sessionTimeoutSeconds: SESSION_TTL,
      }));
      this._sessionId = out.sessionId;
      console.log(`browser: session ${this._sessionId} started`);

      await this._connect();
      await this._attach();
    })();

    try { return await this._starting; } finally { this._starting = null; }
  }

  async _signedUrl() {
    const host = `bedrock-agentcore.${REGION}.amazonaws.com`;
    const path = `/browser-streams/${BROWSER_ID}/sessions/${this._sessionId}/automation`;
    const signer = new SignatureV4({
      service: 'bedrock-agentcore',
      region: REGION,
      credentials: defaultProvider(),
      sha256: Sha256,
    });
    const signed = await signer.presign(
      { method: 'GET', protocol: 'https:', hostname: host, path, query: {}, headers: { host } },
      { expiresIn: 300 },
    );
    return `wss://${host}${path}?${new URLSearchParams(signed.query)}`;
  }

  _connect() {
    return new Promise(async (resolve, reject) => {
      const ws = new WebSocket(await this._signedUrl());
      const fail = (e) => reject(new Error(`browser socket failed: ${e?.message ?? 'unknown'}`));
      ws.onopen = () => { this._ws = ws; resolve(); };
      ws.onerror = fail;
      ws.onclose = () => { this._ws = null; this._target = null; };
      ws.onmessage = (e) => {
        let msg;
        try { msg = JSON.parse(e.data); } catch { return; }
        const waiter = msg.id && this._pending.get(msg.id);
        if (!waiter) return;
        this._pending.delete(msg.id);
        msg.error ? waiter.reject(new Error(msg.error.message)) : waiter.resolve(msg.result);
      };
    });
  }

  /** Finds the page tab and attaches, so later commands can target it. */
  async _attach() {
    const { targetInfos } = await this._send('Target.getTargets');
    const page = targetInfos.find((t) => t.type === 'page');
    if (!page) throw new Error('No page target in the browser session.');
    const { sessionId } = await this._send('Target.attachToTarget', {
      targetId: page.targetId, flatten: true,
    });
    this._target = sessionId;
    await this._send('Page.enable', {}, this._target);
  }

  _send(method, params = {}, sessionId = undefined) {
    if (!this._ws) return Promise.reject(new Error('Browser socket is not open.'));
    const id = ++this._nextId;
    return new Promise((resolve, reject) => {
      this._pending.set(id, { resolve, reject });
      this._ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
      setTimeout(() => {
        if (this._pending.delete(id)) reject(new Error(`${method} timed out`));
      }, NAV_TIMEOUT_MS);
    });
  }

  // ----------------------------------------------------------------- verbs
  /**
   * Goes to a URL and waits for the page to settle.
   *
   * Serialised. A model will happily fire two browse calls in the same turn,
   * and with a single tab the second navigation lands on top of the first -
   * both then read whichever page won the race.
   */
  goto(url) {
    const run = this._queue.then(async () => {
      await this._start();
      const target = url.startsWith('http') ? url : `https://${url}`;
      await this._send('Page.navigate', { url: target }, this._target);
      // No load event fires reliably on every site; a short settle is enough
      // for the text extraction and keeps a bad page from hanging a turn.
      await new Promise((r) => setTimeout(r, 2500));
      return target;
    });
    // Keep the chain alive even when a navigation fails.
    this._queue = run.then(() => {}, () => {});
    return run;
  }

  /** Visible text, trimmed to something a model can actually read. */
  async text(maxChars = 6000) {
    const { result } = await this._send('Runtime.evaluate', {
      expression: 'document.body ? document.body.innerText : ""',
      returnByValue: true,
    }, this._target);
    const raw = String(result?.value ?? '').replace(/\n{3,}/g, '\n\n').trim();
    return raw.length > maxChars ? `${raw.slice(0, maxChars)}\n...[truncated]` : raw;
  }

  async title() {
    const { result } = await this._send('Runtime.evaluate', {
      expression: 'document.title', returnByValue: true,
    }, this._target);
    return String(result?.value ?? '');
  }

  /**
   * Captures the viewport and parks it on the session for the event stream.
   *
   * JPEG rather than PNG: a page screenshot compresses to roughly a third the
   * size, which matters when these stream once a second.
   */
  async capture() {
    if (this._capturing || !this._ws) return null;
    this._capturing = true;
    try {
      const { data } = await this._send(
        'Page.captureScreenshot',
        { format: 'jpeg', quality: 55 },
        this._target,
      );
      if (!data) return null;
      this._frame = `data:image/jpeg;base64,${data}`;
      return this._frame;
    } catch {
      // A capture racing a navigation is normal; drop it and try again later.
      return null;
    } finally {
      this._capturing = false;
    /** Serialises navigations: there is one tab, so two at once clobber each other. */
    this._queue = Promise.resolve();
    }
  }

  /** Stops the browser microVM. It bills per second while alive. */
  async close() {
    const sessionId = this._sessionId;
    this._sessionId = null;
    try { this._ws?.close(); } catch { /* already gone */ }
    this._ws = null;
    this._target = null;
    if (!sessionId) return;
    try {
      const { BedrockAgentCoreClient, StopBrowserSessionCommand } =
        await import('@aws-sdk/client-bedrock-agentcore');
      await new BedrockAgentCoreClient({ region: REGION })
        .send(new StopBrowserSessionCommand({ browserIdentifier: BROWSER_ID, sessionId }));
      console.log(`browser: session ${sessionId} stopped`);
    } catch (err) {
      console.warn(`browser: could not stop ${sessionId} -`, err.message);
    }
  }
}
