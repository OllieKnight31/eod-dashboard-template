// Payment-collection reminders. A Contract Signed report carries the amount and
// the date we collect it. Three, two and one day before that date the closer is
// tagged in Discord and gets a task on the contact in GHL, to get the lead on a call.
//
// Two crons call in (08:00 + 09:00 UTC) so one lands on 09:00 London all year.
// Sends are stamped on the report row per channel and day (d3, g3…), so the
// second cron only retries whatever failed and nothing is ever sent twice.

const CFG = require('../journey.config.json');
const N = require('./notion');
const D = require('./discord');

const TZ = CFG.eod?.timezone || 'Europe/London';
const HOUR = 9;
const DAYS = [3, 2, 1];
const DEAD = new Set(['Lost', 'Rejected']);
const GHL = process.env.GHL_API_BASE || 'https://services.leadconnectorhq.com';

function londonNow(d = new Date()) {
  const f = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hour12: false });
  const p = Object.fromEntries(f.formatToParts(d).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour) % 24 };
}
const shift = (ymd, n) => { const d = new Date(`${ymd}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const daysBetween = (a, b) => Math.round((Date.parse(`${b}T12:00:00Z`) - Date.parse(`${a}T12:00:00Z`)) / 86400000);
const leadName = (title) => String(title || '').split(' · ').slice(2).join(' · ') || 'Unnamed lead';
const prose = (days) => (days === 1 ? 'tomorrow' : `in ${days} days`);

async function ghlTask(contactId, { title, body, dueDate, assignedTo }) {
  const res = await fetch(`${GHL}/contacts/${contactId}/tasks`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.GHL_TOKEN}`, Version: '2021-07-28', Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({ title, body, dueDate, completed: false, ...(assignedTo ? { assignedTo } : {}) }),
  });
  if (!res.ok) throw new Error(`ghl task -> ${res.status} ${(await res.text()).slice(0, 200)}`);
}

function card({ rep, name, amount, date, days, lead }) {
  return {
    content: `${D.mention(rep) || `**${rep}**`} get **${name}** on a call: **${D.money(amount)}** collects ${prose(days)}.`,
    embeds: [{
      author: { name: `💳 PAYMENT COLLECTION · ${days} DAY${days === 1 ? '' : 'S'} OUT` },
      title: name,
      color: days === 1 ? D.COLOUR.red : D.COLOUR.amber,
      fields: [
        { name: 'Amount', value: D.money(amount), inline: true },
        { name: 'Collecting on', value: D.when(date), inline: true },
        { name: 'Closer', value: rep, inline: true },
      ],
    }],
    components: [{ type: 1, components: [
      lead?.url && { type: 2, style: 5, label: 'Open in Notion', url: lead.url },
      lead?.ghl && { type: 2, style: 5, label: 'GHL', url: lead.ghl },
    ].filter(Boolean) }].filter((r) => r.components.length),
    allowed_mentions: { parse: ['users'] },
  };
}

/** Sends what is due. `date` and `force` are for testing; `dry` reports without sending. */
async function run({ date, force = false, dry = false } = {}) {
  const now = londonNow();
  if (!force && now.hour < HOUR) return { skipped: `London hour is ${now.hour}, reminders start at ${HOUR}` };
  const today = date || now.date;
  const rows = await N.queryAll(N.DB.eod, { and: [
    { property: 'Collection date', date: { on_or_after: shift(today, 1) } },
    { property: 'Collection date', date: { on_or_before: shift(today, 3) } },
  ] }, [{ timestamp: 'created_time', direction: 'descending' }], 200);

  const out = { today, due: [], errors: [] };
  const seen = new Set();                      // a re-signed lead: only their newest report counts
  for (const r of rows) {
    const leadId = (N.readProp(r, 'Lead') || [])[0] || null;
    const on = N.readProp(r, 'Collection date');
    const ymd = String(on?.start || on || '').slice(0, 10);
    const days = daysBetween(today, ymd);
    if (!DAYS.includes(days) || (leadId && seen.has(leadId))) continue;
    if (leadId) seen.add(leadId);

    const page = leadId ? await N.notion('GET', `/pages/${leadId}`).catch(() => null) : null;
    const amount = N.readProp(r, 'Collection amount') || 0;
    if (page) {
      if (DEAD.has(N.readProp(page, 'Stage'))) continue;
      // Paid already: the lead's cash covers what was taken on the call plus this amount.
      const taken = (N.readProp(r, 'Cash collected') || 0) + amount;
      if ((N.readProp(page, 'Cash Collected') || 0) >= taken) continue;
    }

    const rep = N.readProp(r, 'Rep') || 'Closer';
    const name = page ? (N.readProp(page, 'Lead') || leadName(N.readProp(r, 'Report'))) : leadName(N.readProp(r, 'Report'));
    const contact = page ? N.readProp(page, 'GHL Contact ID') : null;
    const lead = page ? { url: page.url, ghl: N.readProp(page, 'GHL Link') || '' } : null;
    const sent = String(N.readProp(r, 'Collection reminders') || '').split(/\s+/).filter(Boolean);
    const line = { name, rep, days, amount, date: ymd, ghl: contact ? 'task' : 'no contact' };
    out.due.push(line);
    if (dry) continue;

    if (!sent.includes(`d${days}`)) {
      try { if (await D.post(D.channelFor('closer'), card({ rep, name, amount, date: ymd, days, lead }))) sent.push(`d${days}`); }
      catch (e) { out.errors.push(`${name} discord: ${e.message}`); }
    }
    if (contact && !sent.includes(`g${days}`)) {
      try {
        await ghlTask(contact, {
          title: `Get ${name} on a call: ${D.money(amount)} collects ${prose(days)} (${rep})`,
          body: `Collecting ${D.money(amount)} on ${ymd}. Closer: ${rep}.`,
          dueDate: `${today}T17:00:00.000Z`,
          assignedTo: D.teamMember(rep)?.ghl_user,
        });
        sent.push(`g${days}`);
      } catch (e) { out.errors.push(`${name} ghl: ${e.message}`); }
    }
    await N.updatePage(r.id, N.DB.eod, { 'Collection reminders': sent.join(' ') });
  }
  if (out.errors.length) await D.post(CFG.eod?.discord?.logs, { content: `⚙️ collection reminders · ${out.errors.join(' | ')}`.slice(0, 1900), allowed_mentions: { parse: [] } }).catch(() => {});
  return out;
}

module.exports = { run };
