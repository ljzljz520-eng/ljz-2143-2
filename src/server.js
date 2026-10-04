import { createServer } from 'node:http';
import { createReadStream, statSync } from 'node:fs';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { createService, ValidationError } from './service.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = resolve(__dirname, '../public');
const PORT = Number(process.env.PORT || 3000);
const DATA_FILE = process.env.DATA_FILE || resolve(process.cwd(), 'data/checkin.json');
const RESET = process.env.RESET_DATA === '1';

const service = createService(DATA_FILE, { reset: RESET });

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon'
};

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(payload)
  });
  res.end(payload);
}

function readBody(req) {
  return new Promise((resolveBody, rejectBody) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 1_000_000) {
        rejectBody(new ValidationError('body_too_large'));
        req.destroy();
      }
    });
    req.on('end', () => {
      if (!body) return resolveBody({});
      try {
        resolveBody(JSON.parse(body));
      } catch {
        rejectBody(new ValidationError('invalid_json'));
      }
    });
    req.on('error', rejectBody);
  });
}

function serveStatic(req, res, pathname) {
  const requested = pathname === '/' ? '/index.html' : pathname;
  const safePath = normalize(requested).replace(/^(\.\.[/\\])+/, '');
  const filePath = join(PUBLIC_DIR, safePath);
  if (!filePath.startsWith(PUBLIC_DIR)) {
    sendJson(res, 403, { error: 'forbidden' });
    return;
  }
  let stats;
  try {
    stats = statSync(filePath);
    if (stats.isDirectory()) throw new Error('dir');
  } catch {
    // 未知前端路由交给 index；真实资源 404 由浏览器/onerror 自行降级。
    const fallback = join(PUBLIC_DIR, 'index.html');
    res.writeHead(200, { 'content-type': MIME['.html'] });
    createReadStream(fallback).pipe(res);
    return;
  }
  res.writeHead(200, {
    'content-type': MIME[extname(filePath)] || 'application/octet-stream',
    'cache-control': extname(filePath) === '.html' ? 'no-store' : 'public, max-age=60'
  });
  createReadStream(filePath).pipe(res);
}

function sse(req, res, scope) {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-store, no-transform',
    connection: 'keep-alive',
    'access-control-allow-origin': '*'
  });
  const hello = scope === 'public' ? service.publicSnapshot() : service.adminSnapshot();
  res.write(`retry: 2000\n`);
  res.write(`event: hello\ndata: ${JSON.stringify(hello)}\n\n`);
  const listener = (commit) => {
    const payload = scope === 'public' ? service.publicSnapshot() : service.adminSnapshot();
    res.write(`id: ${commit.revision}\n`);
    res.write(`event: commit\ndata: ${JSON.stringify({ commit, payload })}\n\n`);
  };
  service.store.on('commit', listener);
  const ping = setInterval(() => res.write(': ping\n\n'), 25_000);
  req.on('close', () => {
    clearInterval(ping);
    service.store.off('commit', listener);
  });
}

async function handleApi(req, res, pathname) {
  const method = req.method;

  if (pathname === '/api/screen' && method === 'GET') return sendJson(res, 200, service.publicSnapshot());
  if (pathname === '/api/admin' && method === 'GET') return sendJson(res, 200, service.adminSnapshot());
  if (pathname === '/api/events' && method === 'GET') {
    const url = new URL(req.url, 'http://localhost');
    return sse(req, res, url.searchParams.get('scope') === 'public' ? 'public' : 'admin');
  }

  if (method !== 'POST') return sendJson(res, 405, { error: 'method_not_allowed' });
  const body = await readBody(req);

  try {
    if (pathname === '/api/checkins') return sendJson(res, 200, service.submitOnline(body));
    if (pathname === '/api/sync') return sendJson(res, 200, service.syncBatch(body));
    if (pathname === '/api/tickets') return sendJson(res, 200, service.issueOfflineTicket(body));
    if (pathname === '/api/admin/sessions') return sendJson(res, 200, service.createSession(body));
    if (pathname === '/api/admin/eligibility') return sendJson(res, 200, service.grantEligibility(body));
    if (pathname === '/api/admin/recompute') return sendJson(res, 200, service.recompute());
    if (pathname === '/api/admin/publish') return sendJson(res, 200, service.publish(body));

    const resolveMatch = pathname.match(/^\/api\/admin\/staging\/([^/]+)\/resolve$/);
    if (resolveMatch) return sendJson(res, 200, service.resolveConflict({ ...body, stagingId: resolveMatch[1] }));
    const heartbeatMatch = pathname.match(/^\/api\/devices\/([^/]+)\/heartbeat$/);
    if (heartbeatMatch) return sendJson(res, 200, service.heartbeat(heartbeatMatch[1]));

    return sendJson(res, 404, { error: 'not_found' });
  } catch (error) {
    if (error instanceof ValidationError) {
      return sendJson(res, 400, { error: error.code, message: error.message });
    }
    console.error(error);
    return sendJson(res, 500, { error: 'internal_error', message: error.message });
  }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  try {
    res.setHeader('access-control-allow-origin', '*');
    res.setHeader('access-control-allow-methods', 'GET,POST,OPTIONS');
    res.setHeader('access-control-allow-headers', 'content-type');
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      return res.end();
    }
    if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url.pathname);
    return serveStatic(req, res, url.pathname);
  } catch (error) {
    if (!res.headersSent) sendJson(res, 500, { error: 'internal_error', message: error.message });
  }
});

if (process.env.NODE_ENV !== 'test') {
  server.listen(PORT, () => {
    console.log(`校园签到服务已启动：http://localhost:${PORT}`);
    console.log(`数据文件：${DATA_FILE}`);
  });
}

export { server, service };
