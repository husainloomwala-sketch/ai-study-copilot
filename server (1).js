// AI Study Copilot server: static files + tiny JSON database + Claude proxy.
// No npm dependencies. Node 18+.
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, 'data', 'db.json');
const API_KEY = process.env.ANTHROPIC_API_KEY || '';
const MODEL = process.env.CLAUDE_MODEL || 'claude-sonnet-5-5';
const PUBLIC = path.join(__dirname, 'public');
const MAX_BODY = 1_000_000;
const AI_LIMIT_PER_HOUR = Number(process.env.AI_LIMIT_PER_HOUR || 60);

/* ---------- storage: one JSON file, flushed on a short debounce ---------- */
let db = {};
try { db = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); } catch (e) { db = {}; }
let flushTimer = null;
function flush() {
  clearTimeout(flushTimer);
  flushTimer = setTimeout(() => {
    try {
      fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
      const tmp = DATA_FILE + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(db));
      fs.renameSync(tmp, DATA_FILE);
    } catch (e) { console.error('flush failed', e.message); }
  }, 300);
}
process.on('SIGTERM', () => { try { fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true }); fs.writeFileSync(DATA_FILE, JSON.stringify(db)); } catch (e) {} process.exit(0); });

/* ---------- helpers ---------- */
function send(res, code, obj, headers) {
  res.writeHead(code, Object.assign({ 'Content-Type': 'application/json' }, headers || {}));
  res.end(JSON.stringify(obj));
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let n = 0; const chunks = [];
    req.on('data', c => { n += c.length; if (n > MAX_BODY) { reject({ code: 'prompt_too_large' }); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString() || '{}')); } catch (e) { reject({ code: 'invalid_argument' }); } });
    req.on('error', () => reject({ code: 'unavailable' }));
  });
}
function cookies(req) {
  const o = {};
  (req.headers.cookie || '').split(';').forEach(p => { const i = p.indexOf('='); if (i > 0) o[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim()); });
  return o;
}
// Anonymous identity: a random id in an HttpOnly cookie. Each browser gets its own private data.
function identify(req, res) {
  let sid = cookies(req).sid;
  if (!/^[a-f0-9]{32}$/.test(sid || '')) {
    sid = crypto.randomBytes(16).toString('hex');
    const secure = (req.headers['x-forwarded-proto'] || '') === 'https' ? '; Secure' : '';
    res.setHeader('Set-Cookie', 'sid=' + sid + '; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000' + secure);
  }
  return sid;
}
function cleanPath(p, sid) {
  if (typeof p !== 'string' || p.length > 300) return null;
  p = p.replace(/^\/+|\/+$/g, '');
  if (!/^[\w\-./]+$/.test(p) || p.includes('..')) return null;
  return p.startsWith('data/users/' + sid + '/') || p === 'data/users/' + sid ? p : null;
}

const hits = new Map();
function limited(ip) {
  const now = Date.now(), h = (hits.get(ip) || []).filter(t => now - t < 3600e3);
  if (h.length >= AI_LIMIT_PER_HOUR) { hits.set(ip, h); return true; }
  h.push(now); hits.set(ip, h); return false;
}

/* ---------- API: database ---------- */
async function handleDb(req, res, sid) {
  const b = await readBody(req);
  const p = cleanPath(b.path, sid);
  if (!p) return send(res, 400, { code: 'invalid_argument' });
  if (b.op === 'get') return send(res, 200, { exists: Object.prototype.hasOwnProperty.call(db, p), data: db[p] || null });
  if (b.op === 'set') {
    if (JSON.stringify(b.data || {}).length > 400000) return send(res, 400, { code: 'invalid_argument' });
    db[p] = b.data || {}; flush(); return send(res, 200, { ok: true });
  }
  if (b.op === 'delete') { delete db[p]; flush(); return send(res, 200, { ok: true }); }
  if (b.op === 'list') { // direct children of a "collection" path
    const prefix = p + '/', docs = [];
    Object.keys(db).forEach(k => {
      if (k.startsWith(prefix) && !k.slice(prefix.length).includes('/')) docs.push({ id: k.slice(prefix.length), data: db[k] });
    });
    return send(res, 200, { docs });
  }
  return send(res, 400, { code: 'invalid_argument' });
}

/* ---------- API: Claude proxy (streams newline-delimited JSON) ---------- */
async function handleAi(req, res, sid) {
  if (!API_KEY) return send(res, 503, { code: 'sampling_disabled' });
  const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
  if (limited(ip + '|' + sid)) return send(res, 429, { code: 'rate_limited' });
  const b = await readBody(req);
  let messages = b.messages;
  if (typeof b.prompt === 'string') messages = [{ role: 'user', content: b.prompt }];
  if (!Array.isArray(messages) || !messages.length || messages.length > 20) return send(res, 400, { code: 'invalid_argument' });
  messages = messages.map(m => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: String(m.content || '').slice(0, 60000) }));
  if (messages[0].role !== 'user') return send(res, 400, { code: 'invalid_argument' });

  const ctl = new AbortController();
  res.on('close', () => ctl.abort());
  let up;
  try {
    up = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST', signal: ctl.signal,
      headers: { 'content-type': 'application/json', 'x-api-key': API_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: MODEL, max_tokens: Math.min(Number(b.maxTokens) || 2048, 4096), stream: true, messages })
    });
  } catch (e) { return send(res, 502, { code: 'unavailable' }); }
  if (!up.ok) {
    const code = up.status === 429 ? 'rate_limited' : 'unavailable';
    console.error('anthropic error', up.status, (await up.text()).slice(0, 300));
    return send(res, up.status === 429 ? 429 : 502, { code });
  }
  res.writeHead(200, { 'Content-Type': 'application/x-ndjson', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' });
  const dec = new TextDecoder(); let buf = '';
  try {
    for await (const chunk of up.body) {
      buf += dec.decode(chunk, { stream: true });
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
        if (!line.startsWith('data:')) continue;
        let ev; try { ev = JSON.parse(line.slice(5)); } catch (e) { continue; }
        if (ev.type === 'content_block_delta' && ev.delta && ev.delta.type === 'text_delta') res.write(JSON.stringify({ t: ev.delta.text }) + '\n');
        else if (ev.type === 'message_delta' && ev.delta && ev.delta.stop_reason) res.write(JSON.stringify({ stop: ev.delta.stop_reason }) + '\n');
      }
    }
  } catch (e) { res.write(JSON.stringify({ error: 'unavailable' }) + '\n'); }
  res.end();
}

/* ---------- static files ---------- */
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };
function serveStatic(req, res) {
  let u = decodeURIComponent((req.url || '/').split('?')[0]);
  if (u === '/') u = '/index.html';
  const f = path.normalize(path.join(PUBLIC, u));
  if (!f.startsWith(PUBLIC + path.sep)) { res.writeHead(403); return res.end(); }
  fs.readFile(f, (err, data) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(f)] || 'application/octet-stream', 'Cache-Control': u.endsWith('.html') ? 'no-cache' : 'public, max-age=300' });
    res.end(data);
  });
}

/* ---------- router ---------- */
http.createServer(async (req, res) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  const url = (req.url || '/').split('?')[0];
  try {
    if (url === '/health') return send(res, 200, { ok: true, ai: !!API_KEY });
    if (url.startsWith('/api/')) {
      const sid = identify(req, res);
      if (url === '/api/me' && req.method === 'GET') return send(res, 200, { id: sid, name: null, avatarUrl: null, ai: !!API_KEY });
      if (req.method !== 'POST') return send(res, 405, { code: 'invalid_argument' });
      if (url === '/api/db') return await handleDb(req, res, sid);
      if (url === '/api/ai') return await handleAi(req, res, sid);
      return send(res, 404, { code: 'invalid_argument' });
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end(); }
    serveStatic(req, res);
  } catch (e) {
    if (!res.headersSent) send(res, (e && e.code === 'prompt_too_large') ? 413 : 500, { code: (e && e.code) || 'unavailable' });
    else res.end();
  }
}).listen(PORT, () => console.log('AI Study Copilot on http://localhost:' + PORT + (API_KEY ? '' : '  (no ANTHROPIC_API_KEY: AI features off)')));
