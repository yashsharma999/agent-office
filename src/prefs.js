/**
 * Per-viewer preferences, stored in DynamoDB.
 *
 * There is no login, so a viewer is identified by an anonymous id the browser
 * generates once and keeps in localStorage. That is enough to remember a theme
 * across reloads and devices-with-the-same-browser, and it means the data is
 * server-side rather than trapped in one browser.
 *
 * Every call degrades gracefully: with no table or no credentials the API
 * reports `stored: false` and the browser falls back to localStorage, so
 * local development needs no AWS at all.
 */
const TABLE = process.env.PREFS_TABLE || 'my-agent-prefs';
const REGION = process.env.AWS_REGION || 'us-east-1';

let docClient = null;
let unavailable = false;

async function client() {
  if (unavailable) return null;
  if (docClient) return docClient;
  try {
    const { DynamoDBClient } = await import('@aws-sdk/client-dynamodb');
    const { DynamoDBDocumentClient } = await import('@aws-sdk/lib-dynamodb');
    docClient = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }), {
      // Optional fields are simply absent, not a marshalling error.
      marshallOptions: { removeUndefinedValues: true },
    });
    return docClient;
  } catch (err) {
    console.warn('prefs: DynamoDB client unavailable -', err.message);
    unavailable = true;
    return null;
  }
}

/**
 * @returns {Promise<{prefs: object|null, stored: boolean, failed: boolean}>}
 *
 * `failed` matters: a read that errored is NOT the same as a user with no
 * data, and callers that conflate them tell people to build an agent they
 * already have.
 */
export async function readPrefs(clientId) {
  const db = await client();
  if (!db || !clientId) return { prefs: null, stored: false, failed: false };
  try {
    const { GetCommand } = await import('@aws-sdk/lib-dynamodb');
    const out = await db.send(new GetCommand({
      TableName: TABLE,
      Key: { clientId },
      // The roster is read immediately after being written, and an eventually
      // consistent read can still be showing the previous item.
      ConsistentRead: true,
    }));
    return { prefs: out.Item ?? null, stored: true, failed: false };
  } catch (err) {
    console.warn('prefs: read failed -', err.message);
    return { prefs: null, stored: false, failed: true };
  }
}

/**
 * Merges `prefs` into the viewer's record. Keys not mentioned are left alone.
 *
 * This used to be a whole-item Put, and the theme route wrote `{theme}` - so
 * changing the room's look deleted the user's agents and unlinked their
 * accounts. Several things share this one record; a write must only ever
 * touch what it was given.
 *
 * @returns {Promise<{stored: boolean}>}
 */
export async function writePrefs(clientId, prefs) {
  const db = await client();
  if (!db || !clientId) return { stored: false };
  const names = {}, values = {}, sets = [];
  Object.entries({ ...prefs, updatedAt: new Date().toISOString() }).forEach(([k, v], n) => {
    if (v === undefined) return;
    names[`#k${n}`] = k;
    values[`:v${n}`] = v;
    sets.push(`#k${n} = :v${n}`);
  });
  try {
    const { UpdateCommand } = await import('@aws-sdk/lib-dynamodb');
    await db.send(new UpdateCommand({
      TableName: TABLE,
      Key: { clientId },
      UpdateExpression: 'SET ' + sets.join(', '),
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: values,
    }));
    return { stored: true };
  } catch (err) {
    console.warn('prefs: write failed -', err.message);
    return { stored: false };
  }
}

/**
 * Atomically adds to numeric fields on a record, creating it if needed. For
 * counters: two turns finishing together must both count.
 */
export async function addCounters(clientId, counters) {
  const db = await client();
  if (!db || !clientId) return { stored: false };
  const names = {}, values = {}, adds = [];
  Object.entries(counters).forEach(([k, v], n) => {
    if (!Number.isFinite(v) || v === 0) return;
    names[`#k${n}`] = k;
    values[`:v${n}`] = v;
    adds.push(`#k${n} :v${n}`);
  });
  if (!adds.length) return { stored: true };
  names['#u'] = 'updatedAt';
  values[':u'] = new Date().toISOString();
  const { UpdateCommand } = await import('@aws-sdk/lib-dynamodb');
  await db.send(new UpdateCommand({
    TableName: TABLE,
    Key: { clientId },
    UpdateExpression: `ADD ${adds.join(', ')} SET #u = :u`,
    ExpressionAttributeNames: names,
    ExpressionAttributeValues: values,
  }));
  return { stored: true };
}
