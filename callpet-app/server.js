import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from './lib/db.js';
import { createApi, HttpError } from './lib/api.js';

const ROOT = resolve(fileURLToPath(new URL('./public', import.meta.url)));
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
};
const MAX_BODY = 100 * 1024;

export function createAppServer(db, options = {}) {
  const api = createApi(db, options);

  async function readBody(req) {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > MAX_BODY) throw new HttpError(413, '요청이 너무 큽니다.');
      chunks.push(chunk);
    }
    if (!size) return {};
    try {
      const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
      return parsed;
    } catch {
      throw new HttpError(400, 'JSON 형식이 올바르지 않습니다.');
    }
  }

  function send(res, status, body, type = TYPES['.json']) {
    res.writeHead(status, {
      'Content-Type': type,
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'Content-Security-Policy': "default-src 'self'; style-src 'self'; script-src 'self'; img-src 'self' data:; frame-ancestors 'none'",
    });
    res.end(body);
  }

  return createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      if (url.pathname.startsWith('/api/')) {
        const body = req.method === 'GET' || req.method === 'DELETE' ? {} : await readBody(req);
        const { status, data } = await api(req.method, url.pathname, url.searchParams, req.headers, body);
        return send(res, status, JSON.stringify(data));
      }
      if (req.method !== 'GET') throw new HttpError(405, '허용되지 않는 요청입니다.');
      let path = url.pathname === '/' ? '/index.html' : url.pathname === '/hospital' ? '/hospital.html' : url.pathname;
      const file = resolve(join(ROOT, normalize(decodeURIComponent(path))));
      if (!file.startsWith(ROOT + '/')) throw new HttpError(404, '찾을 수 없습니다.');
      const content = await readFile(file).catch(() => null);
      if (!content) throw new HttpError(404, '찾을 수 없습니다.');
      return send(res, 200, content, TYPES[extname(file)] ?? 'application/octet-stream');
    } catch (err) {
      if (err instanceof HttpError) return send(res, err.status, JSON.stringify({ error: err.message }));
      console.error(err);
      return send(res, 500, JSON.stringify({ error: '서버 오류가 발생했습니다.' }));
    }
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT ?? 3000);
  const db = openDb(process.env.DB_PATH ?? 'callpet.db');
  const adminKey = process.env.ADMIN_KEY ?? '';
  if (!adminKey) console.warn('ADMIN_KEY가 없어 병원 승인 API가 비활성화됩니다.');
  createAppServer(db, { adminKey }).listen(port, () => console.log(`http://localhost:${port}`));
}
