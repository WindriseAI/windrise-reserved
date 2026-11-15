import { createHash, createHmac, scrypt as derive, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
const scrypt = promisify(derive);
export const hashToken = token => createHash('sha256').update(token).digest('hex');
const hex = (value, size) => typeof value === 'string' && new RegExp(`^[a-f0-9]{${size}}$`).test(value);
const COOKIE = '__Host-ops_session';
const YEAR = 365 * 86400;
const LOCK_MS = 15 * 60000;
export function validateAuth(config) {
  if (!config || Object.keys(config).sort().join(',') !== 'passwordHash,passwordSalt,username,version,vpsTokenHash' || config.version !== 3 || typeof config.username !== 'string' || !config.username.length || Buffer.byteLength(config.username) > 128 || /[\x00-\x1f\x7f]/.test(config.username) || !hex(config.passwordHash, 64) || !hex(config.passwordSalt, 32) || !hex(config.vpsTokenHash, 64)) throw new Error('auth_config_invalid');
  return config;
}
function equal(a, b) { return a.length === b.length && timingSafeEqual(a, b); }
export function createAuth(config, { sessionKey, now = Date.now } = {}) {
  validateAuth(config);
  if (typeof sessionKey !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(sessionKey)) throw new Error('session_key_invalid');
  const signingKey = Buffer.from(sessionKey, 'base64url');
  const tokenHash = Buffer.from(config.vpsTokenHash, 'hex');
  const credential = hashToken(config.passwordSalt + config.passwordHash);
  const failures = new Map(); let running = 0;
  const signature = payload => createHmac('sha256', signingKey).update(payload).digest('base64url');
  const state = ip => {
    const value = failures.get(ip);
    if (value?.until && value.until <= now()) { failures.delete(ip); return null; }
    return value;
  };
  return {
    vpsUpload(header) {
      return typeof header === 'string' && /^Bearer [A-Za-z0-9_-]{43}$/.test(header) && equal(Buffer.from(hashToken(header.slice(7)), 'hex'), tokenHash);
    },
    reader(header) {
      if (typeof header !== 'string' || header.length > 4096) return false;
      const matches = header.split(';').map(value => value.trim()).filter(value => value.startsWith(COOKIE + '='));
      if (matches.length !== 1) return false;
      const token = matches[0].slice(COOKIE.length + 1);
      if (token.length > 1024 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/.test(token)) return false;
      const [payload, signed] = token.split('.');
      if (!equal(Buffer.from(signature(payload)), Buffer.from(signed))) return false;
      try {
        const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
        const seconds = Math.floor(now() / 1000);
        return Object.keys(data).sort().join(',') === 'credential,exp,iat,v' && data.v === 1 && data.credential === credential && Number.isSafeInteger(data.iat) && Number.isSafeInteger(data.exp) && data.iat <= seconds && data.exp > seconds && data.exp > data.iat && data.exp - data.iat <= YEAR;
      } catch { return false; }
    },
    async login(username, password, remember, ip) {
      const locked = state(ip);
      if (locked?.until > now()) return { status: 429, retryAfter: Math.ceil((locked.until - now()) / 1000) };
      if (running >= 2) return { status: 429, retryAfter: 1 };
      running++;
      let valid = false;
      try {
        if (typeof username === 'string' && Buffer.byteLength(username) <= 128 && typeof password === 'string' && Buffer.byteLength(password) > 0 && Buffer.byteLength(password) <= 256) {
          const derived = await scrypt(password, Buffer.from(config.passwordSalt, 'hex'), 32, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
          valid = equal(Buffer.from(username), Buffer.from(config.username)) && equal(derived, Buffer.from(config.passwordHash, 'hex'));
        }
      } finally { running--; }
      const current = state(ip);
      if (current?.until > now()) return { status: 429, retryAfter: Math.ceil((current.until - now()) / 1000) };
      if (!valid) {
        const count = (current?.count ?? 0) + 1;
        failures.set(ip, { count, until: count >= 10 ? now() + LOCK_MS : 0 });
        return count >= 10 ? { status: 429, retryAfter: LOCK_MS / 1000 } : { status: 401 };
      }
      failures.delete(ip);
      const issued = Math.floor(now() / 1000); const lifetime = remember ? YEAR : 12 * 3600;
      const payload = Buffer.from(JSON.stringify({ v: 1, iat: issued, exp: issued + lifetime, credential })).toString('base64url');
      const cookie = `${COOKIE}=${payload}.${signature(payload)}; Path=/; HttpOnly; Secure; SameSite=Lax${remember ? `; Max-Age=${YEAR}` : ''}`;
      return { status: 200, cookie };
    },
  };
}
