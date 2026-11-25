// Read the ids the board-view recipe needs, from inside the logged-in tab.
const { run } = require('./cdp');
(async () => {
  const out = await run(`async () => {
    const dash = s => s.replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, '$1-$2-$3-$4-$5');
    const VIEW = dash(new URL(location.href).searchParams.get('v'));
    const r = await fetch('/api/v3/syncRecordValues', {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ requests:[{ pointer:{ table:'collection_view', id:VIEW }, version:-1 }] })
    });
    const j = await r.json();
    const dig = (n)=>{ let x=n; for(let i=0;i<6&&x;i++){ if(x.query2!==undefined||x.format!==undefined) return x; x=x.value; } return null; };
    const cv = dig(j.recordMap.collection_view[VIEW]);
    const COLLECTION = cv.format.collection_pointer.id;
    const r2 = await fetch('/api/v3/syncRecordValues', {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ requests:[{ pointer:{ table:'collection', id:COLLECTION }, version:-1 }] })
    });
    const j2 = await r2.json();
    const dig2 = (n)=>{ let x=n; for(let i=0;i<6&&x;i++){ if(x.schema) return x; x=x.value; } return null; };
    const coll = dig2(j2.recordMap.collection[COLLECTION]);
    const props = {};
    for (const [pid, def] of Object.entries(coll.schema||{})) props[def.name] = { id: pid, type: def.type };

    const r3 = await fetch('/api/v3/syncRecordValues', {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ requests:[{ pointer:{ table:'block', id: cv.parent_id }, version:-1 }] })
    });
    const j3 = await r3.json();
    const dig3 = (n)=>{ let x=n; for(let i=0;i<6&&x;i++){ if(x.view_ids) return x; x=x.value; } return null; };
    const blk = dig3(j3.recordMap.block[cv.parent_id]);

    return {
      currentView: VIEW,
      spaceId: cv.space_id,
      collectionId: COLLECTION,
      parentBlock: cv.parent_id,
      viewIds: blk ? blk.view_ids : [],
      journeyStage: props['Journey Stage'] || null,
      journeyNo: props['Journey #'] || null,
      stalled: props['Stalled'] || null,
      email: props['Email'] || null,
      phone: props['Phone'] || null,
      nextAction: props['Next Action'] || null,
      owner: props['Owner'] || null,
    };
  }`, 'notion.com');
  console.log(JSON.stringify(out, null, 2));
  require('fs').writeFileSync(`${__dirname}/../.view-ids.json`, JSON.stringify(out, null, 2));
})().catch((e) => { console.error('FAILED', e.message); process.exit(1); });
