import { createHash, scrypt as derive, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
const scrypt = promisify(derive);
export const hashToken = token => createHash('sha256').update(token).digest('hex');
const hex = (value, size) => typeof value === 'string' && new RegExp(`^[a-f0-9]{${size}}$`).test(value);
export function validateAuth(config) {
  if (!config || Object.keys(config).sort().join(',') !== 'passwordHash,passwordSalt,version,vpsTokenHash' || config.version !== 2 || !hex(config.passwordHash, 64) || !hex(config.passwordSalt, 32) || !hex(config.vpsTokenHash, 64)) throw new Error('auth_config_invalid');
  return config;
}
function equal(a, b) { return a.length === b.length && timingSafeEqual(a, b); }
export function createAuth(config, now = Date.now) {
  validateAuth(config);
  const tokenHash = Buffer.from(config.vpsTokenHash, 'hex');
  let cached = null; let running = 0; let attempts = 0; let window = now();
  return {
    vpsUpload(header) {
      return typeof header === 'string' && /^Bearer [A-Za-z0-9_-]{43}$/.test(header) && equal(Buffer.from(hashToken(header.slice(7)), 'hex'), tokenHash);
    },
    async reader(header) {
      if (typeof header !== 'string' || header.length > 2048 || !/^Basic [A-Za-z0-9+/]+={0,2}$/.test(header)) return false;
      const digest = createHash('sha256').update(header).digest();
      if (cached && equal(cached, digest)) return true;
      if (now() - window >= 60_000) { attempts = 0; window = now(); }
      if (running >= 2 || attempts >= 10) return false;
      attempts++; running++;
      try {
        const text = Buffer.from(header.slice(6), 'base64').toString('utf8');
        if (!text.startsWith('owner:')) return false;
        const password = text.slice(6);
        if (Buffer.byteLength(password) < 16 || Buffer.byteLength(password) > 256) return false;
        const derived = await scrypt(password, Buffer.from(config.passwordSalt, 'hex'), 32, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
        if (!equal(derived, Buffer.from(config.passwordHash, 'hex'))) return false;
        cached = digest;
        return true;
      } finally { running--; }
    },
  };
}
