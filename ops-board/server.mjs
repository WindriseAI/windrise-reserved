#!/usr/bin/env node
import http from 'node:http';
import { lstat, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isIP } from 'node:net';
import { createAuth } from './auth.mjs';
import { createResidentCollector } from './resident.mjs';
import { runtimeDependencies } from '../ops-status/runtime.mjs';
import { validateVpsReport } from './vps-spec.mjs';

const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.ico': 'image/x-icon', '.woff2': 'font/woff2' };
const loopback = address => ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(address);
function safePath(url) {
  const raw = url.split('?')[0];
  if (!raw.startsWith('/') || raw.includes('\\') || raw.includes('\0')) throw new Error('path_invalid');
  let decoded;
  try { decoded = decodeURIComponent(raw); } catch { throw new Error('path_invalid'); }
  if (decoded.includes('%') || decoded.includes('\\') || decoded.includes('\0') || decoded.split('/').some(part => part.startsWith('.'))) throw new Error('path_invalid');
  return decoded;
}
async function staticFile(root, route) {
  const parts = (route === '/' ? '/index.html' : route).slice(1).split('/');
  let current = root;
  for (const part of parts) {
    if (!part) throw new Error('file_missing');
    current = path.join(current, part);
    if ((await lstat(current)).isSymbolicLink()) throw new Error('file_missing');
  }
  const actual = await realpath(current);
  const relative = path.relative(root, actual);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative) || !(await lstat(actual)).isFile()) throw new Error('file_missing');
  const type = TYPES[path.extname(actual).toLowerCase()];
  if (!type) throw new Error('file_missing');
  return { type, body: await readFile(actual) };
}
async function readVpsReport(req) {
  if (req.headers['content-encoding'] || !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(req.headers['content-type'] ?? '')) throw new Error('content_type');
  if (Number(req.headers['content-length']) > 4096) throw new Error('too_large');
  const chunks = []; let size = 0;
  for await (const chunk of req) {
    size += chunk.length; if (size > 4096) throw new Error('too_large'); chunks.push(chunk);
  }
  return validateVpsReport(JSON.parse(Buffer.concat(chunks).toString('utf8')));
}
async function loginForm(req) {
  if (req.headers['content-encoding'] || !/^application\/x-www-form-urlencoded(?:\s*;\s*charset=utf-8)?$/i.test(req.headers['content-type'] ?? '')) throw new Error('content_type');
  const chunks = []; let size = 0;
  for await (const chunk of req) { size += chunk.length; if (size > 4096) throw new Error('too_large'); chunks.push(chunk); }
  return new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
}
function loginIp(req) {
  const peer = (req.socket.remoteAddress ?? '').replace(/^::ffff:/, '');
  const proxy = /^(?:10\.|127\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.)/.test(peer) || peer === '::1' || /^(?:fc|fd)[a-f0-9:]+$/i.test(peer);
  // Cloady's ingress appends the client address. Ignore untrusted leading entries.
  const forwarded = req.headers['x-forwarded-for']?.split(',').at(-1)?.trim();
  return proxy && isIP(forwarded ?? '') ? forwarded : peer;
}


export async function createBoardServer({ pageDirectory, authConfig, sessionKey, getRecord = () => null, acceptVpsReport = null, now = Date.now, landingFile = null, hosted = false }) {
  const pageRoot = await realpath(pageDirectory);
  if ((await lstat(pageDirectory)).isSymbolicLink() || !(await lstat(pageRoot)).isDirectory()) throw new Error('page_invalid');
  const auth = createAuth(authConfig, { sessionKey, now });
  let writing = false; let lastVpsAt = null;
  const server = http.createServer({ maxHeaderSize: 8192, requestTimeout: 30_000, headersTimeout: 10_000 }, async (req, res) => {
    const reply = (status, body = '', extra = {}) => {
      res.writeHead(status, { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', 'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'", ...extra });
      res.end(req.method === 'HEAD' ? undefined : body);
      if (!req.readableEnded) req.resume();
    };
    try {
      // Cloady terminates HTTPS and forwards to this container's HTTP port.
      if ((!hosted && !loopback(req.socket.remoteAddress)) || req.headers['x-forwarded-proto'] !== 'https') { reply(400); return; }
      const shortDomain = req.headers.host?.toLowerCase() === 'ops.windrise.si';
      const base = hosted && !shortDomain ? '/ops-board/' : '/';
      const loginPage = async message => (await readFile(path.join(pageRoot, 'login.html'), 'utf8')).replace('<!--LOGIN_MESSAGE-->', message ? `<p role="alert">${message}</p>` : '');
      let route; let requestPath = req.url;
      try {
        safePath(requestPath);
        if (hosted) {
          if (requestPath === '/healthz' && ['GET', 'HEAD'].includes(req.method)) { reply(200, 'ok'); return; }
          if (!shortDomain && (requestPath === '/' || requestPath === '/index.html') && landingFile && ['GET', 'HEAD'].includes(req.method)) { reply(200, await readFile(landingFile), { 'content-type': TYPES['.html'], 'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'" }); return; }
          if (requestPath === '/ops-board' && ['GET', 'HEAD'].includes(req.method)) { reply(308, '', { location: '/ops-board/' }); return; }
          if (requestPath.startsWith('/ops-board/')) requestPath = requestPath.slice('/ops-board'.length);
          else if (!shortDomain) { reply(404); return; }
        }
        route = safePath(requestPath);
      } catch { reply(400); return; }
      if (route.startsWith('/upload/')) {
        if (requestPath !== '/upload/raksmart.json') { reply(404); return; }
        if (req.method !== 'PUT') { reply(405, '', { allow: 'PUT' }); return; }
        if (!auth.vpsUpload(req.headers.authorization)) { reply(401); return; }
        if (!acceptVpsReport) { reply(503); return; }
        if (writing) { reply(429); return; }
        writing = true;
        try {
          const report = await readVpsReport(req);
          if (Date.parse(report.collectedAt) > now() + 300000) { reply(422); return; }
          if (lastVpsAt && report.collectedAt < lastVpsAt) { reply(409); return; }
          acceptVpsReport(report); lastVpsAt = report.collectedAt; reply(204);
        } catch (error) { reply(error.message === 'too_large' ? 413 : error.message === 'content_type' ? 415 : error.message === 'report_invalid' || error instanceof SyntaxError ? 422 : 500); }
        finally { writing = false; }
        return;
      }
      if (route === '/login') {
        if (['GET', 'HEAD'].includes(req.method)) { reply(200, await loginPage(), { 'content-type': TYPES['.html'] }); return; }
        if (req.method !== 'POST') { reply(405, '', { allow: 'GET, HEAD, POST' }); return; }
        if (req.headers.origin) {
          let sameOrigin = false;
          try { const origin = new URL(req.headers.origin); sameOrigin = origin.protocol === 'https:' && origin.host === req.headers.host; } catch {}
          if (!sameOrigin) { reply(403); return; }
        }
        let form;
        try { form = await loginForm(req); }
        catch (error) { reply(error.message === 'too_large' ? 413 : 415); return; }
        const result = await auth.login(form.get('username'), form.get('password'), form.get('remember') === '1', loginIp(req));
        if (result.status === 200) { reply(303, '', { location: base, 'set-cookie': result.cookie }); return; }
        const message = result.status === 429 ? '尝试太多，稍后再试' : '账号或密码不对';
        reply(result.status, await loginPage(message), { 'content-type': TYPES['.html'], ...(result.retryAfter ? { 'retry-after': result.retryAfter } : {}) }); return;
      }
      if (!['GET', 'HEAD'].includes(req.method)) { reply(405, '', { allow: 'GET, HEAD' }); return; }
      if (route === '/board.css') { const file = await staticFile(pageRoot, route); reply(200, file.body, { 'content-type': file.type }); return; }
      if (!auth.reader(req.headers.cookie)) {
        reply(401, route === '/' || route === '/index.html' ? await loginPage() : '', { 'content-type': TYPES['.html'] }); return;
      }
      if (route === '/snapshot.json') {
        const record = getRecord();
        if (!record) { reply(503); return; }
        reply(200, JSON.stringify(record.snapshot), { 'content-type': 'application/json; charset=utf-8', 'x-ops-collected-at': record.collectedAt });
        return;
      }
      try { const file = await staticFile(pageRoot, route); reply(200, file.body, { 'content-type': file.type }); }
      catch { reply(404); }
    } catch { if (!res.headersSent) reply(500); else res.destroy(); }
  });
  server.keepAliveTimeout = 5000;
  server.maxRequestsPerSocket = 100;
  return server;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 2) throw new Error('arguments_invalid');
    const authConfig = JSON.parse(process.env.OPS_BOARD_AUTH ?? 'null');
    delete process.env.OPS_BOARD_AUTH;
    const sessionKey = process.env.OPS_BOARD_SESSION_KEY;
    delete process.env.OPS_BOARD_SESSION_KEY;
    const port = Number(process.env.PORT ?? 3000);
    if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error('port_invalid');
    const resident = createResidentCollector({ dependencies: await runtimeDependencies() });
    const server = await createBoardServer({ pageDirectory: fileURLToPath(new URL('./page/', import.meta.url)), authConfig, sessionKey, getRecord: resident.getRecord, acceptVpsReport: resident.acceptVpsReport, hosted: true, landingFile: fileURLToPath(new URL('./landing.html', import.meta.url)) });
    server.on('error', () => { console.error('server_failed'); process.exitCode = 1; });
    server.listen(port, '0.0.0.0', () => { console.log('server_ready'); void resident.start(); });
    for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { void resident.stop(); server.close(); });
  } catch { console.error('server_config_invalid'); process.exitCode = 1; }
}
