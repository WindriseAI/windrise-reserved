import { CATALOG, freshValue } from '../ops-status/model.mjs';
import { validateVpsReport } from './vps-spec.mjs';
export function vpsMetricValues(report) {
  const ids = CATALOG.filter(def => def.source === 'vps').map(def => def.id);
  if (!report) return { values: {}, issues: Object.fromEntries(ids.map(id => [id, 'report_missing'])) };
  validateVpsReport(report);
  const at = Date.parse(report.collectedAt);
  return { values: {
    'server.raksmart.reachable': freshValue(1, at),
    'server.raksmart.cpu': freshValue(report.cpuPercent, at),
    'server.raksmart.memory': freshValue(report.memoryPercent, at),
    'server.raksmart.disk': freshValue(report.diskPercent, at),
    'server.raksmart.uptime': freshValue(report.uptimeSeconds, at),
    'server.raksmart.host_traffic': freshValue(report.traffic.usedBytes, at, { observedSince: report.traffic.observedSince, complete: false }),
  }, issues: {} };
}
