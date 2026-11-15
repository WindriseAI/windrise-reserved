import { freshValue, number } from './model.mjs';
import { expiryValue } from './public-status.mjs';

export async function collectSubscription(key, fetchImpl, now) {
  let response;
  try {
    const url = new URL(key.url);
    if (url.protocol !== 'https:' || url.username || url.password || url.hash || url.port && url.port !== '443') throw new Error();
    response = await fetchImpl(url.href, { method: 'GET', headers: { 'user-agent': 'clash-verge/2' }, redirect: 'error', signal: AbortSignal.timeout(15000) });
    if (!response.ok) throw new Error();
    const header = response.headers.get('subscription-userinfo');
    if (!header || header.length > 4096) throw new Error();
    const fields = {};
    for (const part of header.split(';')) {
      const match = /^\s*(upload|download|total|expire)\s*=\s*(\d+)\s*$/.exec(part);
      if (!match || Object.hasOwn(fields, match[1])) throw new Error();
      const value = number(match[2]);
      if (!Number.isSafeInteger(value)) throw new Error();
      fields[match[1]] = value;
    }
    if (!['upload', 'download', 'total'].every(name => Object.hasOwn(fields, name)) || !Number.isSafeInteger(fields.upload + fields.download)) throw new Error();
    const values = { 'server.raksmart.traffic': freshValue(fields.upload + fields.download, now, { limit: fields.total }) };
    const issues = {};
    if (fields.expire > 0 && fields.expire * 1000 <= 8640000000000000) values['server.raksmart.subscription_expiry_days'] = expiryValue(new Date(fields.expire * 1000).toISOString(), now);
    else issues['server.raksmart.subscription_expiry_days'] = 'dataset_unavailable';
    return { values, issues };
  } catch { throw new Error('subscription_unavailable'); }
  finally { try { await response?.body?.cancel(); } catch {} }
}
