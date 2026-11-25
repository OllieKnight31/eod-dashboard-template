#!/usr/bin/env node
// Creates a "🧭 Client Journey" board tab on 💰 Sales, grouped by Journey Stage,
// with the nine stages in order and the two exits at the end.
//
// Notion's public API cannot create or configure a view, so this drives the
// private saveTransactionsFanout endpoint from inside the logged-in tab.
const fs = require('fs');
const { run } = require('./cdp');
const CFG = require('../journey.config.json');

const ids = JSON.parse(fs.readFileSync(`${__dirname}/../.view-ids.json`, 'utf8'));
const columns = [...CFG.stages.map((s) => s.name), ...CFG.exits.map((e) => e.name)];

const payload = {
  space: ids.spaceId,
  collection: ids.collectionId,
  parent: ids.parentBlock,
  stageProp: ids.journeyStage.id,
  lastView: ids.viewIds[ids.viewIds.length - 1],
  columns,
  cardProps: [ids.email, ids.phone, ids.nextAction, ids.stalled, ids.owner]
    .filter(Boolean).map((p) => p.id),
};

(async () => {
  const out = await run(`async () => {
    const P = ${JSON.stringify(payload)};
    const NEW = crypto.randomUUID();

    const mkCol = (name) => ({
      value: name ? { type: 'select', value: name } : { type: 'select' },
      hidden: !name,                     // keep the "no stage" group, collapsed
      property: P.stageProp,
    });
    const board_columns = [...P.columns.map(mkCol), mkCol(null)];

    const record = {
      id: NEW, version: 1, type: 'board', name: '🧭 Client Journey',
      format: {
        board_columns,
        board_columns_by: { sort: { type: 'manual' }, type: 'select',
                            property: P.stageProp, hideEmptyGroups: false },
        board_properties: P.cardProps.map((pid) => ({ property: pid, visible: true })),
        board_cover: { type: 'none' },
        board_cover_size: 'small',
        collection_pointer: { id: P.collection, table: 'collection', spaceId: P.space },
      },
      parent_id: P.parent, parent_table: 'block', alive: true,
      query2: { aggregations: [{ aggregator: 'count', enforceMaxAggregationLimit: true }] },
      space_id: P.space,
    };

    const ops = [
      { pointer: { table: 'collection_view', id: NEW, spaceId: P.space }, path: [], command: 'set', args: record },
      { pointer: { table: 'block', id: P.parent, spaceId: P.space }, path: ['view_ids'],
        command: 'listAfter', args: { after: P.lastView, id: NEW } },
    ];

    const r = await fetch('/api/v3/saveTransactionsFanout', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ requestId: crypto.randomUUID(),
        transactions: [{ id: crypto.randomUUID(), spaceId: P.space, operations: ops }] }),
    });
    return { status: r.status, body: (await r.text()).slice(0, 300), viewId: NEW };
  }`, 'notion.com');

  console.log(JSON.stringify(out, null, 2));
  if (out.status === 200) {
    const st = JSON.parse(fs.readFileSync(`${__dirname}/../journey.state.json`, 'utf8'));
    st.board_view = out.viewId;
    st.board_url = `https://www.notion.so/${ids.parentBlock.replace(/-/g, '')}?v=${out.viewId.replace(/-/g, '')}`;
    fs.writeFileSync(`${__dirname}/../journey.state.json`, JSON.stringify(st, null, 2));
    console.log('\nboard:', st.board_url);
  } else {
    process.exit(1);
  }
})().catch((e) => { console.error('FAILED', e.message); process.exit(1); });
