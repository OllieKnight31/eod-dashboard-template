#!/usr/bin/env node
// Recompute the funnel. `--dry` derives and prints without writing anything.
// `--since=YYYY-MM-DD` or `--since=all` changes the cohort window.
const J = require('../lib/journey');

(async () => {
  const args = process.argv.slice(2);
  const dry = args.includes('--dry');
  const sinceArg = (args.find((a) => a.startsWith('--since=')) || '').split('=')[1];
  const since = sinceArg === 'all' ? null : (sinceArg || undefined);

  const out = await J.recompute({ since, writeLeads: !dry, writeHealth: !dry });

  console.log(`\ncohort ${out.cohort.since || 'all time'} — ${out.cohort.leads} of ${out.cohort.of} leads` +
              (dry ? '  (dry run, nothing written)' : `  ·  ${out.moved} lead rows updated`));
  console.log('\n   #  stage                      enter    adv   conv%  target   open   lost  verdict');
  console.log('   ────────────────────────────────────────────────────────────────────────────────────');
  for (const s of out.stages) {
    const conv = s.conversion === null ? '    —' : String(s.conversion).padStart(5);
    let verdict = '·  no data';
    if (s.conversion !== null && s.entered > 0) {
      if (s.conversion >= s.target) verdict = '🟢 on target';
      else if (s.conversion >= s.target - 10) verdict = '🟡 watch';
      else verdict = '🔴 BOTTLENECK';
    }
    console.log(
      `  ${String(s.no).padStart(2)}  ${s.stage.padEnd(24)}  ${String(s.entered).padStart(5)}  ${String(s.advanced).padStart(5)}  ${conv}   ${String(s.target).padStart(5)}  ${String(s.open).padStart(5)}  ${String(s.lost).padStart(5)}  ${verdict}`);
  }
  console.log('');
})().catch((e) => { console.error(e); process.exit(1); });
