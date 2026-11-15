import { isIP } from 'node:net';
import { CATALOG } from '../ops-status/model.mjs';
import { instanceMetricDefinitions } from '../ops-status/aliyun-servers.mjs';
import { REASON_DETAILS, classifyReason, isFinancial, isR2UnclassifiedDetail } from '../ops-status/reasons.mjs';
import { historyEligible } from '../ops-status/history.mjs';
export const MAX_SNAPSHOT_BYTES = 2 * 1024 * 1024;
const TOP = ['schemaVersion', 'generatedAt', 'mode', 'limitsBasis', 'metrics', 'businessReadBudget', 'aliyunServers', 'history'];
const FIELDS = ['id', 'source', 'label', 'used', 'limit', 'unit', 'collectedAt', 'status', 'reason', 'reasonDetail', 'alertEligible', 'period', 'periodDate', 'refreshSeconds', 'staleAfterSeconds', 'accounting'];
const STATUSES = new Set(['正常', '关注', '警告', '未接', '失败', '未更新', '不适用']);
const REASONS = new Set([null, 'not_provided', 'not_authorized', 'collect_failed']);
function invalid() { throw new Error('snapshot_invalid'); }
function exactKeys(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) invalid();
}
function iso(value) { return typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value; }
function date(value) { return typeof value === 'string' && /^\d{4}-\d\d-\d\d$/.test(value) && iso(`${value}T00:00:00.000Z`); }
function numeric(value) { return value === null || typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= Number.MAX_SAFE_INTEGER; }
function validateMetric(metric, def) {
  const expiry = def.expiry === true;
  const fields = [...FIELDS, ...(expiry ? ['expiresAt', 'thresholds'] : def.id === 'cf.d1.write' ? ['thresholds'] : []), ...(def.manual ? ['asOf'] : []), ...(def.consoleUrl ? ['consoleUrl'] : []), ...(def.trafficObservation ? ['observedSince', 'complete'] : []), ...(def.service ? ['httpStatus', 'durationMs', 'certificateValid'] : [])];
  exactKeys(metric, fields);
  const accounting = def.accounting ?? (def.id === 'aliyun.yesterday_bill' ? 'reported_bill_not_cash_debited' : def.id.startsWith('cf.') ? 'analytics_not_invoice' : 'observed');
  const currency = def.source === 'aliyunBilling';
  if (metric.id !== def.id || metric.source !== def.source || metric.label !== def.label || metric.period !== def.period || metric.accounting !== accounting || metric.refreshSeconds !== def.refreshMs / 1000 || metric.staleAfterSeconds !== def.refreshMs / 500 || !STATUSES.has(metric.status) || !REASONS.has(metric.reason) || !(metric.collectedAt === null || iso(metric.collectedAt)) || !(metric.periodDate === null || def.id === 'aliyun.yesterday_bill' && date(metric.periodDate)) || (currency ? !['CNY', 'USD', 'JPY'].includes(metric.unit) : metric.unit !== def.unit) || !numeric(metric.used) || !numeric(metric.limit) || metric.limit !== null && metric.limit < 0) invalid();
  if (!(metric.reasonDetail === null || REASON_DETAILS.has(metric.reasonDetail) || ['cf.r2.a', 'cf.r2.b'].includes(def.id) && isR2UnclassifiedDetail(metric.reasonDetail)) || metric.reason !== classifyReason(metric.reasonDetail) || metric.alertEligible !== (!isFinancial(def) && metric.status !== '不适用') || isFinancial(def) && ['关注', '警告'].includes(metric.status)) invalid();
  if (def.service && (!(metric.httpStatus === null || Number.isInteger(metric.httpStatus) && metric.httpStatus >= 100 && metric.httpStatus <= 599) || !(metric.durationMs === null || Number.isSafeInteger(metric.durationMs) && metric.durationMs >= 0) || ![null, true, false].includes(metric.certificateValid))) invalid();
  if (!currency && !def.decimal && metric.id !== 'cf.cpu_p99_max' && metric.used !== null && (!Number.isSafeInteger(metric.used) || !expiry && metric.used < 0)) invalid();
  if (expiry && (!(metric.expiresAt === null || iso(metric.expiresAt) || date(metric.expiresAt)) || metric.used !== null && metric.expiresAt === null || metric.limit !== null)) invalid();
  if (expiry || def.id === 'cf.d1.write') {
    const expected = expiry ? { direction: 'below', attention: 30, warning: 7, urgent: 1 } : { direction: 'above', attention: 50000, warning: 80000, urgent: 90000 };
    exactKeys(metric.thresholds, Object.keys(expected));
    if (Object.entries(expected).some(([key, value]) => metric.thresholds[key] !== value)) invalid();
  }
  if (def.manual && !(metric.asOf === null || date(metric.asOf))) invalid();
  if (def.consoleUrl && metric.consoleUrl !== def.consoleUrl) invalid();
  if (def.trafficObservation && (!(metric.observedSince === null || iso(metric.observedSince)) || metric.complete !== false)) invalid();
  if (metric.used !== null && metric.collectedAt === null) invalid();
}
function validateAliyunServers(data) {
  exactKeys(data, ['collectedAt', 'status', 'reason', 'reasonDetail', 'complete', 'counts', 'failures', 'instances']);
  exactKeys(data.counts, ['swas', 'ecs']);
  if (!(data.collectedAt === null || iso(data.collectedAt)) || !STATUSES.has(data.status) || !REASONS.has(data.reason) || typeof data.complete !== 'boolean' || !Array.isArray(data.failures) || data.failures.length > 2000 || !Array.isArray(data.instances) || data.instances.length > 10000) invalid();
  if (!(data.reasonDetail === null || REASON_DETAILS.has(data.reasonDetail)) || data.reason !== classifyReason(data.reasonDetail)) invalid();
  for (const item of data.failures) {
    exactKeys(item, ['type', 'regionId', 'action', 'reason', 'reasonDetail']);
    if (!['swas', 'ecs'].includes(item.type) || !(item.regionId === null || typeof item.regionId === 'string' && /^[a-z][a-z0-9-]{2,39}$/.test(item.regionId)) || !['ListRegions', 'DescribeRegions', 'ListInstances', 'DescribeInstances', 'DescribeMonitorData', 'ListInstancesTrafficPackages', 'DescribeInstanceMonitorData', 'DescribeMetricLast'].includes(item.action) || !REASONS.has(item.reason) || item.reason === null || !REASON_DETAILS.has(item.reasonDetail) || item.reason !== classifyReason(item.reasonDetail)) invalid();
  }
  const seen = new Set(); let aliases = 0;
  for (const row of data.instances) {
    exactKeys(row, ['id', 'alias', 'type', 'name', 'regionId', 'publicIps', 'status', 'billingMode', 'metrics']);
    if (typeof row.id !== 'string' || !/^[a-f0-9]{24}$/.test(row.id) || seen.has(row.id) || !['swas', 'ecs'].includes(row.type) || ![null, 'aleg'].includes(row.alias) || row.alias === 'aleg' && (row.type !== 'swas' || ++aliases > 1) || typeof row.name !== 'string' || row.name.length > 128 || /[\x00-\x1f\x7f]/.test(row.name) || typeof row.regionId !== 'string' || !/^[a-z][a-z0-9-]{2,39}$/.test(row.regionId) || !Array.isArray(row.publicIps) || row.publicIps.length > 20 || new Set(row.publicIps).size !== row.publicIps.length || row.publicIps.some(ip => typeof ip !== 'string' || !isIP(ip)) || !['Running', 'Starting', 'Stopping', 'Stopped', 'Pending', 'Rebooting', 'Resetting', 'Expired', 'Disabled', 'Unknown'].includes(row.status) || !['prepaid', 'postpaid', 'unknown'].includes(row.billingMode)) invalid();
    seen.add(row.id);
    const defs = instanceMetricDefinitions(row.id, row.type);
    if (!Array.isArray(row.metrics) || row.metrics.length !== defs.length) invalid();
    for (let index = 0; index < defs.length; index++) validateMetric(row.metrics[index], defs[index]);
  }
  for (const type of ['swas', 'ecs']) {
    const count = data.counts[type];
    if (count === null ? data.complete : !Number.isSafeInteger(count) || count < 0 || count !== data.instances.filter(row => row.type === type).length) invalid();
  }
  if (data.collectedAt === null && (data.instances.length || data.complete)) invalid();
}
// Only bounded inventory metadata and catalog metrics can reach the private page.
export function validateSnapshot(snapshot) {
  exactKeys(snapshot, TOP);
  if (snapshot.schemaVersion !== 2 || !iso(snapshot.generatedAt) || !['fixture', 'local'].includes(snapshot.mode) || snapshot.limitsBasis !== 'Cloudflare Free / R2 Standard reference; DirectMail initial gift reference' || !Array.isArray(snapshot.metrics) || snapshot.metrics.length !== CATALOG.length) invalid();
  const remaining = new Map(CATALOG.map(def => [def.id, def]));
  for (const metric of snapshot.metrics) {
    const def = remaining.get(metric?.id);
    if (!def) invalid();
    validateMetric(metric, def); remaining.delete(metric.id);
  }
  validateAliyunServers(snapshot.aliyunServers);
  const tracked = [...snapshot.metrics, ...snapshot.aliyunServers.instances.flatMap(row => row.metrics)].filter(historyEligible);
  exactKeys(snapshot.history, tracked.map(metric => metric.id));
  for (const metric of tracked) {
    const points = snapshot.history[metric.id];
    if (!Array.isArray(points) || points.length > 48) invalid();
    let last = '';
    for (const point of points) {
      exactKeys(point, ['t', 'v', 'status']);
      if (!iso(point.t) || point.t <= last || !numeric(point.v) || !STATUSES.has(point.status) || ['未接', '失败', '未更新', '不适用'].includes(point.status) && point.v !== null) invalid();
      last = point.t;
    }
  }
  const budget = snapshot.businessReadBudget;
  exactKeys(budget, ['day', 'used', 'limit', 'accounting', 'protection']);
  if (!date(budget.day) || !Number.isSafeInteger(budget.used) || budget.used < 0 || budget.limit !== 100000 || budget.accounting !== 'actual_rows_read_when_available_otherwise_reserved_estimate' || budget.protection !== 'preflight_reservation_and_stop_after_observed_overrun_not_database_hard_cap') invalid();
  if (Buffer.byteLength(JSON.stringify(snapshot)) > MAX_SNAPSHOT_BYTES) invalid();
  return snapshot;
}
