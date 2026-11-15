import { cloudflareKey } from './credentials.mjs';
import { requestJson } from './http.mjs';
import { freshValue, number } from './model.mjs';

export const QUERY = `query OpsUsage($account: string!, $day: Date!, $month: Date!) {
 viewer { accounts(filter: {accountTag: $account}) {
  workersInvocationsAdaptive(limit:1000,filter:{date:$day}) { sum {requests errors} quantiles {cpuTimeP99} dimensions {scriptName} }
  d1AnalyticsAdaptiveGroups(limit:1000,filter:{date:$day}) {sum {rowsRead rowsWritten} dimensions {databaseId} }
  d1StorageAdaptiveGroups(limit:1000,filter:{date:$day}) {max {databaseSizeBytes} dimensions {databaseId} }
  kvOperationsAdaptiveGroups(limit:1000,filter:{date:$day}) {sum {requests} dimensions {namespaceId actionType} }
  kvStorageAdaptiveGroups(limit:1000,filter:{date:$day}) {max {byteCount} dimensions {namespaceId} }
  r2OperationsAdaptiveGroups(limit:1000,filter:{date_geq:$month,date_leq:$day}) {sum {requests} dimensions {bucketName actionType} }
  r2StorageAdaptiveGroups(limit:1000,filter:{date:$day}) {max {payloadSize metadataSize} dimensions {bucketName} }
 } }
}`;

// Pricing enumerates all 15 Class A, 8 Class B and 3 free operations:
// https://developers.cloudflare.com/r2/pricing/#class-a-operations
const classA = new Set([
  'ListBuckets', 'PutBucket', 'ListObjects', 'PutObject', 'CopyObject',
  'CompleteMultipartUpload', 'CreateMultipartUpload', 'LifecycleStorageTierTransition',
  'ListMultipartUploads', 'UploadPart', 'UploadPartCopy', 'ListParts',
  'PutBucketEncryption', 'PutBucketCors', 'PutBucketLifecycleConfiguration',
]);
const classB = new Set([
  'HeadBucket', 'HeadObject', 'GetObject', 'UsageSummary', 'GetBucketEncryption',
  'GetBucketLocation', 'GetBucketCors', 'GetBucketLifecycleConfiguration',
  // [INFERENCE] Configuration reads follow Class B's read-existing-state basis;
  // pricing does not enumerate these two names. Official GET semantics:
  // https://developers.cloudflare.com/api/resources/r2/subresources/buckets/subresources/event_notifications/methods/list/
  // https://developers.cloudflare.com/api/resources/r2/subresources/buckets/subresources/sippy/methods/get/
  'GetBucketNotificationConfiguration', 'GetBucketSippyConfiguration',
]);
const free = new Set(['DeleteObject', 'DeleteBucket', 'AbortMultipartUpload']);

function groups(account, name) {
  const result = account[name];
  if (!Array.isArray(result) || result.length === 0) throw new Error('empty_dataset');
  if (result.length >= 1000) throw new Error('truncated_dataset');
  return result;
}
function sum(rows, field, section = 'sum') {
  return rows.reduce((total, row) => total + number(row[section]?.[field]), 0);
}

export async function collectCloudflare(key, fetchImpl, now) {
  cloudflareKey(key);
  const day = new Date(now).toISOString().slice(0, 10);
  const body = await requestJson(fetchImpl, 'https://api.cloudflare.com/client/v4/graphql', {
    method: 'POST', headers: { Authorization: `Bearer ${key.apiToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: QUERY, variables: { account: key.accountId, day, month: `${day.slice(0, 7)}-01` } }),
  });
  if (body.errors?.length) throw new Error('graphql_failed');
  const account = body.data?.viewer?.accounts?.[0];
  if (!account) throw new Error('empty_response');
  const values = {};
  const put = (id, value, extra) => { values[id] = freshValue(value, now, extra); };
  const issues = {};
  // A dataset unavailable on this plan must not erase unrelated successful datasets.
  const section = (ids, fn) => { try { fn(); } catch { for (const id of ids) issues[id] = 'dataset_unavailable'; } };
  section(['cf.requests', 'cf.errors', 'cf.cpu_p99_max'], () => {
    const data = groups(account, 'workersInvocationsAdaptive');
    put('cf.requests', sum(data, 'requests')); put('cf.errors', sum(data, 'errors'));
    put('cf.cpu_p99_max', Math.max(...data.map(row => number(row.quantiles?.cpuTimeP99))) / 1000);
  });
  section(['cf.d1.read', 'cf.d1.write'], () => {
    const data = groups(account, 'd1AnalyticsAdaptiveGroups');
    put('cf.d1.read', sum(data, 'rowsRead')); put('cf.d1.write', sum(data, 'rowsWritten'));
  });
  section(['cf.d1.storage', 'cf.d1.largest'], () => {
    const data = groups(account, 'd1StorageAdaptiveGroups');
    put('cf.d1.storage', sum(data, 'databaseSizeBytes', 'max'));
    put('cf.d1.largest', Math.max(...data.map(row => number(row.max?.databaseSizeBytes))));
  });
  section(['cf.kv.read', 'cf.kv.write', 'cf.kv.delete', 'cf.kv.list'], () => {
    const data = groups(account, 'kvOperationsAdaptiveGroups');
    for (const type of ['read', 'write', 'delete', 'list']) {
      const selected = data.filter(row => row.dimensions?.actionType?.toLowerCase() === type);
      // An omitted operation is unknown; only an explicit provider zero is zero.
      if (selected.length) put(`cf.kv.${type}`, sum(selected, 'requests'));
      else issues[`cf.kv.${type}`] = 'empty_dataset';
    }
  });
  section(['cf.kv.storage'], () => put('cf.kv.storage', sum(groups(account, 'kvStorageAdaptiveGroups'), 'byteCount', 'max')));
  section(['cf.r2.a', 'cf.r2.b'], () => {
    const totals = { a: 0, b: 0 }; const seen = new Set();
    let unclassifiedRequests = null;
    for (const row of groups(account, 'r2OperationsAdaptiveGroups')) {
      const type = row.dimensions?.actionType;
      const count = number(row.sum?.requests);
      if (!Number.isSafeInteger(count)) throw new Error('invalid_number');
      if (classA.has(type)) { totals.a += count; seen.add('a'); }
      else if (classB.has(type)) { totals.b += count; seen.add('b'); }
      else if (!free.has(type)) unclassifiedRequests = (unclassifiedRequests ?? 0) + count;
    }
    if (unclassifiedRequests !== null && !Number.isSafeInteger(unclassifiedRequests)) throw new Error('invalid_number');
    const reasonDetail = unclassifiedRequests === null ? null : `r2_unclassified_operations:${unclassifiedRequests}`;
    for (const type of ['a', 'b']) {
      if (seen.has(type)) put(`cf.r2.${type}`, totals[type], { reasonDetail });
      else issues[`cf.r2.${type}`] = reasonDetail ?? 'empty_dataset';
    }
  });
  section(['cf.r2.storage'], () => {
    const data = groups(account, 'r2StorageAdaptiveGroups');
    put('cf.r2.storage', sum(data, 'payloadSize', 'max') + sum(data, 'metadataSize', 'max'));
  });
  return { values, issues };
}
