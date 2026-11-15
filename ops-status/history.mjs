const histories = new WeakMap();
export const historyEligible = metric => metric.source === 'serviceHealth' || /^(?:server\.[a-z]+|aliyun\.[a-f0-9]{24})\.(?:reachable|cpu|memory|disk|traffic|host_traffic)$/.test(metric.id);
export function appendHistory(snapshot, state, now, source = null) {
  const metrics = [...snapshot.metrics, ...snapshot.aliyunServers.instances.flatMap(row => row.metrics)].filter(historyEligible);
  const previous = histories.get(state) ?? {};
  const history = {};
  for (const metric of metrics) {
    const points = previous[metric.id] ?? [];
    if (source !== null && metric.source !== source) { history[metric.id] = points; continue; }
    const point = { t: new Date(now).toISOString(), v: ['未接', '失败', '未更新', '不适用'].includes(metric.status) ? null : metric.used, status: metric.status };
    if (points.length && points.at(-1).t > point.t) { history[metric.id] = points; continue; }
    const prior = points.at(-1)?.t === point.t ? points.slice(0, -1) : points;
    history[metric.id] = [...prior.slice(-47), point];
  }
  histories.set(state, history);
  snapshot.history = history;
  return snapshot;
}
