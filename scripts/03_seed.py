#!/usr/bin/env python3
"""
Seeds (and re-syncs) the Funnel Health stage rows and the Journey Assets rows
from journey.config.json. Idempotent — matches on the title and patches only
the descriptive columns, so recomputed metrics and hand-edited KPI targets
survive a re-run unless --reset-targets is passed.
"""
import json, os, sys
sys.path.insert(0, os.path.dirname(__file__))
from notion_lib import req, rt

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CFG = json.load(open(os.path.join(ROOT, "journey.config.json")))
ST = json.load(open(os.path.join(ROOT, "journey.state.json")))
BASE = os.environ.get("PUBLIC_BASE_URL") or CFG.get("public_base") or "https://your-eod-app.example.com"
RESET = "--reset-targets" in sys.argv


def existing(db_id):
    out, cur = {}, None
    while True:
        b = {"page_size": 100}
        if cur: b["start_cursor"] = cur
        d = req("POST", f"/databases/{db_id}/query", b)
        for r in d["results"]:
            for v in r["properties"].values():
                if v.get("type") == "title":
                    out["".join(t["plain_text"] for t in v["title"])] = r
                    break
        if not d.get("has_more"): break
        cur = d["next_cursor"]
    return out


def txt(v):  return {"rich_text": [{"type": "text", "text": {"content": (v or "")[:2000]}}]}
def sel(v):  return {"select": {"name": v} if v else None}
def num(v):  return {"number": v}

# ------------------------------------------------------------- stages
have = existing(ST["stages_db"])
for s in CFG["stages"]:
    props = {
        "Stage": {"title": [{"type": "text", "text": {"content": s["name"]}}]},
        "#": num(s["no"]),
        "Owner": sel(s["owner"]),
        "Movement": sel("🤖 Automatic" if s["auto"] else "✍️ Manual (EOD)"),
        "How it advances": txt(s["advances_via"]),
        "Definition": txt(s["definition"]),
    }
    row = have.get(s["name"])
    if row:
        if RESET:
            props["KPI Target %"] = num(s["kpi_target"])
        req("PATCH", f"/pages/{row['id']}", {"properties": props})
        print(f'  = {s["name"]}')
    else:
        props["KPI Target %"] = num(s["kpi_target"])
        req("POST", "/pages", {"parent": {"database_id": ST["stages_db"]}, "properties": props})
        print(f'  + {s["name"]}')

# ------------------------------------------------------------- assets
STAGE_BY_KEY = {s["key"]: s for s in CFG["stages"]}
have = existing(ST["assets_db"])
for a in CFG["assets"]:
    st = STAGE_BY_KEY[a["stage_key"]]
    live = bool(a.get("video_url"))
    props = {
        "Asset": {"title": [{"type": "text", "text": {"content": a["title"]}}]},
        "Slug": txt(a["slug"]),
        "Type": sel(a["type"]),
        "Stage": sel(st["name"]),
        "Watch page": {"url": f'{BASE}/v/{a["slug"]}'},
        "Video URL": {"url": a.get("video_url") or None},
        "Status": sel("🟢 Live" if live else "🔴 Needs video"),
        "Headline": txt(a["kicker"]),
        "Blurb": txt(a["blurb"]),
        "Duration": txt(a.get("duration_hint", "")),
    }
    row = have.get(a["title"])
    if row:
        # Never stamp over a Video URL someone pasted into Notion — Notion wins.
        if row["properties"].get("Video URL", {}).get("url"):
            props.pop("Video URL"); props.pop("Status")
        req("PATCH", f"/pages/{row['id']}", {"properties": props})
        print(f'  = {a["title"]}')
    else:
        for k in ("Sent", "Opened", "Played", "Completed"):
            props[k] = num(0)
        req("POST", "/pages", {"parent": {"database_id": ST["assets_db"]}, "properties": props})
        print(f'  + {a["title"]}')

print("\nseeded.")
