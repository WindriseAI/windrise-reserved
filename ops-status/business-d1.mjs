import { cloudflareKey } from './credentials.mjs';
import { requestJson } from './http.mjs';
import { freshValue, number } from './model.mjs';

// Identifiers are used only inside SQLite. The response contains aggregate counts only.
// Successful v2 receipts persist server-side minute buckets in both identity paths.
export const ACTIVITY_SQL = `WITH observations AS (
 SELECT machine_id AS machine, CAST(json_extract(control_state,'$.minute') AS INTEGER)*60000 AS seen
 FROM devices WHERE revoked=0 AND machine_id IS NOT NULL
 AND json_extract(control_state,'$.counter')>0
 AND COALESCE(json_extract(control_state,'$.status'),200)=200
 AND NOT EXISTS(SELECT 1 FROM control_accounts a WHERE a.user_id=devices.user_id AND a.revoked=1)
 UNION ALL
 SELECT device_id,CAST(json_extract(state,'$.report.minute') AS INTEGER)*60000
 FROM gateway_usage WHERE json_extract(state,'$.report.counter')>0
 AND COALESCE(json_extract(state,'$.report.status'),200)=200
), latest AS (SELECT machine,MAX(seen) AS seen FROM observations GROUP BY machine)
SELECT COALESCE(SUM(seen>=? AND seen<=?),0) AS recent_hour,
 COALESCE(SUM(seen>=? AND seen<=?),0) AS today FROM latest`;

export const MEMBERS_SQL = `WITH ranked AS (
 SELECT user_id,plan,ROW_NUMBER() OVER(PARTITION BY user_id ORDER BY expires_at DESC,id) AS rank
 FROM account_entitlements WHERE status='active' AND starts_at<=? AND expires_at>?
), members AS (SELECT user_id,plan FROM ranked WHERE rank=1)
SELECT COUNT(*) AS accounts,
 COALESCE(SUM(m.user_id IS NULL),0) AS free,
 COALESCE(SUM(m.plan='monthly'),0) AS monthly,
 COALESCE(SUM(m.plan='quarterly'),0) AS quarterly,
 COALESCE(SUM(m.plan='yearly'),0) AS yearly,
 COALESCE(SUM(m.plan='trial'),0) AS trial,
 COALESCE(SUM(m.plan='manual'),0) AS manual,
 COALESCE(SUM(m.user_id IS NOT NULL AND m.plan NOT IN ('monthly','quarterly','yearly','trial','manual')),0) AS other
FROM users u LEFT JOIN members m ON u.id=m.user_id`;

export async function collectBusiness(key, fetchImpl, now, kind, accountRows) {
  cloudflareKey(key, true);
  const beijingDay = new Date(now + 8 * 3_600_000).toISOString().slice(0, 10);
  const dayStart = Date.parse(`${beijingDay}T00:00:00+08:00`);
  const sql = kind === 'activity' ? ACTIVITY_SQL : MEMBERS_SQL;
  const params = kind === 'activity' ? [now - 3_600_000, now, dayStart, now] : [now, now];
  const body = await requestJson(fetchImpl,
    `https://api.cloudflare.com/client/v4/accounts/${key.accountId}/d1/database/${key.databaseId}/query`, {
      method: 'POST', headers: { Authorization: `Bearer ${key.apiToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ sql, params }),
    });
  // Account even a query whose result shape is invalid; never return raw D1 errors/results.
  const result = body.result?.[0];
  const rows = result?.meta?.rows_read;
  if (typeof rows === 'number' && Number.isSafeInteger(rows) && rows >= 0) await accountRows(rows);
  else throw new Error('read_cost_unknown');
  if (body.success !== true || body.result.length !== 1 || result.success !== true || result.meta.rows_written !== 0 || !Array.isArray(result.results) || result.results.length !== 1) throw new Error('invalid_response');
  const row = result.results[0];
  const values = {};
  if (kind === 'activity') {
    for (const name of ['recent_hour', 'today']) values[`business.${name}`] = freshValue(number(row[name]), now);
  } else {
    const plans = ['free', 'monthly', 'quarterly', 'yearly', 'trial', 'manual', 'other'];
    const counts = plans.map(plan => number(row[plan]));
    if (counts.reduce((sum, count) => sum + count, 0) !== number(row.accounts)) throw new Error('invalid_counts');
    for (let i = 0; i < plans.length; i++) values[`business.members.${plans[i]}`] = freshValue(counts[i], now);
  }
  return { values, issues: {} };
}
