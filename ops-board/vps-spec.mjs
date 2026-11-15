const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const iso = value => typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
const integer = value => Number.isSafeInteger(value) && value >= 0;
export function validateVpsReport(report) {
  if (!exact(report, ['version', 'collectedAt', 'cpuPercent', 'memoryPercent', 'diskPercent', 'uptimeSeconds', 'traffic']) || report.version !== 1 || !iso(report.collectedAt) || !['cpuPercent', 'memoryPercent', 'diskPercent'].every(key => typeof report[key] === 'number' && Number.isFinite(report[key]) && report[key] >= 0 && report[key] <= 100) || !integer(report.uptimeSeconds)) throw new Error('report_invalid');
  const traffic = report.traffic;
  if (!exact(traffic, ['month', 'usedBytes', 'observedSince', 'complete']) || traffic.month !== report.collectedAt.slice(0, 7) || !integer(traffic.usedBytes) || !iso(traffic.observedSince) || traffic.observedSince > report.collectedAt || traffic.observedSince.slice(0, 7) !== traffic.month || traffic.complete !== false || Buffer.byteLength(JSON.stringify(report)) > 4096) throw new Error('report_invalid');
  return report;
}
