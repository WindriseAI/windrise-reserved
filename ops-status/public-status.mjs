import net from 'node:net';
import tls from 'node:tls';
import { requestJson } from './http.mjs';
import { DOMAINS, CERTIFICATES, CLOADY_HOST, domainSlug } from './extra-catalog.mjs';
import { freshValue, DAY } from './model.mjs';

export function expiryValue(expires, now, extra = {}) {
  if (typeof expires !== 'string' || !/^\d{4}-\d\d-\d\d(?:T.*(?:Z|[+-]\d\d:\d\d))?$/.test(expires) || !Number.isFinite(Date.parse(expires))) throw new Error('expiry_unavailable');
  const expiresAt = expires.length === 10 ? expires : new Date(expires).toISOString();
  return freshValue(Math.ceil((Date.parse(expiresAt) - now) / DAY), now, { expiresAt, ...extra });
}
export function whois(domain) {
  const host = { 'windrisebridge.cn': 'whois.cnnic.cn', 'windrise.si': 'whois.arnes.si', 'secrethq.shop': 'whois.nic.shop' }[domain];
  if (!host) throw new Error('domain_invalid');
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host, port: 43 }); let text = '';
    const fail = () => { socket.destroy(); reject(new Error('domain_unavailable')); };
    socket.setTimeout(10000, fail); socket.on('error', fail);
    socket.on('connect', () => socket.end(`${domain}\r\n`));
    socket.on('data', chunk => { text += chunk.toString('utf8'); if (Buffer.byteLength(text) > 131072) fail(); });
    socket.on('end', () => {
      const value = text.match(/^(?:Registry Expiry Date|Registrar Registration Expiration Date|Expiration Time|Expiry date|expire|expires):\s*(.+)$/im)?.[1]?.trim();
      if (!value) return fail();
      // CNNIC publishes local Beijing time without a timezone.
      resolve(/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/.test(value) && domain.endsWith('.cn') ? value.replace(' ', 'T') + '+08:00' : value);
    });
  });
}
export async function collectDomains(fetchImpl, now, readWhois = whois) {
  const values = {}; const issues = {};
  for (const domain of DOMAINS) {
    const id = `domain.${domainSlug(domain)}.expiry_days`;
    try {
      let expires;
      if (domain.endsWith('.com')) {
        const body = await requestJson(fetchImpl, `https://rdap.verisign.com/com/v1/domain/${domain}`, { method: 'GET' });
        expires = body.events?.find(event => event.eventAction === 'expiration')?.eventDate;
      } else expires = await readWhois(domain);
      values[id] = expiryValue(expires, now);
    } catch { issues[id] = 'collection_failed'; }
  }
  return { values, issues };
}
export function readCertificate(host) {
  if (!Object.values(CERTIFICATES).includes(host)) throw new Error('host_invalid');
  return new Promise((resolve, reject) => {
    const socket = tls.connect({ host, port: 443, servername: host, rejectUnauthorized: true });
    const fail = () => { socket.destroy(); reject(new Error('certificate_unavailable')); };
    socket.setTimeout(10000, fail); socket.on('error', fail);
    socket.on('secureConnect', () => { const value = socket.getPeerCertificate().valid_to; socket.destroy(); if (value && Number.isFinite(Date.parse(value))) resolve(new Date(value).toISOString()); else fail(); });
  });
}
export async function collectCertificates(now, read = readCertificate) {
  const values = {}; const issues = {};
  for (const [name, host] of Object.entries(CERTIFICATES)) {
    const id = `cert.${name}.expiry_days`;
    try { values[id] = expiryValue(await read(host), now); } catch { issues[id] = 'collection_failed'; }
  }
  return { values, issues };
}
export function tcpProbe(host, port) {
  return new Promise(resolve => {
    const socket = net.connect({ host, port });
    const done = value => { socket.destroy(); resolve(value); };
    socket.setTimeout(5000, () => done(0)); socket.on('error', () => done(0)); socket.on('connect', () => done(1));
  });
}
export async function collectConnectivity(config, fetchImpl, now, probe = tcpProbe) {
  const values = {}; const issues = {};
  for (const host of ['hwa', 'hwb']) {
    const target = config.connectivity?.[host]; const id = `server.${host}.reachable`;
    if (!target || !net.isIP(target.host) || !Number.isInteger(target.port) || target.port < 1 || target.port > 65535) { issues[id] = 'dataset_unavailable'; continue; }
    values[id] = freshValue(await probe(target.host, target.port), now);
  }
  try {
    const response = await fetchImpl(`https://${CLOADY_HOST}/healthz`, { redirect: 'error', signal: AbortSignal.timeout(10000) });
    const ok = response.status === 200; await response.body?.cancel();
    values['server.cloady.reachable'] = freshValue(ok ? 1 : 0, now);
  } catch { values['server.cloady.reachable'] = freshValue(0, now); }
  return { values, issues };
}
