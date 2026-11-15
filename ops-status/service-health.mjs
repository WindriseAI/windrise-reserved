import https from 'node:https';
import { SERVICES } from './extra-catalog.mjs';
import { freshValue } from './model.mjs';

const INVALID_TLS = new Set(['CERT_HAS_EXPIRED', 'CERT_NOT_YET_VALID', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'SELF_SIGNED_CERT_IN_CHAIN', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'ERR_TLS_CERT_ALTNAME_INVALID', 'CERT_REVOKED']);
export function httpsProbe(host) {
  if (!Object.values(SERVICES).includes(host)) throw new Error('host_invalid');
  return new Promise(resolve => {
    const started = performance.now(); let finished = false; let certificateValid = null;
    const done = (httpStatus, detail = null) => {
      if (finished) return;
      finished = true; clearTimeout(timer);
      const durationMs = Math.round(performance.now() - started);
      request.destroy(); resolve({ httpStatus, durationMs, certificateValid, detail });
    };
    // One GET, no redirect, cookie, authentication or shared socket; TLS verification stays enabled.
    const request = https.request({ hostname: host, port: 443, path: '/', method: 'GET', agent: false, rejectUnauthorized: true }, response => {
      certificateValid = response.socket.authorized === true;
      done(response.statusCode, certificateValid ? null : 'tls_invalid');
    });
    const timer = setTimeout(() => done(null, 'http_timeout'), 10000);
    request.on('socket', socket => socket.once('secureConnect', () => { certificateValid = socket.authorized === true; }));
    request.on('error', error => {
      if (INVALID_TLS.has(error.code)) certificateValid = false;
      done(null, certificateValid === false ? 'tls_invalid' : 'http_transport');
    });
    request.end();
  });
}
export async function collectServiceHealth(now, probe = httpsProbe) {
  const values = {};
  await Promise.all(Object.entries(SERVICES).map(async ([name, host]) => {
    let result;
    try { result = await probe(host); }
    catch { result = { httpStatus: null, durationMs: null, certificateValid: null, detail: 'http_transport' }; }
    const { httpStatus, durationMs, certificateValid, detail } = result;
    const healthy = certificateValid === true && (httpStatus >= 200 && httpStatus < 400 || httpStatus === 401);
    values[`service.${name}.reachable`] = freshValue(healthy ? 1 : 0, now, { httpStatus, durationMs, certificateValid, serviceIssue: detail ?? (healthy ? null : 'http_status') });
  }));
  return { values, issues: {} };
}
