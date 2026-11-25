// journey.state.json holds the Notion ids the setup scripts create (dashboard
// page, Call EOD Reports, Sign-offs and so on). It is written by scripts/02_page.py
// and friends, so a fresh clone has none yet: fall back to an empty object and
// let the NOTION_*_DB env vars fill any gaps.
const fs = require('fs');
const path = require('path');

let STATE = {};
try { STATE = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'journey.state.json'), 'utf8')); }
catch (e) { STATE = {}; }

module.exports = STATE;
