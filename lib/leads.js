// Resolving "who is this?" from a watch link, a webhook or a name a closer typed.

const N = require('./notion');

const b64url = {
  enc: (s) => Buffer.from(String(s), 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''),
  dec: (s) => { try { return Buffer.from(String(s).replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'); } catch (e) { return ''; } },
};

/**
 * A watch link identifies its lead one of three ways, in order of preference:
 *   ?c=<ghl contact id>   — what a GoHighLevel merge tag can emit
 *   ?e=<base64url email>  — what anything else can emit
 *   ?l=<notion page id>   — what this system emits for itself
 * The same string is handed to the page as an opaque token and comes back on
 * every beacon, so the browser never has to know which kind it holds.
 */
function tokenFrom(query) {
  if (query.c) return `c:${query.c}`;
  if (query.e) return `e:${query.e}`;
  if (query.l) return `l:${query.l}`;
  return '';
}

async function resolve(token) {
  if (!token) return null;
  const [kind, ...rest] = String(token).split(':');
  const val = rest.join(':');
  if (!val) return null;
  try {
    if (kind === 'c') return await N.findLeadByGhlContact(val);
    if (kind === 'e') return await N.findLeadByEmail(b64url.dec(val));
    if (kind === 'l') return await N.notion('GET', `/pages/${val}`);
  } catch (e) { return null; }
  return null;
}

function firstNameOf(row) {
  const full = N.readProp(row, 'Lead') || '';
  return full.trim().split(/\s+/)[0] || '';
}

function linkFor(row, slug, base) {
  const contact = N.readProp(row, 'GHL Contact ID');
  const email = N.readProp(row, 'Email');
  const q = contact ? `c=${encodeURIComponent(contact)}`
    : email ? `e=${b64url.enc(email)}`
    : `l=${row.id.replace(/-/g, '')}`;
  return `${base}/v/${slug}?${q}`;
}

/**
 * Live search for the report's lead picker: name, email or Instagram handle.
 * Ten rows, most recently touched first. Test and spam rows are dropped so
 * the picker never offers a sacrificial lead as a real prospect.
 */
async function search(q, { limit = 10 } = {}) {
  const term = String(q || '').trim();
  if (term.length < 2) return [];
  const body = {
    page_size: Math.min(limit * 2, 50),
    sorts: [{ timestamp: 'last_edited_time', direction: 'descending' }],
    filter: { or: [
      { property: 'Lead', title: { contains: term } },
      { property: 'Email', email: { contains: term.toLowerCase() } },
      { property: 'Instagram', rich_text: { contains: term.replace(/^@/, '') } },
    ] },
  };
  const page = await N.notion('POST', `/databases/${N.DB.sales}/query`, body);
  return page.results
    .filter((r) => !['Tests', 'Spam'].includes(N.readProp(r, 'Stage')))
    .slice(0, limit);
}

module.exports = { b64url, tokenFrom, resolve, firstNameOf, linkFor, search };
