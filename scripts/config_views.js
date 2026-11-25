#!/usr/bin/env node
// Column order, visibility and sort for the inline tables.
// Notion's public API cannot touch view configuration, so this drives the
// private endpoint from the logged-in tab, same as the board view.
const fs = require('fs');
const { run } = require('./cdp');
const ST = require('../lib/state');

// For an inline database the block id and the database id are the same thing.
const PLAN = [
  // Trimmed so nothing sprawls past the text column. Everything hidden here is
  // still on the record — open a row and it is all there.
  {
    db: ST.stages_db, label: 'Funnel Health',
    show: ['Stage', 'Conversion %', 'KPI Target %', 'Health'],
    widths: { Stage: 232, 'Conversion %': 138, 'KPI Target %': 140, Health: 158 },
    sort: [{ property: '#', direction: 'ascending' }],
  },
  {
    db: ST.eod_db, label: 'Call EOD Reports',
    show: ['Report', 'Date', 'Call type', 'Outcome'],
    widths: { Report: 280, Date: 110, 'Call type': 120, Outcome: 190 },
    sort: [{ property: 'Date', direction: 'descending' }],
  },
  {
    db: ST.setter_db, label: 'Setter Daily Activity',
    show: ['Day', 'Setter', 'Messages sent', 'Calls booked', 'Booked per 100 DMs'],
    widths: { Day: 128, Setter: 90, 'Messages sent': 152, 'Calls booked': 132, 'Booked per 100 DMs': 190 },
    sort: [{ property: 'Date', direction: 'descending' }],
  },
  {
    db: ST.assets_db, label: 'Journey Assets',
    show: ['Asset', 'Status', 'Sent', 'Opened', 'Played', 'Avg watch %'],
    widths: { Asset: 166, Status: 134, Sent: 74, Opened: 96, Played: 90, 'Avg watch %': 128 },
    sort: [{ property: 'Stage', direction: 'ascending' }],
  },
];

(async () => {
  const out = await run(`async () => {
    const PLAN = ${JSON.stringify(PLAN)};
    const dash = s => s.replace(/-/g,'').replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, '$1-$2-$3-$4-$5');
    const sync = async (table, id) => {
      const r = await fetch('/api/v3/syncRecordValues', {
        method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ requests:[{ pointer:{ table, id: dash(id) }, version:-1 }] })
      });
      const j = await r.json();
      const rec = (j.recordMap[table]||{})[dash(id)];
      let x = rec; for (let i=0;i<6&&x;i++){ if (x.id || x.schema || x.view_ids) return x; x = x.value; }
      return null;
    };

    const results = [];
    for (const p of PLAN) {
      const block = await sync('block', p.db);
      if (!block || !block.view_ids || !block.view_ids.length) { results.push({ db:p.label, err:'no view_ids' }); continue; }
      const collId = (block.collection_id) || (block.format && block.format.collection_pointer && block.format.collection_pointer.id) || p.db;
      const coll = await sync('collection', collId);
      if (!coll) { results.push({ db:p.label, err:'no collection' }); continue; }
      const space = block.space_id;

      const byName = {};
      for (const [pid, def] of Object.entries(coll.schema||{})) byName[def.name] = pid;

      const ordered = [];
      for (const name of p.show) { if (byName[name]) ordered.push({ name, id: byName[name] }); }
      const rest = Object.entries(coll.schema||{})
        .filter(([pid]) => !ordered.some(o => o.id === pid))
        .map(([pid, def]) => ({ name: def.name, id: pid }));

      const table_properties = [
        ...ordered.map(o => ({ property: o.id, visible: true, width: p.widths[o.name] || 140 })),
        ...rest.map(o => ({ property: o.id, visible: false, width: 140 })),
      ];
      const sorts = (p.sort||[]).filter(s => byName[s.property])
        .map(s => ({ property: byName[s.property], direction: s.direction }));

      const view = block.view_ids[0];
      const ops = [
        { pointer:{ table:'collection_view', id:view, spaceId:space }, path:['format','table_properties'], command:'set', args: table_properties },
        { pointer:{ table:'collection_view', id:view, spaceId:space }, path:['format','table_wrap'], command:'set', args: true },
        { pointer:{ table:'collection_view', id:view, spaceId:space }, path:['query2','sort'], command:'set', args: sorts },
      ];
      const r = await fetch('/api/v3/saveTransactionsFanout', {
        method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ requestId: crypto.randomUUID(),
          transactions:[{ id: crypto.randomUUID(), spaceId: space, operations: ops }] })
      });
      results.push({ db: p.label, view, status: r.status, cols: ordered.length, hidden: rest.length, sorts: sorts.length });
    }
    return results;
  }`, 'notion.com');

  console.log(JSON.stringify(out, null, 2));
})().catch((e) => { console.error('FAILED', e.message); process.exit(1); });
