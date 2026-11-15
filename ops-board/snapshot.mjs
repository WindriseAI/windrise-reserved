import { CATALOG } from '../ops-status/model.mjs';
export const MAX_SNAPSHOT_BYTES = 131072;
const TOP = ['schemaVersion', 'generatedAt', 'mode', 'limitsBasis', 'metrics', 'businessReadBudget'];
const FIELDS = ['id', 'source', 'label', 'used', 'limit', 'unit', 'collectedAt', 'status', 'reason', 'period', 'periodDate', 'refreshSeconds', 'staleAfterSeconds', 'accounting'];
const STATUSES = new Set(['正常', '关注', '警告', '未接', '失败', '未更新']);
const REASONS = new Set([null, 'key_missing', 'key_invalid', 'collection_failed', 'dataset_unavailable', 'empty_dataset', 'read_budget', 'clock_rollback', 'stale', 'manual_missing', 'console_only', 'unsupported_billing_mode']);
function exactKeys(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) throw new Error('snapshot_invalid');
}
function iso(value) { return typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value; }
function date(value) { return typeof value === 'string' && /^\d{4}-\d\d-\d\d$/.test(value) && iso(`${value}T00:00:00.000Z`); }
function numeric(value) { return value === null || (typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= Number.MAX_SAFE_INTEGER); }
// Fixed catalog text and enumerated metadata keep secrets and identifiers out of uploads.
export function validateSnapshot(snapshot) {
  exactKeys(snapshot, TOP);
  if (snapshot.schemaVersion !== 1 || !iso(snapshot.generatedAt) || !['fixture', 'local'].includes(snapshot.mode) || snapshot.limitsBasis !== 'Cloudflare Free / R2 Standard reference; DirectMail initial gift reference' || !Array.isArray(snapshot.metrics) || snapshot.metrics.length !== CATALOG.length) throw new Error('snapshot_invalid');
  const remaining = new Map(CATALOG.map(def => [def.id, def]));
  for (const metric of snapshot.metrics) {
    const def = remaining.get(metric?.id);
    if (!def) throw new Error('snapshot_invalid');
    const expiry = def.source === 'swas' || def.expiry;
    const fields = [...FIELDS, ...(expiry ? ['expiresAt', 'thresholds'] : def.id === 'cf.d1.write' ? ['thresholds'] : []), ...(def.manual ? ['asOf'] : []), ...(def.consoleUrl ? ['consoleUrl'] : []), ...(def.source === 'localTraffic' ? ['observedSince', 'complete'] : [])];
    exactKeys(metric, fields); remaining.delete(metric.id);
    const accounting = def.accounting ?? (def.id === 'aliyun.yesterday_bill' ? 'reported_bill_not_cash_debited' : def.id.startsWith('cf.') ? 'analytics_not_invoice' : 'observed');
    const currency = def.source === 'aliyunBilling';
    if (metric.source !== def.source || metric.label !== def.label || metric.period !== def.period || metric.accounting !== accounting || metric.refreshSeconds !== def.refreshMs / 1000 || metric.staleAfterSeconds !== def.refreshMs / 500 || !STATUSES.has(metric.status) || !REASONS.has(metric.reason) || !(metric.collectedAt === null || iso(metric.collectedAt)) || !(metric.periodDate === null || (def.id === 'aliyun.yesterday_bill' && date(metric.periodDate))) || (currency ? !['CNY', 'USD', 'JPY'].includes(metric.unit) : metric.unit !== def.unit) || !numeric(metric.used) || !numeric(metric.limit) || (metric.limit !== null && metric.limit < 0)) throw new Error('snapshot_invalid');
    if (!currency && !def.decimal && metric.id !== 'cf.cpu_p99_max' && metric.used !== null && (!Number.isSafeInteger(metric.used) || (!expiry && metric.used < 0))) throw new Error('snapshot_invalid');
    if (expiry && (!(metric.expiresAt === null || iso(metric.expiresAt) || date(metric.expiresAt)) || (metric.used !== null && metric.expiresAt === null) || metric.limit !== null)) throw new Error('snapshot_invalid');
    if (expiry || def.id === 'cf.d1.write') {
      const expected = expiry ? { direction: 'below', attention: 30, warning: 7, urgent: 1 } : { direction: 'above', attention: 50000, warning: 80000, urgent: 90000 };
      exactKeys(metric.thresholds, Object.keys(expected));
      if (Object.entries(expected).some(([key, value]) => metric.thresholds[key] !== value)) throw new Error('snapshot_invalid');
    }
    if (def.manual && !(metric.asOf === null || date(metric.asOf))) throw new Error('snapshot_invalid');
    if (def.consoleUrl && metric.consoleUrl !== def.consoleUrl) throw new Error('snapshot_invalid');
    if (def.source === 'localTraffic' && (!(metric.observedSince === null || iso(metric.observedSince)) || typeof metric.complete !== 'boolean')) throw new Error('snapshot_invalid');
    if (metric.used !== null && metric.collectedAt === null) throw new Error('snapshot_invalid');
  }
  const budget = snapshot.businessReadBudget;
  exactKeys(budget, ['day', 'used', 'limit', 'accounting', 'protection']);
  if (!date(budget.day) || !Number.isSafeInteger(budget.used) || budget.used < 0 || budget.limit !== 100000 || budget.accounting !== 'actual_rows_read_when_available_otherwise_reserved_estimate' || budget.protection !== 'preflight_reservation_and_stop_after_observed_overrun_not_database_hard_cap') throw new Error('snapshot_invalid');
  if (Buffer.byteLength(JSON.stringify(snapshot)) > MAX_SNAPSHOT_BYTES) throw new Error('snapshot_invalid');
  return snapshot;
}
