#!/usr/bin/env python3
"""
Step 0 of the Notion setup: the 💰 Sales database (the lead CRM).

Skip this if the client already has a Sales database: put its id in
journey.config.json -> notion.sales_db and run 01_sales.py, which adds the
journey columns to it. The app reads these base columns by name, so an
existing database needs at least: Lead (title), Email (email), Stage (select).

Run:
  export NOTION_API_KEY=...            # internal integration token
  export NOTION_PARENT_PAGE=...        # page shared with that integration
  python3 scripts/00_sales.py

Creates the database under the parent page and writes its id into
journey.config.json -> notion.sales_db. Idempotent: does nothing if a real
sales_db id is already set.
"""
import json, os, sys
sys.path.insert(0, os.path.dirname(__file__))
from notion_lib import req, rt, parent_page, MONEY

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CFG_PATH = os.path.join(ROOT, "journey.config.json")
CFG = json.load(open(CFG_PATH))

have = os.environ.get("NOTION_SALES_DB") or CFG["notion"].get("sales_db", "")
if have and not have.startswith("YOUR_"):
    print("sales_db already set:", have)
    sys.exit(0)

C = ["blue", "green", "purple", "orange", "yellow", "pink", "brown", "gray", "red", "default"]
opts = lambda names: [{"name": n, "color": C[i % len(C)]} for i, n in enumerate(names)]

# CRM stages: everything the journey config knows about, plus the working stages
# the EOD report's "waiting for your report" list looks for.
stages = []
for name in (["New Lead", "Contacted", "In conversation", "No response. Reach out!", "Applied",
              "Triage Call Booked", "Follow-Up", "No-Show", "Closing Call Booked",
              "Awaiting Payment", "Closed"]
             + list(CFG.get("stage_floor", {}).keys()) + list(CFG.get("exit_stages", {}).keys())
             + ["Tests", "Spam"]):
    if name not in stages:
        stages.append(name)

db = req("POST", "/databases", {
    "parent": {"type": "page_id", "page_id": parent_page(CFG)},
    "icon": {"type": "emoji", "emoji": "💰"},
    "title": [rt("Sales")],
    "description": [rt("One row per lead. Written by the website form (via GHL), the GHL sync and the EOD reports.")],
    "properties": {
        "Lead":            {"title": {}},
        "Email":           {"email": {}},
        "Phone":           {"phone_number": {}},
        "Instagram":       {"rich_text": {}},
        "Stage":           {"select": {"options": opts(stages)}},
        "Source":          {"select": {"options": opts(CFG.get("lead_sources", []))}},
        "Applied":         {"date": {}},
        "Booked Call Date": {"date": {}},
        "Budget":          {"select": {"options": opts(CFG.get("eod", {}).get("budget_bands", []))}},
        "Deal Size":       {"number": {"format": MONEY}},
        "Cash Collected":  {"number": {"format": MONEY}},
        "Opp Status":      {"select": {"options": opts(["Open", "Won", "Lost"])}},
        "Loss Reason":     {"select": {"options": opts(["Price", "Timing", "Bad Fit", "Ghosted", "Other"])}},
        "Next Action":     {"multi_select": {"options": []}},
        "GHL Contact ID":  {"rich_text": {}},
        "GHL Link":        {"url": {}},
        "Calendly Link":   {"url": {}},
    },
})

CFG["notion"]["sales_db"] = db["id"]
json.dump(CFG, open(CFG_PATH, "w"), indent=2, ensure_ascii=False)
print("💰 Sales created:", db["id"])
print("saved to journey.config.json -> notion.sales_db")
print("\nnext: python3 scripts/01_sales.py")
