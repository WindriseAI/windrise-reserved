import { createHash } from 'node:crypto';
import { isIP } from 'node:net';
import { aliyunKey } from './credentials.mjs';
import { signedRpcV3 } from './http.mjs';
import { buildMetric, freshValue, number, DAY } from './model.mjs';
import { expiryValue, tcpProbe } from './public-status.mjs';

const REGION = /^[a-z][a-z0-9-]{2,39}$/;
const INSTANCE = /^[A-Za-z0-9][A-Za-z0-9-]{7,63}$/;
const TYPES = { swas: { product: 'swas', version: '2020-06-01', regions: 'ListRegions', list: 'ListInstances' }, ecs: { product: 'ecs', version: '2014-05-26', regions: 'DescribeRegions', list: 'DescribeInstances' } };
const reason = error => ['permission_denied', 'dataset_unavailable'].includes(error?.message) ? error.message : 'collection_failed';
export function emptyAliyunServers(missing = true) {
  return { collectedAt: null, status: missing ? '未接' : '失败', reason: missing ? 'key_missing' : 'collection_failed', complete: false, counts: { swas: null, ecs: null }, failures: [], instances: [] };
}
async function api(type, regionId, action, key, params, fetchImpl, now) {
  if (!REGION.test(regionId)) throw new Error('dataset_unavailable');
  const spec = TYPES[type];
  const request = signedRpcV3(`${spec.product}.${regionId}.aliyuncs.com`, action, spec.version, key, params, now);
  try {
    const response = await fetchImpl(request.url, { ...request.options, redirect: 'error', signal: AbortSignal.timeout(15000) });
    if ([401, 403].includes(response.status)) { await response.body?.cancel(); throw new Error('permission_denied'); }
    if (!response.ok) { await response.body?.cancel(); throw new Error('collection_failed'); }
    const body = await response.json();
    if (!body || typeof body !== 'object') throw new Error('dataset_unavailable');
    if (body.Success === false || body.Code !== undefined && !['Success', 'OK', '200'].includes(String(body.Code))) throw new Error(/forbidden|denied|unauthoriz|permission/i.test(String(body.Code)) ? 'permission_denied' : 'collection_failed');
    return body;
  } catch (error) { throw new Error(reason(error)); }
}
async function discover(key, fetchImpl, now) {
  const entries = []; const failures = []; const counts = { swas: 0, ecs: 0 };
  for (const [type, spec] of Object.entries(TYPES)) {
    let regions;
    try {
      const body = await api(type, 'cn-hangzhou', spec.regions, key, {}, fetchImpl, now);
      const rows = type === 'swas' ? body.Regions : body.Regions?.Region;
      if (!Array.isArray(rows) || !rows.length || rows.length > 100 || rows.some(row => !REGION.test(row.RegionId)) || new Set(rows.map(row => row.RegionId)).size !== rows.length) throw new Error('dataset_unavailable');
      regions = rows.map(row => row.RegionId);
    } catch (error) {
      failures.push({ type, regionId: null, action: spec.regions, reason: reason(error) }); counts[type] = null;
      // Existing configured region still works when global discovery is not authorized.
      regions = type === 'swas' && REGION.test(key.regionId) ? [key.regionId] : [];
    }
    for (const regionId of regions) {
      try {
        const found = []; const seen = new Set(); let expected;
        for (let page = 1; page <= 100; page++) {
          const body = await api(type, regionId, spec.list, key, { RegionId: regionId, PageNumber: page, PageSize: 100 }, fetchImpl, now);
          const rows = type === 'swas' ? body.Instances : body.Instances?.Instance;
          const total = number(body.TotalCount);
          if (!Number.isSafeInteger(total) || !Array.isArray(rows) || expected !== undefined && total !== expected) throw new Error('dataset_unavailable');
          expected = total;
          for (const row of rows) {
            if (!INSTANCE.test(row.InstanceId) || seen.has(row.InstanceId) || row.RegionId && row.RegionId !== regionId) throw new Error('dataset_unavailable');
            seen.add(row.InstanceId); found.push({ type, regionId, row });
          }
          if (found.length === total) break;
          if (found.length > total || rows.length < 100 || page === 100) throw new Error('dataset_unavailable');
        }
        entries.push(...found); if (counts[type] !== null) counts[type] += found.length;
      } catch (error) { failures.push({ type, regionId, action: spec.list, reason: reason(error) }); counts[type] = null; }
    }
  }
  return { discoveredAt: now, entries, failures, counts, complete: failures.length === 0 };
}
export function instanceMetricDefinitions(id, type) {
  const item = (name, label, unit, options = {}) => ({ id: `aliyun.${id}.${name}`, source: 'aliyunServers', label, unit, limit: null, period: 'as-of-collection', refreshMs: 900000, decimal: unit === '%', ...options });
  return [item('cpu', 'CPU', '%', { limit: 100 }), item('memory', '内存已用', type === 'swas' ? '字节' : '%', { limit: type === 'swas' ? null : 100 }),
    item('disk', type === 'swas' ? '磁盘已用' : '最高磁盘占用率', type === 'swas' ? '字节' : '%', { limit: type === 'swas' ? null : 100 }),
    item('traffic', type === 'swas' ? '周期公网出流量' : '近15分钟公网出流量', '字节', { period: type === 'swas' ? 'provider-month' : 'last-15-minutes', accounting: type === 'swas' ? 'provider_traffic_package' : 'ecs_monitor_outgoing_not_invoice' }),
    item('expiry_days', '到期', '天', { expiry: true, refreshMs: DAY }), item('reachable', '端口连通', '布尔')];
}
export async function collectAliyunServers(key, fetchImpl, now, previous = null, probe = tcpProbe) {
  aliyunKey(key);
  const inventory = previous?.complete && now >= previous.discoveredAt && now - previous.discoveredAt < DAY ? previous : await discover(key, fetchImpl, now);
  const failures = [...inventory.failures]; const instances = [];
  for (const { type, regionId, row } of inventory.entries) {
    const rawId = row.InstanceId;
    const id = createHash('sha256').update(`${type}:${regionId}:${rawId}`).digest('hex').slice(0, 24);
    const alias = type === 'swas' && rawId === key.instanceId && regionId === key.regionId ? 'aleg' : null;
    const values = {}; const issues = {};
    const set = (name, value) => { values[`aliyun.${id}.${name}`] = value; };
    const fail = (names, action, error) => {
      const why = reason(error);
      for (const name of names) issues[`aliyun.${id}.${name}`] = why;
      failures.push({ type, regionId, action, reason: why });
    };
    const charge = type === 'swas' ? row.ChargeType : row.InstanceChargeType;
    const billingMode = { PrePaid: 'prepaid', PostPaid: 'postpaid' }[charge] ?? 'unknown';
    try {
      if (billingMode === 'postpaid') issues[`aliyun.${id}.expiry_days`] = 'not_applicable';
      else if (billingMode !== 'prepaid') issues[`aliyun.${id}.expiry_days`] = 'dataset_unavailable';
      else set('expiry_days', expiryValue(row.ExpiredTime, inventory.discoveredAt));
    } catch { issues[`aliyun.${id}.expiry_days`] = 'dataset_unavailable'; }
    if (type === 'swas') {
      for (const [name, metric] of [['cpu', 'CPU_UTILIZATION'], ['memory', 'MEMORY_ACTUALUSEDSPACE'], ['disk', 'DISKUSAGE_USED']]) {
        try {
          const body = await api(type, regionId, 'DescribeMonitorData', key, { RegionId: regionId, InstanceId: rawId, MetricName: metric, Period: 300, StartTime: new Date(now - 900000).toISOString(), EndTime: new Date(now).toISOString(), Length: 100 }, fetchImpl, now);
          const rows = JSON.parse(body.Datapoints);
          if (!Array.isArray(rows) || !rows.length || body.NextToken) throw new Error('dataset_unavailable');
          const latest = rows.reduce((a, b) => number(a.timestamp) > number(b.timestamp) ? a : b);
          const used = number(latest.value); const at = number(latest.timestamp);
          if (at > now || now - at > 900000 || name === 'cpu' && used > 100 || name !== 'cpu' && !Number.isSafeInteger(used)) throw new Error('dataset_unavailable');
          set(name, freshValue(used, at));
        } catch (error) { fail([name], 'DescribeMonitorData', error); }
      }
      try {
        const body = await api(type, regionId, 'ListInstancesTrafficPackages', key, { RegionId: regionId, InstanceIds: JSON.stringify([rawId]) }, fetchImpl, now);
        const rows = body.InstanceTrafficPackageUsages;
        if (!Array.isArray(rows) || rows.length !== 1 || rows[0].InstanceId !== rawId) throw new Error('dataset_unavailable');
        const used = number(rows[0].TrafficUsed); const limit = number(rows[0].TrafficPackageTotal);
        if (!Number.isSafeInteger(used) || !Number.isSafeInteger(limit)) throw new Error('dataset_unavailable');
        set('traffic', freshValue(used, now, { limit }));
      } catch (error) { fail(['traffic'], 'ListInstancesTrafficPackages', error); }
    } else {
      try {
        const body = await api(type, regionId, 'DescribeInstanceMonitorData', key, { InstanceId: rawId, StartTime: new Date(now - 900000).toISOString().replace(/\.\d{3}Z$/, 'Z'), EndTime: new Date(now).toISOString().replace(/\.\d{3}Z$/, 'Z'), Period: 60 }, fetchImpl, now);
        const rows = body.MonitorData?.InstanceMonitorData;
        if (!Array.isArray(rows) || !rows.length || rows.some(point => point.InstanceId && point.InstanceId !== rawId)) throw new Error('dataset_unavailable');
        const fresh = rows.filter(point => { const at = Date.parse(point.TimeStamp); return at <= now && at > now - 900000; });
        if (!fresh.length) throw new Error('dataset_unavailable');
        const latest = fresh.reduce((a, b) => Date.parse(a.TimeStamp) > Date.parse(b.TimeStamp) ? a : b);
        try { const used = number(latest.CPU); if (used > 100) throw new Error(); set('cpu', freshValue(used, Date.parse(latest.TimeStamp))); } catch { issues[`aliyun.${id}.cpu`] = 'dataset_unavailable'; }
        try { const used = fresh.reduce((sum, point) => sum + number(point.InternetTX) * 125, 0); if (!Number.isSafeInteger(used)) throw new Error(); set('traffic', freshValue(used, Date.parse(latest.TimeStamp))); } catch { issues[`aliyun.${id}.traffic`] = 'dataset_unavailable'; }
      } catch (error) { fail(['cpu', 'traffic'], 'DescribeInstanceMonitorData', error); }
      for (const [name, metric] of [['memory', 'memory_usedutilization'], ['disk', 'diskusage_utilization']]) {
        try {
          const request = signedRpcV3(`metrics.${regionId}.aliyuncs.com`, 'DescribeMetricLast', '2019-01-01', key, { Namespace: 'acs_ecs_dashboard', MetricName: metric, Dimensions: JSON.stringify([{ instanceId: rawId }]), StartTime: String(now - 900000), EndTime: String(now), Period: 60, Length: 1440 }, now);
          const body = await fetchImpl(request.url, { ...request.options, redirect: 'error', signal: AbortSignal.timeout(15000) });
          if ([401, 403].includes(body.status)) { await body.body?.cancel(); throw new Error('permission_denied'); }
          if (!body.ok) { await body.body?.cancel(); throw new Error('collection_failed'); }
          const data = await body.json();
          if (data.Success !== true || !['200', 'Success'].includes(String(data.Code))) throw new Error(/forbidden|denied|unauthoriz|permission/i.test(String(data.Code)) ? 'permission_denied' : 'dataset_unavailable');
          const rows = JSON.parse(data.Datapoints);
          if (!Array.isArray(rows) || !rows.length || data.NextToken || rows.some(point => point.instanceId !== rawId)) throw new Error('dataset_unavailable');
          const devices = new Map();
          for (const point of rows) {
            const at = number(point.timestamp); const used = number(point.Average);
            if (at > now || now - at > 900000 || used > 100) continue;
            const device = String(point.device ?? 'memory');
            if (!devices.has(device) || at > devices.get(device).at) devices.set(device, { at, used });
          }
          if (!devices.size) throw new Error('dataset_unavailable');
          const highest = [...devices.values()].reduce((a, b) => a.used > b.used ? a : b);
          set(name, freshValue(highest.used, highest.at));
        } catch (error) { fail([name], 'DescribeMetricLast', error); }
      }
    }
    let publicIps = type === 'swas' ? [row.PublicIpAddress] : [...(row.PublicIpAddress?.IpAddress ?? []), row.EipAddress?.IpAddress];
    publicIps = [...new Set(publicIps.filter(ip => typeof ip === 'string' && isIP(ip)))];
    if (alias === 'aleg' && publicIps.includes('47.95.145.46')) {
      try { set('reachable', freshValue(await probe('47.95.145.46', 22), now)); } catch { issues[`aliyun.${id}.reachable`] = 'collection_failed'; }
    } else issues[`aliyun.${id}.reachable`] = alias === 'aleg' ? 'dataset_unavailable' : 'not_applicable';
    const name = typeof row.InstanceName === 'string' ? row.InstanceName.replace(/[\x00-\x1f\x7f]/g, '').slice(0, 128) : '';
    const status = ['Running', 'Starting', 'Stopping', 'Stopped', 'Pending', 'Rebooting', 'Resetting', 'Expired', 'Disabled'].includes(row.Status) ? row.Status : 'Unknown';
    instances.push({ id, alias, type, name, regionId, publicIps, status, billingMode, metrics: instanceMetricDefinitions(id, type).map(def => buildMetric(def, values[def.id], issues[def.id], now)) });
  }
  instances.sort((a, b) => (a.alias === 'aleg' ? -1 : b.alias === 'aleg' ? 1 : `${a.type}:${a.regionId}:${a.id}`.localeCompare(`${b.type}:${b.regionId}:${b.id}`)));
  const uniqueFailures = [...new Map(failures.map(item => [JSON.stringify(item), item])).values()];
  return { inventory, snapshot: { collectedAt: new Date(now).toISOString(), status: uniqueFailures.length ? '失败' : '正常', reason: uniqueFailures.length ? 'collection_failed' : null, complete: inventory.complete, counts: inventory.counts, failures: uniqueFailures, instances } };
}
