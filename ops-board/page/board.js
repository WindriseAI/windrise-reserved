/*
 * 运营状态页：只读同源 ./snapshot.json，按页面合同（给用户-运营状态单/快照字段.md）显示。
 * 不请求任何供应商接口，不带钥匙。空值不画成 0；估算和平台统计不标成已扣费。
 * 每次渲染都用当前时间重查每项 collectedAt，超过 staleAfterSeconds 就显示「未更新」。
 *
 * 版式按紧急程度从上往下（11-16 改版）：结论横幅 → 实时状态（服务、服务器在不在线，带最近 N 次检查竖条）
 * → 服务器资源（数字 + 细横条 + 小折线）→ 额度和用量 → 钱 → 折叠的到期、报到人数、后台链接。
 * 钱（余额、账单、费用）只用中性色，不计入横幅（用户 11-16：「看板费用别给我算异常，我自己看就行了」）。
 */
(function () {
  'use strict';

  var REFETCH_MS = 60000;
  var RETICK_MS = 30000;
  var STATUSES = ['正常', '关注', '警告', '未接', '失败', '未更新', '不适用'];
  var SNAPSHOT_STALE_MS = 30 * 60000;
  var STRIP_SLOTS = 48;
  // 额度用量低于这个百分比、状态正常的行，组内合成一行「其余 N 项正常」，默认收起（理由见页面-报告「发布前最后一轮」）
  var NEAR_ZERO_PCT = 10;
  // 横幅最多点几个名字，多出来的写「另 N 项」
  var BANNER_NAMES = 3;

  // ---------- 名字 ----------

  var NAMES = {
    'cf.requests': 'Workers 请求',
    'cf.errors': 'Workers 执行错误',
    'cf.cpu_p99_max': 'Workers CPU P99',
    'cf.d1.read': 'D1 读行',
    'cf.d1.write': 'D1 写行',
    'cf.d1.storage': 'D1 容量',
    'cf.d1.largest': 'D1 最大单库',
    'cf.kv.read': 'KV 读取',
    'cf.kv.write': 'KV 写入',
    'cf.kv.delete': 'KV 删除',
    'cf.kv.list': 'KV 列举',
    'cf.kv.storage': 'KV 容量',
    'cf.r2.a': 'R2 A 类操作',
    'cf.r2.b': 'R2 B 类操作',
    'cf.r2.storage': 'R2 容量',
    'cf.tunnels': '命名隧道',
    'mail.daily_free': 'DirectMail 今日赠额',
    'mail.total_free': 'DirectMail 累计赠额',
    'tencent_ses.month.sent': '腾讯 SES 本月',
    'tencent_ses.gift_remaining': '腾讯 SES 剩余赠额',
    'sms.package_remaining': '短信资源包剩余',
    'server.cloady.traffic': 'Cloady 流量',
    'server.cloady.requests': 'Cloady 请求',
    'server.cloady.cpu_hours': 'Cloady CPU 时长',
    'server.cloady.memory_gb_hours': 'Cloady 内存用量',
    'server.raksmart.traffic': '订阅流量',
    'aliyun.available': '阿里云可用额度',
    'aliyun.cash': '阿里云现金余额',
    'aliyun.yesterday_bill': '阿里云昨日账单',
    'huawei.cash': '华为云现金余额',
    'huawei.coupons': '华为云代金券',
    'sms.month.estimated_cost': '短信本月估算',
    'business.recent_hour': '最近 1 小时',
    'business.today': '今天',
    'business.members.free': '免费账号',
    'business.members.monthly': '月卡',
    'business.members.quarterly': '季卡',
    'business.members.yearly': '年卡',
    'business.members.trial': '试用',
    'business.members.manual': '手动发放',
    'business.members.other': '其他权益',
    'server.expiry_days': 'aleg 到期',
    'server.raksmart.expiry_days': 'RakSmart 账单到期',
    'server.raksmart.subscription_expiry_days': '订阅到期'
  };

  // 服务在线检查：指标 id 由后端写进《快照字段.md》；这里按 service.<键>.reachable 读，没有的项显示「未接」。
  // 「看板」在没有专门检查时用 Cloady HTTPS 连通（看板就跑在 Cloady 上）。
  var SERVICES = [['website_cn', '官网中文'], ['website_en', '官网英文'], ['gateway', '网关'], ['mcp', 'MCP'],
    ['activation', '激活接口'], ['ops_board', '看板', 'server.cloady.reachable']];

  // 服务器：先阿里云实例（aleg 在前），再按这个顺序；快照里有别的 server.<主机>.reachable 也照样列出
  var HOST_ORDER = ['aleg', 'raksmart', 'hwa', 'hwb', 'ln', 'pc1'];
  var HOST_NAMES = { aleg: 'aleg', raksmart: 'RakSmart', hwa: 'hwa', hwb: 'hwb', ln: 'LN', pc1: '电脑一' };
  // Cloady 是看板所在的应用，不当服务器列；它的用量在额度和用量里
  var HOST_SKIP = { cloady: true };
  var RESOURCES = [['cpu', 'CPU'], ['memory', '内存'], ['disk', '磁盘'], ['traffic', '流量']];

  var ALI_ID = /^aliyun\.([a-f0-9]{24})\.([a-z_]+)$/;
  var ALI_STATES = { Running: '运行中', Starting: '启动中', Stopping: '停止中', Stopped: '已停止', Pending: '准备中', Rebooting: '重启中',
    Resetting: '重置中', Expired: '已过期', Disabled: '已停用', Unknown: '状态未知' };
  var ALI_DOWN = { Stopped: true, Expired: true, Disabled: true };

  var DOMAINS = [['windrisebridge_com', 'windrisebridge.com'], ['windrisebridge_cn', 'windrisebridge.cn'], ['windrise_si', 'windrise.si'], ['secrethq_shop', 'secrethq.shop']];
  var CERTS = [['website_cn', 'windrisebridge.cn'], ['website_cn_www', 'www.windrisebridge.cn'], ['website_en', 'windrisebridge.com'], ['website_en_www', 'www.windrisebridge.com'],
    ['gateway', 'gw.windrise.si'], ['activation', 'api.secrethq.shop'], ['mcp', 'mcp.windrise.si'], ['cloady', 'Cloady'],
    ['ops', 'ops.windrise.si']];
  var MANUALS = [['evsign', 'Windows 签名'], ['mac_signing', 'Mac 代签'], ['feishu', '飞书企业邮箱']];

  var USAGE_GROUPS = [
    ['Cloudflare', ['cf.requests', 'cf.errors', 'cf.cpu_p99_max', 'cf.d1.read', 'cf.d1.write', 'cf.d1.storage', 'cf.d1.largest',
      'cf.kv.read', 'cf.kv.write', 'cf.kv.delete', 'cf.kv.list', 'cf.kv.storage', 'cf.r2.a', 'cf.r2.b', 'cf.r2.storage', 'cf.tunnels']
      // windrisebridge.cn 的 DNS 在 DNSPod，合同没有这一项
      .concat(DOMAINS.filter(function (d) { return d[0] !== 'windrisebridge_cn'; }).map(function (d) { return 'cf.dns.' + d[0]; }))],
    ['邮件', ['mail.daily_free', 'mail.total_free', 'tencent_ses.month.sent', 'tencent_ses.gift_remaining']],
    ['短信', ['@sms.day', '@sms.month', 'sms.package_remaining']],
    ['Cloady 和订阅', ['server.cloady.traffic', 'server.cloady.requests', 'server.cloady.cpu_hours', 'server.cloady.memory_gb_hours', 'server.raksmart.traffic']]
  ];
  var MONEY_IDS = ['aliyun.available', 'aliyun.cash', 'aliyun.yesterday_bill', 'huawei.cash', 'huawei.coupons', 'sms.month.estimated_cost'];
  // 钱：余额、账单、费用、价格。不判色、不计入横幅
  var MONEY = /^(aliyun\.(available|cash|yesterday_bill)|huawei\.(cash|coupons)|sms\.month\.estimated_cost|payments\..+)$|\.(hourly_price|monthly_price|renewal_price|annual_price)$/;

  var BACKEND = [
    ['Cloudflare 账单', 'https://dash.cloudflare.com/?to=/:account/billing'],
    ['阿里云费用', 'https://usercenter2.aliyun.com/home'],
    ['阿里云轻量服务器', 'https://swas.console.aliyun.com/#/servers'],
    ['Resend', 'https://resend.com/settings/usage'],
    ['Brevo', 'https://app.brevo.com/'],
    ['Elastic Email', 'https://app.elasticemail.com/'],
    ['Mailjet', 'https://app.mailjet.com/'],
    ['Mailtrap', 'https://mailtrap.io/'],
    ['Maileroo', 'https://app.maileroo.com/']
  ];
  var CONSOLE_NAMES = [[/^payments\.creem\./, 'Creem'], [/^payments\.alipay\./, '支付宝'], [/^github\./, 'GitHub']];

  // 读不到只有三类，照后端合同（快照字段.md）的 reason：not_provided 这家不提供、not_authorized 待授权、collect_failed 采集失败。
  // status=未接 单独显示「未接」，不归进这三类（见 unread）。
  var REASON_KIND = { not_provided: 'none', not_authorized: 'auth', collect_failed: 'fail' };
  // 旧夹具和改版前的快照 reason 写的是细分原因（合同里叫 reasonDetail）：按后端 reasons.mjs 的同一张表归类，认不出的算采集失败
  var DETAIL_KIND = {
    unsupported_billing_mode: 'none', traffic_package_empty: 'none', agent_no_data: 'none', subscription_expiry_missing: 'none',
    provider_unsupported: 'none', not_applicable: 'none',
    key_missing: 'auth', key_invalid: 'auth', permission_denied: 'auth', manual_missing: 'auth', probe_not_configured: 'auth',
    rate_not_configured: 'auth', console_only: 'auth', auth_pending: 'auth', needs_authorization: 'auth'
  };
  var KIND_LABEL = { none: '这家不提供', auth: '待授权', fail: '采集失败', unwired: '未接', stale: '未更新' };

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


  function duration(ms) {
    var min = Math.max(0, Math.floor(ms / 60000));
    if (min < 120) return min + ' 分钟';
    var h = Math.floor(min / 60);
    if (h < 48) return h + ' 小时';
    return Math.floor(h / 24) + ' 天 ' + (h % 24) + ' 小时';
  }

  function bytes(v) {
    var a = Math.abs(v);
    if (v === 0) return '0 GB';
    if (a >= 999.95e9) return oneFmt.format(v / 1e12) + ' TB';
    if (a >= 999.95e6) return oneFmt.format(v / 1e9) + ' GB';
    if (a >= 999.95e3) return oneFmt.format(v / 1e6) + ' MB';
    if (a >= 999.95) return oneFmt.format(v / 1e3) + ' KB';
    return intFmt.format(v) + ' 字节';
  }

  var CURRENCY = { CNY: '¥', USD: 'US$', JPY: 'JP¥' };


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
    if (kind === '%') return intFmt.format(Math.round(v)) + '%';
    if (kind === '秒') return duration(v * 1000);
    return (Number.isInteger(v) ? intFmt : oneFmt).format(v) + (kind ? ' ' + kind : '');
  }

  // 「已用 / 上限」：同单位只在上限后写一次
  function usedOfLimit(unit, used, limit) {
    if (unit === '字节') return bytes(used) + ' / ' + bytes(limit);
    var plain = function (v) { return (Number.isInteger(v) ? intFmt : oneFmt).format(v); };
    return plain(used) + ' / ' + fmt(unit, limit);
  }

  function num(key, kind, v, text) {
    return '<span class="num" data-k="' + esc(key) + '" data-f="' + esc(kind) + '" data-v="' + v + '">' + esc(text || fmt(kind, v)) + '</span>';
  }

  function anchorOf(id) { return 'm-' + String(id).replace(/[^a-zA-Z0-9_-]/g, '-'); }

  // ---------- 状态 ----------

  // 未接优先；有旧值且超时或时间回退显示未更新。页面以当前时间重查，不信 JSON 里的「正常」。
  function evaluate(m, t) {
    var used = typeof m.used === 'number' && isFinite(m.used) ? m.used : null;
    var limit = typeof m.limit === 'number' && isFinite(m.limit) ? m.limit : null;
    var status = STATUSES.indexOf(m.status) >= 0 ? m.status : '未知';
    var reason = m.reason || null;
    if (reason === 'not_applicable') { status = '不适用'; used = null; }
    var collected = m.collectedAt ? Date.parse(m.collectedAt) : NaN;
    var age = isFinite(collected) ? t - collected : null;
    if (status !== '未接' && status !== '不适用' && age !== null) {
      if (age < 0) { status = '未更新'; reason = 'clock_rollback'; }
      else if (typeof m.staleAfterSeconds === 'number' && age > m.staleAfterSeconds * 1000) { status = '未更新'; reason = reason === 'read_budget' ? reason : 'stale'; }
    }
    if (used === null && (status === '正常' || status === '关注' || status === '警告')) status = '未知';
    if (status === '未接' || status === '不适用') used = null;
    var pct = used !== null && limit !== null && limit > 0 ? used / limit * 100 : null;
    return { m: m, id: m.id, used: used, limit: limit, status: status, reason: reason, age: age, pct: pct };
  }

  // 读不到 / 不提供 / 停更：返回 { kind, label }；有正常数值返回 null
  function unread(e) {
    if (e.status === '不适用') return { kind: 'none', label: KIND_LABEL.none };
    if (e.status === '未更新' && e.used !== null) return { kind: 'stale', label: KIND_LABEL.stale };
    if (e.used !== null && e.status !== '失败') return null;
    if (e.used !== null && e.status === '失败') return { kind: 'stale', label: KIND_LABEL.stale };
    if (e.status === '未接') return { kind: 'unwired', label: KIND_LABEL.unwired };
    var kind = REASON_KIND[e.reason] || DETAIL_KIND[e.reason] || DETAIL_KIND[e.m.reasonDetail] || 'fail';
    return { kind: kind, label: KIND_LABEL[kind] };
  }

  // 后端标 alertEligible=false 的项（余额、账单、费用、不适用）不判色、不计入总体异常；用户 11-16「看板费用别给我算异常」
  function notAlerting(e) { return MONEY.test(e.id) || (e.m && e.m.alertEligible === false); }

  // 横幅和色调只认这几种；钱永远中性
  function tone(e) {
    if (MONEY.test(e.id)) return 'neutral';
    if (e.m && e.m.alertEligible === false && !unread(e)) return 'neutral';
    if (unread(e)) return 'unknown';
    if (e.status === '警告') return 'alert';
    if (e.status === '关注') return 'watch';
    if (e.status === '正常') return 'ok';
    return 'unknown';
  }

  // 本次渲染登记过的项：横幅从这里数
  var registry = [];
  var registered = {};
  // opt.anchor：几项合成一行显示时，横幅点名跳到那一行；opt.live：实时状态里的在线项
  function register(id, name, e, counted, opt) {
    if (registered[id]) return;
    registered[id] = true;
    opt = opt || {};
    registry.push({ id: id, name: name, e: e, counted: counted !== false && !notAlerting(e), anchor: opt.anchor || anchorOf(id), live: !!opt.live });
  }

  // ---------- 小部件 ----------

  function dot(t) { return '<span class="dot" data-t="' + t + '" aria-hidden="true"></span>'; }

  function historyOf(id) {
    var h = snapshot && snapshot.history && typeof snapshot.history === 'object' ? snapshot.history[id] : null;
    if (!Array.isArray(h)) return null;
    var list = h.filter(function (p) { return p && typeof p === 'object'; }).slice(-STRIP_SLOTS);
    return list.length ? list : null;
  }

  function pointTone(p) {
    var v = typeof p.v === 'number' && isFinite(p.v) ? p.v : null;
    if (p.status === '警告' || v === 0) return 'alert';
    if (v === null || (p.status && p.status !== '正常' && p.status !== '关注')) return 'none';
    if (p.status === '关注') return 'watch';
    return 'ok';
  }

  // 最近 N 次检查：一格一次，最新的在右；不满 48 次的左边留空格
  function strip(id) {
    var list = historyOf(id);
    if (!list) return '';
    var counts = { ok: 0, watch: 0, alert: 0, none: 0 };
    var cells = '';
    for (var i = 0; i < STRIP_SLOTS - list.length; i++) cells += '<i data-t="empty"></i>';
    list.forEach(function (p) {
      var t = pointTone(p);
      counts[t]++;
      var when = p.t && isFinite(Date.parse(p.t)) ? beijing(p.t) + ' ' : '';
      var word = t === 'ok' ? '正常' : t === 'alert' ? '异常' : t === 'watch' ? '关注' : '没数据';
      cells += '<i data-t="' + t + '" title="' + esc(when + word) + '"></i>';
    });
    var label = '最近 ' + list.length + ' 次检查：' + [['ok', '正常'], ['watch', '关注'], ['alert', '异常'], ['none', '没数据']]
      .filter(function (k) { return counts[k[0]]; }).map(function (k) { return counts[k[0]] + ' 次' + k[1]; }).join('，');
    return '<div class="strip" role="img" aria-label="' + esc(label) + '">' + cells + '</div>';
  }

  // 小折线：有两个以上数值点才画；纵轴从 0 到上限（没有上限就到最大值）
  function spark(id, limit) {
    var list = historyOf(id);
    if (!list) return '';
    var pts = list.map(function (p, i) { return { i: i, v: typeof p.v === 'number' && isFinite(p.v) ? p.v : null }; }).filter(function (p) { return p.v !== null; });
    if (pts.length < 2) return '';
    var W = 64, H = 20, pad = 2;
    var max = limit && limit > 0 ? limit : Math.max.apply(null, pts.map(function (p) { return p.v; }));
    if (!(max > 0)) max = 1;
    var span = Math.max(1, list.length - 1);
    var xy = pts.map(function (p) {
      var x = pad + (W - 2 * pad) * (p.i / span);
      var y = H - pad - (H - 2 * pad) * Math.max(0, Math.min(1, p.v / max));
      return [Math.round(x * 10) / 10, Math.round(y * 10) / 10];
    });
    var last = xy[xy.length - 1];
    return '<svg class="spark" width="' + W + '" height="' + H + '" viewBox="0 0 ' + W + ' ' + H + '" aria-hidden="true">' +
      '<polyline points="' + xy.map(function (p) { return p.join(','); }).join(' ') + '"/>' +
      '<circle cx="' + last[0] + '" cy="' + last[1] + '" r="2"/></svg>';
  }

  function bar(e) {
    var p = Math.max(0, Math.min(100, e.pct));
    return '<div class="bar" data-t="' + tone(e) + '" data-k="' + esc(e.id) + ':bar" data-p="' + p + '" style="--p:' + p + '%" aria-hidden="true"><span></span></div>';
  }

  // ---------- 1. 实时状态 ----------

  function onlineRow(key, name, e, words, extra) {
    var id = e ? e.id : extra && extra.entry ? extra.entry.id : 'missing.' + key;
    var a = anchorOf(id);
    var t, text;
    if (extra && extra.tone) { t = extra.tone; text = '<span class="state' + (t === 'alert' ? '' : ' is-muted') + '">' + esc(extra.text) + '</span>'; }
    else if (!e) { t = 'unknown'; text = '<span class="state is-muted">未接</span>'; }
    else {
      t = tone(e);
      var u = unread(e);
      if (u) text = '<span class="state is-muted">' + esc(u.label) + '</span>';
      else if (e.used === 0) { t = 'alert'; text = '<span class="state">' + esc(words.down) + '</span>'; }
      // 正常只留左边的小绿点，不再写「在线」（同一状态不两处标记）；有事才写短标签
      else if (t === 'ok') text = '';
      else text = '<span class="state">' + esc(t === 'alert' ? words.down : t === 'watch' ? '关注' : words.up) + '</span>';
    }
    if (e) register(id, name, e, true, { live: true });
    else if (extra && extra.entry) register(extra.entry.id, name, extra.entry, true, { live: true });
    var s = e ? strip(e.id) : '';
    return '<li class="live" id="' + a + '" data-t="' + t + '"><span class="live-name">' + dot(t) + '<span>' + esc(name) + '</span></span>' +
      '<span class="live-state">' + text + '</span>' + (s || '<span class="strip-none" aria-hidden="true"></span>') + '</li>';
  }

  function servicesCard(byId) {
    var known = {};
    var rows = SERVICES.map(function (s) {
      var e = byId['service.' + s[0] + '.reachable'] || null;
      if (!e) {
        // 后端可能用别的后缀：取这一服务下第一个布尔项
        Object.keys(byId).forEach(function (id) { if (!e && id.indexOf('service.' + s[0] + '.') === 0 && byId[id].m.unit === '布尔') e = byId[id]; });
      }
      if (!e && s[2]) e = byId[s[2]] || null;
      known['service.' + s[0]] = true;
      return onlineRow(s[0], s[1], e, { up: '在线', down: '连不上' });
    });
    // 快照里另有的服务也列出来
    Object.keys(byId).forEach(function (id) {
      var m = /^(service\.[a-z0-9_]+)\./.exec(id);
      if (!m || known[m[1]] || byId[id].m.unit !== '布尔') return;
      known[m[1]] = true;
      rows.push(onlineRow(id, byId[id].m.label || m[1].slice(8), byId[id], { up: '在线', down: '连不上' }));
    });
    return '<section class="card" aria-labelledby="h-svc"><h3 class="card-title" id="h-svc">服务</h3><ul class="lives">' + rows.join('') + '</ul></section>';
  }

  // 主机表：阿里云实例 + server.<主机>.*，按 HOST_ORDER 排
  function hostsOf(byId, ali) {
    var hosts = [];
    var seen = {};
    if (ali) {
      ali.instances.forEach(function (inst) {
        var key = inst.alias || inst.id;
        var get = function (k) { return byId['aliyun.' + inst.id + '.' + k] || null; };
        hosts.push({ key: key, order: inst.alias === 'aleg' ? 0 : 0.5, name: inst.alias || inst.name, inst: inst,
          reach: get('reachable'), cpu: get('cpu'), memory: get('memory'), disk: get('disk'), traffic: get('traffic') });
        seen[key] = true;
      });
      if (!ali.instances.length && ali.entry) hosts.push({ key: 'aliyun', order: 0, name: '阿里云', entry: ali.entry });
    }
    Object.keys(byId).forEach(function (id) {
      var m = /^server\.([a-z0-9_]+)\.([a-z_]+)$/.exec(id);
      if (!m || HOST_SKIP[m[1]] || seen[m[1]]) return;
      var h = m[1];
      seen[h] = true;
      var get = function (k) { return byId['server.' + h + '.' + k] || null; };
      var idx = HOST_ORDER.indexOf(h);
      hosts.push({ key: h, order: idx >= 0 ? idx : HOST_ORDER.length, name: HOST_NAMES[h] || h, reach: get('reachable'),
        cpu: get('cpu'), memory: get('memory'), disk: get('disk'),
        // RakSmart 的「流量」是本机网卡流量；订阅流量算额度，放在额度和用量里
        traffic: h === 'raksmart' ? get('host_traffic') : get('traffic') });
    });
    hosts.sort(function (a, b) { return a.order - b.order; });
    return hosts;
  }

  function serversCard(hosts) {
    var rows = hosts.map(function (h) {
      if (h.entry) return onlineRow(h.key, h.name, h.entry, { up: '在线', down: '连不上' });
      var vps = h.reach && h.reach.m.source === 'vps';
      var words = vps ? { up: '在线', down: '没上报' } : { up: '在线', down: '连不上' };
      var u = h.reach ? unread(h.reach) : null;
      // 没有探测端口（不适用）的阿里云实例：写供应商给的运行状态，不当连通
      if (h.inst && (!h.reach || (u && u.kind === 'none'))) {
        var st = h.inst.status;
        var tt = ALI_DOWN[st] ? 'alert' : st === 'Running' ? 'ok' : 'unknown';
        var entry = { id: 'aliyun.' + h.inst.id + '.state', status: tt === 'alert' ? '警告' : tt === 'ok' ? '正常' : '未知',
          used: tt === 'unknown' ? null : 1, reason: null, m: { id: 'aliyun.' + h.inst.id + '.state' } };
        return onlineRow(h.key, h.name, null, words, { tone: tt, text: ALI_STATES[st] || ALI_STATES.Unknown, entry: entry });
      }
      return onlineRow(h.key, h.name, h.reach, words);
    });
    if (!rows.length) return '';
    return '<section class="card" aria-labelledby="h-host"><h3 class="card-title" id="h-host">服务器</h3><ul class="lives">' + rows.join('') + '</ul></section>';
  }

  // ---------- 2. 服务器资源 ----------

  function resourceRow(hostName, label, e) {
    if (!e) return '';
    var name = hostName + ' ' + label;
    register(e.id, name, e);
    var u = unread(e);
    var value = '';
    var unit = e.m.unit || '';
    if (e.used !== null) {
      if (unit === '%') value = num(e.id, '%', e.used);
      else if (e.limit !== null && e.limit > 0) value = num(e.id, unit, e.used, usedOfLimit(unit, e.used, e.limit));
      else value = num(e.id, unit, e.used);
    }
    var t = tone(e);
    var head = '<div class="res-head"><span class="res-label">' + esc(label) + '</span>' + spark(e.id, unit === '%' ? 100 : e.limit) +
      '<span class="res-value' + (u ? ' is-muted' : '') + '">' + (value ? '<span class="v">' + value + '</span>' : '') +
      // 本机网卡流量从开始观测才计，月初那段没算，不能当整月
      (e.m.complete === false && e.used !== null ? '<span class="state is-muted">统计不完整</span>' : '') +
      (u ?'<span class="state is-muted">' + esc(u.label) + '</span>' : t === 'alert' || t === 'watch' ? dot(t) : '') + '</span></div>';
    var body = e.pct !== null && e.used !== null ? bar(e) : '';
    return '<li class="res" id="' + anchorOf(e.id) + '" data-t="' + t + '">' + head + body + '</li>';
  }

  function resourcesSection(hosts) {
    var cards = hosts.map(function (h) {
      if (h.entry) return '';
      var list = RESOURCES.map(function (r) {
        var e = h[r[0]];
        // ECS 的流量是近 15 分钟的出方向流量，不是本月
        var label = r[0] === 'traffic' && e && e.m.period === 'last-15-minutes' ? '15 分钟流量' : r[1];
        return [label, e];
      }).filter(function (x) { return x[1]; });
      if (!list.length) return '';
      // 四项都读不到且原因一样：一行写清
      var first = unread(list[0][1]);
      var same = list.length > 1 && first && list.every(function (x) { var u = unread(x[1]); return u && u.label === first.label && x[1].used === null; });
      var inner;
      if (same) {
        list.forEach(function (x) { register(x[1].id, h.name + ' ' + x[0], x[1], true, { anchor: anchorOf(list[0][1].id) }); });
        inner = '<p class="res-all" id="' + anchorOf(list[0][1].id) + '">' + list.map(function (x) { return x[0]; }).join('、') +
          '<span class="state is-muted">' + esc(first.label) + '</span></p>';
      } else {
        inner = '<ul class="ress">' + list.map(function (x) { return resourceRow(h.name, x[0], x[1]); }).join('') + '</ul>';
      }
      return '<section class="card host" aria-label="' + esc(h.name) + '"><h3 class="card-title">' + esc(h.name) + '</h3>' + inner + '</section>';
    }).join('');
    if (!cards) return '';
    return '<section class="sec" aria-labelledby="h-res"><h2 class="sec-title" id="h-res">服务器资源</h2><div class="hosts">' + cards + '</div></section>';
  }

  // ---------- 3. 额度和用量 ----------

  function usageRow(e, name) {
    name = name || NAMES[e.id] || e.m.label || e.id;
    register(e.id, name, e);
    var u = unread(e);
    var unit = e.m.unit || '';
    var t = tone(e);
    var right;
    if (e.used === null) right = '<span class="state is-muted">' + esc(u ? u.label : '采集失败') + '</span>';
    else if (e.limit !== null && e.limit > 0) right = num(e.id, unit, e.used, usedOfLimit(unit, e.used, e.limit));
    else if (e.limit === 0) right = num(e.id, unit, e.used) + ' / 0';
    else right = num(e.id, unit, e.used);
    // R2 有本月没归类的操作（reasonDetail=r2_unclassified_operations:N）：已归类的合计照常显示，名字下面一行 12 号字写未归类次数
    // （放在右边会把「R2 B 类操作」挤成几行）
    var unc = /^r2_unclassified_operations:(0|[1-9][0-9]*)$/.exec(e.m.reasonDetail || '');
    var note = unc && e.used !== null ? '<p class="use-note">未归类 ' + esc(fmt('', Number(unc[1]))) + ' 次</p>' : '';
    if (u && e.used !== null) right += '<span class="state is-muted">' + esc(u.label) + '</span>';
    else if (t === 'alert' || t === 'watch') right += dot(t);
    var body = e.pct !== null && e.used !== null ? bar(e) : '';
    return '<li class="use' + (body ? '' : ' no-bar') + '" id="' + anchorOf(e.id) + '" data-t="' + t + '"><div class="use-head"><span class="use-name">' + esc(name) + '</span>' +
      '<span class="use-value">' + right + '</span></div>' + note + body + '</li>';
  }

  // 短信：当天、本月各一行，写发送条数和失败回执
  function smsRow(byId, key, name) {
    var sent = byId['sms.' + key + '.sent'];
    var failed = byId['sms.' + key + '.failed'];
    var success = byId['sms.' + key + '.success'];
    if (!sent) return '';
    [sent, failed, success].forEach(function (e) { if (e) register(e.id, '短信' + name + NAMES_SMS[e.id.split('.').pop()], e, true, { anchor: anchorOf(sent.id) }); });
    var all = [sent, failed, success].filter(Boolean);
    var worstE = all.filter(function (e) { return tone(e) === 'alert'; })[0] || all.filter(function (e) { return tone(e) === 'watch'; })[0];
    var u = unread(sent);
    var right;
    if (sent.used === null) right = '<span class="state is-muted">' + esc(u ? u.label : '采集失败') + '</span>';
    else {
      right = num(sent.id, '条', sent.used);
      if (failed && failed.used !== null) right += '<span class="sub">失败 ' + esc(fmt('', failed.used)) + '</span>';
      if (worstE) right += dot(tone(worstE));
    }
    return '<li class="use no-bar" id="' + anchorOf(sent.id) + '"><div class="use-head"><span class="use-name">短信' + esc(name) + '</span><span class="use-value">' + right + '</span></div></li>';
  }
  var NAMES_SMS = { sent: '发送', success: '成功回执', failed: '失败回执' };

  function sortUsage(list) {
    var rank = { alert: 0, watch: 1 };
    return list.map(function (x, i) { return { x: x, i: i, r: x.e ? (rank[tone(x.e)] !== undefined ? rank[tone(x.e)] : 2) : 2 }; })
      .sort(function (a, b) { return a.r - b.r || a.i - b.i; }).map(function (o) { return o.x; });
  }

  // 接近 0 的额度行：有上限、有数、状态正常、用量低于 NEAR_ZERO_PCT。钱不在这一块，不受影响
  function nearZero(x) {
    var e = x.e;
    return !x.sms && e && tone(e) === 'ok' && e.used !== null && e.pct !== null && e.pct < NEAR_ZERO_PCT;
  }

  function usageSection(byId, openSet) {
    var groups = USAGE_GROUPS.map(function (g, gi) {
      var items = [];
      g[1].forEach(function (id) {
        if (id === '@sms.day') items.push({ html: smsRow(byId, 'day', '今天'), e: byId['sms.day.sent'], sms: true });
        else if (id === '@sms.month') items.push({ html: smsRow(byId, 'month', '本月'), e: byId['sms.month.sent'], sms: true });
        else if (byId[id]) {
          var e = byId[id];
          var dns = /^cf\.dns\.([a-z_]+)$/.exec(id);
          var name = null;
          if (dns) DOMAINS.forEach(function (d) { if (d[0] === dns[1]) name = d[1] + ' DNS 记录'; });
          items.push({ html: usageRow(e, name), e: e });
        }
      });
      items = items.filter(function (x) { return x.html; });
      if (!items.length) return '';
      var shown = sortUsage(items.filter(function (x) { return !nearZero(x); }));
      var rest = items.filter(nearZero);
      var html = shown.map(function (x) { return x.html; }).join('');
      // 只有一项时不收：收起一行再换出一行，没省下什么
      if (rest.length === 1) html += rest[0].html;
      else if (rest.length) {
        var key = 'rest-' + gi;
        html += '<li class="rest"><details data-fold="' + key + '"' + (openSet[key] ? ' open' : '') + '><summary>其余 ' + rest.length + ' 项正常</summary>' +
          '<ul class="uses">' + rest.map(function (x) { return x.html; }).join('') + '</ul></details></li>';
      }
      return '<div class="use-group"><h3 class="group-title">' + esc(g[0]) + '</h3><ul class="uses">' + html + '</ul></div>';
    }).join('');
    if (!groups) return '';
    return '<section class="sec sec-usage" aria-labelledby="h-use"><h2 class="sec-title" id="h-use">额度和用量</h2><div class="card"><div class="usage">' + groups + '</div></div></section>';
  }

  // ---------- 4. 钱 ----------

  function moneySection(byId) {
    var rows = MONEY_IDS.map(function (id) {
      var e = byId[id];
      if (!e) return '';
      register(e.id, NAMES[id], e, false);
      var u = unread(e);
      var value = e.used === null ? '<span class="state is-muted">' + esc(u ? u.label : '采集失败') + '</span>'
        : num(e.id, e.m.unit || '', e.used) + (u ? '<span class="state is-muted">' + esc(u.label) + '</span>' : '');
      return '<li class="money" id="' + anchorOf(id) + '"><span class="money-name">' + esc(NAMES[id]) + '</span><span class="money-value">' + value + '</span></li>';
    }).join('');
    if (!rows) return '';
    return '<section class="sec sec-money" aria-labelledby="h-money"><h2 class="sec-title" id="h-money">钱</h2><ul class="card moneys">' + rows + '</ul></section>';
  }

  // ---------- 5. 折叠：到期、报到人数、后台链接 ----------
  function daysText(d) {
    if (d > 0) return '还剩 ' + intFmt.format(d) + ' 天';
    if (d === 0) return '今天到期';
    return '已过期 ' + intFmt.format(-d) + ' 天';
  }


  function remainingDays(e) {
    var expires = e.m.expiresAt && isFinite(Date.parse(e.m.expiresAt)) ? e.m.expiresAt : null;
    return expires ? Math.ceil((Date.parse(expires) - now()) / 86400000) : e.used;
  }

  function expiryList(byId, ali) {
    var list = [];
    var add = function (id, name) { if (byId[id]) list.push({ e: byId[id], name: name }); };
    if (ali) ali.instances.forEach(function (inst) { add('aliyun.' + inst.id + '.expiry_days', (inst.alias || inst.name) + ' 到期'); });
    add('server.expiry_days', NAMES['server.expiry_days']);
    add('server.raksmart.expiry_days', NAMES['server.raksmart.expiry_days']);
    add('server.raksmart.subscription_expiry_days', NAMES['server.raksmart.subscription_expiry_days']);
    DOMAINS.forEach(function (d) { add('domain.' + d[0] + '.expiry_days', d[1] + ' 域名'); });
    CERTS.forEach(function (c) { add('cert.' + c[0] + '.expiry_days', c[1] + ' 证书'); });
    MANUALS.forEach(function (m) { add('manual.' + m[0] + '.expiry_days', m[1]); });
    // 这家不提供到期日（按量付费等）的不列
    return list.filter(function (x) { var u = unread(x.e); return !(u && u.kind === 'none'); });
  }

  // 展开后电脑宽分两栏 / 三栏，用网格按列排（先排满第一栏）：每栏几行在这里算好写进 --r2 / --r3，
  // 每栏第一行标 data-top2 / data-top3，样式据此不画上边线（多栏流排会把行间细线带到栏顶）
  function fold(key, title, count, unit, inner, open) {
    var n = (inner.match(/<li\b/g) || []).length;
    var r2 = Math.max(1, Math.ceil(n / 2)), r3 = Math.max(1, Math.ceil(n / 3)), k = 0;
    inner = inner.replace(/<li\b/g, function () { var i = k++; return '<li' + (i % r2 ? '' : ' data-top2') + (i % r3 ? '' : ' data-top3'); })
      .replace(/^<ul\b/, '<ul style="--r2:' + r2 + ';--r3:' + r3 + '"');
    return '<details class="card fold" data-fold="' + key + '"' + (open ? ' open' : '') + '><summary><span class="fold-title">' + esc(title) +
      '</span><span class="fold-count">' + count + ' ' + unit + '</span></summary>' + inner + '</details>';
  }

  function expiryFold(byId, ali, openSet) {
    var list = expiryList(byId, ali);
    if (!list.length) return '';
    list.forEach(function (x) { x.days = x.e.used === null ? null : remainingDays(x.e); register(x.e.id, x.name, x.e); });
    list.sort(function (a, b) { return (a.days === null ? 1e9 : a.days) - (b.days === null ? 1e9 : b.days); });
    var hot = list.some(function (x) { var tt = tone(x.e); return tt === 'alert' || tt === 'watch'; });
    var rows = list.map(function (x) {
      var t = tone(x.e);
      var u = unread(x.e);
      var right = x.days === null ? '<span class="state is-muted">' + esc(u ? u.label : '采集失败') + '</span>' : '<span class="num">' + esc(daysText(x.days)) + '</span>' + (u ? '<span class="state is-muted">' + esc(u.label) + '</span>' : '');
      return '<li class="kv" id="' + anchorOf(x.e.id) + '" data-t="' + t + '"><span class="kv-name">' + (t === 'alert' || t === 'watch' ? dot(t) : '') + esc(x.name) + '</span><span class="kv-value">' + right + '</span></li>';
    }).join('');
    return fold('expiry', '到期', list.length, '项', '<ul class="kvs">' + rows + '</ul>', hot || openSet.expiry);
  }

  function businessFold(byId, budget, openSet) {
    var ids = ['business.recent_hour', 'business.today', 'business.members.free', 'business.members.monthly', 'business.members.quarterly',
      'business.members.yearly', 'business.members.trial', 'business.members.manual', 'business.members.other'];
    var rows = ids.filter(function (id) { return byId[id]; }).map(function (id) {
      var e = byId[id];
      register(id, '报到 ' + NAMES[id], e, false);
      var u = unread(e);
      var unit = /^business\.(recent_hour|today)$/.test(id) ? '台' : '个';
      var right = e.used === null ? '<span class="state is-muted">' + esc(u ? u.label : '采集失败') + '</span>' : num(e.id, unit, e.used) + (u ? '<span class="state is-muted">' + esc(u.label) + '</span>' : '');
      return '<li class="kv" id="' + anchorOf(id) + '"><span class="kv-name">' + esc(NAMES[id]) + '</span><span class="kv-value">' + right + '</span></li>';
    });
    if (budget && typeof budget.limit === 'number' && budget.limit > 0 && typeof budget.used === 'number') {
      var e = { id: 'budget', m: { id: 'budget', unit: '行' }, used: budget.used, limit: budget.limit, pct: budget.used / budget.limit * 100,
        status: budget.used > budget.limit ? '警告' : '正常', reason: null };
      register('budget', '统计读行预算', e);
      rows.push('<li class="use" id="m-budget" data-t="' + tone(e) + '"><div class="use-head"><span class="use-name">统计读行预算</span><span class="use-value">' +
        num('budget', '行', budget.used, usedOfLimit('行', budget.used, budget.limit)) + '</span></div>' + bar(e) + '</li>');
    }
    if (!rows.length) return '';
    return fold('business', '报到人数', rows.length, '项', '<ul class="kvs">' + rows.join('') + '</ul>', openSet.business);
  }

  var LINK_ICON = '<svg class="ico" width="16" height="16" viewBox="0 0 24 24" aria-hidden="true"><path d="M7 17 17 7"/><path d="M7 7h10v10"/></svg>';

  function linksFold(list, openSet) {
    var links = BACKEND.slice();
    var seen = {};
    links.forEach(function (l) { seen[l[1]] = true; });
    list.forEach(function (e) {
      var url = e.m.consoleUrl;
      if (!url || !/^https:\/\//.test(url) || seen[url]) return;
      var name = null;
      CONSOLE_NAMES.forEach(function (c) { if (!name && c[0].test(e.id)) name = c[1]; });
      if (!name) return;
      seen[url] = true;
      links.push([name, url]);
    });
    var rows = links.map(function (l) {
      return '<li><a href="' + esc(l[1]) + '" target="_blank" rel="noopener noreferrer">' + LINK_ICON + '<span>' + esc(l[0]) + '</span></a></li>';
    }).join('');
    return fold('links', '后台链接', links.length, '个', '<ul class="links">' + rows + '</ul>', openSet.links);
  }

  // ---------- 横幅 ----------

  function banner(snap, t) {
    var stale = snap && snap.generatedAt && isFinite(Date.parse(snap.generatedAt)) ? t - Date.parse(snap.generatedAt) : null;
    if (!snap) {
      return bannerHtml('unknown', loadProblem ? '读不到快照' : '正在读取', loadProblem ? '<p class="banner-sub">' + esc(loadProblem) + '</p>' : '');
    }
    var counted = registry.filter(function (r) { return r.counted; });
    var alerts = counted.filter(function (r) { return tone(r.e) === 'alert'; });
    var watches = counted.filter(function (r) { return tone(r.e) === 'watch'; });
    // 读不到（待授权、采集失败、未更新）和未接都算「读不到」：在线状态未接时同样不能说「全部正常」
    var dark = counted.filter(function (r) { var u = unread(r.e); return u && u.kind !== 'none'; });
    var extra = loadProblem ? '<p class="banner-sub">' + esc(loadProblem) + '</p>' : '';
    if (stale !== null && (stale > SNAPSHOT_STALE_MS || stale < 0)) {
      var head = stale < 0 ? '快照时间不对' : '数据停更 ' + duration(stale);
      return bannerHtml('unknown', head, '<p class="banner-sub">' + esc(stale < 0 ? '快照时间晚于本机时间' : '下面是 ' + beijing(snap.generatedAt) + ' 的数') + '</p>' + extra);
    }
    var darkLine = dark.length ? '<p class="banner-sub">另有 ' + dark.length + ' 项读不到</p>' : '';
    if (alerts.length) {
      return bannerHtml('alert', alerts.length + ' 项异常', namesLine(alerts) + (watches.length ? '<p class="banner-sub">另有 ' + watches.length + ' 项需要注意</p>' : '') + darkLine + extra);
    }
    if (watches.length) return bannerHtml('watch', watches.length + ' 项需要注意', namesLine(watches) + darkLine + extra);
    // 服务、服务器在不在线读不到时不能说「全部正常」：横幅转灰，点名是哪几项
    var liveDark = dark.filter(function (r) { return r.live; });
    if (liveDark.length) {
      var rest = dark.length - liveDark.length;
      return bannerHtml('unknown', liveDark.length + ' 项在线状态读不到', namesLine(liveDark) + (rest ? '<p class="banner-sub">另有 ' + rest + ' 项读不到</p>' : '') + extra);
    }
    return bannerHtml('ok', '全部正常', darkLine + extra);
  }

  // 紧急程度：服务连不上 → 服务器连不上 → 7 天内到期（合同的警告线）→ 服务器资源 → 额度 → 8 天以上到期。
  // 同一档里资源和额度按用量百分比从高到低，到期按剩余天数从少到多，再按页面上的先后
  var RES_ID = /^(server\.[a-z0-9_]+|aliyun\.[a-f0-9]{24})\.(cpu|memory|disk|traffic|host_traffic)$/;
  function urgency(r, i) {
    var e = r.e;
    var rank, key = 0;
    if (r.live) rank = /^service\./.test(r.id) ? 0 : 1;
    else if (/expiry_days$/.test(r.id)) {
      var d = e.used === null ? null : remainingDays(e);
      rank = d !== null && d <= 7 ? 2 : 5;
      key = d === null ? 1e9 : d;
    } else {
      rank = RES_ID.test(r.id) ? 3 : 4;
      key = e.pct === null || e.pct === undefined ? 0 : -e.pct;
    }
    return { r: r, rank: rank, key: key, i: i };
  }
  function byUrgency(list) {
    return list.map(urgency).sort(function (a, b) { return a.rank - b.rank || a.key - b.key || a.i - b.i; }).map(function (o) { return o.r; });
  }

  // 最要紧的前三项点名，多出来的写「另 N 项」。
  // 每个名字和它后面的标点（「、」或「，另 N 项」）包成一段整体换行，标点不会落到行首
  function namesLine(list) {
    var sorted = byUrgency(list);
    var top = sorted.slice(0, BANNER_NAMES);
    var more = sorted.length > BANNER_NAMES ? '<span class="banner-more">，另 ' + (sorted.length - BANNER_NAMES) + ' 项</span>' : '';
    var html = top.map(function (r, i) {
      var tail = i < top.length - 1 ? '<span class="sep">、</span>' : more;
      return '<span class="banner-item"><a href="#' + r.anchor + '" data-jump="' + r.anchor + '">' + esc(r.name) + '</a>' + tail + '</span>';
    }).join('');
    return '<p class="banner-names">' + html + '</p>';
  }

  function bannerHtml(t, head, rest) {
    return '<section class="banner" data-t="' + t + '" aria-live="polite"><span class="banner-mark" aria-hidden="true"></span><div class="banner-body"><p class="banner-head">' + esc(head) + '</p>' + rest + '</div></section>';
  }

  // ---------- 页面 ----------

  function readAliyun(raw, t) {
    if (!raw || typeof raw !== 'object' || !Array.isArray(raw.instances)) return null;
    var metrics = [];
    var instances = raw.instances.filter(function (inst) {
      return inst && typeof inst.id === 'string' && /^[a-f0-9]{24}$/.test(inst.id) && Array.isArray(inst.metrics);
    }).map(function (inst) {
      inst.metrics.forEach(function (m) {
        if (!m || typeof m.id !== 'string' || m.id.indexOf('aliyun.' + inst.id + '.') !== 0) return;
        metrics.push(evaluate(m, t));
      });
      return { id: inst.id, alias: inst.alias, name: typeof inst.name === 'string' && inst.name ? inst.name : '阿里云实例', status: inst.status };
    });
    var status = STATUSES.indexOf(raw.status) >= 0 ? raw.status : '未知';
    var entry = !instances.length && status !== '正常'
      ? evaluate({ id: 'aliyunServers', label: '阿里云服务器', status: status, reason: raw.reason || null, used: null, limit: null, collectedAt: raw.collectedAt || null }, t)
      : null;
    return { instances: instances, metrics: metrics, entry: entry };
  }

  function headHtml(snap, t) {
    var line = '';
    if (snap && snap.generatedAt && isFinite(Date.parse(snap.generatedAt))) {
      line = '<span class="num">' + esc(beijing(snap.generatedAt)) + '</span> 更新';
    }
    var tag = snap && snap.mode === 'fixture' ? '<span class="tag">演示数据</span>' : '';
    return '<header class="head"><h1 class="head-title">运营状态</h1><p class="head-line">' + line + tag + '</p></header>';
  }

  function openFolds() {
    var set = {};
    app.querySelectorAll('details[data-fold]').forEach(function (d) { if (d.open) set[d.getAttribute('data-fold')] = true; });
    return set;
  }

  function render() {
    var t = now();
    registry = [];
    registered = {};
    var openSet = rendered ? openFolds() : {};
    var body = '';
    if (snapshot) {
      var list = (Array.isArray(snapshot.metrics) ? snapshot.metrics : [])
        .filter(function (m) { return m && typeof m.id === 'string'; })
        .map(function (m) { return evaluate(m, t); });
      var ali = readAliyun(snapshot.aliyunServers, t);
      if (ali) list = list.concat(ali.metrics, ali.entry ? [ali.entry] : []);
      var byId = {};
      list.forEach(function (e) { byId[e.id] = e; });
      var hosts = hostsOf(byId, ali);
      var live = '<section class="sec" aria-labelledby="h-live"><h2 class="sec-title" id="h-live">实时状态</h2><div class="lives-grid">' +
        servicesCard(byId) + serversCard(hosts) + '</div></section>';
      var res = resourcesSection(hosts);
      var use = usageSection(byId, openSet);
      var money = moneySection(byId);
      var folds = expiryFold(byId, ali, openSet) + businessFold(byId, snapshot.businessReadBudget, openSet) + linksFold(list, openSet);
      body = live + res + '<div class="pair">' + use + money + '</div>' + '<div class="folds">' + folds + '</div>';
    }
    var html = headHtml(snapshot, t) + banner(snapshot, t) + body;
    var old = rendered ? collect() : null;
    app.innerHTML = html;
    if (old) animateFrom(old);
    if (!rendered) requestAnimationFrame(function () { app.classList.add('is-live'); });
    rendered = true;
  }

  // 横幅里点名字：所在的折叠先展开，再滚到那一行，那一行留一个浅底
  app.addEventListener('click', function (ev) {
    var a = ev.target.closest ? ev.target.closest('a[data-jump]') : null;
    if (!a) return;
    var el = document.getElementById(a.getAttribute('data-jump'));
    if (!el) return;
    ev.preventDefault();
    var d = el.closest('details');
    if (d) d.open = true;
    app.querySelectorAll('.is-target').forEach(function (x) { x.classList.remove('is-target'); });
    el.classList.add('is-target');
    el.scrollIntoView({ behavior: reduceMotion.matches ? 'auto' : 'smooth', block: 'center' });
    if (history.replaceState) history.replaceState(null, '', '#' + el.id);
  });

  // ---------- 动效：只在两次读取之间数值变化时，数字和横条轻过渡；减少动态效果时直接终态 ----------

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

        el.style.setProperty('--p', old[key] + '%');
        requestAnimationFrame(function () { requestAnimationFrame(function () { el.style.setProperty('--p', to + '%'); }); });
        return;
      }
      var target = Number(el.getAttribute('data-v'));
      // 「已用 / 上限」这类拼过的文字不逐帧改写，直接换
      if (old[key] === target || !isFinite(old[key]) || el.textContent !== fmt(el.getAttribute('data-f'), target)) return;
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

      if (data.schemaVersion !== 1 && data.schemaVersion !== 2) throw new Error('version:' + String(data.schemaVersion));
      if (!Array.isArray(data.metrics)) throw new Error('format');
      snapshot = data;
      loadProblem = null;
      render();
    }).catch(function (err) {
      var msg = String(err && err.message || '');
      if (msg.indexOf('version:') === 0) loadProblem = '快照版本 ' + msg.slice(8) + ' 不受支持，页面要更新';
      else if (msg === 'format') loadProblem = '快照格式不对';
      else loadProblem = '读不到快照文件';
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
