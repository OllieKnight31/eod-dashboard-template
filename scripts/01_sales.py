#!/usr/bin/env python3
"""
Step 1 of the Notion setup (after 00_sales.py).
Additively extends the 💰 Sales database with the journey-tracking
properties. Never removes or rewrites an existing property, so it is safe to
re-run against the database the CRM sync is actively writing to.
"""
import json, os, sys
sys.path.insert(0, os.path.dirname(__file__))
from notion_lib import req, rt, para, heading, callout, divider, bullet, ASSETS, GOLD, GOLD_BG

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CFG = json.load(open(os.path.join(ROOT, "journey.config.json")))
STATE_PATH = os.path.join(ROOT, "journey.state.json")
STATE = json.load(open(STATE_PATH)) if os.path.exists(STATE_PATH) else {}

def save():
    json.dump(STATE, open(STATE_PATH, "w"), indent=2)

STAGES = CFG["stages"]
EXITS = CFG["exits"]
from notion_lib import sales_db
SALES_DB = sales_db(CFG)

JOURNEY_OPTIONS = (
    [{"name": s["name"], "color": s["colour"]} for s in STAGES]
    + [{"name": e["name"], "color": e["colour"]} for e in EXITS]
)

# ------------------------------------------------ extend 💰 Sales (additive)
sales = req("GET", f"/databases/{SALES_DB}")
existing = set(sales["properties"].keys())

wanted = {
    "Journey Stage": {"select": {"options": JOURNEY_OPTIONS}},
    "Journey #": {"number": {"format": "number"}},
    "Journey Updated": {"date": {}},
    "Journey Source": {"select": {"options": [
        {"name": "application", "color": "orange"},
        {"name": "ghl-stage", "color": "blue"},
        {"name": "vsl-tracking", "color": "yellow"},
        {"name": "eod-report", "color": "green"},
        {"name": "contract", "color": "brown"},
        {"name": "manual", "color": "gray"},
    ]}},
    "VSL 1 Sent": {"date": {}},
    "VSL 1 Viewed": {"date": {}},
    "VSL 1 Watch %": {"number": {"format": "number"}},
    "VSL 2 Sent": {"date": {}},
    "VSL 2 Viewed": {"date": {}},
    "VSL 2 Watch %": {"number": {"format": "number"}},
    "Triage Date": {"date": {}},
    "Triage Outcome": {"select": {"options": [
        {"name": "Showed — advancing", "color": "green"},
        {"name": "Showed — follow-up", "color": "yellow"},
        {"name": "No-show", "color": "red"},
        {"name": "Rescheduled", "color": "orange"},
        {"name": "Rejected", "color": "pink"},
    ]}},
    "Closing Date": {"date": {}},
    "Closing Outcome": {"select": {"options": [
        {"name": "Won", "color": "green"},
        {"name": "Lost", "color": "red"},
        {"name": "Follow-up", "color": "yellow"},
        {"name": "No-show", "color": "gray"},
    ]}},
    "Paid Date": {"date": {}},
    "Onboarded Date": {"date": {}},
    # The offer sold. Options come from eod.pathways in journey.config.json.
    "Tier": {"select": {"options": [
        {"name": n, "color": ["gray", "brown", "orange", "yellow", "green", "blue"][i % 6]}
        for i, n in enumerate(CFG.get("eod", {}).get("pathways", []))
    ]}},
    "Next Action": {"rich_text": {}},
    "Next Action Due": {"date": {}},
    "Days in Stage": {"formula": {"expression":
        'if(empty(prop("Journey Updated")), toNumber(""), dateBetween(now(), prop("Journey Updated"), "days"))'}},
    "Stalled": {"formula": {"expression":
        'if(empty(prop("Journey Updated")), "", '
        f'if(dateBetween(now(), prop("Journey Updated"), "days") >= {CFG["stall_days"]}, '
        '"⚠ " + format(dateBetween(now(), prop("Journey Updated"), "days")) + "d idle", "✓ active"))'}},
}

add = {k: v for k, v in wanted.items() if k not in existing}
if add:
    # Formula properties must land after the properties they reference.
    plain = {k: v for k, v in add.items() if "formula" not in v}
    formulas = {k: v for k, v in add.items() if "formula" in v}
    if plain:
        req("PATCH", f"/databases/{SALES_DB}", {"properties": plain})
        print(f"💰 Sales  + {len(plain)} properties: {', '.join(plain)}")
    if formulas:
        req("PATCH", f"/databases/{SALES_DB}", {"properties": formulas})
        print(f"💰 Sales  + {len(formulas)} formulas: {', '.join(formulas)}")
else:
    print("💰 Sales  all journey properties already present")


print("\n💰 Sales journey properties in place.")
