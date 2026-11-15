import { createHash, createHmac } from 'node:crypto';
import { requestJson } from './http.mjs';
import { freshValue, number } from './model.mjs';
export async function collectTencentSes(key, fetchImpl, now) {
  if (!key || typeof key.secretId !== 'string' || !/^[A-Za-z0-9]{8,128}$/.test(key.secretId) || typeof key.secretKey !== 'string' || !key.secretKey || !['ap-hongkong', 'ap-guangzhou', 'ap-singapore'].includes(key.region)) throw new Error('key_invalid');
  const end = new Date(now + 8 * 3600000).toISOString().slice(0, 10);
  const body = JSON.stringify({ StartDate: end.slice(0, 7) + '-01', EndDate: end, Domain: 'm4.windrisebridge.com' });
  const timestamp = Math.floor(now / 1000); const date = new Date(now).toISOString().slice(0, 10);
  const hash = text => createHash('sha256').update(text).digest('hex');
  const hmac = (secret, text) => createHmac('sha256', secret).update(text).digest();
  const canonical = `POST\n/\n\ncontent-type:application/json; charset=utf-8\nhost:ses.tencentcloudapi.com\nx-tc-action:getstatisticsreport\n\ncontent-type;host;x-tc-action\n${hash(body)}`;
  const scope = `${date}/ses/tc3_request`;
  const signing = hmac(hmac(hmac(`TC3${key.secretKey}`, date), 'ses'), 'tc3_request');
  const signature = createHmac('sha256', signing).update(`TC3-HMAC-SHA256\n${timestamp}\n${scope}\n${hash(canonical)}`).digest('hex');
  const result = await requestJson(fetchImpl, 'https://ses.tencentcloudapi.com/', { method: 'POST', headers: {
    'content-type': 'application/json; charset=utf-8', 'x-tc-action': 'GetStatisticsReport', 'x-tc-version': '2020-10-02', 'x-tc-region': key.region, 'x-tc-timestamp': String(timestamp),
    authorization: `TC3-HMAC-SHA256 Credential=${key.secretId}/${scope}, SignedHeaders=content-type;host;x-tc-action, Signature=${signature}`,
  }, body });
  const error = result.Response?.Error?.Code;
  if (error) throw new Error(/UnauthorizedOperation|NoPermission|AuthFailure/i.test(String(error)) ? 'permission_denied' : 'collection_failed');
  if (!result.Response?.OverallVolume) throw new Error('dataset_unavailable');
  return { values: { 'tencent_ses.month.sent': freshValue(number(result.Response.OverallVolume.AcceptedCount), now) }, issues: {} };
}
