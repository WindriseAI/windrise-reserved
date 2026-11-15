import { createHash, createHmac } from 'node:crypto';
import { requestJson, encode } from './http.mjs';
import { freshValue, number } from './model.mjs';
import { issueCode } from './reasons.mjs';

export function signedHuaweiRequest(endpoint, route, key, now, { method = 'GET', query = {}, body } = {}) {
  const text = body === undefined ? '' : JSON.stringify(body);
  const parameters = Object.keys(query).sort().map(name => `${encode(name)}=${encode(query[name])}`).join('&');
  const date = new Date(now).toISOString().replace(/[-:]|\.\d{3}/g, '');
  const headers = { 'content-type': 'application/json', host: endpoint, 'x-sdk-date': date };
  const hash = input => createHash('sha256').update(input).digest('hex');
  const canonical = `${method}\n${route.endsWith('/') ? route : `${route}/`}\n${parameters}\n${Object.entries(headers).map(([name, value]) => `${name}:${value}\n`).join('')}\ncontent-type;host;x-sdk-date\n${hash(text)}`;
  const signature = createHmac('sha256', key.accessKeySecret).update(`SDK-HMAC-SHA256\n${date}\n${hash(canonical)}`).digest('hex');
  headers.authorization = `SDK-HMAC-SHA256 Access=${key.accessKeyId}, SignedHeaders=content-type;host;x-sdk-date, Signature=${signature}`;
  return { url: `https://${endpoint}${route}${parameters ? `?${parameters}` : ''}`, options: { method, headers, ...(body === undefined ? {} : { body: text }) } };
}
function validateKey(key) {
  if (typeof key.accessKeyId !== 'string' || !/^[A-Za-z0-9]{8,128}$/.test(key.accessKeyId) || typeof key.accessKeySecret !== 'string' || !key.accessKeySecret || /[\r\n]/.test(key.accessKeySecret)) throw new Error('key_invalid');
}
async function api(key, now, fetchImpl, route, options = {}, endpoint = 'bss.myhuaweicloud.com') {
  validateKey(key);
  const request = signedHuaweiRequest(endpoint, route, key, now, options);
  const body = await requestJson(fetchImpl, request.url, request.options);
  if (body.error_code !== undefined) throw new Error(/forbidden|denied|unauthoriz|permission/i.test(String(body.error_code)) ? 'permission_denied' : 'collection_failed');
  return body;
}
export async function collectHuaweiBalance(key, fetchImpl, now) {
  const body = await api(key, now, fetchImpl, '/v2/accounts/customer-accounts/balances');
  const rows = body.account_balances;
  if (!Array.isArray(rows) || body.currency !== 'CNY' || Number(body.measure_id) !== 1) throw new Error('dataset_unavailable');
  const cash = rows.filter(row => Number(row.account_type) === 1);
  if (!cash.length || cash.some(row => row.currency !== 'CNY' || Number(row.measure_id) !== 1)) throw new Error('dataset_unavailable');
  const amount = cash.reduce((sum, row) => sum + number(row.amount, { signed: true }), 0);
  return { values: { 'huawei.cash': freshValue(amount, now) }, issues: {} };
}
export async function collectHuaweiCoupons(key, fetchImpl, now) {
  let total = 0; let expected; let received = 0; const seen = new Set();
  for (let offset = 0; offset < 10_000; offset += 100) {
    const body = await api(key, now, fetchImpl, '/v2/promotions/benefits/coupons', { query: { coupon_type: 1, offset, limit: 100 } });
    const count = number(body.count);
    if (!Number.isSafeInteger(count) || count < 0 || (expected !== undefined && count !== expected) || !Array.isArray(body.user_coupons)) throw new Error('dataset_unavailable');
    expected = count;
    for (const row of body.user_coupons) {
      if (typeof row.coupon_id !== 'string' || seen.has(row.coupon_id) || Number(row.coupon_type) !== 1) throw new Error('dataset_unavailable');
      seen.add(row.coupon_id);
      const start = Date.parse(row.valid_time); const end = Date.parse(row.expire_time);
      if (!Number.isFinite(start) || !Number.isFinite(end)) throw new Error('dataset_unavailable');
      if (!([2, 3].includes(Number(row.status))) || start > now || end <= now || String(row.is_frozen) !== '0') continue;
      if (Number(row.status) === 3 && Number(row.coupon_version) !== 2) continue;
      if (row.currency !== 'CNY' || Number(row.measure_id) !== 1) throw new Error('dataset_unavailable');
      total += number(row.balance);
    }
    received += body.user_coupons.length;
    if (received === expected) return { values: { 'huawei.coupons': freshValue(total, now) }, issues: {} };
    if (received > expected || body.user_coupons.length < 100) throw new Error('dataset_unavailable');
  }
  throw new Error('dataset_unavailable');
}
export async function collectHuaweiServerPrice(host, key, fetchImpl, now) {
  if (!['hwa', 'hwb'].includes(host)) throw new Error('key_invalid');
  const target = key.servers?.[host];
  if (!target || !/^[a-z][a-z0-9-]{2,39}$/.test(target.regionId) || !/^[a-f0-9]{32}$/i.test(target.projectId) || !/^[a-f0-9-]{36}$/i.test(target.serverId)) throw new Error('key_invalid');
  const body = await api(key, now, fetchImpl, `/v1/${target.projectId}/cloudservers/detail`, { query: { server_id: target.serverId } }, `ecs.${target.regionId}.myhuaweicloud.com`);
  const server = body.servers?.[0];
  if (!Array.isArray(body.servers) || body.servers.length !== 1 || server.id !== target.serverId || !['0', '1', '2'].includes(server.metadata?.charging_mode)) throw new Error('dataset_unavailable');
  const mode = { 0: 'on_demand', 1: 'prepaid', 2: 'spot' }[server.metadata.charging_mode];
  const values = { [`server.${host}.billing_mode`]: freshValue(Number(server.metadata.charging_mode), now, { billingMode: mode }) };
  if (mode !== 'on_demand') return { values, issues: { [`server.${host}.hourly_price`]: 'unsupported_billing_mode' } };
  const os = { Windows: 'win', Linux: 'linux' }[server.metadata.os_type];
  if (!os || typeof server.flavor?.id !== 'string' || !/^[a-z0-9.\-]{2,80}$/i.test(server.flavor.id)) throw new Error('dataset_unavailable');
  const id = `quote-${host}`;
  const quote = await api(key, now, fetchImpl, '/v2/bills/ratings/on-demand-resources', { method: 'POST', body: {
    project_id: target.projectId, inquiry_precision: 1,
    product_infos: [{ id, cloud_service_type: 'hws.service.type.ec2', resource_type: 'hws.resource.type.vm', resource_spec: `${server.flavor.id}.${os}`, region: target.regionId, usage_factor: 'Duration', usage_value: 1, usage_measure_id: 4, subscription_num: 1 }],
  } });
  if (!['CNY', '', null].includes(quote.currency) || Number(quote.measure_id) !== 1 || !Array.isArray(quote.product_rating_results) || quote.product_rating_results.length !== 1 || quote.product_rating_results[0].id !== id || Number(quote.product_rating_results[0].measure_id) !== 1) throw new Error('dataset_unavailable');
  values[`server.${host}.hourly_price`] = freshValue(number(quote.product_rating_results[0].amount), now);
  return { values, issues: {} };
}

export async function collectHuaweiMonitor(host, key, fetchImpl, now) {
  const target = key.servers?.[host];
  if (!['hwa', 'hwb'].includes(host) || !target || !/^[a-z][a-z0-9-]{2,39}$/.test(target.regionId) || !/^[a-f0-9]{32}$/i.test(target.projectId) || !/^[a-f0-9-]{36}$/i.test(target.serverId)) throw new Error('key_invalid');
  const values = {}; const issues = {};
  for (const [name, namespace, metric] of [['cpu', 'SYS.ECS', 'cpu_util'], ['memory', 'AGT.ECS', 'mem_usedPercent'], ['disk', 'AGT.ECS', 'disk_usedPercent']]) {
    const id = `server.${host}.${name}`;
    try {
      const body = await api(key, now, fetchImpl, `/V1.0/${target.projectId}/metric-data`, { query: { namespace, metric_name: metric, 'dim.0': `instance_id,${target.serverId}`, from: now - 900000, to: now, period: 300, filter: 'average' } }, `ces.${target.regionId}.myhuaweicloud.com`);
      const rows = body.datapoints;
      if (!Array.isArray(rows)) throw new Error('dataset_unavailable');
      if (rows.length === 0) throw new Error(name === 'cpu' ? 'empty_dataset' : 'agent_no_data');
      const latest = rows.reduce((a, b) => a.timestamp > b.timestamp ? a : b);
      const at = number(latest.timestamp); const used = number(latest.average);
      if (at > now || now - at > 900000 || used > 100) throw new Error('dataset_unavailable');
      values[id] = freshValue(used, at);
    } catch (error) { issues[id] = issueCode(error); }
  }
  return { values, issues };
}
