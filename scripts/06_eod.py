#!/usr/bin/env python3
"""
The EOD report system's Notion side.

  1. Extends Call EOD Reports (one row per call, any role) — renames Closer to
     Rep, adds Role, the setter outcomes, the triage qualification fields and
     the pointers back to Discord and the day's sign-off.
  2. Extends 💰 Sales with the next-call columns the setter and triage reports
     write, so "booked but not reported" can be computed.
  3. Creates 📝 EOD Sign-offs — one row per rep per day.
  4. Builds the 📝 EOD Reports child page under 🧭 Client Journey: links row,
     a "This week" table the nightly job rewrites, the sign-offs table, and
     links to the two call/activity tables that already live on the parent.
  5. Adds an "EOD dashboard" link to the parent page's links row.

Idempotent: every step checks before it writes. Re-run freely.
"""
import json, os, sys
sys.path.insert(0, os.path.dirname(__file__))
from notion_lib import req, rt, para, heading, append, GOLD, MONEY, sales_db

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CFG = json.load(open(os.path.join(ROOT, "journey.config.json")))
SP = os.environ.get("JOURNEY_STATE") or os.path.join(ROOT, "journey.state.json")
STATE = json.load(open(SP))
def save(): json.dump(STATE, open(SP, "w"), indent=2)

SALES = sales_db(CFG)
BASE  = os.environ.get("PUBLIC_BASE_URL") or CFG.get("public_base") or "https://your-eod-app.example.com"
EOD   = STATE["eod_db"]
SETTER = STATE["setter_db"]
PAGE  = STATE["page"]

def opt(name, color="default"): return {"name": name, "color": color}

def merged_options(existing, wanted):
    """Existing options by id (so nothing in use is dropped) plus any new names."""
    have = {o["name"] for o in existing}
    out = [{"id": o["id"], "name": o["name"], "color": o["color"]} for o in existing]
    out += [o for o in wanted if o["name"] not in have]
    return out

# ------------------------------------------------------------ 1. Call EOD Reports
db = req("GET", f"/databases/{EOD}")
P = db["properties"]
patch = {}
if "Closer" in P and "Rep" not in P:
    patch["Closer"] = {"name": "Rep"}
if "Role" not in P:
    patch["Role"] = {"select": {"options": [opt("Setter", "blue"), opt("Triage", "yellow"), opt("Closer", "purple")]}}
patch["Call type"] = {"select": {"options": merged_options(P["Call type"]["select"]["options"],
    [opt("Setting", "blue")])}}
patch["Outcome"] = {"select": {"options": merged_options(P["Outcome"]["select"]["options"], [
    opt("Triage call booked", "green"), opt("Follow-up — not booked", "yellow"),
    opt("Not interested", "red"), opt("No response", "gray")])}}
patch["Attendance"] = {"select": {"options": merged_options(P["Attendance"]["select"]["options"],
    [opt("Booked", "blue"), opt("Not held", "gray")])}}
adds = {
    "Booked for":      {"date": {}},
    "Booked with":     {"rich_text": {}},
    "Setter":          {"rich_text": {}},
    "Fit":             {"select": {"options": [opt("Strong", "green"), opt("Possible", "yellow"), opt("Weak", "red")]}},
    "Budget band":     {"select": {"options": [opt("Up to 15k"), opt("15k to 50k"), opt("50k to 150k"), opt("150k plus"), opt("Discuss on the call")]}},
    "Decision maker":  {"select": {"options": [opt("Sole", "green"), opt("Joint", "yellow"), opt("Not the decision maker", "red")]}},
    "Timeline":        {"select": {"options": [opt("Now", "green"), opt("Within 30 days", "yellow"), opt("Within 90 days", "orange"), opt("Someday", "gray")]}},
    "Payment type":    {"select": {"options": [opt("Paid in Full", "green"), opt("Deposit", "yellow"), opt("Payment Plan", "blue")]}},
    "Stage set":       {"rich_text": {}},
    "Discord":         {"url": {}},
}
for k, v in adds.items():
    if k not in P: patch[k] = v
req("PATCH", f"/databases/{EOD}", {"properties": patch})
print("Call EOD Reports patched:", ", ".join(k for k in patch))

# ------------------------------------------------------------ 2. 💰 Sales
sales = req("GET", f"/databases/{SALES}")
SPROPS = sales["properties"]
spatch = {}
if "Next Call At" not in SPROPS:   spatch["Next Call At"] = {"date": {}}
if "Next Call Type" not in SPROPS: spatch["Next Call Type"] = {"select": {"options": [opt("Triage", "yellow"), opt("Closing", "purple")]}}
if "Next Call With" not in SPROPS: spatch["Next Call With"] = {"rich_text": {}}
if "Set By" not in SPROPS:         spatch["Set By"] = {"rich_text": {}}
if spatch:
    req("PATCH", f"/databases/{SALES}", {"properties": spatch})
    print("Sales extended:", ", ".join(spatch))
else:
    print("Sales already has the next-call columns")

# ------------------------------------------------------------ 4a. the page (the DB needs a parent)
if not STATE.get("eod_page"):
    pg = req("POST", "/pages", {
        "parent": {"type": "page_id", "page_id": PAGE},
        "icon": {"type": "emoji", "emoji": "📝"},
        "properties": {"title": {"title": [rt("EOD Reports")]}},
    })
    STATE["eod_page"] = pg["id"]; save()
    print("eod_page", pg["id"])
EPAGE = STATE["eod_page"]

if not STATE.get("eod_links_block"):
    res = append(EPAGE, [
        para([rt("Three reports, one per lead — filed right after the call by whoever held it, then a sign-off at the end of the day. Every row links to the lead in 💰 Sales and posts to Discord as it lands.")]),
        para([
            rt("📝 File a report", bold=True, link=f"{BASE}/eod"),
            rt("     ·     "),
            rt("📊 EOD dashboard", bold=True, link=f"{BASE}/reports"),
            rt("     ·     "),
            rt("🧭 Client Journey", bold=True, link="https://www.notion.so/" + PAGE.replace("-", "")),
        ]),
        heading("This week", 2, color=GOLD),
        para([rt("Per rep, last seven days. Rewritten every night at 9pm UK and whenever a sign-off lands.")]),
    ])
    ids = [b["id"] for b in res[0]["results"]]
    STATE["eod_links_block"] = ids[1]
    STATE["eod_week_anchor"] = ids[3]
    save()
    # placeholder table under the anchor — the nightly job replaces it
    req("PATCH", f"/blocks/{EPAGE}/children", {"after": STATE["eod_week_anchor"], "children": [{
        "object": "block", "type": "table",
        "table": {"table_width": 7, "has_column_header": True, "has_row_header": False, "children": [
            {"object": "block", "type": "table_row", "table_row": {"cells": [[rt(h)] for h in
                ["Rep", "Role", "Calls", "Showed", "Won / booked", "Cash", "Sign-offs"]]}},
            {"object": "block", "type": "table_row", "table_row": {"cells": [[rt("No reports filed yet")]] + [[rt("")]] * 6}},
        ]}}]})
    print("page intro written")

# ------------------------------------------------------------ 3. 📝 EOD Sign-offs
if not STATE.get("signoff_db"):
    append(EPAGE, [
        heading("Sign-offs", 2, color=GOLD),
        para([rt("One row per rep per day. The numbers are counted from the day's call reports; the notes, wins and blockers are theirs.")]),
    ])
    sdb = req("POST", "/databases", {
        "parent": {"type": "page_id", "page_id": EPAGE}, "is_inline": True,
        "icon": {"type": "emoji", "emoji": "📝"},
        "title": [rt("EOD Sign-offs")],
        "description": [rt("One row per rep per day, filed on the End of Day report. Counts come from the day's call reports.")],
        "properties": {
            "Sign-off":     {"title": {}},
            "Date":         {"date": {}},
            "Rep":          {"select": {"options": [opt(t["name"], "purple") for t in {t["name"]: t for t in CFG.get("eod", {}).get("team", [])}.values()]}},
            "Role":         {"select": {"options": [opt("Setter", "blue"), opt("Triage", "yellow"), opt("Closer", "purple")]}},
            "Hit KPIs":     {"select": {"options": [opt("Yes", "green"), opt("Partial", "yellow"), opt("No", "red")]}},
            "No calls":     {"checkbox": {}},
            "Calls held":   {"number": {"format": "number"}},
            "Showed":       {"number": {"format": "number"}},
            "No-shows":     {"number": {"format": "number"}},
            "Qualified":    {"number": {"format": "number"}},
            "Closing calls booked": {"number": {"format": "number"}},
            "Won":          {"number": {"format": "number"}},
            "Lost":         {"number": {"format": "number"}},
            "Cash collected": {"number": {"format": MONEY}},
            "Deal value":   {"number": {"format": MONEY}},
            "Calls booked": {"number": {"format": "number"}},
            "Messages sent": {"number": {"format": "number"}},
            "Outbounds":    {"number": {"format": "number"}},
            "Inbounds":     {"number": {"format": "number"}},
            "Follow-ups":   {"number": {"format": "number"}},
            "Show rate %":  {"formula": {"expression": 'if(prop("Calls held") > 0, round(prop("Showed") / prop("Calls held") * 100), toNumber(""))'}},
            "Close rate %": {"formula": {"expression": 'if(prop("Showed") > 0, round(prop("Won") / prop("Showed") * 100), toNumber(""))'}},
            "Booked per 100 DMs": {"formula": {"expression": 'if(prop("Messages sent") > 0, round(prop("Calls booked") / prop("Messages sent") * 100), toNumber(""))'}},
            "Hottest lead": {"rich_text": {}},
            "Wins":         {"rich_text": {}},
            "Blockers":     {"rich_text": {}},
            "Notes":        {"rich_text": {}},
            "Reports":      {"relation": {"database_id": EOD, "single_property": {}}},
            "Discord":      {"url": {}},
        },
    })
    STATE["signoff_db"] = sdb["id"]; save()
    print("signoff_db", sdb["id"])
SIGN = STATE["signoff_db"]

# Inline databases are not pages, so link_to_page cannot point at them — a
# paragraph of links does the same job.
if not STATE.get("eod_calls_section"):
    nurl = lambda i: "https://www.notion.so/" + i.replace("-", "")
    res = append(EPAGE, [
        heading("Call reports", 2, color=GOLD),
        para([rt("One row per call — every setting, triage and closing report, linked to its lead. Both tables live on the Client Journey page: "),
              rt("Call EOD Reports", bold=True, link=nurl(EOD)), rt("  ·  "),
              rt("Setter Daily Activity", bold=True, link=nurl(SETTER)), rt(".")]),
    ])
    STATE["eod_calls_section"] = res[0]["results"][0]["id"]; save()
    print("call reports section written")

# the back-pointer from a call report to its sign-off
db = req("GET", f"/databases/{EOD}")
if "Sign-off" not in db["properties"]:
    req("PATCH", f"/databases/{EOD}", {"properties": {"Sign-off": {"relation": {"database_id": SIGN, "single_property": {}}}}})
    print("Call EOD Reports: Sign-off relation added")

# ------------------------------------------------------------ 5. link on the parent page
LINKS_BLOCK = os.environ.get("NOTION_LINKS_BLOCK") or STATE.get("links_block")
links = req("GET", f"/blocks/{LINKS_BLOCK}") if LINKS_BLOCK else None
runs = links["paragraph"]["rich_text"] if links and "paragraph" in links else None
if runs is not None and not any((r.get("text", {}).get("link") or {}).get("url", "").endswith("/reports") for r in runs):
    for r in runs: r.pop("plain_text", None); r.pop("href", None)
    runs += [rt("     ·     "), rt("📊 EOD dashboard", bold=True, link=f"{BASE}/reports"),
             rt("     ·     "), rt("📝 EOD page", bold=True, link="https://www.notion.so/" + EPAGE.replace("-", ""))]
    req("PATCH", f"/blocks/{LINKS_BLOCK}", {"paragraph": {"rich_text": runs}})
    print("parent links row extended")

print("\nEOD page  https://www.notion.so/" + EPAGE.replace("-", ""))
print("Sign-offs https://www.notion.so/" + SIGN.replace("-", ""))
