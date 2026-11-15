import { aliyunKey, cloudflareKey } from './credentials.mjs';
import { requestJson, rpc, signedRpcV3 } from './http.mjs';
import { freshValue, number } from './model.mjs';
import { CLOUDFLARE_DOMAINS, domainSlug } from './extra-catalog.mjs';

export async function collectSms(key, config, fetchImpl, now) {
  aliyunKey(key);
  const day = new Date(now + 8 * 3600000).toISOString().slice(0, 10).replaceAll('-', '');
  const values = {}; const issues = {};
  for (const period of ['day', 'month']) {
    let received = 0; let expected; let sent = 0; let success = 0; let failed = 0;
    try {
      for (let page = 1; page <= 100; page++) {
        const body = await rpc(fetchImpl, 'dysmsapi.aliyuncs.com', 'QuerySendStatistics', '2017-05-25', key, { IsGlobe: 1, StartDate: period === 'day' ? day : day.slice(0, 6) + '01', EndDate: day, PageIndex: page, PageSize: 50 }, now);
        const rows = body.Data?.TargetList; const count = number(body.Data?.TotalSize);
        if (!Number.isSafeInteger(count) || !Array.isArray(rows) || (expected !== undefined && count !== expected)) throw new Error('dataset_unavailable');
        expected = count;
        for (const row of rows) { sent += number(row.TotalCount); success += number(row.RespondedSuccessCount); failed += number(row.RespondedFailCount); }
        received += rows.length;
        if (received === expected) break;
        if (received > expected || rows.length < 50 || page === 100) throw new Error('dataset_unavailable');
      }
      for (const [name, used] of Object.entries({ sent, success, failed })) values[`sms.${period}.${name}`] = freshValue(used, now);
      if (period === 'month') {
        if (typeof config.smsUnitPrice === 'number' && Number.isFinite(config.smsUnitPrice) && config.smsUnitPrice >= 0) values['sms.month.estimated_cost'] = freshValue(Math.round(sent * config.smsUnitPrice * 1000000) / 1000000, now);
        else issues['sms.month.estimated_cost'] = 'dataset_unavailable';
      }
    } catch { for (const name of ['sent', 'success', 'failed']) issues[`sms.${period}.${name}`] = 'collection_failed'; if (period === 'month') issues['sms.month.estimated_cost'] = 'collection_failed'; }
  }
  return { values, issues };
}
export async function collectSmsPackages(key, fetchImpl, now) {
  aliyunKey(key);
  let remaining = 0; let received = 0; let expected; const seen = new Set();
  for (let page = 1; page <= 100; page++) {
    const body = await rpc(fetchImpl, 'business.aliyuncs.com', 'QueryResourcePackageInstances', '2017-12-14', key, { ProductCode: 'dysms', PageNum: page, PageSize: 100 }, now);
    const rows = body.Data?.Instances?.Instance; const count = number(body.Data?.TotalCount);
    if (!Array.isArray(rows) || !Number.isSafeInteger(count) || (expected !== undefined && expected !== count)) throw new Error('dataset_unavailable');
    expected = count;
    for (const row of rows) {
      if (typeof row.InstanceId !== 'string' || seen.has(row.InstanceId)) throw new Error('dataset_unavailable');
      seen.add(row.InstanceId);
      const expires = Date.parse(row.ExpiryTime); const starts = Date.parse(row.EffectiveTime);
      if (!Number.isFinite(expires) || !Number.isFinite(starts)) throw new Error('dataset_unavailable');
      if (row.Status !== 'Available' || expires <= now || starts > now) continue;
      if (!['条', 'Count', 'count'].includes(row.RemainingAmountUnit)) throw new Error('dataset_unavailable');
      remaining += number(row.RemainingAmount);
    }
    received += rows.length;
    if (received === expected) return { values: { 'sms.package_remaining': freshValue(remaining, now) }, issues: {} };
    if (received > expected || rows.length < 100) throw new Error('dataset_unavailable');
  }
  throw new Error('dataset_unavailable');
}
export async function collectCfResources(key, fetchImpl, now) {
  cloudflareKey(key);
  const headers = { authorization: `Bearer ${key.apiToken}` };
  const get = async route => { const body = await requestJson(fetchImpl, `https://api.cloudflare.com/client/v4${route}`, { method: 'GET', headers }); if (body.success !== true) throw new Error('collection_failed'); return body; };
  const values = {}; const issues = {};
  try {
    let count = 0;
    for (let page = 1; page <= 100; page++) {
      const body = await get(`/accounts/${key.accountId}/cfd_tunnel?is_deleted=false&page=${page}&per_page=100`);
      if (!Array.isArray(body.result) || !Number.isSafeInteger(body.result_info?.total_count) || !Number.isSafeInteger(body.result_info?.total_pages)) throw new Error('dataset_unavailable');
      count += body.result.length;
      if (page >= body.result_info.total_pages) { if (count !== body.result_info.total_count) throw new Error('dataset_unavailable'); values['cf.tunnels'] = freshValue(count, now); break; }
      if (page === 100) throw new Error('dataset_unavailable');
    }
  } catch { issues['cf.tunnels'] = 'collection_failed'; }
  for (const domain of CLOUDFLARE_DOMAINS) {
    const id = `cf.dns.${domainSlug(domain)}`;
    try {
      const zones = await get(`/zones?name=${domain}&account.id=${key.accountId}&per_page=50`);
      if (!Array.isArray(zones.result) || zones.result.length !== 1 || !/^[a-f0-9]{32}$/i.test(zones.result[0].id)) throw new Error('dataset_unavailable');
      const body = await get(`/zones/${zones.result[0].id}/dns_records/usage`);
      const used = number(body.result?.record_usage); const quota = body.result?.record_quota;
      values[id] = freshValue(used, now, { limit: quota === null ? null : number(quota) });
    } catch { issues[id] = 'collection_failed'; }
  }
  return { values, issues };
}
