import defaults from './config.json' with { type: 'json' };
import { KEY_FILES } from './credentials.mjs';

export async function runtimeDependencies(environment = process.env) {
  const supplied = JSON.parse(environment.OPS_BOARD_QUERY_KEYS ?? '{}');
  if (!supplied || typeof supplied !== 'object' || Array.isArray(supplied) || Object.keys(supplied).some(source => !Object.hasOwn(KEY_FILES, source))) throw new Error('query_config_invalid');
  const keys = {}; const problems = {};
  for (const source of Object.keys(KEY_FILES)) {
    const key = supplied[source];
    if (key === undefined) { keys[source] = null; problems[source] = 'key_missing'; }
    else if (!key || typeof key !== 'object' || Array.isArray(key)) { keys[source] = null; problems[source] = 'key_invalid'; }
    else keys[source] = key;
  }
  if (typeof environment.OPS_BOARD_SUBSCRIPTION_URL === 'string' && environment.OPS_BOARD_SUBSCRIPTION_URL) keys.subscription = { url: environment.OPS_BOARD_SUBSCRIPTION_URL };
  Object.assign(keys, { domains: {}, certificates: {}, manual: {}, connectivity: {}, vps: {}, paymentConsole: {}, githubConsole: {} });
  keys.cloudMonitor = keys.huawei ? { identities: [keys.huawei.accessKeyId, keys.huawei.servers] } : null;
  keys.cfResources = keys.cloudflare;
  delete environment.OPS_BOARD_QUERY_KEYS; delete environment.OPS_BOARD_SUBSCRIPTION_URL;
  return { keys, problems, config: defaults, fetchImpl: globalThis.fetch, calibration: true };
}
