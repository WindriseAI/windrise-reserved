#!/usr/bin/env node
import http from 'node:http';
import { lstat, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAuth } from './auth.mjs';
import { validateSnapshot, MAX_SNAPSHOT_BYTES } from './snapshot.mjs';

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
async function readSnapshot(req) {
  if (req.headers['content-encoding'] || !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(req.headers['content-type'] ?? '')) throw new Error('content_type');
  if (Number(req.headers['content-length']) > MAX_SNAPSHOT_BYTES) throw new Error('too_large');
  const chunks = []; let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_SNAPSHOT_BYTES) throw new Error('too_large');
    chunks.push(chunk);
  }
  return validateSnapshot(JSON.parse(Buffer.concat(chunks).toString('utf8')));
}

export async function createBoardServer({ pageDirectory, authConfig, now = Date.now, landingFile = null, hosted = false }) {
  const pageRoot = await realpath(pageDirectory);
  if ((await lstat(pageDirectory)).isSymbolicLink() || !(await lstat(pageRoot)).isDirectory()) throw new Error('page_invalid');
  let record = null; let writing = false;
  const auth = createAuth(authConfig, now);
  const server = http.createServer({ maxHeaderSize: 8192, requestTimeout: 30_000, headersTimeout: 10_000 }, async (req, res) => {
    const reply = (status, body = '', extra = {}) => {
      res.writeHead(status, { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', 'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'", ...extra });
      res.end(req.method === 'HEAD' ? undefined : body);
      if (!req.readableEnded) req.resume();
    };
    try {
      // Cloady terminates HTTPS and forwards to this container's HTTP port.
      if ((!hosted && !loopback(req.socket.remoteAddress)) || req.headers['x-forwarded-proto'] !== 'https') { reply(400); return; }
      let route; let requestPath = req.url;
      try {
        safePath(requestPath);
        if (hosted) {
          if (requestPath === '/healthz' && ['GET', 'HEAD'].includes(req.method)) { reply(200, 'ok'); return; }
          if ((requestPath === '/' || requestPath === '/index.html') && landingFile && ['GET', 'HEAD'].includes(req.method)) { reply(200, await readFile(landingFile), { 'content-type': TYPES['.html'], 'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'" }); return; }
          if (requestPath === '/ops-board' && ['GET', 'HEAD'].includes(req.method)) { reply(308, '', { location: '/ops-board/' }); return; }
          if (!requestPath.startsWith('/ops-board/')) { reply(404); return; }
          requestPath = requestPath.slice('/ops-board'.length);
        }
        route = safePath(requestPath);
      } catch { reply(400); return; }
      if (route.startsWith('/upload/')) {
        if (requestPath !== '/upload/snapshot.json') { reply(404); return; }
        if (req.method !== 'PUT') { reply(405, '', { allow: 'PUT' }); return; }
        if (!auth.upload(req.headers.authorization)) { reply(401); return; }
        if (writing) { reply(429); return; }
        writing = true;
        try {
          const snapshot = await readSnapshot(req);
          if (snapshot.mode !== 'local') { reply(422); return; }
          if (Date.parse(snapshot.generatedAt) > now() + 300_000) { reply(422); return; }
          if (record && Date.parse(snapshot.generatedAt) < Date.parse(record.snapshot.generatedAt)) { reply(409); return; }
          const next = { snapshot, uploadedAt: new Date(now()).toISOString() };
          record = next;
          reply(204);
        } catch (error) { reply(error.message === 'too_large' ? 413 : error.message === 'content_type' ? 415 : ['snapshot_invalid', 'Unexpected end of JSON input'].includes(error.message) || error instanceof SyntaxError ? 422 : 500); }
        finally { writing = false; }
        return;
      }
      if (!['GET', 'HEAD'].includes(req.method)) { reply(405, '', { allow: 'GET, HEAD' }); return; }
      if (!await auth.reader(req.headers.authorization)) { reply(401, '', { 'www-authenticate': 'Basic realm="Operations", charset="UTF-8"' }); return; }
      if (route === '/snapshot.json') {
        if (!record) { reply(503); return; }
        reply(200, JSON.stringify(record.snapshot), { 'content-type': 'application/json; charset=utf-8', 'x-ops-uploaded-at': record.uploadedAt });
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
    const port = Number(process.env.PORT ?? 3000);
    if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error('port_invalid');
    const server = await createBoardServer({ pageDirectory: fileURLToPath(new URL('./page/', import.meta.url)), authConfig, hosted: true, landingFile: fileURLToPath(new URL('./landing.html', import.meta.url)) });
    server.on('error', () => { console.error('server_failed'); process.exitCode = 1; });
    server.listen(port, '0.0.0.0', () => console.log('server_ready'));
    for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close());
  } catch { console.error('server_config_invalid'); process.exitCode = 1; }
}
