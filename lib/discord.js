// Posting EOD reports into the team's Discord server.
//
// Bot-token posts, not webhooks: the same bot the Notion relay uses, so the
// cards can carry link buttons and the nightly job can find and edit them.
// Every function here is best-effort — a Discord outage must never stop a
// report from being filed.

const CFG = require('../journey.config.json');
const LIVE = require('./live');

const BASE = 'https://discord.com/api/v10';
const UA = 'DiscordBot (https://github.com, eod-journey/1.0)';
const token = () => process.env.DISCORD_BOT_TOKEN || '';
const CH = CFG.eod?.discord || {};

async function api(method, path, body) {
  if (!token()) return null;
  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await fetch(BASE + path, {
      method,
      headers: { Authorization: `Bot ${token()}`, 'User-Agent': UA, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (res.status === 429) {
      const d = await res.json().catch(() => ({}));
      const wait = Math.min(Number(d.retry_after) || 1, 15);
      await new Promise((r) => setTimeout(r, (wait + 0.25) * 1000));
      continue;
    }
    const text = await res.text();
    if (!res.ok) throw new Error(`discord ${method} ${path} -> ${res.status} ${text.slice(0, 300)}`);
    return text ? JSON.parse(text) : {};
  }
  throw new Error(`discord ${method} ${path} -> rate limited out`);
}

const link = (channelId, messageId) => `https://discord.com/channels/${CH.guild}/${channelId}/${messageId}`;

/** Post a message; returns { id, url } or null when Discord is not configured. */
async function post(channelId, payload) {
  if (!token() || !channelId) return null;
  const m = await api('POST', `/channels/${channelId}/messages`, payload);
  return m ? { id: m.id, channel: channelId, url: link(channelId, m.id) } : null;
}
const edit = (channelId, messageId, payload) => api('PATCH', `/channels/${channelId}/messages/${messageId}`, payload);
const remove = (channelId, messageId) => api('DELETE', `/channels/${channelId}/messages/${messageId}`);

/* ------------------------------------------------------------ helpers */

const COLOUR = {
  green: 3066993, gold: 13938487, red: 15158332, amber: 15105570,
  grey: 9807270, blue: 3447003, purple: 10181046, wine: 7483191,
};
const BIZ = CFG.business || {};
const money = (n) => (n === null || n === undefined || n === '' ? null
  : new Intl.NumberFormat(BIZ.locale || 'en-US', { style: 'currency', currency: BIZ.currency || 'USD', maximumFractionDigits: 0 }).format(Number(n)));

function when(iso, tz = LIVE.live.timezone) {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(+d)) return String(iso);
  const dateOnly = !String(iso).includes('T');
  return d.toLocaleString('en-GB', {
    timeZone: tz, weekday: 'short', day: 'numeric', month: 'short',
    ...(dateOnly ? {} : { hour: '2-digit', minute: '2-digit' }),
  });
}

function mention(name) {
  const t = teamMember(name);
  return t?.discord ? `<@${t.discord}>` : null;
}
const teamMember = LIVE.teamMember;

const buttons = (list) => {
  const row = list.filter((b) => b && b.url && /^https?:\/\//.test(b.url)).slice(0, 5)
    .map((b) => ({ type: 2, style: 5, label: b.label.slice(0, 80), url: b.url }));
  return row.length ? [{ type: 1, components: row }] : [];
};

const channelFor = (role) => (role === 'setter' ? CH.setter : CH.closer);

/* ------------------------------------------------------------- cards */

const ROLE_WORD = { setter: 'Setting', triage: 'Triage', closer: 'Closing' };

/** One call report → one card. */
function callCard({ role, rep, date, outcome, lead, call, stage, moved, base }) {
  const oc = outcome; // { key, label, colour, emoji }
  const name = lead?.name || call.prospect_name || call.prospect_email || 'Unnamed lead';
  const fields = [];
  const f = (n, v, inline = true) => { if (v !== null && v !== undefined && v !== '') fields.push({ name: n, value: String(v).slice(0, 1024), inline }); };

  f('Rep', rep);
  f('Outcome', oc.shown || oc.label);
  if (role === 'setter') {
    f('Booked for', when(call.booked_for));
    f('With', call.booked_with);
    f('Source', call.lead_source);
  }
  if (role === 'triage') {
    f('Fit', call.fit);
    f('Budget', call.budget_band);
    f('Decision', call.decision_maker);
    f('Timeline', call.timeline);
    f('Pathway', call.package);
    f('Closing call', when(call.booked_for));
    f('Closer', call.booked_with);
  }
  if (role === 'closer') {
    f('Pathway', call.package);
    f('Deal total', money(call.ticket));
    f('Cash collected', money(call.cash_collected));
    f('Payment', call.payment_type);
    if (call.collection_amount) f('To collect', `${money(call.collection_amount)} on ${when(call.collection_date)}`);
    f('Lost reason', call.lost_reason);
  }
  f('Objection', call.objections, false);
  if (call.follow_up_action || call.follow_up_date) {
    f('Next step', [call.follow_up_action, call.follow_up_date ? `due ${when(call.follow_up_date)}` : ''].filter(Boolean).join(' · '), false);
  }
  if (stage) f('CRM stage', stage);
  if (lead && lead.stageLine) f('Journey', lead.stageLine);
  if (call.notes) f('Notes', call.notes.slice(0, 900), false);

  const desc = lead
    ? `**${name}**${lead.email ? ` · ${lead.email}` : ''}`
    : `**${name}** — no CRM match, filed unlinked`;

  return {
    embeds: [{
      author: { name: `${oc.emoji} ${ROLE_WORD[role].toUpperCase()} · ${(oc.shown || oc.label).toUpperCase()}` },
      title: `${name}`,
      description: desc,
      color: oc.colour,
      fields,
      footer: { text: `${ROLE_WORD[role]} report · ${date}${moved ? ' · lead moved' : ''}` },
      timestamp: new Date().toISOString(),
    }],
    components: buttons([
      lead?.url && { label: 'Open in Notion', url: lead.url },
      lead?.ghl && { label: 'GHL', url: lead.ghl },
      call.recording_url && { label: 'Recording', url: call.recording_url },
      base && { label: 'Dashboard', url: `${base}/reports` },
    ]),
    allowed_mentions: { parse: [] },
  };
}

/** The end-of-day sign-off card. `seats` is one entry per seat the sign-off closed ({ role, counts, reports }). */
function signoffCard({ role, rep, date, counts, seats, p, reports, base }) {
  const fields = [];
  const f = (n, v, inline = true) => { if (v !== null && v !== undefined && v !== '' && !(typeof v === 'number' && Number.isNaN(v))) fields.push({ name: n, value: String(v).slice(0, 1024), inline }); };

  // Triage and closing can be one person: show every seat that has calls, each under its own name.
  const all = seats && seats.length ? seats : [{ role, counts, reports: reports || [] }];
  const withCalls = all.filter((x) => x.reports.length);
  const shown = withCalls.length ? withCalls : all.filter((x) => x.role === role);
  const multi = shown.length > 1;

  if (role === 'setter') {
    f('Active conversations', p.active_conversations);
    f('Total messages sent', p.messages_sent);
    f('Inbound', p.inbounds);
    f('Outbound', p.outbounds);
    f('Links sent', p.links_sent);
    f('Calls booked', p.calls_booked ?? counts.booked);
    f('New followers', p.new_followers);
    f('Qualified (ICP)', p.qualified_followers);
    f('Hottest leads', String(p.hottest_lead || '').split(', ').filter(Boolean).join('\n'), false);
  } else {
    for (const x of shown) {
      const c = x.counts, pre = multi ? `${ROLE_WORD[x.role]} · ` : '';
      f(`${pre}Calls held`, c.held);
      f(`${pre}Showed`, c.showed);
      f(`${pre}No-shows`, c.no_shows);
      if (x.role === 'triage') { f(`${pre}Qualified`, c.qualified); f(`${pre}Closing calls booked`, c.closing_booked); f(`${pre}Rejected`, c.rejected); }
      if (x.role === 'closer') { f(`${pre}Contracts signed`, c.won); f(`${pre}Lost`, c.lost); f(`${pre}Follow-ups`, c.follow_ups); }
    }
    f('Cash collected', money(shown.reduce((a, x) => a + (x.counts.cash || 0), 0)));
    if (shown.some((x) => x.role === 'closer')) f('Deal value', money(shown.reduce((a, x) => a + (x.counts.deal || 0), 0)));
  }
  f('Hit KPIs', p.hit_kpis);
  if (p.no_calls && !withCalls.length) f('No calls today', p.no_calls_notes || 'No calls booked', false);
  f('Wins', p.wins, false);
  f('Blockers', p.blockers, false);
  f('Notes', p.notes, false);

  const lines = (rs) => rs.slice(0, 12).map((r) => `• ${r.name} — ${r.outcome === 'Closed Won' ? 'Contract Signed' : r.outcome}`).join('\n');
  const list = multi
    ? shown.map((x) => `**${ROLE_WORD[x.role]} calls**\n${lines(x.reports)}`).join('\n\n')
    : (withCalls.length ? `**Today's ${role === 'setter' ? 'leads' : `${ROLE_WORD[shown[0].role].toLowerCase()} calls`}**\n${lines(shown[0].reports)}` : '');
  const colour = p.hit_kpis === 'Yes' ? COLOUR.green : p.hit_kpis === 'No' ? COLOUR.red : COLOUR.gold;
  const word = shown.map((x) => ROLE_WORD[x.role]).join(' + ');
  return {
    embeds: [{
      author: { name: `📝 EOD SIGN-OFF · ${word.toUpperCase()}` },
      title: `${rep} · ${when(date)}`,
      description: (list || (p.no_calls ? 'No calls today.' : 'No call reports filed today.')).slice(0, 4000),
      color: colour,
      fields,
      footer: { text: `${word} sign-off · ${date}` },
      timestamp: new Date().toISOString(),
    }],
    components: buttons([
      base && { label: 'Dashboard', url: `${base}/reports` },
      base && { label: 'File a report', url: `${base}/eod` },
    ]),
    allowed_mentions: { parse: [] },
  };
}

/** The nightly digest for daily-standup. */
function digestCard({ date, rows, totals, missing, base, notionUrl, status = {}, ping = true, hour = 21 }) {
  const lines = rows.map((r) => {
    const bits = [];
    const n = (v, one) => `${v} ${one}${v === 1 ? '' : 's'}`;
    if (r.role === 'setter') bits.push(n(r.calls, 'lead report'), r.signed ? `${r.messages ?? 0} DMs` : '', `${r.booked} booked`);
    else if (!r.calls) bits.push('no calls today');
    else {
      bits.push(n(r.scheduled, 'call'), `${r.showed} showed`);
      if (r.role === 'triage') bits.push(`${r.qualified} qualified`, `${r.closing_booked} closing booked`);
      if (r.role === 'closer') bits.push(`${r.won} won`, money(r.cash) ? `${money(r.cash)} collected` : '');
    }
    const kpi = r.hit_kpis ? ` · KPIs ${r.hit_kpis.toLowerCase()}` : '';
    const signed = r.signed ? '' : ' · **no sign-off**';
    // on target / below / critical against the daily targets, from the scorecard
    const st = status[`${r.rep.toLowerCase()}|${r.role}`];
    const mark = st ? `${st.total ? (st.hit === st.total ? '🟢' : st.crit ? '🔴' : '🟠') : '⚪'} ` : '';
    const tgt = st && st.total ? ` · ${st.hit}/${st.total} on target` : '';
    return `${mark}**${r.rep}** (${ROLE_WORD[r.role]}) — ${bits.filter(Boolean).join(' · ')}${tgt}${kpi}${signed}`;
  });
  const miss = missing.length
    ? `\n\n**No report at all from:** ${missing.map((m) => m.name).join(', ')}`
      + (base ? `\n👉 **[Fill in your EOD report](${base}/eod)** · two minutes` : '')
    : '';
  // The link goes in the ping line itself, so it is in the notification and not only a button under the card.
  // Nobody is tagged here: the missed-report reminder (lib/scorecard.js runNudge) tags each person who missed,
  // one message each. The digest only names them.
  const pings = '';
  const chase = pings ? `⏰ ${pings} today's EOD report hasn't been filed.${base ? ` Fill it in here, it takes two minutes: <${base}/eod>` : ''}` : undefined;
  const t = [
    totals.setting ? `${totals.setting} lead report${totals.setting === 1 ? '' : 's'}` : '',
    `${totals.triage + totals.closing} call${totals.triage + totals.closing === 1 ? '' : 's'}`,
    `${totals.booked} booked`, `${totals.showed} showed`, `${totals.won} won`,
    money(totals.cash) ? `${money(totals.cash)} collected` : '',
  ].filter(Boolean).join(' · ');
  return {
    content: ping ? chase : undefined,
    embeds: [{
      author: { name: '📝 END OF DAY DIGEST' },
      title: when(date),
      description: (lines.length ? lines.join('\n') : 'Nothing was filed today.') + miss,
      color: missing.length ? COLOUR.amber : COLOUR.gold,
      fields: [{ name: 'Totals', value: t, inline: false }],
      footer: { text: `Posted ${String(hour).padStart(2, '0')}:00 · from the EOD report` },
      timestamp: new Date().toISOString(),
    }],
    components: buttons([
      base && { label: 'Scorecard', url: `${base}/scorecard?date=${date}` },
      base && { label: 'Dashboard', url: `${base}/reports` },
      base && { label: 'File a report', url: `${base}/eod` },
      notionUrl && { label: 'Notion', url: notionUrl },
    ]),
    allowed_mentions: { parse: [] },
  };
}

module.exports = { post, edit, remove, link, channelFor, callCard, signoffCard, digestCard, COLOUR, money, when, teamMember, mention };
