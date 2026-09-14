/**
 * Getting files out of the sandbox and in front of the user.
 *
 * The sandbox lives beside the agent inside AgentCore; the browser talks to
 * App Runner. Rather than pushing bytes back through the event stream (SSE
 * plus base64, against a 100 MB payload cap), finished files go to S3 and the
 * stream carries a presigned URL. Telegram gets the same URL.
 *
 * Nothing here is durable storage: the bucket expires objects after 7 days.
 */
import { extname } from 'node:path';
import * as library from './library.js';

const BUCKET = process.env.ARTIFACT_BUCKET || '';
const REGION = process.env.AWS_REGION || 'us-east-1';
const URL_TTL_SECONDS = Number(process.env.ARTIFACT_URL_TTL || 24 * 60 * 60);

/**
 * Scratch the sandbox image ships with, plus anything the runtime writes for
 * itself. Without this every run would "produce" a dozen artifacts.
 */
const IGNORED = new Set([
  'node_modules', 'log', 'run', 'package.json', 'package-lock.json',
  '.ipython', 'nodejs-js-execution', 'nodejs-ts-execution', '.cache', '.config', '.local',
]);

/** Anything the image ships with, plus dotfiles, is scratch rather than output. */
const keep = (f) => !f.isDir && !IGNORED.has(f.name) && !f.name.startsWith('.');

/** Files the user asked for, not the scripts used to make them. */
const SCRIPT_EXTENSIONS = new Set(['.py', '.js', '.ts', '.sh']);

const MIME = {
  '.pdf': 'application/pdf',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.csv': 'text/csv',
  '.json': 'application/json',
  '.md': 'text/markdown',
  '.txt': 'text/plain',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.zip': 'application/zip',
  '.html': 'text/html',
};

export const mimeFor = (name) => MIME[extname(name).toLowerCase()] || 'application/octet-stream';

/** Names currently in the workspace root, minus the image's own scratch. */
export async function snapshot(workspace) {
  try {
    const files = await workspace.listFiles('');
    return new Set(files.filter((f) => keep(f)).map((f) => f.name));
  } catch {
    return new Set();
  }
}

let s3 = null;
async function client() {
  if (!s3) {
    const { S3Client } = await import('@aws-sdk/client-s3');
    s3 = new S3Client({ region: REGION });
  }
  return s3;
}

/**
 * Uploads one file's bytes and returns a link the browser can open directly.
 * Falls back to a data: URL when no bucket is configured, so local runs work
 * with no AWS setup - fine for the small files a demo produces.
 */
async function publish(name, bytes, sessionId) {
  const contentType = mimeFor(name);
  if (!BUCKET) {
    return `data:${contentType};base64,${Buffer.from(bytes).toString('base64')}`;
  }
  const key = `artifacts/${sessionId}/${Date.now()}-${name}`;
  const { PutObjectCommand, GetObjectCommand } = await import('@aws-sdk/client-s3');
  const { getSignedUrl } = await import('@aws-sdk/s3-request-presigner');
  const c = await client();
  await c.send(new PutObjectCommand({
    Bucket: BUCKET,
    Key: key,
    Body: Buffer.from(bytes),
    ContentType: contentType,
    // Makes the browser save it under a sensible name instead of the key.
    ContentDisposition: `attachment; filename="${name.replace(/"/g, '')}"`,
  }));
  return getSignedUrl(c, new GetObjectCommand({ Bucket: BUCKET, Key: key }), {
    expiresIn: URL_TTL_SECONDS,
  });
}

/**
 * Diffs the workspace against a snapshot and publishes whatever is new.
 *
 * @returns {Promise<Array<{name,size,mimeType,url}>>}
 */
export async function collectNew(workspace, before, sessionId = 'anon', userId = null) {
  if (!workspace) return [];
  let after;
  try {
    after = await workspace.listFiles('');
  } catch {
    return [];
  }

  const candidates = after
    .filter((f) => keep(f) && !before.has(f.name))
    .map((f) => f.name);

  // If the run produced a real deliverable, the helper script that built it is
  // noise. If all it produced was a script, that script IS the deliverable.
  const deliverables = candidates.filter((n) => !SCRIPT_EXTENSIONS.has(extname(n).toLowerCase()));
  const wanted = deliverables.length ? deliverables : candidates;

  const out = [];
  for (const name of wanted.slice(0, 8)) {
    try {
      const bytes = await workspace.readFile(name);
      // Finished documents are filed automatically. The user should not have
      // to think about saving, and the sandbox is wiped within minutes.
      if (userId && library.libraryEnabled()) {
        library.put(userId, name, bytes, mimeFor(name))
          .catch((err) => console.warn(`library: could not file ${name} -`, err.message));
      }
      out.push({
        name,
        size: bytes.length,
        mimeType: mimeFor(name),
        url: await publish(name, bytes, sessionId),
      });
    } catch (err) {
      console.warn(`artifacts: could not collect ${name} -`, err.message);
    }
  }
  return out;
}
