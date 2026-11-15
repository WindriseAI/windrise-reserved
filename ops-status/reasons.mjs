const DETAILS = new Set(['key_missing', 'key_invalid', 'collection_failed', 'permission_denied', 'dataset_unavailable', 'empty_dataset', 'read_budget', 'clock_rollback', 'stale', 'manual_missing', 'console_only', 'unsupported_billing_mode', 'report_missing', 'not_applicable', 'dimension_conflict', 'traffic_package_empty', 'probe_not_configured', 'rate_not_configured', 'agent_no_data', 'subscription_expiry_missing', 'http_timeout', 'http_transport', 'tls_invalid', 'http_status']);
// Only documented codes cross the response boundary; provider messages never do.
const PROVIDER_PERMISSIONS = new Set(['NoPermission', 'NotAuthorized', 'Unauthorized', 'UnauthorizedOperation', 'Forbidden', 'Forbidden.RAM', 'Forbidden.NoPermission', 'Forbidden.SubUser', 'AccessDenied', 'AccessDenied.RAM', 'AuthorizationDenied', 'PermissionDenied', 'InsufficientPermissions']);
const PROVIDER_FAILURES = new Set(['UnsupportedHTTPMethod', 'InvalidParameter', 'InvalidParameterValue', 'InvalidParameter.Format', 'MissingParameter', 'SignatureDoesNotMatch', 'IncompleteSignature', 'InvalidSignature', 'InvalidSignatureVersion', 'InvalidSignatureMethod', 'SignatureNonceUsed', 'InvalidTimeStamp.Expired', 'InvalidTimeStamp.Format', 'InvalidAccessKeyId', 'InvalidAccessKeyId.NotFound', 'InvalidAccessKeyId.Inactive', 'InvalidSecurityToken.Expired', 'InvalidSecurityToken.Malformed']);
for (const code of [...PROVIDER_PERMISSIONS, ...PROVIDER_FAILURES]) DETAILS.add(code);
export function providerIssue(code) {
  return PROVIDER_PERMISSIONS.has(code) || PROVIDER_FAILURES.has(code) ? code : 'collection_failed';
}
export function issueCode(error) {
  return DETAILS.has(error?.message) ? error.message : 'collection_failed';
}
// A bounded local count, never provider text or action names.
export function isR2UnclassifiedDetail(detail) {
  return typeof detail === 'string' && /^r2_unclassified_operations:(?:0|[1-9]\d{0,15})(?![\s\S])/.test(detail)
    && Number.isSafeInteger(Number(detail.slice('r2_unclassified_operations:'.length)));
}
export function classifyReason(detail) {
  if (detail === null || detail === 'not_applicable' || isR2UnclassifiedDetail(detail)) return null;
  if (PROVIDER_PERMISSIONS.has(detail) || ['key_missing', 'key_invalid', 'permission_denied', 'manual_missing', 'probe_not_configured', 'rate_not_configured', 'console_only'].includes(detail)) return 'not_authorized';
  if (['unsupported_billing_mode', 'traffic_package_empty', 'agent_no_data', 'subscription_expiry_missing'].includes(detail)) return 'not_provided';
  return 'collect_failed';
}
export function reasonDetail(detail) {
  return detail === null || DETAILS.has(detail) || isR2UnclassifiedDetail(detail) ? detail : 'collection_failed';
}
export const REASON_DETAILS = DETAILS;
export const isFinancial = def => /^(?:CNY|USD|JPY)(?:\/|$)/.test(def.unit);
