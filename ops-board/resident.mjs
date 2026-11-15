import { collect, emptyState } from '../ops-status/collector.mjs';
import { validateSnapshot } from './snapshot.mjs';
import { CATALOG, buildMetric } from '../ops-status/model.mjs';
import { vpsMetricValues } from './vps-metrics.mjs';

export function createResidentCollector({ dependencies, now = Date.now, interval = 900000, collectImpl = collect, setTimer = setInterval, clearTimer = clearInterval, log = console.log }) {
  let state = emptyState(); let record = null; let running = null; let timer = null; let stopped = false;
  let latestVps = null;
  const updateVps = snapshot => {
    const result = vpsMetricValues(latestVps);
    Object.assign(state.cache, result.values);
    snapshot.metrics = snapshot.metrics.map(metric => {
      const def = CATALOG.find(item => item.id === metric.id);
      if (def.source !== 'vps') return metric;
      if (result.issues[def.id]) state.failures[def.id] = result.issues[def.id]; else delete state.failures[def.id];
      return buildMetric(def, state.cache[def.id], result.issues[def.id], now());
    });
    return snapshot;
  };
  const tick = () => {
    if (stopped) return Promise.resolve();
    if (running) return running;
    running = (async () => {
      try {
        const result = await collectImpl({ ...dependencies, probes: { ...dependencies.probes, vpsReport: () => latestVps }, now: now(), state, mode: 'local' });
        const snapshot = validateSnapshot(updateVps(result.snapshot));
        state = result.state;
        record = { snapshot, collectedAt: new Date(now()).toISOString() };
        log('collection_complete');
      } catch { log('collection_failed'); }
      finally { running = null; }
    })();
    return running;
  };
  return {
    start() {
      if (stopped) return Promise.resolve();
      if (timer === null) { timer = setTimer(tick, interval); timer?.unref?.(); }
      return tick();
    },
    getRecord: () => record,
    acceptVpsReport(report) {
      latestVps = report;
      if (record) record = { snapshot: validateSnapshot(updateVps({ ...record.snapshot })), collectedAt: new Date(now()).toISOString() };
    },
    async stop() { stopped = true; if (timer !== null) clearTimer(timer); await running; },
  };
}
