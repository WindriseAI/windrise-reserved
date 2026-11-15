import { createHash, createHmac, randomUUID } from 'node:crypto';
import { issueCode, providerIssue } from './reasons.mjs';

// Discard headers, URLs and provider messages; retain only allowlisted error codes.
export async function requestJson(fetchImpl, url, options) {
  try {
    const response = await fetchImpl(url, { ...options, redirect: 'error', signal: AbortSignal.timeout(15_000) });
    if (!response.ok) {
      const body = await response.json().catch(() => null);
      const code = body?.Code ?? body?.code ?? body?.error_code ?? body?.Response?.Error?.Code;
      const issue = code === undefined && [401, 403].includes(response.status) && body?.errors?.some(row => [1000, 10000, 9109].includes(row.code))
        ? 'permission_denied' : providerIssue(code);
      throw new Error(issue);
    }
    const body = await response.json();
    if (!body || typeof body !== 'object') throw new Error('empty_response');
    return body;
  } catch (error) {
    throw new Error(issueCode(error));
  }
}

export function encode(value) {
  return encodeURIComponent(String(value)).replace(/[!'()*]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
}

// RPC v1 remains supported by these read APIs; no SDK/default credential chain.
// https://help.aliyun.com/zh/sdk/product-overview/rpc-mechanism
function signedRpcParameters(action, version, key, params, now, nonce, method) {
  const values = { ...params, Action: action, Version: version, Format: 'JSON', AccessKeyId: key.accessKeyId,
    SignatureMethod: 'HMAC-SHA1', SignatureVersion: '1.0', SignatureNonce: nonce,
    Timestamp: new Date(now).toISOString().replace(/\.\d{3}Z$/, 'Z') };
  const query = Object.keys(values).sort().map(name => `${encode(name)}=${encode(values[name])}`).join('&');
  const signature = createHmac('sha1', `${key.accessKeySecret}&`).update(`${method}&%2F&${encode(query)}`).digest('base64');
  return `${query}&Signature=${encode(signature)}`;
}

export function signedRpcUrl(endpoint, action, version, key, params, now, nonce = randomUUID()) {
  return `https://${endpoint}/?${signedRpcParameters(action, version, key, params, now, nonce, 'GET')}`;
}

export async function rpc(fetchImpl, endpoint, action, version, key, params, now) {
  // Official metadata: only Dysmsapi/2017-05-25/QuerySendStatistics is POST-only.
  const method = endpoint === 'dysmsapi.aliyuncs.com' && version === '2017-05-25' && action === 'QuerySendStatistics' ? 'POST' : 'GET';
  const query = signedRpcParameters(action, version, key, params, now, randomUUID(), method);
  const url = `https://${endpoint}/`;
  const body = await requestJson(fetchImpl, method === 'GET' ? `${url}?${query}` : url,
    method === 'GET' ? { method } : { method, headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: query });
  if (body.Success === false || (body.Code !== undefined && !['Success', 'OK', '200'].includes(String(body.Code)))) throw new Error(providerIssue(body.Code));
  return body;
}

export function accountFingerprint(key) {
  return createHash('sha256').update(JSON.stringify({ accountId: key.accountId, accessKeyId: key.accessKeyId, secretId: key.secretId, databaseId: key.databaseId, instanceId: key.instanceId, regionId: key.regionId, servers: key.servers, identities: key.identities, subscriptionUrl: key.url })).digest('hex');
}

// SWAS documents ACS3; all ListInstances parameters are query parameters.
export function signedRpcV3(endpoint, action, version, key, params, now, nonce = randomUUID(), method = 'GET') {
  const query = Object.keys(params).sort().map(name => `${encode(name)}=${encode(params[name])}`).join('&');
  const hash = value => createHash('sha256').update(value).digest('hex');
  const payload = hash('');
  const headers = { host: endpoint, 'x-acs-action': action, 'x-acs-version': version,
    'x-acs-date': new Date(now).toISOString().replace(/\.\d{3}Z$/, 'Z'), 'x-acs-signature-nonce': nonce, 'x-acs-content-sha256': payload };
  const names = Object.keys(headers).sort();
  const signedHeaders = names.join(';');
  const canonical = `${method}\n/\n${query}\n${names.map(name => `${name}:${headers[name]}\n`).join('')}\n${signedHeaders}\n${payload}`;
  const signature = createHmac('sha256', key.accessKeySecret).update(`ACS3-HMAC-SHA256\n${hash(canonical)}`).digest('hex');
  headers.authorization = `ACS3-HMAC-SHA256 Credential=${key.accessKeyId},SignedHeaders=${signedHeaders},Signature=${signature}`;
  return { url: `https://${endpoint}/?${query}`, options: { method, headers } };
}
