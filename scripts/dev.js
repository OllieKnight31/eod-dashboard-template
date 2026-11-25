// Local preview: the same single function and the same rewrites as Vercel, on
// http://localhost:3237. Settings (and logins, if on) are kept in the gitignored .data/
// folder. Logins are off unless ADMIN_PASSWORD (or ACCESS_PASSWORD) is set.
//
//   set -a && source .env && set +a && node scripts/dev.js
//
// It reads the real Notion databases, so filing a report here files a real one.

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.PORT || 3237);
process.env.PUBLIC_BASE_URL = `http://localhost:${PORT}`;

const ROOT = path.join(__dirname, '..');
const handler = require('../api/index.js');
const { rewrites } = require('../vercel.json');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css', '.json': 'application/json' };

function rewrite(pathname) {
  for (const r of rewrites) {
    const names = [];
    const re = new RegExp('^' + r.source.replace(/:(\w+)/g, (_, n) => { names.push(n); return '([^/]+)'; }) + '$');
    const m = re.exec(pathname);
    if (m) return names.reduce((dest, n, i) => dest.replace(`:${n}`, m[i + 1]), r.destination);
  }
  return null;
}

http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  let target = rewrite(url.pathname) || url.pathname;
  if (target.startsWith('/api')) {
    const t = new URL(target, url);
    for (const [k, v] of url.searchParams) if (!t.searchParams.has(k)) t.searchParams.append(k, v);
    req.url = t.pathname + t.search;
    let raw = '';
    for await (const chunk of req) raw += chunk;
    req.body = raw;
    res.status = (code) => { res.statusCode = code; return res; };
    res.json = (obj) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(obj)); return res; };
    res.send = (text) => { res.end(text); return res; };
    return handler(req, res);
  }
  const file = path.join(ROOT, 'public', path.normalize(target).replace(/^(\.\.[/\\])+/, ''));
  fs.readFile(file, (err, buf) => {
    if (err) { res.statusCode = 404; return res.end('Not found'); }
    res.setHeader('Content-Type', TYPES[path.extname(file)] || 'application/octet-stream');
    res.end(buf);
  });
}).listen(PORT, () => console.log(`EOD preview on http://localhost:${PORT}  (${process.env.ADMIN_PASSWORD || process.env.ACCESS_PASSWORD ? 'logins on' : 'logins off: open access'})`));
