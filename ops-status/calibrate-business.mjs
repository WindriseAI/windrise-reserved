import { requestJson } from './http.mjs';
import { number } from './model.mjs';
export const TABLE_SIZES_SQL = 'SELECT (SELECT COUNT(*) FROM devices) AS devices, (SELECT COUNT(*) FROM gateway_usage) AS gateway_usage, (SELECT COUNT(*) FROM users) AS users, (SELECT COUNT(*) FROM account_entitlements) AS account_entitlements, (SELECT COUNT(*) FROM control_accounts) AS control_accounts';
export async function calibrateBusiness(key, fetchImpl, accountRows) {
  const body = await requestJson(fetchImpl, `https://api.cloudflare.com/client/v4/accounts/${key.accountId}/d1/database/${key.databaseId}/query`, { method: 'POST', headers: { authorization: `Bearer ${key.apiToken}`, 'content-type': 'application/json' }, body: JSON.stringify({ sql: TABLE_SIZES_SQL, params: [] }) });
  const row = body.result?.[0];
  if (Number.isSafeInteger(row?.meta?.rows_read) && row.meta.rows_read >= 0) await accountRows(row.meta.rows_read); else throw new Error('read_cost_unknown');
  if (body.success !== true || body.result.length !== 1 || row.success !== true || row.meta.rows_written !== 0 || row.results?.length !== 1) throw new Error('dataset_unavailable');
  const counts = Object.fromEntries(['devices', 'gateway_usage', 'users', 'account_entitlements', 'control_accounts'].map(name => [name, number(row.results[0][name])]));
  if (Object.values(counts).some(value => !Number.isSafeInteger(value))) throw new Error('dataset_unavailable');
  return { counts, activityReadEstimate: Math.max(1, 3 * (counts.devices + counts.gateway_usage + counts.control_accounts)), membersReadEstimate: Math.max(1, 3 * (counts.users + counts.account_entitlements)) };
}
