/*
 * 运营状态页：只读同源 ./snapshot.json，按页面合同（给用户-运营状态单/快照字段.md）显示。
 * 不请求任何供应商接口，不带钥匙。空值不画成 0；估算和平台统计不标成已扣费。
 * 每次渲染都用当前时间重查每项 collectedAt，超过 staleAfterSeconds 就显示「未更新」。
 */
(function () {
  'use strict';

  var REFETCH_MS = 60000;
  var RETICK_MS = 30000;
  var STATUSES = ['正常', '关注', '警告', '未接', '失败', '未更新'];
  // 一眼要先看到的排前面
  var SEVERITY = { '警告': 6, '失败': 5, '未更新': 4, '关注': 3, '未知': 2, '未接': 1, '正常': 0 };
  var COUNT_ORDER = ['警告', '关注', '未更新', '失败', '未接', '正常'];

  var NAMES = {
    'cf.requests': 'Worker 动态请求',
    'cf.errors': 'Worker 执行错误',
    'cf.cpu_p99_max': '各脚本 CPU P99 中的最大值',
    'cf.d1.read': 'D1 读行',
    'cf.d1.write': 'D1 写行',
    'cf.d1.storage': 'D1 各库当日峰值容量合计',
    'cf.d1.largest': 'D1 最大单库当日峰值',
    'cf.kv.read': 'KV 读取',
    'cf.kv.write': 'KV 写入',
    'cf.kv.delete': 'KV 删除',
    'cf.kv.list': 'KV 列举',
    'cf.kv.storage': 'KV 各空间当日峰值容量合计',
    'cf.r2.a': 'R2 A 类操作',
    'cf.r2.b': 'R2 B 类操作',
    'cf.r2.storage': 'R2 各桶当日峰值容量合计',
    'business.recent_hour': '最近 1 小时有报到记录的电脑',
    'business.today': '今日有报到记录的电脑',
    'business.members.free': '免费账号',
    'business.members.monthly': '月卡',
    'business.members.quarterly': '季卡',
    'business.members.yearly': '年卡',
    'business.members.trial': '试用',
    'business.members.manual': '手动发放',
    'business.members.other': '其他有效权益',
    'aliyun.available': '可用额度',
    'aliyun.cash': '现金余额',
    'aliyun.yesterday_bill': '昨日账单应付',
    'mail.total_free': 'DirectMail 累计免费赠额',
    'mail.daily_free': 'DirectMail 当日免费赠额',
    'server.expiry_days': '阿里云轻量服务器到期',
    'cf.tunnels': '命名隧道',
    'huawei.cash': '现金余额',
    'huawei.coupons': '有效代金券',
    'sms.month.estimated_cost': '本月估算费用',
    'sms.package_remaining': '有效资源包余量',
    'tencent_ses.month.sent': '本月通过数量',
    'tencent_ses.gift_remaining': '剩余赠额'
  };

  // 服务器分主机显示：行内用短名，「需要留意」里用主机名 + 短名
  var HOSTS = [
    ['raksmart', 'RakSmart VPS', ['reachable', 'cpu', 'memory', 'disk', 'uptime', 'traffic', 'expiry_days', 'monthly_price']],
    ['aleg', '阿里云轻量服务器', ['reachable', 'cpu', 'memory', 'disk', 'traffic', '@server.expiry_days']],
    ['hwa', '华为云 hwa', ['reachable', 'cpu', 'memory', 'disk', 'hourly_price', 'billing_mode']],
    ['hwb', '华为云 hwb', ['reachable', 'cpu', 'memory', 'disk', 'hourly_price', 'billing_mode']],
    ['cloady', 'Cloady 应用', ['reachable', 'traffic', 'requests', 'cpu_hours', 'memory_gb_hours']]
  ];
  var HOST_SHORT = {
    reachable: '连通', cpu: 'CPU', memory: '内存已用', disk: '磁盘已用', uptime: '运行时间', traffic: '本月流量',
    expiry_days: '到期', monthly_price: '月费', hourly_price: '计算实例每小时询价', billing_mode: '计费模式',
    requests: '本月请求', cpu_hours: '本月 CPU 时长', memory_gb_hours: '本月内存用量'
  };
  // 主机控制台只放已核实的地址；其余主机没有可靠后台链接，不编
  var HOST_CONSOLE = { aleg: ['阿里云轻量应用服务器控制台', 'https://swas.console.aliyun.com/#/servers'] };
  var DOMAINS = [['windrisebridge_com', 'windrisebridge.com'], ['windrisebridge_cn', 'windrisebridge.cn'], ['windrise_si', 'windrise.si'], ['secrethq_shop', 'secrethq.shop']];
  var CERTS = [['website_cn', '中文官网 windrisebridge.cn'], ['website_cn_www', '中文官网 www'], ['website_en', '英文官网 windrisebridge.com'], ['website_en_www', '英文官网 www'],
    ['gateway', '网关 gw.windrise.si'], ['activation', '激活 api.secrethq.shop'], ['mcp', 'MCP mcp.windrise.si'], ['cloady', 'Cloady 应用域名']];
  var MANUALS = [['evsign', 'Windows 签名'], ['mac_signing', 'Mac 代签'], ['feishu', '飞书企业邮箱']];
  var PAYMENTS = [['creem', 'Creem'], ['alipay', '支付宝']];
  var PAY_FIELDS = [['count', '收款笔数'], ['amount', '收款金额'], ['fees', '手续费'], ['refunds', '退款金额'], ['disputes', '拒付笔数']];

  var GROUP_NAMES = { cloudflare: 'Cloudflare', aliyun: '云账户余额', mail: '邮件与短信', server: '服务器', business: '报到人数',
    domain: '域名与证书', pay: '付款与 GitHub', manual: '手填项' };

  var EXTRA_NOTES = {
    'cf.r2.storage': '只作容量参考，不是月账单的存储用量',
    'cf.d1.storage': '各库峰值相加，不是同一时刻的精确合计',
    'cf.kv.storage': '各空间峰值相加，不是同一时刻的精确合计',
    'cf.d1.read': '包含本机报到统计的查询',
    'aliyun.cash': '只展示，不设提醒线',
    'mail.total_free': '累计赠额用完不会恢复'
  };

  var PERIODS = {
    'utc-day': '按 UTC 日累计，北京时间 8 点清零',
    'utc-month': '按 UTC 自然月累计',
    'utc-day-peak': '当日峰值',
    'as-of-collection': '截至采集时',
    'asia-shanghai-day': '北京时间当天 0 点起',
    'lifetime': '累计',
    'provider-day': '按邮件推送服务的当日口径',
    'provider-month': '按服务商账期累计',
    'asia-shanghai-month': '北京时间本月'
  };

  var REASONS = {
    key_missing: '尚未接入只读钥匙',
    key_invalid: '本机钥匙文件格式或读取条件不符合要求',
    collection_failed: '本次读取失败',
    dataset_unavailable: '此数据集为空、不完整或当前账号暂不可读取',
    empty_dataset: '平台没有返回此项记录，不能按零计算',
    read_budget: '业务读行预算不足或已超预算，本次未更新',
    clock_rollback: '采集电脑的时间早于已有记录，已停止查询',
    stale: '数据已超过更新周期',
    manual_missing: '待填，还没有手填',
    console_only: '没有只读接口，只能在后台看',
    unsupported_billing_mode: '不是按需计费，查不到每小时价格'
  };

  var BACKEND = [
    ['Cloudflare 账单与发票', 'https://dash.cloudflare.com/?to=/:account/billing', '最终费用以发票为准，本页只是平台统计的用量'],
    ['阿里云费用与成本', 'https://usercenter2.aliyun.com/home', '分账、调账、优惠券和最终账单'],
    ['Resend 用量', 'https://resend.com/settings/usage', '现有钥匙权限过大，不接入本页'],
    ['Brevo', 'https://app.brevo.com/', '发信额度，只读查询尚未接入'],
    ['Elastic Email', 'https://app.elasticemail.com/', '发信量，只读查询尚未接入'],
    ['Mailjet', 'https://app.mailjet.com/', '只读钥匙能力未核实'],
    ['Mailtrap', 'https://mailtrap.io/', '只读钥匙能力未核实'],
    ['Maileroo', 'https://app.maileroo.com/', '只读钥匙能力未核实']
  ];

  var app = document.getElementById('app');
  var params = new URLSearchParams(location.search);
  var demo = params.get('demo');
  var source = './snapshot.json';
  var fixedNow = null;
  if (demo && /^[a-z0-9-]{1,40}$/.test(demo)) {
    source = './demo/' + demo + '.json';
    var n = Date.parse(params.get('now') || '');
    if (Number.isFinite(n)) fixedNow = n;
  }

  var snapshot = null;
  var loadProblem = null;
  var rendered = false;
  var previous = {};
  var reduceMotion = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : { matches: false };

  function now() { return fixedNow !== null ? fixedNow : Date.now(); }

  // ---------- 格式化 ----------

  function esc(text) {
    return String(text).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  var intFmt = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 0 });
  var oneFmt = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 1 });
  var moneyFmt = new Intl.NumberFormat('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  var timeFmt = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });

  function beijing(iso) {
    var parts = {};
    timeFmt.formatToParts(new Date(iso)).forEach(function (p) { parts[p.type] = p.value; });
    return parts.month + '月' + parts.day + '日 ' + parts.hour + ':' + parts.minute;
  }

  function dayLabel(ymd) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd || '');
    return m ? Number(m[2]) + '月' + Number(m[3]) + '日' : '';
  }

  function duration(ms) {
    var min = Math.max(0, Math.floor(ms / 60000));
    if (min < 120) return min + ' 分钟';
    var h = Math.floor(min / 60);
    if (h < 48) return h + ' 小时 ' + (min % 60) + ' 分钟';
    return Math.floor(h / 24) + ' 天 ' + (h % 24) + ' 小时';
  }

  function bytes(v) {
    // 按四舍五入到一位小数后的值选单位，避免 999,995,000 字节写成「1,000 MB」
    var a = Math.abs(v);
    if (a >= 999.95e6) return oneFmt.format(v / 1e9) + ' GB';
    if (a >= 999.95e3) return oneFmt.format(v / 1e6) + ' MB';
    if (a >= 999.95) return oneFmt.format(v / 1e3) + ' KB';
    return intFmt.format(v) + ' 字节';
  }

  var CURRENCY = { CNY: '¥', USD: 'US$', JPY: 'JP¥' };

  // kind: 数值格式，和单位一起决定怎么写
  function fmt(kind, v) {
    if (kind === 'pct') {
      if (v > 0 && v < 1) return '不到 1%';
      return intFmt.format(Math.floor(v)) + '%';
    }
    if (kind === '字节') return bytes(v);
    if (kind === '毫秒') return oneFmt.format(v) + ' 毫秒';
    if (CURRENCY[kind]) return (v < 0 ? '-' : '') + CURRENCY[kind] + moneyFmt.format(Math.abs(v));
    var per = /^(CNY|USD|JPY)\/(.+)$/.exec(kind || '');
    if (per) return fmt(per[1], v) + ' / ' + per[2];
    if (kind === '%') return oneFmt.format(v) + '%';
    if (kind === '秒') return duration(v * 1000);
    return (Number.isInteger(v) ? intFmt : oneFmt).format(v) + (kind ? ' ' + kind : '');
  }

  function num(key, kind, v) {
    return '<span class="num" data-k="' + esc(key) + '" data-f="' + esc(kind) + '" data-v="' + v + '">' + esc(fmt(kind, v)) + '</span>';
  }

  function badge(status) {
    return '<span class="badge" data-s="' + esc(status) + '"><span class="dot" data-s="' + esc(status) + '" aria-hidden="true"></span>' + esc(status) + '</span>';
  }

  // ---------- 状态 ----------

  // 合同第 1、2 条：未接优先；有旧值且超时或时间回退显示未更新。页面以当前时间重查，不信 JSON 里的「正常」。
  function evaluate(m, t) {
    var used = typeof m.used === 'number' && isFinite(m.used) ? m.used : null;
    var limit = typeof m.limit === 'number' && isFinite(m.limit) ? m.limit : null;
    var status = STATUSES.indexOf(m.status) >= 0 ? m.status : '未知';
    var reason = m.reason || null;
    var collected = m.collectedAt ? Date.parse(m.collectedAt) : NaN;
    var age = isFinite(collected) ? t - collected : null;
    if (status !== '未接' && age !== null) {
      if (age < 0) { status = '未更新'; reason = 'clock_rollback'; }
      else if (typeof m.staleAfterSeconds === 'number' && age > m.staleAfterSeconds * 1000) { status = '未更新'; reason = reason === 'read_budget' ? reason : 'stale'; }
    }
    // 判色状态却没有数值，就是未知，不能按 0 判正常
    if (used === null && (status === '正常' || status === '关注' || status === '警告')) status = '未知';
    if (status === '未接') used = null;
    var pct = used !== null && limit !== null && limit > 0 ? used / limit * 100 : null;
    return { m: m, id: m.id, used: used, limit: limit, status: status, reason: reason, age: age, collected: isFinite(collected) ? m.collectedAt : null, pct: pct };
  }

  function worst(list) {
    var w = '正常';
    list.forEach(function (e) { if (SEVERITY[e.status] > SEVERITY[w]) w = e.status; });
    return w;
  }

  // ---------- 行 ----------

  function hostOf(id) {
    if (id === 'server.expiry_days') return HOSTS[1];
    var m = /^server\.([a-z]+)\.([a-z_]+)$/.exec(id);
    if (!m) return null;
    for (var i = 0; i < HOSTS.length; i++) if (HOSTS[i][0] === m[1]) return HOSTS[i];
    return null;
  }

  function shortName(e) {
    if (e.id === 'server.expiry_days') return '到期';
    var m = /^server\.[a-z]+\.([a-z_]+)$/.exec(e.id);
    if (m && HOST_SHORT[m[1]]) return HOST_SHORT[m[1]];
    var d = /^(?:domain|cert)\.([a-z_]+)\.expiry_days$/.exec(e.id);
    if (d) {
      var all = DOMAINS.concat(CERTS);
      for (var i = 0; i < all.length; i++) if (all[i][0] === d[1]) return all[i][1];
    }
    var dns = /^cf\.dns\.([a-z_]+)$/.exec(e.id);
    if (dns) for (var j = 0; j < DOMAINS.length; j++) if (DOMAINS[j][0] === dns[1]) return DOMAINS[j][1] + ' DNS 记录';
    return NAMES[e.id] || e.m.label || e.id;
  }

  // 全名：跨组列表（需要留意）里用，带主机或证书前缀
  function name(e) {
    var h = hostOf(e.id);
    if (h) return h[1] + ' ' + shortName(e);
    if (/^cert\./.test(e.id)) return shortName(e) + ' 证书到期';
    if (/^domain\.[a-z_]+\.expiry_days$/.test(e.id)) return shortName(e) + ' 域名到期';
    var mm = /^manual\.([a-z_]+)\.expiry_days$/.exec(e.id);
    if (mm) for (var i = 0; i < MANUALS.length; i++) if (MANUALS[i][0] === mm[1]) return MANUALS[i][1] + '到期';
    if (/^sms\./.test(e.id)) return '短信' + shortName(e);
    if (/^tencent_ses\./.test(e.id)) return '腾讯 SES ' + shortName(e);
    if (/^huawei\./.test(e.id)) return '华为云' + shortName(e);
    if (/^aliyun\./.test(e.id)) return '阿里云' + shortName(e);
    return shortName(e);
  }

  function periodText(e) {
    if (e.m.period === 'asia-shanghai-yesterday') return e.m.periodDate ? dayLabel(e.m.periodDate) + '的账单' : '昨日账单';
    return PERIODS[e.m.period] || '';
  }

  function stateNote(e, groupTime) {
    var parts = [];
    var when = e.collected ? '，下面是 ' + beijing(e.collected) + ' 采集的旧值' : '，下面是上次的旧值';
    if (e.status === '未更新' && e.used !== null) {
      var why = (e.reason === 'stale' || !REASONS[e.reason]) && e.age !== null ? '已停更 ' + duration(e.age) : (REASONS[e.reason] || '本次未更新');
      parts.push(why + when);
    } else if (e.status === '失败' && e.used !== null) {
      parts.push((REASONS[e.reason] || '本次读取失败') + when);
    } else if (e.collected && groupTime && e.collected !== groupTime) {
      parts.push(beijing(e.collected) + ' 采集');
    }
    return parts;
  }

  function missingText(e) {
    if (e.status === '未接') return REASONS[e.reason] || REASONS.key_missing;
    if (e.status === '未知') return '数值未知，不按 0 计算';
    var r = REASONS[e.reason];
    if (e.status === '未更新') return (r || '本次未更新') + '，暂时没有数值';
    return (r || '读取失败') + '，暂时没有数值';
  }

  function finite(v) { return typeof v === 'number' && isFinite(v) ? v : null; }

  // 第二版可选字段：有 thresholds（direction=above）就按它画刻度，没有就画合同默认的 50% 和 80%
  function aboveThresholds(e) {
    var t = e.m.thresholds;
    if (!t || t.direction !== 'above' || finite(t.attention) === null || finite(t.warning) === null) return null;
    return { attention: t.attention, warning: t.warning, urgent: finite(t.urgent) };
  }

  function tickPositions(e) {
    var th = aboveThresholds(e);
    if (!th || !(e.limit > 0)) return [{ left: 50 }, { left: 80 }];
    var list = [{ left: th.attention / e.limit * 100 }, { left: th.warning / e.limit * 100 }];
    if (th.urgent !== null) list.push({ left: th.urgent / e.limit * 100, urgent: true });
    return list.filter(function (t) { return t.left > 0 && t.left < 100; });
  }

  // 轻量服务器到期：天数可以为负；有 expiresAt 就按现在重算，重算不改 collectedAt，也不改停更判断
  function daysText(d) {
    if (d > 0) return '还剩 ' + intFmt.format(d) + ' 天';
    if (d === 0) return '今天到期';
    return '已过期 ' + intFmt.format(-d) + ' 天';
  }

  function isExpiry(e) {
    var t = e.m.thresholds;
    return !!(t && t.direction === 'below') || e.m.unit === '天';
  }

  function remainingDays(e) {
    var expires = e.m.expiresAt && isFinite(Date.parse(e.m.expiresAt)) ? e.m.expiresAt : null;
    return expires ? Math.ceil((Date.parse(expires) - now()) / 86400000) : e.used;
  }

  function expiresText(iso) {
    // 只有日期的（WHOIS、手填）保留日期，不捏造时刻
    if (/^\d{4}-\d{2}-\d{2}$/.test(iso)) return '到期日 ' + dayLabel(iso);
    return '到期 ' + beijing(iso) + '（北京时间）';
  }

  function manualNote(e) {
    if (!e.m.asOf) return '';
    return '截至 ' + dayLabel(e.m.asOf) + ' 手填';
  }

  // 手填项的 collectedAt 是截至日零点，不写「几点采集」，停更照写
  function stateFor(e, groupTime) {
    var list = stateNote(e, groupTime);
    if (e.m.asOf) list = list.filter(function (x) { return !/ 采集$/.test(x); });
    return list;
  }

  function linkHtml(text, url) {
    if (!url || !/^https:\/\//.test(url)) return '';
    return '<a href="' + esc(url) + '" target="_blank" rel="noopener noreferrer">' + esc(text) + '</a>';
  }

  function noteHtml(notes, link) {
    notes = notes.filter(Boolean);
    if (!notes.length && !link) return '';
    return '<p class="row-note">' + esc(notes.join('，')) + (link ? (notes.length ? '，' : '') + link : '') + '</p>';
  }

  function rowHead(label, right) {
    return '<div class="row-head"><span class="row-name">' + esc(label) + '</span><span class="row-right">' + right + '</span></div>';
  }

  function expiryRow(e, groupTime, label, extra) {
    var right = '';
    var notes = [];
    if (e.used !== null) {
      right = '<span class="row-pct">' + esc(daysText(remainingDays(e))) + '</span>';
      if (e.m.expiresAt) notes.push(expiresText(e.m.expiresAt));
      if (e.m.expiresAt && remainingDays(e) !== e.used) notes.push('采集时' + daysText(e.used));
      if (!e.m.expiresAt) notes.push('采集时的天数，没有到期时间可重算');
    } else {
      notes.push(missingText(e));
    }
    notes.push(manualNote(e));
    var state = stateFor(e, groupTime);
    // 天数已按到期时间重算，不是旧值；停更、失败照样写出来
    if (e.m.expiresAt && e.used !== null) state = state.map(function (x) { return x.replace(/，下面是.*旧值$/, '，到期时间是上次取到的'); });
    notes = notes.concat(state, extra || []);
    return '<li class="row">' + rowHead(label || shortName(e), right + badge(e.status)) + noteHtml(notes) + '</li>';
  }

  // 没有上限的单个数：名称 / 数值 + 徽标，一行说明
  function valueRow(e, groupTime, label, extra, text) {
    var unit = e.m.unit || '';
    var right = e.used === null ? '' : '<span class="row-pct">' + (text ? esc(text) : num(e.id, unit, e.used)) + '</span>';
    var notes = e.used === null ? [missingText(e)] : [];
    notes.push(manualNote(e));
    notes = notes.concat(stateFor(e, groupTime), extra || []);
    var link = e.m.consoleUrl ? linkHtml('去后台看', e.m.consoleUrl) : '';
    return '<li class="row">' + rowHead(label || shortName(e), right + badge(e.status)) + noteHtml(notes, link) + '</li>';
  }

  var BILLING_MODES = { 0: '按需', 1: '预付费', 2: '竞价' };

  // 服务器每一行按单位分派
  function hostRow(e, t) {
    var unit = e.m.unit;
    if (isExpiry(e)) return expiryRow(e, t);
    if (unit === '布尔') return valueRow(e, t, null, null, e.used === 1 ? '连得上' : e.used === 0 ? '连不上' : '');
    if (unit === '枚举') return valueRow(e, t, null, null, BILLING_MODES[e.used] || '未知方式');
    if (e.m.accounting === 'quote_compute_only_not_invoice') return valueRow(e, t, null, ['只是计算实例询价，不含磁盘和带宽，不是账单']);
    if (e.m.source === 'localTraffic') return meterRow(e, t, null, trafficGap(e));
    if (e.limit !== null || unit === '%') return meterRow(e, t);
    return valueRow(e, t);
  }

  // 本机网卡流量：首月缺启用前的量，不是供应商账单
  function trafficGap(e) {
    if (e.m.complete !== false) return null;
    var since = e.m.observedSince && isFinite(Date.parse(e.m.observedSince)) ? '从 ' + beijing(e.m.observedSince) + ' 开始计' : '开始计数时间未知';
    return { tag: '统计不完整', notes: [since + '，之前的流量没算', '本机网卡计数，不是服务商账单，服务商按每月 10 日重置'] };
  }

  function meterRow(e, groupTime, label, gap) {
    var unit = e.m.unit || '';
    var head = '<div class="row-head"><span class="row-name">' + esc(label || shortName(e)) + '</span><span class="row-right">';
    if (gap && gap.tag) head += '<span class="tag">' + esc(gap.tag) + '</span>';
    if (e.pct !== null && e.used !== null) head += '<span class="row-pct">' + num(e.id + ':pct', 'pct', e.pct) + '</span>';
    head += badge(e.status) + '</span></div>';

    var body = '';
    var fig = '';
    if (e.used === null) {
      if (e.limit !== null && e.limit > 0) body = '<div class="meter-empty" aria-hidden="true"></div>';
      fig = missingText(e);
      if (e.limit !== null) fig += '<span class="gap"></span>' + (e.limit === 0 ? '无可用额度' : '上限 ' + esc(fmt(unit, e.limit)));
    } else if (e.limit === null) {
      fig = '<b>' + num(e.id, unit, e.used) + '</b><span class="gap"></span>' + (/^cf\.dns\./.test(e.id) ? '上限未确认' : '无已知上限');
    } else if (e.limit === 0) {
      fig = '已用 <b>' + num(e.id, unit, e.used) + '</b><span class="gap"></span>无可用额度';
    } else {
      var p = Math.max(0, Math.min(100, e.pct));
      var ticks = tickPositions(e).map(function (t) {
        return '<span class="meter-tick' + (t.urgent ? ' is-urgent' : '') + '" style="left:' + t.left + '%"></span>';
      }).join('');
      body = '<div class="meter" data-s="' + esc(e.status) + '" data-k="' + esc(e.id) + ':bar" data-p="' + p + '" style="--p:' + p + '%" role="img" aria-label="' + esc(name(e) + ' 已用 ' + fmt('pct', e.pct)) + '">' +
        '<span class="meter-fill"></span>' + ticks + '</div>';
      // 百分比项上限就是 100%，不再重复写已用 / 上限 / 剩余
      if (unit === '%') fig = '';
      else {
        fig = '已用 <b>' + num(e.id, unit, e.used) + '</b> / 上限 ' + esc(fmt(unit, e.limit)) +
          '<span class="gap"></span>剩余 <b>' + num(e.id + ':left', unit, Math.max(0, e.limit - e.used)) + '</b>';
        if (e.used > e.limit) fig += '<span class="gap"></span>超出 <b>' + num(e.id + ':over', unit, e.used - e.limit) + '</b>';
      }
    }

    var notes = [unit === '%' && e.m.period === 'as-of-collection' ? '' : periodText(e)];
    if (EXTRA_NOTES[e.id]) notes.push(EXTRA_NOTES[e.id]);
    if (gap && gap.notes) notes = notes.concat(gap.notes);
    var th = aboveThresholds(e);
    if (th && th.urgent !== null) {
      notes.push(e.used !== null && e.used >= th.urgent ? '已过紧急线 ' + fmt(unit, th.urgent) : '最右一条刻度是紧急线 ' + fmt(unit, th.urgent));
    }
    notes = notes.concat(stateNote(e, groupTime)).filter(Boolean);
    return '<li class="row">' + head + body + (fig ? '<p class="row-fig">' + fig + '</p>' : '') +
      (notes.length ? '<p class="row-note">' + esc(notes.join('，')) + '</p>' : '') + '</li>';
  }

  function moneyRow(e, groupTime) {
    var unit = e.m.unit || '';
    var head = '<div class="row-head"><span class="row-name">' + esc(shortName(e)) + '</span><span class="row-right">' + badge(e.status) + '</span></div>';
    var fig = e.used === null ? '<p class="row-fig">' + esc(missingText(e)) + '</p>'
      : '<p class="row-fig"><span class="row-value">' + num(e.id, unit, e.used) + '</span></p>';
    var notes = [];
    if (e.id === 'aliyun.yesterday_bill') notes.push(periodText(e), '账单晚一天出，是应付金额，不等于已经扣款');
    else if (e.id === 'huawei.coupons') notes.push('代金券有适用范围，不能当现金');
    else notes.push(periodText(e));
    if (EXTRA_NOTES[e.id]) notes.push(EXTRA_NOTES[e.id]);
    notes = notes.concat(stateNote(e, groupTime)).filter(Boolean);
    return '<li class="row">' + head + fig + '<p class="row-note">' + esc(notes.join('，')) + '</p></li>';
  }

  function countRow(e, groupTime) {
    var right = e.used === null ? badge(e.status)
      : '<span class="row-value">' + num(e.id, '', e.used) + '</span>' + (e.status === '正常' ? '' : badge(e.status));
    var notes = e.used === null ? [missingText(e)] : stateNote(e, groupTime);
    return '<li class="row"><div class="row-head"><span class="row-name">' + esc(shortName(e)) + '</span><span class="row-right">' + right + '</span></div>' +
      (notes.length ? '<p class="row-note">' + esc(notes.join('，')) + '</p>' : '') + '</li>';
  }

  // ---------- 卡片 ----------

  function groupTimeOf(list) {
    var latest = null;
    list.forEach(function (e) { if (e.collected && (!latest || Date.parse(e.collected) > Date.parse(latest))) latest = e.collected; });
    return latest;
  }

  function card(key, list, inner, extraMeta, noTime) {
    var w = list.length ? worst(list) : '未接';
    var t = noTime ? null : groupTimeOf(list);
    var meta = [];
    if (t) meta.push(beijing(t) + ' 采集');
    if (extraMeta) meta.push(extraMeta);
    return '<section class="card" aria-labelledby="g-' + key + '"><div class="card-head"><h2 class="card-title" id="g-' + key + '">' + GROUP_NAMES[key] + '</h2>' + badge(w) + '</div>' +
      (meta.length ? '<p class="card-meta">' + esc(meta.join('，')) + '</p>' : '') + inner + '</section>';
  }

  function pick(byId, ids) { return ids.map(function (id) { return byId[id]; }).filter(Boolean); }

  function cloudflareCard(byId) {
    var subs = [
      ['Workers', ['cf.requests', 'cf.errors', 'cf.cpu_p99_max']],
      ['D1 数据库', ['cf.d1.read', 'cf.d1.write', 'cf.d1.storage', 'cf.d1.largest']],
      ['KV 存储', ['cf.kv.read', 'cf.kv.write', 'cf.kv.delete', 'cf.kv.list', 'cf.kv.storage']],
      ['R2 对象存储', ['cf.r2.a', 'cf.r2.b', 'cf.r2.storage']],
      // windrisebridge.cn 的 DNS 在 DNSPod，不在 Cloudflare，合同没有这一项；它的域名到期和证书在「域名与证书」卡
      ['隧道与 DNS', ['cf.tunnels'].concat(DOMAINS.filter(function (d) { return d[0] !== 'windrisebridge_cn'; }).map(function (d) { return 'cf.dns.' + d[0]; }))]
    ];
    var all = [];
    subs.forEach(function (s) { all = all.concat(pick(byId, s[1])); });
    var t = groupTimeOf(all);
    var inner = subs.map(function (s) {
      var list = pick(byId, s[1]);
      if (!list.length) return '';
      return '<h3 class="sub-title">' + esc(s[0]) + '</h3><ul class="rows">' + list.map(function (e) { return meterRow(e, t); }).join('') + '</ul>';
    }).join('');
    return card('cloudflare', all, inner, '平台统计的用量，不是账单，不代表已经扣费');
  }

  function aliyunCard(byId) {
    var ali = pick(byId, ['aliyun.available', 'aliyun.cash', 'aliyun.yesterday_bill']);
    var hw = pick(byId, ['huawei.cash', 'huawei.coupons']);
    var t = groupTimeOf(ali.concat(hw));
    var inner = '<h3 class="sub-title">阿里云</h3><ul class="rows">' + ali.map(function (e) { return moneyRow(e, t); }).join('') + '</ul>';
    if (hw.length) inner += '<h3 class="sub-title">华为云</h3><ul class="rows">' + hw.map(function (e) { return moneyRow(e, t); }).join('') + '</ul>';
    return card('aliyun', ali.concat(hw), inner);
  }

  // 短信：今日 / 本月 × 计费发送 / 成功回执 / 失败回执，三列小表，空格写原因不写 0
  function smsTable(byId) {
    var cols = [['sent', '计费发送'], ['success', '成功回执'], ['failed', '失败回执']];
    var rows = [['day', '今日'], ['month', '本月']];
    var cells = [];
    var head = '<tr><th scope="col"></th>' + cols.map(function (c) { return '<th scope="col">' + c[1] + '</th>'; }).join('') + '</tr>';
    var body = rows.map(function (r) {
      return '<tr><th scope="row">' + r[1] + '</th>' + cols.map(function (c) {
        var e = byId['sms.' + r[0] + '.' + c[0]];
        if (!e) return '<td>—</td>';
        cells.push(e);
        if (e.used === null) return '<td class="is-missing">' + esc(e.status) + '</td>';
        var mark = e.status === '正常' ? '' : ' data-s="' + esc(e.status) + '"';
        return '<td' + mark + '>' + num(e.id, '', e.used) + (e.status === '正常' ? '' : '<span class="cell-s">' + esc(e.status) + '</span>') + '</td>';
      }).join('') + '</tr>';
    }).join('');
    if (!cells.length) return { html: '', list: [] };
    return { html: '<table class="mini">' + head + body + '</table>', list: cells };
  }

  function mailCard(byId) {
    var dm = pick(byId, ['mail.total_free', 'mail.daily_free']);
    var ses = pick(byId, ['tencent_ses.month.sent', 'tencent_ses.gift_remaining']);
    var sms = smsTable(byId);
    var smsMore = pick(byId, ['sms.month.estimated_cost', 'sms.package_remaining']);
    var all = dm.concat(ses, sms.list, smsMore);
    var t = groupTimeOf(all);
    var inner = '<h3 class="sub-title">阿里云 DirectMail</h3><ul class="rows">' + dm.map(function (e) { return meterRow(e, t); }).join('') + '</ul>';
    if (ses.length) {
      inner += '<h3 class="sub-title">腾讯 SES</h3><ul class="rows">' + ses.map(function (e) {
        return valueRow(e, t, null, e.id === 'tencent_ses.gift_remaining' ? ['公开统计不返回余额，按手填'] : [periodText(e)]);
      }).join('') + '</ul>';
    }
    if (sms.list.length || smsMore.length) {
      inner += '<h3 class="sub-title">阿里云短信</h3>';
      if (sms.list.length && sms.list.every(function (e) { return e.used === null; })) {
        inner += '<p class="row-note">发送和回执：' + esc(missingText(sms.list[0])) + '</p>';
      } else inner += sms.html + '<p class="row-note">北京时间；计费条数和回执分开计，不相加</p>';
      inner += '<ul class="rows">' + smsMore.map(function (e) {
        return valueRow(e, t, null, e.id === 'sms.month.estimated_cost' ? ['按普通单价估算，没扣资源包，不是实际扣款'] : ['只算有效的短信资源包']);
      }).join('') + '</ul>';
    }
    return card('mail', all, inner);
  }

  function serverCard(byId) {
    var swas = linkHtml('阿里云轻量应用服务器控制台', 'https://swas.console.aliyun.com/#/servers');
    var all = [];
    var blocks = HOSTS.map(function (h) {
      var list = h[2].map(function (k) { return byId[k.charAt(0) === '@' ? k.slice(1) : 'server.' + h[0] + '.' + k]; }).filter(Boolean);
      if (!list.length) return '';
      all = all.concat(list);
      var t = groupTimeOf(list);
      var link = HOST_CONSOLE[h[0]] ? linkHtml(HOST_CONSOLE[h[0]][0], HOST_CONSOLE[h[0]][1]) : '';
      var extra = h[0] === 'cloady' ? '<p class="row-note">用量取自 Cloady 官方接口，正式单位还在核对</p>' : '';
      return '<section class="host" aria-label="' + esc(h[1]) + '"><div class="host-head"><h3 class="host-title">' + esc(h[1]) + '</h3>' + badge(worst(list)) + '</div>' +
        '<ul class="rows">' + list.map(function (e) { return hostRow(e, t); }).join('') + '</ul>' + extra + (link ? '<p class="row-note">后台：' + link + '</p>' : '') + '</section>';
    }).join('');
    // 旧版快照没有服务器指标
    if (!all.length) return card('server', [], '<p class="empty">快照里还没有服务器的指标，请先到 ' + swas + ' 查看。</p>');
    return card('server', all, '<div class="hosts">' + blocks + '</div>', '连通只说明地址端口连得上，不代表服务可用或有人在线');
  }

  function domainCard(byId) {
    var doms = DOMAINS.map(function (d) { return byId['domain.' + d[0] + '.expiry_days']; }).filter(Boolean);
    var prices = DOMAINS.map(function (d) { return byId['domain.' + d[0] + '.renewal_price']; }).filter(Boolean);
    var certs = CERTS.map(function (c) { return byId['cert.' + c[0] + '.expiry_days']; }).filter(Boolean);
    if (!doms.length && !certs.length) return '';
    var t = groupTimeOf(doms.concat(certs));
    var inner = '';
    if (doms.length) {
      inner += '<h3 class="sub-title">域名（公开 WHOIS，只有日期）</h3><ul class="rows">' + doms.map(function (e) {
        var p = byId[e.id.replace('.expiry_days', '.renewal_price')];
        var extra = [];
        if (p) extra.push(p.used === null ? '续费价' + (p.status === '未接' ? '待填' : missingText(p)) : '续费参考价 ' + fmt(p.m.unit, p.used) + (p.m.asOf ? '（截至 ' + dayLabel(p.m.asOf) + ' 手填）' : ''));
        return expiryRow(e, t, null, extra);
      }).join('') + '</ul>';
    }
    if (certs.length) inner += '<h3 class="sub-title">网站证书</h3><ul class="rows">' + certs.map(function (e) { return expiryRow(e, t); }).join('') + '</ul>';
    return card('domain', doms.concat(prices, certs), inner, '30 天内关注，7 天内警告，1 天内紧急');
  }

  function payCard(byId) {
    var all = [];
    var groups = PAYMENTS.map(function (p) {
      return [p[1], PAY_FIELDS.map(function (f) { return byId['payments.' + p[0] + '.' + f[0]]; }).filter(Boolean), PAY_FIELDS];
    });
    groups.push(['GitHub Actions', pick(byId, ['github.actions_minutes', 'github.artifact_storage'])]);
    var inner = groups.map(function (g) {
      var list = g[1];
      if (!list.length) return '';
      all = all.concat(list);
      var url = list[0].m.consoleUrl;
      var head = '<div class="host-head"><h3 class="host-title">' + esc(g[0]) + '</h3>' + badge(worst(list)) + '</div>';
      // 全部没数：一行列出项目名和后台链接，不逐行重复「未接」
      if (list.every(function (e) { return e.used === null; })) {
        var names = list.map(function (e) { return shortName(e).replace(/^(Creem|支付宝)本月/, '').replace(/^GitHub Actions /, ''); });
        return '<section class="host">' + head + '<p class="row-note">' + esc(names.join('、') + '：' + missingText(list[0])) + (url ? '，' + linkHtml('去后台看', url) : '') + '</p></section>';
      }
      var t = groupTimeOf(list);
      return '<section class="host">' + head + '<ul class="rows">' + list.map(function (e) { return valueRow(e, t); }).join('') + '</ul></section>';
    }).join('');
    if (!all.length) return '';
    return card('pay', all, '<div class="stack">' + inner + '</div>');
  }

  function manualCard(byId) {
    var all = [];
    var rows = MANUALS.map(function (m) {
      var exp = byId['manual.' + m[0] + '.expiry_days'];
      var price = byId['manual.' + m[0] + '.annual_price'];
      var seats = m[0] === 'feishu' ? byId['manual.feishu.seats'] : null;
      [exp, price, seats].forEach(function (e) { if (e) all.push(e); });
      if (!exp) return '';
      var extra = [];
      if (price) extra.push(price.used === null ? '年费待填' : '年费 ' + fmt('CNY', price.used) + (price.m.asOf && price.m.asOf !== exp.m.asOf ? '（截至 ' + dayLabel(price.m.asOf) + '）' : ''));
      if (seats) extra.push(seats.used === null ? '席位待填' : '席位 ' + fmt('个', seats.used));
      return expiryRow(exp, null, m[1], extra);
    }).join('');
    if (!all.length) return '';
    return card('manual', all, '<ul class="rows">' + rows + '</ul>', '你本人填的到期日和价格，截至日以后的变化这里看不到', true);
  }

  function businessCard(byId, budget) {
    var active = pick(byId, ['business.recent_hour', 'business.today']);
    var members = pick(byId, ['business.members.free', 'business.members.monthly', 'business.members.quarterly', 'business.members.yearly', 'business.members.trial', 'business.members.manual', 'business.members.other']);
    var all = active.concat(members);
    var t = groupTimeOf(all);
    var tiles = '<ul class="tiles">' + active.map(function (e) {
      var v = e.used === null ? '<span class="tile-v is-missing">' + esc(missingText(e)) + '</span>' : '<span class="tile-v">' + num(e.id, '', e.used) + '</span>';
      var notes = stateNote(e, t);
      return '<li class="tile"><span class="tile-k">' + esc(shortName(e)) + '（台）</span>' + v +
        '<span class="tile-n">' + (e.status === '正常' ? '' : badge(e.status)) + (notes.length ? '<span>' + esc(notes.join('，')) + '</span>' : '') + '</span></li>';
    }).join('') + '</ul>';
    var memberTime = groupTimeOf(members);
    var memberList = members.length ? '<h3 class="sub-title">当前有效权益（账号）</h3><ul class="rows">' + members.map(function (e) { return countRow(e, memberTime); }).join('') + '</ul>' +
      '<p class="row-note">试用和手动发放不是付费用户。账号数和报到电脑数是两种单位，不能相加。</p>' : '';
    var budgetHtml = '';
    if (budget && typeof budget.limit === 'number' && budget.limit > 0 && typeof budget.used === 'number') {
      var pct = budget.used / budget.limit * 100;
      var p = Math.max(0, Math.min(100, pct));
      budgetHtml = '<h3 class="sub-title">本机报到统计的读行预算</h3><ul class="rows"><li class="row">' +
        '<div class="row-head"><span class="row-name">' + esc((dayLabel(budget.day) ? dayLabel(budget.day) + '（UTC 日）' : '今日') + '已用') + '</span><span class="row-right"><span class="row-pct">' + num('budget:pct', 'pct', pct) + '</span></span></div>' +
        '<div class="meter" data-k="budget:bar" data-p="' + p + '" style="--p:' + p + '%" aria-hidden="true"><span class="meter-fill"></span></div>' +
        '<p class="row-fig">已用 <b>' + num('budget', '行', budget.used) + '</b> / 预算 ' + esc(fmt('行', budget.limit)) +
        (budget.used > budget.limit ? '<span class="gap"></span>超出 <b>' + num('budget:over', '行', budget.used - budget.limit) + '</b>，之后的查询会跳过' : '<span class="gap"></span>剩余 <b>' + num('budget:left', '行', budget.limit - budget.used) + '</b>') + '</p>' +
        '<p class="row-note">只算本机采集的查询，已经包含在 Cloudflare 的 D1 读行里，不要相加</p></li></ul>';
    }
    return card('business', all, tiles + memberList + budgetHtml, '只看趋势，没有人数上限');
  }

  function backendCard() {
    return '<section class="card" aria-labelledby="g-backend"><div class="card-head"><h2 class="card-title" id="g-backend">只能在后台看的</h2></div>' +
      '<p class="card-meta">这些服务没有接入本页，点名称打开官方后台</p><ul class="links">' + BACKEND.map(function (b) {
        var title = b[1] ? '<a href="' + esc(b[1]) + '" target="_blank" rel="noopener noreferrer">' + esc(b[0]) + '</a>' : '<span class="row-name">' + esc(b[0]) + '</span>';
        return '<li>' + title + '<p>' + esc(b[2]) + '</p></li>';
      }).join('') + '</ul></section>';
  }

  // ---------- 总览 ----------

  function overview(list) {
    var counts = {};
    list.forEach(function (e) { counts[e.status] = (counts[e.status] || 0) + 1; });
    var order = COUNT_ORDER.slice();
    if (counts['未知']) order.splice(5, 0, '未知');
    var tiles = '<ul class="counts">' + order.map(function (s) {
      var n = counts[s] || 0;
      return '<li class="count" data-zero="' + (n ? 0 : 1) + '"><span class="count-n num">' + n + '</span><span class="count-k"><span class="dot" data-s="' + s + '" aria-hidden="true"></span>' + s + '</span></li>';
    }).join('') + '</ul>';

    var watch = list.filter(function (e) { return e.status === '警告' || e.status === '关注'; });
    watch.sort(function (a, b) { return SEVERITY[b.status] - SEVERITY[a.status] || (b.pct || 0) - (a.pct || 0); });
    var items = watch.map(function (e) {
      var unit = e.m.unit || '';
      var main = '';
      var sub = '';
      if (isExpiry(e) && e.used !== null) main = daysText(remainingDays(e));
      else if (e.m.unit === '布尔') main = e.used === 0 ? '连不上' : '';
      else if (e.limit === 0) main = '无可用额度';
      else if (e.pct !== null) {
        main = fmt('pct', e.pct);
        sub = e.used > e.limit ? '超出 ' + fmt(unit, e.used - e.limit) : '剩余 ' + fmt(unit, e.limit - e.used);
      } else if (e.used !== null) main = fmt(unit, e.used);
      return '<li class="watch-item"><span class="watch-name">' + esc(name(e)) + '</span>' +
        '<span class="watch-fig"><span class="pct">' + esc(main) + '</span>' + badge(e.status) + '</span>' +
        '<span class="watch-src">' + esc(GROUP_NAMES[groupOf(e.id)] || '') + '</span><span class="watch-src watch-sub">' + esc(sub) + '</span></li>';
    }).join('');
    // 停更、失败、未接、未知的项最新用量不明，不能让「没有要留意的」盖过去
    var dark = ['未更新', '失败', '未接', '未知'].filter(function (s) { return counts[s]; })
      .map(function (s) { return counts[s] + ' 项' + s; });
    var darkNote = dark.length ? '<p class="watch-dark">另有 ' + esc(dark.join('，')) + '，这些项现在的用量不知道，不算在上面。</p>' : '';
    var watchCard = '<section class="card overview" aria-labelledby="g-watch"><div class="card-head"><h2 class="card-title" id="g-watch">需要留意</h2></div>' +
      (items ? '<ul class="watch-list">' + items + '</ul>' : '<p class="watch-empty">' + (dark.length ? '有数的项目都没到关注线。' : '没有到关注线的项目。') + '</p>') + darkNote +
      '<ul class="legend" aria-label="图例"><li><span class="legend-tick"></span>刻度线：50% 关注，80% 警告</li>' +
      '<li><span class="legend-bar" style="background:var(--fill-ok)"></span>正常</li>' +
      '<li><span class="legend-bar" style="background:var(--fill-watch)"></span>关注</li>' +
      '<li><span class="legend-bar" style="background:var(--fill-warn)"></span>警告</li></ul></section>';
    return '<div class="top">' + tiles + watchCard + '</div>';
  }

  function groupOf(id) {
    if (id.indexOf('cf.') === 0) return 'cloudflare';
    if (id.indexOf('aliyun.') === 0 || id.indexOf('huawei.') === 0) return 'aliyun';
    if (id.indexOf('mail.') === 0 || id.indexOf('sms.') === 0 || id.indexOf('tencent_ses.') === 0) return 'mail';
    if (id.indexOf('domain.') === 0 || id.indexOf('cert.') === 0) return 'domain';
    if (id.indexOf('payments.') === 0 || id.indexOf('github.') === 0) return 'pay';
    if (id.indexOf('manual.') === 0) return 'manual';
    if (id.indexOf('business.') === 0) return 'business';
    if (id.indexOf('server.') === 0) return 'server';
    return '';
  }

  // ---------- 页面 ----------

  function headHtml(snap, t) {
    var line = '';
    if (snap && snap.generatedAt && isFinite(Date.parse(snap.generatedAt))) {
      var age = t - Date.parse(snap.generatedAt);
      line = '数据时间 <strong class="num">' + esc(beijing(snap.generatedAt)) + '</strong>（北京时间），';
      if (age < 0) line += '<span class="head-stale">快照时间晚于本机时间，请核对电脑时钟</span>';
      else if (age > 30 * 60000) line += '<span class="head-stale">已停更 ' + esc(duration(age)) + '</span>';
      else line += esc(duration(age)) + '前生成';
    } else if (loadProblem) {
      line = '没有可显示的数据';
    } else {
      line = '正在读取快照';
    }
    return '<header class="head"><h1 class="title">运营状态</h1><p class="head-line">' + line + '</p></header>';
  }

  function render() {
    var t = now();
    var html = headHtml(snapshot, t);
    if (loadProblem) {
      html += '<p class="notice">' + esc(loadProblem) + (snapshot ? '<small>下面是上次读到的内容。</small>' : '') + '</p>';
    }
    if (snapshot) {
      if (snapshot.mode === 'fixture') html += '<p class="notice">演示数据：由离线夹具生成，不是真实账号的数字。</p>';
      var list = (Array.isArray(snapshot.metrics) ? snapshot.metrics : [])
        .filter(function (m) { return m && typeof m.id === 'string'; })
        .map(function (m) { return evaluate(m, t); });
      var byId = {};
      list.forEach(function (e) { byId[e.id] = e; });
      html += overview(list);
      // 手机按顺序一列；宽屏：Cloudflare 左列，余额 / 邮件短信 / 报到右列；服务器整行；域名证书左、付款与手填右
      var lower = domainCard(byId);
      var right = payCard(byId) + manualCard(byId);
      html += '<div class="stack"><div class="groups"><div class="col">' + cloudflareCard(byId) + '</div><div class="col">' +
        aliyunCard(byId) + mailCard(byId) + businessCard(byId, snapshot.businessReadBudget) + '</div></div>' +
        serverCard(byId) +
        (lower || right ? '<div class="groups"><div class="col">' + lower + '</div><div class="col">' + right + '</div></div>' : '') +
        backendCard() + '</div>';
      html += '<footer class="foot"><p>上限按 Cloudflare 免费版、R2 标准存储和 DirectMail 初始赠额参考，不是从账号识别出的套餐。</p>' +
        '<p>页面每分钟重新读取一次快照；某一项超过它的更新周期两倍还没有新数据，就标为未更新。</p></footer>';
    }
    var old = rendered ? collect() : null;
    app.innerHTML = html;
    if (old) animateFrom(old);
    if (!rendered) requestAnimationFrame(function () { app.classList.add('is-live'); });
    rendered = true;
  }

  // ---------- 动效：只在两次读取之间数值变化时，数字和用量条轻过渡；减少动态效果时直接终态 ----------

  function collect() {
    var map = {};
    app.querySelectorAll('[data-k]').forEach(function (el) { map[el.getAttribute('data-k')] = Number(el.getAttribute(el.hasAttribute('data-p') ? 'data-p' : 'data-v')); });
    return map;
  }

  // cubic-bezier(.23, 1, .32, 1)，与令牌 --ease 一致
  function bezier(x1, y1, x2, y2) {
    function c(a1, a2, s) { return ((1 - 3 * a2 + 3 * a1) * s + (3 * a2 - 6 * a1)) * s * s + 3 * a1 * s; }
    function d(a1, a2, s) { return 3 * (1 - 3 * a2 + 3 * a1) * s * s + 2 * (3 * a2 - 6 * a1) * s + 3 * a1; }
    return function (x) {
      var s = x;
      for (var i = 0; i < 8; i++) {
        var dx = c(x1, x2, s) - x;
        var slope = d(x1, x2, s);
        if (Math.abs(dx) < 1e-5 || slope === 0) break;
        s -= dx / slope;
      }
      return c(y1, y2, Math.max(0, Math.min(1, s)));
    };
  }
  var ease = bezier(0.23, 1, 0.32, 1);
  var DURATION = 240;

  function animateFrom(old) {
    if (reduceMotion.matches) return;
    var numbers = [];
    app.querySelectorAll('[data-k]').forEach(function (el) {
      var key = el.getAttribute('data-k');
      if (!(key in old)) return;
      if (el.hasAttribute('data-p')) {
        var to = Number(el.getAttribute('data-p'));
        if (old[key] === to) return;
        // 先放回旧宽度，下一帧切到新值，由 CSS 过渡 clip-path
        el.style.setProperty('--p', old[key] + '%');
        requestAnimationFrame(function () { requestAnimationFrame(function () { el.style.setProperty('--p', to + '%'); }); });
        return;
      }
      var target = Number(el.getAttribute('data-v'));
      if (old[key] === target || !isFinite(old[key])) return;
      numbers.push({ el: el, from: old[key], to: target, kind: el.getAttribute('data-f') });
    });
    if (!numbers.length) return;
    var start = performance.now();
    // 按时间差推进，120Hz 屏上每帧都更新，60Hz 自然降帧
    function step(time) {
      var k = Math.min(1, (time - start) / DURATION);
      var e = ease(k);
      numbers.forEach(function (n) {
        var v = n.from + (n.to - n.from) * e;
        if (Number.isInteger(n.to) && n.kind !== 'pct') v = Math.round(v);
        n.el.textContent = fmt(n.kind, k === 1 ? n.to : v);
      });
      if (k < 1) requestAnimationFrame(step);
    }
    requestAnimationFrame(step);
  }

  // ---------- 读取 ----------

  function load() {
    fetch(source, { cache: 'no-store', credentials: 'same-origin' }).then(function (res) {
      if (!res.ok) throw new Error('http');
      return res.text();
    }).then(function (text) {
      var data;
      try { data = JSON.parse(text); } catch (err) { throw new Error('format'); }
      if (!data || typeof data !== 'object') throw new Error('format');
      if (data.schemaVersion !== 1) throw new Error('version:' + String(data.schemaVersion));
      if (!Array.isArray(data.metrics)) throw new Error('format');
      snapshot = data;
      loadProblem = null;
      render();
    }).catch(function (err) {
      var msg = String(err && err.message || '');
      if (msg.indexOf('version:') === 0) loadProblem = '快照版本 ' + msg.slice(8) + ' 不受支持，这个页面需要更新后才能显示。';
      else if (msg === 'format') loadProblem = '快照文件格式不对，读不出数字。';
      else loadProblem = '读不到快照文件，可能是网络断了或采集电脑还没上传。';
      render();
    });
  }

  load();
  if (fixedNow === null) {
    setInterval(load, REFETCH_MS);
    setInterval(render, RETICK_MS);
    document.addEventListener('visibilitychange', function () { if (!document.hidden) load(); });
  }
})();
