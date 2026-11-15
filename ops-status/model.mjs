import { EXTRA_CATALOG } from './extra-catalog.mjs';
export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;
export const SOURCES = ['cloudflare', 'businessD1', 'aliyunBilling', 'directMail', 'swas', ...new Set(EXTRA_CATALOG.map(item => item.source))];

// Limits are the documented Free/Standard reference, not a detected subscription.
const rows = [
  ['cf.requests', 'cloudflare', '动态请求', '次', 100_000, 'utc-day'],
  ['cf.errors', 'cloudflare', 'Worker执行错误', '次', null, 'utc-day'],
  ['cf.cpu_p99_max', 'cloudflare', '各脚本CPU P99最大值', '毫秒', null, 'utc-day'],
  ['cf.d1.read', 'cloudflare', 'D1扫描读行', '行', 5_000_000, 'utc-day'],
  ['cf.d1.write', 'cloudflare', 'D1写行', '行', 100_000, 'utc-day'],
  ['cf.d1.storage', 'cloudflare', 'D1各库当日峰值容量合计', '字节', 5_000_000_000, 'utc-day-peak'],
  ['cf.d1.largest', 'cloudflare', 'D1最大单库当日峰值', '字节', 500_000_000, 'utc-day-peak'],
  ['cf.kv.read', 'cloudflare', 'KV读取', '次', 100_000, 'utc-day'],
  ['cf.kv.write', 'cloudflare', 'KV写入', '次', 1_000, 'utc-day'],
  ['cf.kv.delete', 'cloudflare', 'KV删除', '次', 1_000, 'utc-day'],
  ['cf.kv.list', 'cloudflare', 'KV列举', '次', 1_000, 'utc-day'],
  ['cf.kv.storage', 'cloudflare', 'KV各空间当日峰值容量合计', '字节', 1_000_000_000, 'utc-day-peak'],
  ['cf.r2.a', 'cloudflare', 'R2 Class A操作', '次', 1_000_000, 'utc-month'],
  ['cf.r2.b', 'cloudflare', 'R2 Class B操作', '次', 10_000_000, 'utc-month'],
  ['cf.r2.storage', 'cloudflare', 'R2各桶当日峰值容量合计', '字节', 10_000_000_000, 'utc-day-peak'],
  ['business.recent_hour', 'businessD1', '最近一小时有报到记录的电脑', '台', null, 'as-of-collection'],
  ['business.today', 'businessD1', '今日有报到记录的电脑', '台', null, 'asia-shanghai-day'],
  ['business.members.free', 'businessD1', '当前免费账号', '账号', null, 'as-of-collection'],
  ...['monthly', 'quarterly', 'yearly', 'trial', 'manual', 'other'].map(plan =>
    [`business.members.${plan}`, 'businessD1', `当前有效权益 ${plan}`, '账号', null, 'as-of-collection']),
  ['aliyun.available', 'aliyunBilling', '阿里云可用额度', 'CNY', null, 'as-of-collection'],
  ['aliyun.cash', 'aliyunBilling', '阿里云现金余额', 'CNY', null, 'as-of-collection'],
  ['aliyun.yesterday_bill', 'aliyunBilling', '昨日账单应付金额', 'CNY', null, 'asia-shanghai-yesterday'],
  ['mail.total_free', 'directMail', 'DirectMail累计赠额已用', '封', 2_000, 'lifetime'],
  ['mail.daily_free', 'directMail', 'DirectMail当日赠额已用', '封', 200, 'provider-day'],
];

export const CATALOG = rows.map(([id, source, label, unit, limit, period]) => ({
  id, source, label, unit, limit, period,
  refreshMs: id.startsWith('business.members.') || id === 'aliyun.yesterday_bill' ? DAY
    : source === 'businessD1' ? 6 * HOUR : 15 * MINUTE,
})).concat(EXTRA_CATALOG);

export function number(value, { signed = false } = {}) {
  if (typeof value !== 'number' && typeof value !== 'string') throw new Error('invalid_number');
  if (typeof value === 'string' && !/^-?(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d+)?$/.test(value)) throw new Error('invalid_number');
  const result = Number(typeof value === 'string' ? value.replaceAll(',', '') : value);
  if (!Number.isFinite(result) || (!signed && result < 0)) throw new Error('invalid_number');
  return result;
}

export function freshValue(used, now, extra = {}) {
  return { used: number(used, { signed: true }), collectedAt: new Date(now).toISOString(), ...extra };
}

export function buildSnapshot(cache, results, now, budget) {
  return {
    schemaVersion: 2,
    generatedAt: new Date(now).toISOString(),
    mode: results.mode,
    limitsBasis: 'Cloudflare Free / R2 Standard reference; DirectMail initial gift reference',
    metrics: CATALOG.map(def => buildMetric(def, cache[def.id], results.issues[def.id], now, results.missing.includes(def.source))),
    businessReadBudget: budget,
  };
}

export function buildMetric(def, value, issue, now, missing = false) {
      const age = value ? now - Date.parse(value.collectedAt) : Infinity;
      let status = '正常';
      if (missing) status = '未接';
      else if (issue === 'not_applicable') status = '不适用';
      else if (value && (age < 0 || age > 2 * def.refreshMs)) status = '未更新';
      else if (issue === 'read_budget') status = '未更新';
      else if (issue === 'manual_missing' || issue === 'console_only' || issue === 'report_missing') status = '未接';
      else if (issue || !value) status = '失败';
      else if (def.expiry) {
        if (value.used <= 7) status = '警告';
        else if (value.used <= 30) status = '关注';
      }
      else if ((value.lowWarning ?? def.lowWarning) !== undefined && (value.lowWarning ?? def.lowWarning) !== null) {
        if (value.used < (value.lowWarning ?? def.lowWarning)) status = '警告';
        else if (value.used < 2 * (value.lowWarning ?? def.lowWarning)) status = '关注';
      } else {
        const limit = value.limit === undefined ? def.limit : value.limit;
        if (limit === 0) status = '警告';
        else if (limit !== null && value.used >= limit * 0.8) status = '警告';
        else if (limit !== null && value.used >= limit * 0.5) status = '关注';
        if (def.unit === '布尔' && value.used === 0) status = '警告';
      }
      return {
        id: def.id, source: def.source, label: def.label,
        used: missing ? null : value?.used ?? null,
        limit: value?.limit === undefined ? def.limit : value.limit,
        unit: value?.unit ?? def.unit, collectedAt: missing ? null : value?.collectedAt ?? null,
        status, reason: missing ? 'key_missing' : issue ?? (status === '未更新' ? 'stale' : null),
        period: def.period,
        periodDate: value?.billingDate ?? null,
        refreshSeconds: def.refreshMs / 1000,
        staleAfterSeconds: 2 * def.refreshMs / 1000,
        ...(def.id === 'cf.d1.write' ? { thresholds: { direction: 'above', attention: 50000, warning: 80000, urgent: 90000 } } : {}),
        ...(def.expiry ? { expiresAt: missing ? null : value?.expiresAt ?? null,
          thresholds: { direction: 'below', attention: 30, warning: 7, urgent: 1 } } : {}),
        ...(def.manual ? { asOf: value?.asOf ?? null } : {}),
        ...(def.consoleUrl ? { consoleUrl: def.consoleUrl } : {}),
        ...(def.trafficObservation ? { observedSince: value?.observedSince ?? null, complete: false } : {}),
        // Peak storage is a capacity warning, not GB-month consumed or a charged invoice.
        accounting: def.accounting ?? (def.id === 'aliyun.yesterday_bill' ? 'reported_bill_not_cash_debited'
          : def.id.startsWith('cf.') ? 'analytics_not_invoice' : 'observed'),
      };
}
