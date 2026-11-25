// Offline smoke test: runs the API handler in-process with no Notion, Discord or Upstash.
// Checks open mode (no password set) and password mode (ADMIN_PASSWORD set) in turn.
//
//   npm test

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const MODE = process.argv[2];

// Each mode runs in a fresh child process, so module-level env reads start clean.
if (!MODE) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'eod-smoke-'));
  const clean = { ...process.env };
  for (const k of ['ADMIN_PASSWORD', 'ACCESS_PASSWORD', 'SETTINGS_SECRET', 'VERCEL', 'KV_REST_API_URL', 'KV_REST_API_TOKEN',
    'UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN', 'CRON_SECRET', 'SYNC_SECRET', 'NOTION_API_KEY', 'DISCORD_BOT_TOKEN']) delete clean[k];
  try {
    for (const mode of ['open', 'locked']) {
      const dir = fs.mkdtempSync(path.join(tmp, mode + '-'));
      const env = { ...clean, ...(mode === 'locked' ? { ADMIN_PASSWORD: 'smoke-test-only-' + Date.now() } : {}) };
      execFileSync(process.execPath, [__filename, mode], { cwd: dir, env, stdio: 'inherit' });
    }
    console.log('\nAll smoke tests passed.');
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  return;
}

const handler = require('../api/index.js');

function call(url, { method = 'GET', body = null, headers = {} } = {}) {
  const res = {
    _s: 200, _h: {}, _b: null,
    status(c) { this._s = c; return this; },
    setHeader(k, v) { this._h[k] = v; },
    writeHead(c, h) { this._s = c; Object.assign(this._h, h || {}); return this; },
    end(b) { if (b != null) this._b = b; return this; },
    json(o) { this._b = JSON.stringify(o); return this; },
    send(s) { this._b = s; return this; },
  };
  const req = { url, method, headers: { host: 'localhost', ...headers }, body: body ? JSON.stringify(body) : undefined };
  return Promise.resolve(handler(req, res)).then(() => {
    try { res.data = JSON.parse(res._b); } catch { res.data = null; }
    return res;
  });
}

const ok = (name) => console.log(`  ok  [${MODE}] ${name}`);

(async () => {
  if (MODE === 'open') {
    let r = await call('/api?action=auth_state');
    assert.strictEqual(r.data.state, 'open'); ok('auth_state is open');

    r = await call('/api?action=me');
    assert.strictEqual(r._s, 200); assert.strictEqual(r.data.user.role, 'owner'); assert.strictEqual(r.data.user.open, true);
    ok('every visitor is the owner');

    r = await call('/api?action=config');
    assert.ok(r.data.brand && r.data.brand.name); assert.ok(r.data.roster || r.data.team || Object.keys(r.data).length > 2);
    ok('config returns brand and team');

    r = await call('/api?action=settings');
    assert.strictEqual(r._s, 200); ok('settings readable without a login');

    r = await call('/api?source=settings', { method: 'POST', body: { values: { NUDGE_HOUR: '19' } } });
    assert.strictEqual(r._s, 200, r._b); ok('settings save without a password');

    r = await call('/api?action=settings');
    assert.ok(JSON.stringify(r.data).includes('19')); ok('saved setting reads back');

    r = await call('/api?action=users');
    assert.strictEqual(r.data.open, true); assert.deepStrictEqual(r.data.users, []); ok('no logins listed');

    r = await call('/api?source=auth_login', { method: 'POST', body: { username: 'x', password: 'y' } });
    assert.strictEqual(r._s, 400); ok('login refused politely when logins are off');

    r = await call('/api?action=cron');
    assert.strictEqual(r._s, 401); ok('cron still needs the cron caller or a secret');
  } else {
    let r = await call('/api?action=auth_state');
    assert.strictEqual(r.data.state, 'setup'); ok('auth_state asks for the owner setup');

    r = await call('/api?action=me');
    assert.strictEqual(r._s, 401); ok('signed out is refused');

    r = await call('/api?action=settings');
    assert.strictEqual(r._s, 401); ok('settings locked');

    r = await call('/api?action=reports');
    assert.strictEqual(r._s, 302); assert.ok(String(r._h.Location).startsWith('/login')); ok('reports redirect to /login');

    r = await call('/api?source=auth_setup', { method: 'POST', body: { code: 'wrong', name: 'Owner', username: 'owner', password: 'longenough' } });
    assert.strictEqual(r._s, 401); ok('wrong setup code refused');

    r = await call('/api?source=auth_setup', { method: 'POST', body: { code: process.env.ADMIN_PASSWORD, name: 'Owner', username: 'owner', password: 'longenough' } });
    assert.strictEqual(r._s, 200); const cookie = String(r._h['Set-Cookie']).split(';')[0];
    ok('owner created with the setup code');

    r = await call('/api?action=me', { headers: { cookie } });
    assert.strictEqual(r.data.user.role, 'owner'); assert.ok(!r.data.user.open); ok('owner session works');

    r = await call('/api?action=settings', { headers: { cookie } });
    assert.strictEqual(r._s, 200); ok('owner can open settings');
  }
})().catch((e) => { console.error(`FAIL [${MODE}]`, e && e.message); process.exit(1); });
