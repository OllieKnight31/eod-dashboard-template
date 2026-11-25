// Minimal CDP driver: evaluate an async function inside an already-open,
// already-authenticated tab. Notion's view configuration is not reachable from
// the public API, and its private endpoint authorises by session cookie — so
// the request has to be made from inside the user's own logged-in page.
const PORT = process.env.CDP_PORT || '9227';

async function pickTarget(match) {
  const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  // GHL's builder is an out-of-process iframe, so it is its own CDP target
  // with type 'iframe' rather than 'page'.
  const t = list.find((x) => (x.type === 'page' || x.type === 'iframe') && (!match || x.url.includes(match)));
  if (!t) throw new Error(`no page target matching ${match} on port ${PORT}`);
  return t;
}

function evaluate(wsUrl, expression) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const id = 1;
    ws.onopen = () => ws.send(JSON.stringify({
      id, method: 'Runtime.evaluate',
      params: { expression, awaitPromise: true, returnByValue: true },
    }));
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id !== id) return;
      ws.close();
      if (m.error) return reject(new Error(JSON.stringify(m.error)));
      const r = m.result;
      if (r.exceptionDetails) return reject(new Error(r.exceptionDetails.exception?.description || 'eval threw'));
      resolve(r.result?.value);
    };
    ws.onerror = (e) => reject(new Error('ws error ' + (e.message || '')));
    setTimeout(() => { try { ws.close(); } catch (e) {} reject(new Error('cdp timeout')); }, 45000);
  });
}

async function run(fnSource, match) {
  const t = await pickTarget(match);
  return evaluate(t.webSocketDebuggerUrl, `(${fnSource})()`);
}

module.exports = { run, pickTarget, evaluate };
