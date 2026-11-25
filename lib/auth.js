// Logins and who may see what.
//
// Roles
//   owner: everything, including /settings and the logins themselves
//   manager: every dashboard and every report seat; no settings
//   setter / triage / closer: only their own seat on the report and their own scorecard
//
// Logins are OPTIONAL. With no ADMIN_PASSWORD (or ACCESS_PASSWORD) set, the site runs in
// open mode: there is no sign-in and every visitor is treated as the owner. Set either
// variable and redeploy to turn logins on.
//
// With logins on, the first account is created on the first visit ("setup"), and only by
// someone holding the SETUP CODE (the ADMIN_PASSWORD or ACCESS_PASSWORD env var), so a
// stranger who finds the site first cannot claim it. The same code resets the owner later.
//
// Accounts live in the encrypted store next to the settings. Passwords are scrypt hashes.
// A session is a signed, HttpOnly cookie; every request re-checks the account still exists,
// so removing someone or changing their role takes effect at once.

const crypto = require('crypto');
const { readDoc, writeDoc, backend } = require('./store');
const LIVE = require('./live');

const REP_ROLES = LIVE.ROLES;                       // setter, triage, closer
const ROLES = ['owner', 'manager', ...REP_ROLES];
const COOKIE = 'eod_session';
const SESSION_DAYS = 14;
const MIN_PASSWORD = 8;

const setupCode = () => process.env.ADMIN_PASSWORD || process.env.ACCESS_PASSWORD || '';
const secret = () => process.env.SETTINGS_SECRET || setupCode();
// No setup code set: no logins, everyone is the owner.
const openMode = () => !setupCode();
const OPEN_USER = Object.freeze({ id: 'open', name: 'Open access', username: 'open', role: 'owner', person: '', open: true });
const available = () => Boolean(secret()) && backend() !== 'none';
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const same = (a, b) => {
  const x = crypto.createHash('sha256').update(String(a)).digest(), y = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(x, y);
};
const fail = (code, message, extra = {}) => ({ code, body: { status: 'error', message, ...extra } });

/* -------------------------------------------------------------- accounts */
// Read on every request, so keep a short per-instance cache; writes refresh it.
const CACHE_MS = 15000;
let cache = null;
async function loadUsers({ fresh = false } = {}) {
  if (!fresh && cache && Date.now() - cache.at < CACHE_MS) return cache.users;
  const doc = available() ? await readDoc('users') : null;
  cache = { users: (doc && doc.users) || [], at: Date.now() };
  return cache.users;
}
async function saveUsers(users) {
  await writeDoc('users', { users });
  cache = { users, at: Date.now() };
}

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  return { salt, hash: crypto.scryptSync(String(password), salt, 32).toString('hex') };
}
const passwordOk = (user, password) => same(hashPassword(password, user.salt).hash, user.hash);
const normUser = (v) => String(v || '').trim().toLowerCase();

// What the browser is allowed to know about an account.
const publicUser = (u) => ({ id: u.id, name: u.name, username: u.username, role: u.role, person: u.person || '', ...(u.open ? { open: true } : {}) });

/* -------------------------------------------------------------- sessions */
const sign = (payload) => crypto.createHmac('sha256', secret()).update(payload).digest('base64url');
function sessionCookie(user, req) {
  const payload = Buffer.from(JSON.stringify({ id: user.id, exp: Date.now() + SESSION_DAYS * 86400000 })).toString('base64url');
  const secure = String((req.headers && req.headers['x-forwarded-proto']) || '').includes('https') ? '; Secure' : '';
  return `${COOKIE}=${payload}.${sign(payload)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}${secure}`;
}
const clearCookie = () => `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;

async function currentUser(req) {
  if (openMode()) return OPEN_USER;
  if (!secret()) return null;
  const m = new RegExp(`(?:^|;\\s*)${COOKIE}=([^;]+)`).exec(String((req.headers && req.headers.cookie) || ''));
  if (!m) return null;
  const [payload, sig] = m[1].split('.');
  if (!payload || !sig || !same(sig, sign(payload))) return null;
  let data;
  try { data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')); } catch { return null; }
  if (!data || !data.id || !(data.exp > Date.now())) return null;
  return (await loadUsers()).find((u) => u.id === data.id) || null;
}

/* ------------------------------------------------- what each role may do */
const isRep = (user) => Boolean(user) && REP_ROLES.includes(user.role);
const seesDashboards = (user) => Boolean(user) && (user.role === 'owner' || user.role === 'manager');
const isOwner = (user) => Boolean(user) && user.role === 'owner';
const homeOf = (user) => (seesDashboards(user) ? '/reports' : '/eod');
// The name a rep's reports are filed under: their team entry, else their own name.
function repName(user) {
  const t = LIVE.teamMember(user.person || user.name);
  return t ? t.name : (user.person || user.name);
}

// The seats a rep may file for: their own, plus the other call seat (triage ⇄ closer)
// when the team list has them in it — one person often takes both calls.
const CALL_SEATS = ['triage', 'closer'];
function seatsOf(user) {
  if (!isRep(user)) return [];
  const mine = repName(user).toLowerCase();
  const also = CALL_SEATS.includes(user.role)
    ? CALL_SEATS.filter((k) => k !== user.role && (LIVE.live.roster[k] || []).some((t) => t.name.toLowerCase() === mine))
    : [];
  return [user.role, ...also];
}
const seatFor = (user, want) => {
  const w = String(want || '').toLowerCase();
  return seatsOf(user).includes(w) ? w : user.role;
};

// May this user file this report? Reps: only their own seats, and only as themselves.
// `body.role` says which seat the report is for; a rep's is checked against seatsOf, never trusted.
function reportAccess(user, body) {
  if (seesDashboards(user)) return { ok: true };
  if (!isRep(user)) return { ok: false, message: 'You can only file your own report.' };
  body.role = seatFor(user, body.role);
  body.rep = repName(user);                         // a rep can never file under someone else's name
  delete body.closer; delete body.setter_name;
  return { ok: true };
}

// Reps only ever see their own scorecard and their own board, whatever the query asked for.
function scopeQuery(user, query) {
  if (!isRep(user)) return query;
  return { ...query, role: seatFor(user, query.role), person: repName(user), rep: repName(user) };
}

/* ------------------------------------------------------------ validation */
function cleanAccount(input, { users, existing }) {
  const name = String(input.name || '').trim();
  const username = normUser(input.username);
  const role = String(input.role || '').toLowerCase();
  if (!name || name.length > 80) return { error: 'Enter their name.' };
  if (!/^[^\s]{3,120}$/.test(username)) return { error: 'Enter an email or username (no spaces, at least 3 characters).' };
  if (!ROLES.includes(role)) return { error: 'Choose a role.' };
  if (users.some((u) => u.username === username && (!existing || u.id !== existing.id))) return { error: 'That email or username already has a login.' };
  const person = REP_ROLES.includes(role) ? String(input.person || name).trim() : '';
  return { name, username, role, person };
}
const passwordProblem = (p) => (String(p || '').length < MIN_PASSWORD ? `Password must be at least ${MIN_PASSWORD} characters.` : '');

/* ------------------------- handlers (each returns { code, body, cookie? }) */

// GET action=auth_state, what the login page should show.
async function authState() {
  if (openMode()) return { code: 200, body: { status: 'ok', state: 'open', message: 'Logins are off on this site. Anyone with the link can use it.' } };
  if (backend() === 'none') return { code: 200, body: { status: 'ok', state: 'no_storage', message: 'Storage isn’t connected yet. In Vercel open the project → Storage → Upstash → Redis → connect, then redeploy.' } };
  const users = await loadUsers({ fresh: true });
  return { code: 200, body: { status: 'ok', state: users.some((u) => u.role === 'owner') ? 'login' : 'setup' } };
}

// POST source=auth_setup { code, name, username, password }, create (or reset) the owner.
async function setup(body, req) {
  if (openMode()) return fail(400, 'Logins are off. Set ADMIN_PASSWORD (or ACCESS_PASSWORD) and redeploy to turn them on.');
  if (!available()) return fail(503, 'This site isn’t ready for logins yet.');
  if (!setupCode() || !same(body.code || '', setupCode())) { await wait(500); return fail(401, 'That setup code isn’t right. It was shown when the site was set up.'); }
  const users = await loadUsers({ fresh: true });
  const owner = users.find((u) => u.role === 'owner');
  const acct = cleanAccount({ ...body, role: 'owner' }, { users, existing: owner });
  if (acct.error) return fail(400, acct.error);
  const bad = passwordProblem(body.password);
  if (bad) return fail(400, bad);
  const user = { id: owner ? owner.id : crypto.randomUUID(), ...acct, ...hashPassword(body.password), created: owner ? owner.created : new Date().toISOString() };
  await saveUsers(owner ? users.map((u) => (u.id === owner.id ? user : u)) : [...users, user]);
  return { code: 200, body: { status: 'ok', user: publicUser(user) }, cookie: sessionCookie(user, req) };
}

// POST source=auth_login { username, password }
async function login(body, req) {
  if (openMode()) return fail(400, 'Logins are off. Set ADMIN_PASSWORD (or ACCESS_PASSWORD) and redeploy to turn them on.');
  if (!available()) return fail(503, 'This site isn’t ready for logins yet.');
  const user = (await loadUsers({ fresh: true })).find((u) => u.username === normUser(body.username));
  if (!user || !passwordOk(user, body.password || '')) { await wait(500); return fail(401, 'Wrong email or password.'); }
  return { code: 200, body: { status: 'ok', user: publicUser(user) }, cookie: sessionCookie(user, req) };
}

const logout = () => ({ code: 200, body: { status: 'ok' }, cookie: clearCookie() });

// GET action=me
function me(user) {
  if (!user) return fail(401, 'Not signed in.', { status: 'unauthorized' });
  return { code: 200, body: { status: 'ok', user: { ...publicUser(user), files_as: isRep(user) ? repName(user) : '', seats: seatsOf(user) }, home: homeOf(user) } };
}

// GET action=users (owner)
async function listUsers() {
  if (openMode()) return { code: 200, body: { status: 'ok', open: true, users: [] } };
  const users = await loadUsers({ fresh: true });
  const order = (u) => ROLES.indexOf(u.role);
  return { code: 200, body: { status: 'ok', users: users.map(publicUser).sort((a, b) => order(a) - order(b) || a.name.localeCompare(b.name)) } };
}

// POST source=user_save (owner) { id?, name, username, role, person?, password? }
// New login: password required. Existing: password only if it is being reset.
async function saveUser(body, actor) {
  if (openMode()) return fail(400, 'Logins are off. Set ADMIN_PASSWORD (or ACCESS_PASSWORD) and redeploy to turn them on.');
  const users = await loadUsers({ fresh: true });
  const existing = body.id ? users.find((u) => u.id === body.id) : null;
  if (body.id && !existing) return fail(404, 'That login no longer exists.');
  const acct = cleanAccount(body, { users, existing });
  if (acct.error) return fail(400, acct.error);
  if (existing && existing.role === 'owner' && acct.role !== 'owner') return fail(400, 'The owner’s role can’t be changed. Create the new owner with the setup code instead.');
  if (!existing && acct.role === 'owner') return fail(400, 'There is one owner. Add managers for anyone else who needs to see everything.');
  if (!existing || body.password) {
    const bad = passwordProblem(body.password);
    if (bad) return fail(400, bad);
  }
  const user = { ...(existing || { id: crypto.randomUUID(), created: new Date().toISOString() }), ...acct, ...(body.password ? hashPassword(body.password) : {}) };
  await saveUsers(existing ? users.map((u) => (u.id === existing.id ? user : u)) : [...users, user]);
  return { code: 200, body: { status: 'ok', user: publicUser(user), self: user.id === actor.id } };
}

// POST source=user_delete (owner) { id }
async function deleteUser(body, actor) {
  if (openMode()) return fail(400, 'Logins are off. Set ADMIN_PASSWORD (or ACCESS_PASSWORD) and redeploy to turn them on.');
  const users = await loadUsers({ fresh: true });
  const target = users.find((u) => u.id === body.id);
  if (!target) return fail(404, 'That login no longer exists.');
  if (target.id === actor.id || target.role === 'owner') return fail(400, 'The owner login can’t be removed.');
  await saveUsers(users.filter((u) => u.id !== target.id));
  return { code: 200, body: { status: 'ok' } };
}

// POST source=password { current, next }, anyone changing their own.
async function changePassword(body, actor) {
  if (openMode()) return fail(400, 'Logins are off. Set ADMIN_PASSWORD (or ACCESS_PASSWORD) and redeploy to turn them on.');
  if (!passwordOk(actor, body.current || '')) { await wait(500); return fail(401, 'Your current password isn’t right.'); }
  const bad = passwordProblem(body.next);
  if (bad) return fail(400, bad);
  const users = await loadUsers({ fresh: true });
  await saveUsers(users.map((u) => (u.id === actor.id ? { ...u, ...hashPassword(body.next) } : u)));
  return { code: 200, body: { status: 'ok' } };
}

module.exports = {
  ROLES, REP_ROLES, COOKIE, available, openMode,
  currentUser, isRep, isOwner, seesDashboards, homeOf, reportAccess, scopeQuery, seatsOf, repName, publicUser,
  authState, setup, login, logout, me, listUsers, saveUser, deleteUser, changePassword,
  // for the local preview server and the tests only
  _preview: { loadUsers, saveUsers, hashPassword, sessionCookie },
};
