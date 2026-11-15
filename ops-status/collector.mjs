import { CATALOG, SOURCES, DAY, HOUR, buildSnapshot, number } from './model.mjs';
import { accountFingerprint } from './http.mjs';
import { collectCloudflare } from './cloudflare.mjs';
import { collectBusiness } from './business-d1.mjs';
import { collectBalance, collectYesterdayBill } from './aliyun-billing.mjs';
import { collectDirectMail } from './directmail.mjs';
import { collectSms, collectSmsPackages, collectCfResources } from './service-usage.mjs';
import { collectHuaweiBalance, collectHuaweiCoupons, collectHuaweiServerPrice, collectHuaweiMonitor } from './huawei.mjs';
import { collectTencentSes } from './tencent-ses.mjs';
import { collectCloady } from './cloady.mjs';
import { collectDomains, collectCertificates, collectConnectivity, expiryValue } from './public-status.mjs';
import { collectSubscription } from './subscription.mjs';
import { collectAliyunServers, emptyAliyunServers } from './aliyun-servers.mjs';
import defaults from './config.json' with { type: 'json' };
import { calibrateBusiness } from './calibrate-business.mjs';
import { vpsMetricValues } from '../ops-board/vps-metrics.mjs';

export const DAILY_READ_BUDGET = 100_000;
export function emptyState() { return { version: 1, cache: {}, attempts: {}, fingerprints: {}, failures: {}, budget: null }; }

export async function collect({ keys, problems = {}, fetchImpl, now, state = emptyState(), persist = async () => {}, mode = 'local', config = defaults, probes = {}, calibration = false }) {
  if (state.version !== 1 || !state.cache || !state.attempts || !state.fingerprints || !state.failures) throw new Error('state_invalid');
  const day = new Date(now).toISOString().slice(0, 10);
  if (state.budget && (typeof state.budget.spent !== 'number' || !Number.isSafeInteger(state.budget.spent) || state.budget.spent < 0)) throw new Error('state_invalid');
  if (!state.budget || state.budget.day < day) state.budget = { day, spent: 0, estimates: state.budget?.estimates ?? {} };
  if (state.budget.day > day) throw new Error('clock_rollback');
  const report = { issues: { ...state.failures }, missing: [], mode };
  for (const source of SOURCES) {
    if (!keys[source]) {
      if (problems[source] && problems[source] !== 'key_missing') {
        for (const def of CATALOG.filter(item => item.source === source)) report.issues[def.id] = 'key_invalid';
      } else report.missing.push(source);
      continue;
    }
    const fingerprint = accountFingerprint(keys[source]);
    if (state.fingerprints[source] !== fingerprint) {
      for (const def of CATALOG.filter(item => item.source === source)) {
        delete state.cache[def.id]; delete state.failures[def.id]; delete report.issues[def.id];
      }
      // Keep the account-wide daily read ledger when a credential/account is changed.
      for (const name of Object.keys(state.attempts)) if (name.startsWith(source)) delete state.attempts[name];
      if (source === 'businessD1') {
        delete state.calibration;
        for (const task of Object.keys(state.budget.estimates)) if (task.startsWith('businessD1.')) delete state.budget.estimates[task];
      }
      state.fingerprints[source] = fingerprint;
      if (source === 'swas') { delete state.aliyunInventory; delete state.aliyunServers; }
    }
  }

  const run = async (source, task, ids, interval, fn, business = false) => {
    if (!keys[source]) return;
    if (business && task !== 'businessD1.size' && calibration && state.calibration?.fingerprint !== state.fingerprints.businessD1) {
      for (const id of ids) report.issues[id] = 'read_budget';
      return;
    }
    const attempt = state.attempts[task];
    if (attempt !== undefined && (!Number.isSafeInteger(attempt) || attempt > now)) {
      for (const id of ids) report.issues[id] = 'clock_rollback';
      return;
    }
    if (attempt !== undefined && now - attempt < interval) return;
    let reserved = 0;
    if (business) {
      const configured = task === 'businessD1.size' ? DAILY_READ_BUDGET : state.calibration?.[task.endsWith('activity') ? 'activityReadEstimate' : 'membersReadEstimate'] ?? config.businessD1?.[task.endsWith('activity') ? 'activityReadEstimate' : 'membersReadEstimate'];
      const estimate = task === 'businessD1.size' ? DAILY_READ_BUDGET : state.budget.estimates[task] ?? configured ?? 20_000;
      if (!Number.isSafeInteger(estimate) || estimate < 1 || state.budget.spent + estimate > DAILY_READ_BUDGET) {
        for (const id of ids) report.issues[id] = 'read_budget';
        return;
      }
      reserved = estimate;
      state.budget.spent += reserved;
    }
    state.attempts[task] = now;
    // Persist a reservation before sending. A crash/network failure cannot restore that budget.
    await persist(state);
    let accounted = false;
    try {
      const result = await fn(async actual => {
        if (accounted) throw new Error('double_account');
        accounted = true;
        state.budget.spent += actual - reserved;
        state.budget.estimates[task] = Math.max(1, Math.ceil(actual * 1.2));
        await persist(state);
        if (state.budget.spent > DAILY_READ_BUDGET) throw new Error('read_budget_exceeded');
      });
      for (const id of ids) { delete state.failures[id]; delete report.issues[id]; }
      for (const [id, value] of Object.entries(result.values)) {
        if (ids.includes(id)) state.cache[id] = value;
      }
      Object.assign(report.issues, result.issues);
    } catch {
      // No provider errors, request URLs, raw response bodies or credentials leave this scope.
      for (const id of ids) report.issues[id] = business && state.budget.spent > DAILY_READ_BUDGET ? 'read_budget' : 'collection_failed';
    }
    for (const id of ids) {
      if (report.issues[id]) state.failures[id] = report.issues[id];
    }
    await persist(state);
  };
  const ids = source => CATALOG.filter(item => item.source === source).map(item => item.id);
  if (calibration && keys.businessD1 && state.calibration?.fingerprint !== state.fingerprints.businessD1) {
    await run('businessD1', 'businessD1.size', ids('businessD1'), DAY, async accountRows => {
      const result = await calibrateBusiness(keys.businessD1, fetchImpl, accountRows);
      state.calibration = { ...result, fingerprint: state.fingerprints.businessD1, at: now };
      return { values: {}, issues: {} };
    }, true);
  }
  await run('cloudflare', 'cloudflare.usage', ids('cloudflare'), 15 * 60_000,
    () => collectCloudflare(keys.cloudflare, fetchImpl, now));
  await run('businessD1', 'businessD1.activity', ['business.recent_hour', 'business.today'], 6 * HOUR,
    accountRows => collectBusiness(keys.businessD1, fetchImpl, now, 'activity', accountRows), true);
  await run('businessD1', 'businessD1.members', ids('businessD1').filter(id => id.startsWith('business.members.')), DAY,
    accountRows => collectBusiness(keys.businessD1, fetchImpl, now, 'members', accountRows), true);
  await run('aliyunBilling', 'aliyunBilling.balance', ['aliyun.available', 'aliyun.cash'], 15 * 60_000,
    () => collectBalance(keys.aliyunBilling, fetchImpl, now, config.minimumBalance));
  await run('aliyunBilling', 'aliyunBilling.bill', ['aliyun.yesterday_bill'], DAY,
    () => collectYesterdayBill(keys.aliyunBilling, fetchImpl, now));
  await run('directMail', 'directMail.quota', ids('directMail'), 15 * 60_000,
    () => collectDirectMail(keys.directMail, fetchImpl, now, config.directMail));
  await run('swas', 'swas.servers', [], 15 * 60000, async () => {
    const result = await collectAliyunServers(keys.swas, fetchImpl, now, state.aliyunInventory, probes.tcp);
    state.aliyunInventory = result.inventory; state.aliyunServers = result.snapshot;
    return { values: {}, issues: {} };
  });
  await run('huawei', 'huawei.balance', ['huawei.cash'], 15 * 60000, () => collectHuaweiBalance(keys.huawei, fetchImpl, now));
  await run('huawei', 'huawei.coupons', ['huawei.coupons'], DAY, () => collectHuaweiCoupons(keys.huawei, fetchImpl, now));
  for (const host of ['hwa', 'hwb']) await run('huawei', `huawei.${host}.price`, [`server.${host}.hourly_price`, `server.${host}.billing_mode`], DAY, () => collectHuaweiServerPrice(host, keys.huawei, fetchImpl, now));
  for (const host of ['hwa', 'hwb']) await run('cloudMonitor', `cloudMonitor.${host}`, ids('cloudMonitor').filter(id => id.startsWith(`server.${host}.`)), 15 * 60000, () => collectHuaweiMonitor(host, keys.huawei, fetchImpl, now));
  await run('aliyunSms', 'aliyunSms.statistics', ids('aliyunSms'), 15 * 60000, () => collectSms(keys.aliyunSms, config, fetchImpl, now));
  await run('smsPackages', 'smsPackages.remaining', ids('smsPackages'), 15 * 60000, () => collectSmsPackages(keys.smsPackages, fetchImpl, now));
  await run('tencentSes', 'tencentSes.statistics', ids('tencentSes'), 15 * 60000, () => collectTencentSes(keys.tencentSes, fetchImpl, now));
  await run('cloady', 'cloady.usage', ids('cloady'), 15 * 60000, () => collectCloady(keys.cloady, fetchImpl, now));
  await run('cfResources', 'cfResources.usage', ids('cfResources'), 15 * 60000, () => collectCfResources(keys.cfResources, fetchImpl, now));
  await run('domains', 'domains.expiry', ids('domains'), DAY, () => collectDomains(fetchImpl, now, probes.whois));
  await run('certificates', 'certificates.expiry', ids('certificates'), DAY, () => collectCertificates(now, probes.certificate));
  await run('connectivity', 'connectivity.probe', ids('connectivity'), 15 * 60000, () => collectConnectivity(config, fetchImpl, now, probes.tcp));
  await run('subscription', 'subscription.usage', ids('subscription'), 15 * 60000, () => collectSubscription(keys.subscription, fetchImpl, now));
  await run('vps', 'vps.report', ids('vps'), 0, () => vpsMetricValues(probes.vpsReport?.() ?? null));
  // Manual values are re-read each run, but their as-of time never becomes the run time.
  if (keys.manual) {
    for (const def of CATALOG.filter(item => item.manual)) {
      delete state.cache[def.id]; delete state.failures[def.id]; delete report.issues[def.id];
      const entry = config.manual?.[def.id];
      try {
        if (!entry || !/^\d{4}-\d\d-\d\d$/.test(entry.asOf) || !Number.isFinite(Date.parse(entry.asOf)) || Date.parse(entry.asOf) > now) throw new Error('manual_missing');
        const at = Date.parse(entry.asOf); const extra = { asOf: entry.asOf };
        state.cache[def.id] = def.expiry ? expiryValue(entry.expiresAt, at, extra) : { used: number(entry.used), collectedAt: new Date(at).toISOString(), ...extra };
      } catch { report.issues[def.id] = 'manual_missing'; }
    }
  }
  for (const source of ['paymentConsole', 'githubConsole']) if (keys[source]) for (const id of ids(source)) report.issues[id] = 'console_only';
  await persist(state);
  const budget = { day: state.budget.day, used: number(state.budget.spent), limit: DAILY_READ_BUDGET,
    accounting: 'actual_rows_read_when_available_otherwise_reserved_estimate',
    protection: 'preflight_reservation_and_stop_after_observed_overrun_not_database_hard_cap' };
  const snapshot = buildSnapshot(state.cache, report, now, budget);
  snapshot.aliyunServers = keys.swas ? state.aliyunServers ?? emptyAliyunServers(false) : emptyAliyunServers();
  return { snapshot, state };
}
