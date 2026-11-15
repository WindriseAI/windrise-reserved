import { lstat, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';

export const DESKTOP_KEY_DIRECTORY = 'C:/Users/aa/Desktop/风桥-密钥/运营状态单只读钥匙';
export const KEY_DIRECTORY = DESKTOP_KEY_DIRECTORY;
export const KEY_FILES = Object.freeze({
  cloudflare: 'cloudflare-analytics.json',
  businessD1: 'cloudflare-business-d1.json',
  aliyunBilling: 'aliyun-billing.json',
  directMail: 'aliyun-directmail.json',
  swas: 'aliyun-swas.json',
  huawei: 'huawei-readonly.json',
  aliyunSms: 'aliyun-sms.json',
  smsPackages: 'aliyun-sms-packages.json',
  tencentSes: 'tencent-ses.json',
  cloady: 'cloady-readonly.json',
});

async function secureRead(file) {
  if (process.platform !== 'win32') throw new Error('desktop_keys_only');
  const directory = await lstat(KEY_DIRECTORY);
  const stat = await lstat(file);
  if (directory.isSymbolicLink() || !directory.isDirectory() || stat.isSymbolicLink() || !stat.isFile() || stat.size > 16_384) throw new Error('key_invalid');
  const actual = await realpath(file);
  if (path.win32.normalize(actual).toLowerCase() !== path.win32.normalize(file).toLowerCase()) throw new Error('key_invalid');
  return readFile(file, 'utf8');
}

// Injection replaces filesystem access in fixtures. There is no directory/env fallback.
export async function loadKeys(read = secureRead) {
  const keys = {};
  const problems = {};
  for (const [source, name] of Object.entries(KEY_FILES)) {
    try {
      const text = await read(`${KEY_DIRECTORY}/${name}`);
      keys[source] = JSON.parse(text);
      if (!keys[source] || typeof keys[source] !== 'object' || Array.isArray(keys[source])) throw new Error('key_invalid');
    } catch (error) {
      keys[source] = null;
      problems[source] = error?.code === 'ENOENT' ? 'key_missing' : 'key_invalid';
    }
  }
  return { keys, problems };
}

export function cloudflareKey(key, business = false) {
  if (!/^[a-f0-9]{32}$/i.test(key.accountId) || typeof key.apiToken !== 'string' || !key.apiToken.trim()) throw new Error('key_invalid');
  if (business && !/^[a-f0-9-]{36}$/i.test(key.databaseId)) throw new Error('key_invalid');
}

export function aliyunKey(key) {
  if (typeof key.accessKeyId !== 'string' || !key.accessKeyId.trim() || typeof key.accessKeySecret !== 'string' || !key.accessKeySecret.trim()) throw new Error('key_invalid');
}
