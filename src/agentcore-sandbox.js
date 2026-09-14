/**
 * A Strands `Sandbox` backed by AWS Bedrock AgentCore Code Interpreter.
 *
 * Each session is a dedicated microVM (2 vCPU / 8 GB / 10 GB disk, Python
 * 3.12 on ARM64 Amazon Linux) with ~200 packages preinstalled - reportlab,
 * python-pptx, python-docx, openpyxl, Pillow, pandas, matplotlib - so the
 * agent can produce real documents without installing anything.
 *
 * Implementing the six abstract methods is all it takes: the SDK's vended
 * `shell` and `file-editor` tools route their I/O through whatever sandbox
 * the agent is given, so they start working against the VM unchanged.
 *
 * Two things about the file API that are easy to get wrong:
 *  - Paths are relative to the session's working directory. Absolute paths
 *    like /tmp/out.pdf are rejected as "potential path traversal", even
 *    though code running inside the VM can write there perfectly well.
 *  - Binary comes back on `resource.blob`, text on `text`. A plain `data`
 *    field is not populated.
 */
import { Sandbox } from '@strands-agents/sdk/sandbox';
import { makeShell } from '@strands-agents/sdk/vended-tools/shell';

const CODE_INTERPRETER_ID = process.env.CODE_INTERPRETER_ID || 'aws.codeinterpreter.v1';
const REGION = process.env.AWS_REGION || 'us-east-1';
/** AWS default is 900s. Long enough for a task, short enough not to bill for idle. */
const SESSION_TTL = Number(process.env.SANDBOX_TTL_SECONDS || 900);

/** Languages the service accepts, mapped from what a model is likely to say. */
const LANGUAGES = {
  python: 'python', py: 'python', python3: 'python',
  javascript: 'nodejs', js: 'nodejs', node: 'nodejs', nodejs: 'nodejs',
  typescript: 'nodejs', ts: 'nodejs',
};

export class AgentCoreSandbox extends Sandbox {
  /**
   * @param {object} [options]
   * @param {string} [options.label]  shows up in the AWS console session list
   */
  constructor({ label = 'agent' } = {}) {
    super();
    this._label = label;
    this._client = null;
    this._sessionId = null;
    this._starting = null;
  }

  /** True once a microVM is actually running. Checking this avoids starting one. */
  get started() { return Boolean(this._sessionId); }

  /**
   * Tools the agent gets once this sandbox is attached. The base class vends
   * nothing, so without this override the agent holds a sandbox it cannot reach.
   *
   * `fileEditor` is deliberately left out. It validates that paths are
   * ABSOLUTE, while the AgentCore file API rejects absolute paths as
   * "potential path traversal" - the two conventions cannot both be satisfied,
   * and the agent ends up erroring once before falling back to the shell
   * anyway. A shell with heredocs covers the same ground without the confusion.
   */
  getTools() {
    return [makeShell(this)];
  }

  async _sdk() {
    if (!this._client) {
      const { BedrockAgentCoreClient } = await import('@aws-sdk/client-bedrock-agentcore');
      this._client = new BedrockAgentCoreClient({ region: REGION });
    }
    return this._client;
  }

  /** Sessions are started lazily, so an agent that never touches a file costs nothing. */
  async _session() {
    if (this._sessionId) return this._sessionId;
    // Concurrent tool calls must not race into two sessions.
    if (this._starting) return this._starting;

    this._starting = (async () => {
      const client = await this._sdk();
      const { StartCodeInterpreterSessionCommand } = await import('@aws-sdk/client-bedrock-agentcore');
      const out = await client.send(new StartCodeInterpreterSessionCommand({
        codeInterpreterIdentifier: CODE_INTERPRETER_ID,
        name: `${this._label}-${Date.now()}`.slice(0, 100),
        sessionTimeoutSeconds: SESSION_TTL,
      }));
      this._sessionId = out.sessionId;
      console.log(`sandbox: session ${this._sessionId} started`);
      return this._sessionId;
    })();

    try { return await this._starting; } finally { this._starting = null; }
  }

  /**
   * One InvokeCodeInterpreter round trip, collapsed to blocks + structured output.
   *
   * Sessions have a flat wall-clock TTL with no idle extension, so a long
   * conversation will outlive one. Rather than failing the tool call, start a
   * fresh VM and retry once - the agent just sees an empty workspace.
   */
  async _invoke(name, args, retrying = false) {
    const sessionId = await this._session();
    const client = await this._sdk();
    const { InvokeCodeInterpreterCommand } = await import('@aws-sdk/client-bedrock-agentcore');
    const out = await client.send(new InvokeCodeInterpreterCommand({
      codeInterpreterIdentifier: CODE_INTERPRETER_ID,
      sessionId,
      name,
      arguments: args,
    })).catch(async (err) => {
      // Deliberately narrow: a plain ValidationException usually means bad
      // arguments, and restarting the VM on those silently wipes the workspace
      // mid-task.
      const gone = /ResourceNotFoundException|session (?:not found|has expired|is expired)|InvalidSessionException/i
        .test(`${err?.name} ${err?.message}`);
      if (gone && !retrying) {
        console.warn(`sandbox: session ${sessionId} is gone, starting a new one`);
        this._sessionId = null;
        return null;
      }
      throw err;
    });
    if (!out) return this._invoke(name, args, true);

    const blocks = [];
    let structured = null;
    let isError = false;
    for await (const chunk of out.stream ?? []) {
      const r = chunk.result;
      if (!r) continue;
      if (r.isError) isError = true;
      if (r.structuredContent) structured = r.structuredContent;
      for (const b of r.content ?? []) blocks.push(b);
    }
    return { blocks, structured, isError };
  }

  /** Turns a completed invocation into the shape Strands expects. */
  static _toResult({ blocks, structured, isError }) {
    const text = blocks.filter((b) => b.type === 'text').map((b) => b.text ?? '').join('');
    const stdout = structured?.stdout ?? (isError ? '' : text);
    const stderr = structured?.stderr ?? (isError ? text : '');
    return {
      type: 'executionResult',
      exitCode: structured?.exitCode ?? (isError ? 1 : 0),
      stdout: stdout ?? '',
      stderr: stderr ?? '',
      outputFiles: [],
    };
  }

  /**
   * The service returns a whole invocation at once rather than incremental
   * output, so the "stream" is one chunk of stdout then the result. Callers
   * that only use `execute()`/`executeCode()` never notice.
   */
  async *executeStreaming(command, options = {}) {
    const raw = await this._invoke('executeCommand', {
      command,
      ...(options.timeout ? { timeoutSeconds: Math.ceil(options.timeout / 1000) } : {}),
    });
    const result = AgentCoreSandbox._toResult(raw);
    if (result.stdout) yield { type: 'streamChunk', data: result.stdout, streamType: 'stdout' };
    if (result.stderr) yield { type: 'streamChunk', data: result.stderr, streamType: 'stderr' };
    yield result;
  }

  async *executeCodeStreaming(code, language = 'python', options = {}) {
    const runtime = LANGUAGES[String(language).toLowerCase()] ?? 'python';
    const raw = await this._invoke('executeCode', {
      code,
      language: runtime,
      ...(options.timeout ? { timeoutSeconds: Math.ceil(options.timeout / 1000) } : {}),
    });
    const result = AgentCoreSandbox._toResult(raw);
    if (result.stdout) yield { type: 'streamChunk', data: result.stdout, streamType: 'stdout' };
    if (result.stderr) yield { type: 'streamChunk', data: result.stderr, streamType: 'stderr' };
    yield result;
  }

  /** The file API is rooted at the session's working directory. */
  static _rel(path) {
    return String(path ?? '').replace(/^\/+/, '');
  }

  async readFile(path) {
    const { blocks } = await this._invoke('readFiles', { paths: [AgentCoreSandbox._rel(path)] });
    for (const b of blocks) {
      const res = b.resource ?? b;
      const bytes = res.blob ?? res.data;
      if (bytes) return bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
      if (typeof res.text === 'string' && b.type !== 'text') return new TextEncoder().encode(res.text);
    }
    // A lone plain-text block here is the service reporting an error.
    const message = blocks.find((b) => b.type === 'text')?.text ?? 'unknown error';
    throw new Error(`readFile(${path}) failed: ${message}`);
  }

  async writeFile(path, content) {
    const rel = AgentCoreSandbox._rel(path);
    const bytes = content instanceof Uint8Array ? content : new Uint8Array(content);
    // The API takes text or a blob; sending text where possible keeps payloads small.
    let entry;
    try {
      const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      entry = { path: rel, text };
    } catch {
      entry = { path: rel, blob: bytes };
    }
    const { blocks, isError } = await this._invoke('writeFiles', { content: [entry] });
    if (isError) throw new Error(`writeFile(${path}) failed: ${blocks[0]?.text ?? 'unknown error'}`);
  }

  async removeFile(path) {
    const { blocks, isError } = await this._invoke('removeFiles', { paths: [AgentCoreSandbox._rel(path)] });
    if (isError) throw new Error(`removeFile(${path}) failed: ${blocks[0]?.text ?? 'unknown error'}`);
  }

  async listFiles(path = '') {
    const { blocks } = await this._invoke('listFiles', { path: AgentCoreSandbox._rel(path) });
    return blocks
      .filter((b) => b.type === 'resource_link' || b.uri || b.name)
      .map((b) => ({
        name: b.name ?? String(b.uri ?? '').split('/').pop() ?? '',
        isDir: /director/i.test(b.description ?? ''),
        size: b.size,
      }))
      .filter((f) => f.name);
  }

  /** Stops the microVM. Billing is per second, so call this when a task ends. */
  async close() {
    if (!this._sessionId) return;
    const sessionId = this._sessionId;
    this._sessionId = null;
    try {
      const client = await this._sdk();
      const { StopCodeInterpreterSessionCommand } = await import('@aws-sdk/client-bedrock-agentcore');
      await client.send(new StopCodeInterpreterSessionCommand({
        codeInterpreterIdentifier: CODE_INTERPRETER_ID,
        sessionId,
      }));
      console.log(`sandbox: session ${sessionId} stopped`);
    } catch (err) {
      console.warn(`sandbox: could not stop ${sessionId} -`, err.message);
    }
  }
}
