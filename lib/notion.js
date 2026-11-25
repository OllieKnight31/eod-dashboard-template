// Notion client for the EOD and client-journey service.
// Reads and writes 💰 Sales plus the four journey databases.

const CFG   = require('../journey.config.json');
const STATE = require('./state');

const TOKEN = process.env.NOTION_API_KEY;
const VERSION = '2022-06-28';

const DB = {
  sales:   process.env.NOTION_SALES_DB   || CFG.notion.sales_db,
  stages:  process.env.NOTION_STAGES_DB  || STATE.stages_db,
  eod:     process.env.NOTION_EOD_DB     || STATE.eod_db,
  assets:  process.env.NOTION_ASSETS_DB  || STATE.assets_db,
  setter:  process.env.NOTION_SETTER_DB  || STATE.setter_db,
  sessions: process.env.NOTION_SESSIONS_DB || STATE.sessions_db,
  signoff: process.env.NOTION_SIGNOFF_DB || STATE.signoff_db,
};

const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

async function notion(method, path, body, tries = 6) {
  for (let i = 0; i < tries; i++) {
    const r = await fetch(`https://api.notion.com/v1${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        'Notion-Version': VERSION,
        'Content-Type': 'application/json',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (r.ok) return r.json();
    const text = await r.text();

    // 409 is Notion's optimistic-lock conflict; 429/5xx are transient.
    if ((r.status === 429 || r.status === 409 || r.status >= 500) && i < tries - 1) {
      // Notion states how long to wait, in a header and again in the body, and
      // it means it — a short exponential backoff just earns another 429.
      let wait = Number(r.headers.get('retry-after')) * 1000;
      if (!Number.isFinite(wait) || wait <= 0) {
        const m = text.match(/"retry_after"\s*:\s*"?(\d+)/);
        wait = m ? Number(m[1]) * 1000 : 0;
      }
      if (!wait) wait = 500 * (i + 1) ** 2;
      await sleep(wait + 250);
      continue;
    }
    throw new Error(`notion ${method} ${path} -> ${r.status} ${text.slice(0, 400)}`);
  }
}

/* --------------------------------------------------------------- reading */

function readProp(page, name) {
  const p = page.properties?.[name];
  if (!p) return null;
  switch (p.type) {
    case 'title':
    case 'rich_text':   return p[p.type].map((t) => t.plain_text).join('') || null;
    case 'select':      return p.select?.name ?? null;
    case 'status':      return p.status?.name ?? null;
    case 'multi_select':return p.multi_select.map((o) => o.name);
    case 'number':      return p.number;
    case 'checkbox':    return p.checkbox;
    case 'date':        return p.date?.start ?? null;
    case 'email':       return p.email ?? null;
    case 'phone_number':return p.phone_number ?? null;
    case 'url':         return p.url ?? null;
    case 'formula':     return p.formula?.[p.formula.type] ?? null;
    case 'relation':    return p.relation.map((r) => r.id);
    default:            return null;
  }
}

async function queryAll(dbId, filter, sorts, cap = 5000) {
  const out = [];
  let cursor;
  do {
    const body = { page_size: 100 };
    if (cursor) body.start_cursor = cursor;
    if (filter) body.filter = filter;
    if (sorts)  body.sorts = sorts;
    const page = await notion('POST', `/databases/${dbId}/query`, body);
    out.push(...page.results);
    cursor = page.has_more ? page.next_cursor : null;
  } while (cursor && out.length < cap);
  return out;
}

/* --------------------------------------------------------------- writing */

// Build a Notion properties payload from plain values. `null` clears a property.
function buildProps(schema, values) {
  const props = {};
  for (const [name, value] of Object.entries(values)) {
    const def = schema[name];
    if (!def) continue;                       // never invent a column
    if (value === undefined) continue;
    switch (def.type) {
      case 'title':       props[name] = { title: value === null ? [] : [{ type: 'text', text: { content: String(value).slice(0, 2000) } }] }; break;
      case 'rich_text':   props[name] = { rich_text: value === null || value === '' ? [] : [{ type: 'text', text: { content: String(value).slice(0, 2000) } }] }; break;
      case 'select':      props[name] = { select: value ? { name: String(value) } : null }; break;
      case 'number':      props[name] = { number: value === null || value === '' ? null : Number(value) }; break;
      case 'checkbox':    props[name] = { checkbox: !!value }; break;
      case 'date':        props[name] = { date: value ? { start: value } : null }; break;
      case 'email':       props[name] = { email: value || null }; break;
      case 'url':         props[name] = { url: value || null }; break;
      case 'phone_number':props[name] = { phone_number: value || null }; break;
      case 'relation':    props[name] = { relation: (value || []).map((id) => ({ id })) }; break;
      default: break;                          // formula / rollup are read-only
    }
  }
  return props;
}

const schemaCache = new Map();
async function schemaOf(dbId) {
  if (!schemaCache.has(dbId)) {
    const db = await notion('GET', `/databases/${dbId}`);
    schemaCache.set(dbId, db.properties);
  }
  return schemaCache.get(dbId);
}

async function updatePage(pageId, dbId, values) {
  const schema = await schemaOf(dbId);
  return notion('PATCH', `/pages/${pageId}`, { properties: buildProps(schema, values) });
}

async function createPage(dbId, values, extra = {}) {
  const schema = await schemaOf(dbId);
  return notion('POST', '/pages', {
    parent: { database_id: dbId },
    properties: buildProps(schema, values),
    ...extra,
  });
}

/* --------------------------------------------------------- lead lookup */

// Email is the only identifier shared by the website form, GHL, the contract
// platform and a closer typing into the EOD report — so it is the join key.
async function findLeadByEmail(email) {
  if (!email) return null;
  const clean = String(email).trim().toLowerCase();
  if (!clean) return null;
  const rows = await queryAll(DB.sales, {
    property: 'Email', email: { equals: clean },
  }, null, 20);
  if (rows.length) return rows[0];
  // Fall back to a case-sensitive contains, for rows imported with odd casing.
  const loose = await queryAll(DB.sales, {
    property: 'Email', email: { contains: clean },
  }, null, 20);
  return loose[0] || null;
}

async function findLeadByName(name) {
  if (!name) return null;
  const rows = await queryAll(DB.sales, {
    property: 'Lead', title: { equals: String(name).trim() },
  }, null, 20);
  return rows[0] || null;
}

async function findLeadByGhlContact(contactId) {
  if (!contactId) return null;
  const rows = await queryAll(DB.sales, {
    property: 'GHL Contact ID', rich_text: { equals: String(contactId).trim() },
  }, null, 20);
  return rows[0] || null;
}

module.exports = {
  notion, DB, readProp, queryAll, updatePage, createPage, schemaOf, buildProps,
  findLeadByEmail, findLeadByName, findLeadByGhlContact,
};
