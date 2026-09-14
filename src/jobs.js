/**
 * Jobs: runs nobody is watching.
 *
 * A job is one unattended run of the boss agent - started by a routine, a
 * trigger, or a person who said "do this in the background". Its id doubles
 * as the chat id the transcript is filed under, so every job is also an
 * ordinary chat in HISTORY with the whole conversation in it.
 *
 * Table `my-agent-jobs`: partition key userId, sort key jobId. Job ids start
 * with a base-36 timestamp so the sort key is also time order.
 *
 *   status: running | needs_approval | done | failed | skipped
 */
const TABLE = process.env.JOBS_TABLE || 'my-agent-jobs';
const REGION = process.env.AWS_REGION || 'us-east-1';

let docClient = null;
async function client() {
  if (docClient) return docClient;
  const { DynamoDBClient } = await import('@aws-sdk/client-dynamodb');
  const { DynamoDBDocumentClient } = await import('@aws-sdk/lib-dynamodb');
  docClient = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }), {
    marshallOptions: { removeUndefinedValues: true },
  });
  return docClient;
}

export const isJobId = (id) => /^job-[a-z0-9]{6,12}-[a-z0-9]{4,8}$/.test(String(id ?? ''));

export function newJobId() {
  return `job-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** A short title for lists: the first line of the prompt. */
const titleOf = (prompt) => {
  const t = String(prompt ?? '').trim().split('\n')[0].replace(/\s+/g, ' ');
  return t.length > 70 ? `${t.slice(0, 67)}...` : t || 'Untitled job';
};

/**
 * @param {object} j
 * @param {string} j.userId
 * @param {string} j.prompt
 * @param {'manual'|'routine'|'trigger'} j.source
 * @param {string} [j.routineId]
 * @param {string} [j.routineName]
 */
export async function createJob({ userId, prompt, source = 'manual', routineId, routineName, jobId = newJobId() }) {
  const db = await client();
  const { PutCommand } = await import('@aws-sdk/lib-dynamodb');
  const job = {
    userId, jobId,
    title: routineName ? `${routineName}: ${titleOf(prompt)}` : titleOf(prompt),
    prompt, source, routineId, status: 'running',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  await db.send(new PutCommand({ TableName: TABLE, Item: job }));
  return job;
}

export async function updateJob(userId, jobId, patch) {
  const db = await client();
  const { UpdateCommand } = await import('@aws-sdk/lib-dynamodb');
  const names = {}, values = {}, sets = [];
  Object.entries({ ...patch, updatedAt: new Date().toISOString() }).forEach(([k, v], n) => {
    if (v === undefined) return;
    names[`#k${n}`] = k; values[`:v${n}`] = v; sets.push(`#k${n} = :v${n}`);
  });
  await db.send(new UpdateCommand({
    TableName: TABLE, Key: { userId, jobId },
    UpdateExpression: 'SET ' + sets.join(', '),
    ExpressionAttributeNames: names, ExpressionAttributeValues: values,
  }));
}

export async function getJob(userId, jobId) {
  const db = await client();
  const { GetCommand } = await import('@aws-sdk/lib-dynamodb');
  const out = await db.send(new GetCommand({ TableName: TABLE, Key: { userId, jobId }, ConsistentRead: true }));
  return out.Item ?? null;
}

/** Newest first. */
export async function listJobs(userId, limit = 30) {
  const db = await client();
  const { QueryCommand } = await import('@aws-sdk/lib-dynamodb');
  const out = await db.send(new QueryCommand({
    TableName: TABLE,
    KeyConditionExpression: 'userId = :u',
    ExpressionAttributeValues: { ':u': userId },
    ScanIndexForward: false,
    Limit: limit,
  }));
  return out.Items ?? [];
}

export async function deleteJob(userId, jobId) {
  const db = await client();
  const { DeleteCommand } = await import('@aws-sdk/lib-dynamodb');
  await db.send(new DeleteCommand({ TableName: TABLE, Key: { userId, jobId } }));
}
