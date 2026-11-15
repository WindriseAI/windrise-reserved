export const DOMAINS = ['windrisebridge.com', 'windrisebridge.cn', 'windrise.si', 'secrethq.shop'];
export const CLOUDFLARE_DOMAINS = DOMAINS.filter(domain => domain !== 'windrisebridge.cn');
export const CLOADY_HOST = 'windrise-reserved-ole8xig4-titaa-mutiii.cloady.io';
export const CERTIFICATES = {
  website_cn: 'windrisebridge.cn', website_cn_www: 'www.windrisebridge.cn',
  website_en: 'windrisebridge.com', website_en_www: 'www.windrisebridge.com',
  gateway: 'gw.windrise.si', activation: 'api.secrethq.shop', mcp: 'mcp.windrise.si', cloady: CLOADY_HOST,
};
export const domainSlug = domain => domain.replaceAll('.', '_');
const expiry = { expiry: true, refreshMs: 86400000 };
const manual = { manual: true, refreshMs: 86400000, accounting: 'manual_as_of' };
const item = (id, source, label, unit, options = {}) => ({ id, source, label, unit, limit: null, period: 'as-of-collection', refreshMs: 900000, ...options });
export const EXTRA_CATALOG = [
  ...['aleg', 'hwa', 'hwb', 'raksmart'].flatMap(host => [
    item(`server.${host}.reachable`, host === 'raksmart' ? 'localHost' : 'connectivity', `${host} 连通`, '布尔'),
    ...['cpu', 'memory', 'disk'].map(name => item(`server.${host}.${name}`, host === 'raksmart' ? 'localHost' : 'cloudMonitor', `${host} ${name === 'cpu' ? 'CPU' : name === 'memory' ? '内存已用' : '磁盘已用'}`, host === 'aleg' && name !== 'cpu' ? '字节' : '%', { limit: host === 'aleg' && name !== 'cpu' ? null : 100, decimal: host !== 'aleg' || name === 'cpu' })),
    ...(host === 'raksmart' ? [item(`server.${host}.uptime`, 'localHost', 'RakSmart 运行时间', '秒')] : []),
  ]),
  ...['hwa', 'hwb'].flatMap(host => [
    item(`server.${host}.hourly_price`, 'huawei', `${host} ECS 实例每小时询价`, 'CNY/小时', { decimal: true, refreshMs: 86400000, accounting: 'quote_compute_only_not_invoice' }),
    item(`server.${host}.billing_mode`, 'huawei', `${host} 计费模式`, '枚举', { refreshMs: 86400000 }),
  ]),
  item('server.aleg.traffic', 'swasTraffic', '轻量服务器周期出网流量', '字节', { period: 'provider-month' }),
  item('huawei.cash', 'huawei', '华为云现金余额', 'CNY', { decimal: true, lowWarning: 20 }),
  item('huawei.coupons', 'huawei', '华为云有效代金券余额', 'CNY', { decimal: true, refreshMs: 86400000, accounting: 'coupon_restrictions_not_cash' }),
  item('server.cloady.reachable', 'connectivity', 'Cloady HTTPS 连通', '布尔'),
  item('server.raksmart.expiry_days', 'manual', 'RakSmart 账单距到期天数', '天', { ...manual, ...expiry }),
  item('server.raksmart.monthly_price', 'manual', 'RakSmart 月费', 'USD/月', { ...manual, decimal: true }),
  ...[['traffic', '字节'], ['requests', '次'], ['cpu_hours', '小时'], ['memory_gb_hours', 'GB小时']].map(([name, unit]) => item(`server.cloady.${name}`, 'cloady', `Cloady 本月${name}`, unit, { period: 'utc-month', decimal: true })),
  item('server.raksmart.traffic', 'localTraffic', 'RakSmart 本机累计月流量', '字节', { period: 'utc-month', limit: 1024 * 1000000000, accounting: 'local_interface_since_observation_not_provider_invoice' }),
  ...['day', 'month'].flatMap(period => [
    item(`sms.${period}.sent`, 'aliyunSms', `短信${period === 'day' ? '今日' : '本月'}计费发送条数`, '条', { period: `asia-shanghai-${period}` }),
    item(`sms.${period}.success`, 'aliyunSms', `短信${period === 'day' ? '今日' : '本月'}成功回执`, '条', { period: `asia-shanghai-${period}` }),
    item(`sms.${period}.failed`, 'aliyunSms', `短信${period === 'day' ? '今日' : '本月'}失败回执`, '条', { period: `asia-shanghai-${period}` }),
  ]),
  item('sms.month.estimated_cost', 'aliyunSms', '短信本月估算费用', 'CNY', { decimal: true, period: 'asia-shanghai-month', accounting: 'estimated_without_package_deduction_not_invoice' }),
  item('sms.package_remaining', 'smsPackages', '短信有效资源包余量', '条'),
  item('tencent_ses.month.sent', 'tencentSes', '腾讯 SES 本月通过数量', '封', { period: 'asia-shanghai-month' }),
  item('tencent_ses.gift_remaining', 'manual', '腾讯 SES 剩余赠额', '封', manual),
  ...DOMAINS.map(domain => item(`domain.${domainSlug(domain)}.expiry_days`, 'domains', `${domain} 距到期天数`, '天', expiry)),
  ...Object.entries(CERTIFICATES).map(([name, host]) => item(`cert.${name}.expiry_days`, 'certificates', `${host} 证书距到期天数`, '天', expiry)),
  ...DOMAINS.map(domain => item(`domain.${domainSlug(domain)}.renewal_price`, 'manual', `${domain} 续费参考价`, 'CNY/年', { ...manual, decimal: true })),
  item('cf.tunnels', 'cfResources', 'Cloudflare 命名隧道数', '个', { limit: 1000 }),
  ...CLOUDFLARE_DOMAINS.map(domain => item(`cf.dns.${domainSlug(domain)}`, 'cfResources', `${domain} DNS 记录数`, '条')),
  ...[['evsign', 'Windows 签名'], ['mac_signing', 'Mac 代签'], ['feishu', '飞书企业邮箱']].flatMap(([name, label]) => [
    item(`manual.${name}.expiry_days`, 'manual', `${label}距到期天数`, '天', { ...manual, ...expiry }),
    item(`manual.${name}.annual_price`, 'manual', `${label}年费`, 'CNY/年', { ...manual, decimal: true }),
  ]),
  item('manual.feishu.seats', 'manual', '飞书企业邮箱席位', '个', manual),
  ...[['creem', 'Creem', 'USD', 'https://creem.io/dashboard'], ['alipay', '支付宝', 'CNY', 'https://b.alipay.com/']].flatMap(([name, label, currency, consoleUrl]) => [
    ...[['count', '收款笔数', '笔'], ['amount', '收款金额', currency], ['fees', '手续费', currency], ['refunds', '退款金额', currency], ['disputes', '拒付笔数', '笔']].map(([field, text, unit]) => item(`payments.${name}.${field}`, 'paymentConsole', `${label}本月${text}`, unit, { decimal: unit !== '笔', period: 'provider-month', consoleUrl, accounting: 'console_only' })),
  ]),
  item('github.actions_minutes', 'githubConsole', 'GitHub Actions 分钟数', '分钟', { consoleUrl: 'https://github.com/settings/billing/usage', accounting: 'console_only' }),
  item('github.artifact_storage', 'githubConsole', 'GitHub Actions 产物存储', '字节', { consoleUrl: 'https://github.com/settings/billing/usage', accounting: 'console_only' }),
];
