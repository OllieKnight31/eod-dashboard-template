#!/usr/bin/env python3
"""
Builds the 🧭 Client Journey dashboard: four inline databases, each under a
heading and one line, plus a 📖 How it works child page holding everything the
dashboard does not need to say out loud.

The public Notion API only ever appends, so page order is the order of the
calls in this file — which is why a rebuild archives the previous page rather
than patching it. The database schemas live in _db_schemas.json, generated from
the live databases so they cannot drift from what is actually deployed.

After running this: scripts/03_seed.py, then scripts/config_views.js (needs a
logged-in Notion tab over CDP) to restore the trimmed columns and sorts.
"""
import json, os, sys
sys.path.insert(0, os.path.dirname(__file__))
from notion_lib import req, rt, para, heading, append, ASSETS, GOLD, icon, cover, parent_page, sales_db
import reference_content

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CFG = json.load(open(os.path.join(ROOT, "journey.config.json")))
SCHEMAS = json.load(open(os.path.join(os.path.dirname(__file__), "_db_schemas.json")))
# JOURNEY_STATE lets a rehearsal run against a scratch page and state file
SP = os.environ.get("JOURNEY_STATE") or os.path.join(ROOT, "journey.state.json")
STATE = json.load(open(SP)) if os.path.exists(SP) else {}
def save(): json.dump(STATE, open(SP, "w"), indent=2)

SALES = sales_db(CFG)
from notion_lib import MONEY
# Money columns follow business.currency in the config.
for _spec in SCHEMAS.values():
    for _p in _spec["properties"].values():
        if isinstance(_p.get("number"), dict) and _p["number"].get("format") == "dollar":
            _p["number"]["format"] = MONEY
BASE  = os.environ.get("PUBLIC_BASE_URL") or CFG.get("public_base") or "https://your-eod-app.example.com"

# Option lists that belong to the client come from the config, not the exported schema.
_C = ["blue", "green", "purple", "orange", "yellow", "pink", "brown", "gray"]
_opts = lambda names: [{"name": n, "color": _C[i % len(_C)]} for i, n in enumerate(names)]
SCHEMAS["eod"]["properties"]["Source"] = {"select": {"options": _opts(CFG.get("lead_sources", []))}}
SCHEMAS["setter"]["properties"]["Channel"] = {"select": {"options": _opts(CFG.get("lead_sources", []))}}
SCHEMAS["eod"]["properties"]["Tier discussed"] = {"select": {"options": _opts(CFG.get("eod", {}).get("pathways", []) + ["Undecided"])}}
SCHEMAS["eod"]["properties"]["Closer"] = {"select": {"options": _opts(CFG.get("closers", []))}}
BOARD = STATE.get("board_url", "")

# ============================================================ the page
if STATE.get("page"):
    try:
        req("PATCH", f"/pages/{STATE['page']}", {"archived": True})
        print("archived previous page", STATE["page"])
    except Exception as e:
        print("could not archive previous page:", e)
    try:
        req("PATCH", f"/databases/{SALES}", {"properties": {"Call Reports": None}})
    except Exception:
        pass
    for k in ("page", "stages_db", "eod_db", "setter_db", "assets_db", "howto_page", "consolidated"):
        STATE.pop(k, None)
    save()

page = req("POST", "/pages", {
    "parent": {"type": "page_id", "page_id": parent_page(CFG)},
    "icon":  icon("🧭"),
    **({"cover": cover()} if cover() else {}),
    "properties": {"title": {"title": [rt("Client Journey")]}},
})
STATE["page"] = PAGE = page["id"]; save()
print("page", PAGE)


def make_db(key):
    """Create one inline database from the exported live schema."""
    spec = SCHEMAS[key]
    db = req("POST", "/databases", {
        "parent": {"type": "page_id", "page_id": PAGE}, "is_inline": True,
        "icon": {"type": "emoji", "emoji": spec["emoji"]},
        "title": [rt(spec["title"])],
        "description": [rt(spec["description"])] if spec["description"] else [],
        "properties": spec["properties"],
    })
    STATE[f"{key}_db"] = db["id"]; save()
    print(f'  {key}_db', db["id"])
    return db["id"]


# The dashboard opens on a number, not a paragraph. The How it works page below
# carries the rest; this link needs its URL, which only exists once it is made.
PLACEHOLDER = "https://www.notion.so/placeholder"

res = append(PAGE, [
    para([rt("Nine stages. The percentage beside each one is how many leads made it to the next — where it falls under target, that is the bottleneck.")]),
    para([
        rt("🧭 Lead board", bold=True, link=BOARD or None),
        rt("     ·     "),
        rt("📈 Live funnel", bold=True, link=f"{BASE}/journey"),
        rt("     ·     "),
        rt("📝 End of Day report", bold=True, link=f"{BASE}/eod"),
        rt("     ·     "),
        rt("📖 How it works", bold=True, link=PLACEHOLDER),
    ]),
    heading("Funnel health", 2, color=GOLD),
    para([rt("Conversion to the next stage against target. "), rt("KPI Target %", code=True),
          rt(" is yours to edit — Health re-reads the moment you change it.")]),
])
LINKS_BLOCK = res[0]["results"][1]["id"]
make_db("stages")

append(PAGE, [
    heading("Calls — triage and closing", 2, color=GOLD),
    para([rt("Filed by the closer on the "), rt("End of Day report", bold=True, link=f"{BASE}/eod"),
          rt("; the call type on each block is what moves the lead to stage 5 or stage 7.")]),
])
make_db("eod")

append(PAGE, [
    heading("Setter activity", 2, color=GOLD),
    para([rt("Stage 1's volume. Every row in 💰 Sales is already past the DM, so the CRM cannot count conversations — this does.")]),
])
make_db("setter")

append(PAGE, [
    heading("Assets", 2, color=GOLD),
    para([rt("Paste a "), rt("Video URL", code=True),
          rt(" to take a watch page live. Sent, opened, played and watch depth are written by the pages themselves.")]),
])
make_db("assets")

# ================================================ 📖 How it works
sub = req("POST", "/pages", {
    "parent": {"type": "page_id", "page_id": PAGE},
    "icon":  {"type": "emoji", "emoji": "📖"},
    **({"cover": cover("painting")} if cover("painting") else {}),
    "properties": {"title": {"title": [rt("How it works")]}},
})
STATE["howto_page"] = sub["id"]; save()
append(sub["id"], reference_content.blocks(CFG, SALES, BASE, BOARD))
print("howto_page", sub["id"])

HOWTO_URL = "https://www.notion.so/" + sub["id"].replace("-", "")
blk = req("GET", f"/blocks/{LINKS_BLOCK}")
runs = blk["paragraph"]["rich_text"]
for r in runs:
    link = r.get("text", {}).get("link") or {}
    if link.get("url") == PLACEHOLDER:
        r["text"]["link"]["url"] = HOWTO_URL
    r.pop("plain_text", None); r.pop("href", None)
req("PATCH", f"/blocks/{LINKS_BLOCK}", {"paragraph": {"rich_text": runs}})

# ==================================================== relink Sales
sales = req("GET", f"/databases/{SALES}")
if os.environ.get("JOURNEY_STATE"):
    print("rehearsal — leaving the 💰 Sales relation alone")
elif "Call Reports" not in sales["properties"]:
    req("PATCH", f"/databases/{SALES}", {"properties": {"Call Reports": {"relation": {
        "database_id": STATE["eod_db"], "type": "dual_property",
        "dual_property": {"synced_property_name": "Lead"}}}}})
    print("💰 Sales  + relation 'Call Reports' <-> EOD 'Lead'")

STATE["consolidated"] = True; save()
print("\nDASHBOARD  https://www.notion.so/" + PAGE.replace("-", ""))
print("SUB-PAGE  ", HOWTO_URL)
print("\nnext: python3 scripts/03_seed.py, then python3 scripts/05_sessions.py and python3 scripts/06_eod.py")
