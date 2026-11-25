// Exercise the handler in-process with mock req/res — no server needed.

const fs = require('fs');
const envFile = `${__dirname}/../.env`;
for (const line of (fs.existsSync(envFile) ? fs.readFileSync(envFile, 'utf8') : '').split('\n')) {
  const m = line.match(/^([A-Z_]+)=(.*)$/); if (m && m[2]) process.env[m[1]] = m[2];
}
const handler = require('../api/index.js');

function mock(url, { method = 'GET', body = null } = {}) {
  const res = { _s: 200, _h: {}, _b: null,
    status(c) { this._s = c; return this; },
    setHeader(k, v) { this._h[k] = v; },
    json(o) { this._b = JSON.stringify(o); return this; },
    send(s) { this._b = s; return this; } };
  const req = { url, method, headers: { host: 'localhost' }, body };
  return handler(req, res).then(() => res);
}

(async () => {
  const key = process.env.SYNC_SECRET;

  let r = await mock(`/api?action=health&key=${key}`);
  console.log('health      ', r._s, r._b.slice(0, 300));

  r = await mock('/api?action=watch&slug=initial-vsl');
  const html = r._b || '';
  console.log('watch page  ', r._s, html.length, 'bytes',
    '| holding:', html.includes('Arriving shortly'),
    '| brand css:', html.includes('--gold'),
    '| brand:', html.includes(require('../journey.config.json').business.name),
    '| beacon:', html.includes('vsl_event'));

  r = await mock('/api?action=dashboard');
  const d = r._b || '';
  console.log('dashboard   ', r._s, d.length, 'bytes',
    '| funnel rows:', (d.match(/class="row"/g) || []).length,
    '| assets rows:', (d.match(/<tr>/g) || []).length);
  const m = d.match(/Tightest point: ([^<.]+)/);
  console.log('             bottleneck ->', m ? m[1] : '(none flagged)');

  r = await mock('/api?action=watch&slug=nope');
  console.log('bad slug    ', r._s, r._b);

  fs.writeFileSync('/tmp/journey-watch.html', html);
  fs.writeFileSync('/tmp/journey-dash.html', d);
  console.log('\nwrote /tmp/journey-watch.html and /tmp/journey-dash.html');
})().catch((e) => { console.error('FAILED', e); process.exit(1); });
