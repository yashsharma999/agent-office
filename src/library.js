/**
 * The agent's long-term filing cabinet.
 *
 * The sandbox is a desk: whatever is on it vanishes when the VM dies, which is
 * 15 minutes by default. Anything the user hands over, or the agent produces
 * and wants to keep, is filed in S3 instead and can be pulled back onto the
 * desk in a later conversation.
 *
 * Why S3 and not a mounted filesystem: mounting EFS or S3 Files into a Code
 * Interpreter requires `networkMode: VPC`, and VPC mode is mutually exclusive
 * with PUBLIC - which would cost the agent `pip install`. Copying files on and
 * off the desk keeps both.
 *
 * Layout:  library/<userId>/<filename>
 *
 * `userId` is stable across conversations - the browser's anonymous client id,
 * or tg-<chatId> on Telegram - so the cabinet follows the person, not the tab.
 * Swapping in a real identity later means changing what fills this one field.
 */
const BUCKET = process.env.ARTIFACT_BUCKET || '';
const REGION = process.env.AWS_REGION || 'us-east-1';
const MAX_FILES = 500;

let s3 = null;
async function client() {
  if (!s3) {
    const { S3Client } = await import('@aws-sdk/client-s3');
    s3 = new S3Client({ region: REGION });
  }
  return s3;
}

export const libraryEnabled = () => Boolean(BUCKET);

/** Keeps one user's files out of another's, and out of the artifacts prefix. */
function keyFor(userId, name) {
  const safeUser = String(userId || 'anon').replace(/[^\w.@-]/g, '_').slice(0, 96);
  const safeName = String(name).replace(/^.*[/\\]/, '').replace(/[^\w.\- ]/g, '_').slice(0, 120);
  if (!safeName) throw new Error('A filename is required.');
  return { key: `library/${safeUser}/${safeName}`, name: safeName };
}

/** @returns {Promise<Array<{name, size, updated}>>} */
export async function list(userId) {
  if (!BUCKET) return [];
  const { ListObjectsV2Command } = await import('@aws-sdk/client-s3');
  const { key: prefix } = keyFor(userId, 'x');
  const dir = prefix.replace(/[^/]+$/, '');
  const out = await (await client()).send(new ListObjectsV2Command({
    Bucket: BUCKET, Prefix: dir, MaxKeys: MAX_FILES,
  }));
  return (out.Contents ?? [])
    .map((o) => ({
      name: o.Key.slice(dir.length),
      size: o.Size,
      updated: o.LastModified?.toISOString?.().slice(0, 10),
    }))
    .filter((f) => f.name)
    .sort((a, b) => (a.updated < b.updated ? 1 : -1));
}

export async function put(userId, name, bytes, contentType = 'application/octet-stream') {
  if (!BUCKET) throw new Error('No library bucket configured.');
  const { PutObjectCommand } = await import('@aws-sdk/client-s3');
  const { key, name: safeName } = keyFor(userId, name);
  await (await client()).send(new PutObjectCommand({
    Bucket: BUCKET,
    Key: key,
    Body: Buffer.from(bytes),
    ContentType: contentType,
    ContentDisposition: `attachment; filename="${safeName}"`,
  }));
  return safeName;
}

export async function get(userId, name) {
  if (!BUCKET) throw new Error('No library bucket configured.');
  const { GetObjectCommand } = await import('@aws-sdk/client-s3');
  const { key } = keyFor(userId, name);
  const out = await (await client()).send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
  return new Uint8Array(await out.Body.transformToByteArray());
}

export async function remove(userId, name) {
  if (!BUCKET) return;
  const { DeleteObjectCommand } = await import('@aws-sdk/client-s3');
  const { key } = keyFor(userId, name);
  await (await client()).send(new DeleteObjectCommand({ Bucket: BUCKET, Key: key }));
}
