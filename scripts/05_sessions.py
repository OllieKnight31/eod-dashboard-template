#!/usr/bin/env python3
"""
Creates 🌐 Site Sessions: one row per visit to your website (recorded by public/t.js).

A full-page database, not inline, so it lands on the dashboard as a single
link rather than a fifth table. Raw rows live here; the dashboard shows the
aggregate.

Idempotent: skips if journey.state.json already names it.
"""
import json, os, sys
sys.path.insert(0, os.path.dirname(__file__))
from notion_lib import req, rt

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CFG = json.load(open(os.path.join(ROOT, "journey.config.json")))
SP = os.path.join(ROOT, "journey.state.json")
STATE = json.load(open(SP))

if STATE.get("sessions_db"):
    print("sessions_db exists", STATE["sessions_db"]); sys.exit(0)

CHANNELS = ["Meta ads", "Google ads", "TikTok ads", "Tagged link",
            "Organic search", "Organic social", "Referral", "Direct"]
PAGES = list(CFG.get("site_pages") or ["/"]) + ["other"]

db = req("POST", "/databases", {
    "parent": {"type": "page_id", "page_id": STATE["page"]},
    "is_inline": False,
    "icon": {"type": "emoji", "emoji": "🌐"},
    "title": [rt("Site Sessions")],
    "description": [rt("One row per visit to the website. Written by the tracker on the live site; the dashboard reads the aggregate.")],
    "properties": {
        "Session": {"title": {}},
        "Started": {"date": {}},
        "Last seen": {"date": {}},
        "Channel": {"select": {"options": [{"name": c} for c in CHANNELS]}},
        "Landing page": {"select": {"options": [{"name": p} for p in PAGES]}},
        "Referrer": {"rich_text": {}},
        "Device": {"select": {"options": [
            {"name": "Desktop", "color": "blue"},
            {"name": "Mobile", "color": "green"},
            {"name": "Tablet", "color": "orange"}]}},
        "Country": {"rich_text": {}},
        "Pages": {"number": {"format": "number"}},
        # The application funnel, per visitor.
        "Form started": {"checkbox": {}},
        "Furthest step": {"number": {"format": "number"}},
        "Furthest question": {"rich_text": {}},
        "Completed": {"checkbox": {}},
        "Email": {"email": {}},
        "Campaign": {"rich_text": {}},
        "Minutes on site": {"formula": {"expression":
            'if(empty(prop("Last seen")) or empty(prop("Started")), toNumber(""), '
            'round(dateBetween(prop("Last seen"), prop("Started"), "minutes")))'}},
    },
})
STATE["sessions_db"] = db["id"]
json.dump(STATE, open(SP, "w"), indent=2)
print("created sessions_db", db["id"])
print("https://www.notion.so/" + db["id"].replace("-", ""))
