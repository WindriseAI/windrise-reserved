import { requestJson } from './http.mjs';
import { freshValue, number } from './model.mjs';
export async function collectCloady(key, fetchImpl, now) {
  if (!key || typeof key.apiToken !== 'string' || !/^cldy_[a-f0-9]{48}$/.test(key.apiToken)) throw new Error('key_invalid');
  const body = await requestJson(fetchImpl, 'https://cloady.com/api/workspaces/titaa-mutiii/apps/windrise-reserved/services/app/usage?env=production&region=use1&range=15m', { method: 'GET', headers: { authorization: `Bearer ${key.apiToken}` } });
  if (body.error || !body.month || !body.limits) throw new Error('dataset_unavailable');
  const values = {};
  for (const [name, field] of [['traffic', 'traffic'], ['requests', 'requests'], ['cpu_hours', 'cpu'], ['memory_gb_hours', 'memory']]) {
    values[`server.cloady.${name}`] = freshValue(number(body.month[field]), now, { limit: number(body.limits[field]) });
  }
  return { values, issues: {} };
}
