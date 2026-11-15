import { aliyunKey } from './credentials.mjs';
import { rpc } from './http.mjs';
import { freshValue, number } from './model.mjs';

export async function collectDirectMail(key, fetchImpl, now, limits = {}) {
  aliyunKey(key);
  // This version supports the documented China endpoint; no arbitrary host from a key file.
  const body = await rpc(fetchImpl, 'dm.aliyuncs.com', 'DescAccountSummary', '2015-11-23', key, {}, now);
  const remain = number(body.RemainFreeQuota);
  const daily = number(body.DailyRemainFreeQuota);
  const totalLimit = limits.totalFreeLimit === undefined ? 2000 : number(limits.totalFreeLimit);
  const dayLimit = limits.dailyFreeLimit === undefined ? 200 : number(limits.dailyFreeLimit);
  if (remain > totalLimit || daily > dayLimit) throw new Error('limit_mismatch');
  return { values: {
    'mail.total_free': freshValue(totalLimit - remain, now, { limit: totalLimit }),
    'mail.daily_free': freshValue(dayLimit - daily, now, { limit: dayLimit }),
  }, issues: {} };
}
