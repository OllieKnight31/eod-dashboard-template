"""Shared Notion helpers for the EOD and client-journey setup scripts."""
import json, os, sys, time, urllib.request, urllib.error

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
_CFG = json.load(open(os.path.join(ROOT, "journey.config.json")))
_BIZ = _CFG.get("business", {})

TOKEN = os.environ.get("NOTION_API_KEY")
if not TOKEN:
    sys.exit("NOTION_API_KEY not set. Create an internal integration at notion.so/my-integrations, share your parent page with it, then export NOTION_API_KEY=...")

API = "https://api.notion.com/v1"
HDRS = {
    "Authorization": f"Bearer {TOKEN}",
    "Notion-Version": "2022-06-28",
    "Content-Type": "application/json",
}


def req(method, path, body=None, retries=4):
    """One Notion call with retry on 429/5xx."""
    for attempt in range(retries):
        r = urllib.request.Request(
            API + path, method=method,
            data=json.dumps(body).encode() if body is not None else None,
            headers=HDRS,
        )
        try:
            with urllib.request.urlopen(r) as resp:
                return json.load(resp)
        except urllib.error.HTTPError as e:
            payload = e.read().decode()
            if e.code in (429, 502, 503, 504) and attempt < retries - 1:
                time.sleep(1.5 * (attempt + 1))
                continue
            raise RuntimeError(f"{method} {path} -> {e.code} {payload}") from None


# ---------------------------------------------------------------- brand
GOLD = "orange"
GOLD_BG = "brown_background"
# Optional page icon and cover images, from journey.config.json -> business.
ASSETS = {
    "favicon":   _BIZ.get("favicon_url") or "",
    "hero_logo": _BIZ.get("logo_url") or "",
    "cover":     _BIZ.get("cover_url") or "",
    "painting":  _BIZ.get("cover_url") or "",
}


def icon(emoji="🧭"):
    """The page icon: the favicon if one is set, otherwise an emoji."""
    if ASSETS["favicon"]:
        return {"type": "external", "external": {"url": ASSETS["favicon"]}}
    return {"type": "emoji", "emoji": emoji}


def cover(key="cover"):
    """A cover image payload, or None when no image is configured."""
    url = ASSETS.get(key)
    return {"type": "external", "external": {"url": url}} if url else None


def parent_page(cfg):
    """The page everything is built under: NOTION_PARENT_PAGE wins over the config."""
    pid = os.environ.get("NOTION_PARENT_PAGE") or os.environ.get("JOURNEY_PARENT") or cfg["notion"].get("parent_page", "")
    if not pid or pid.startswith("YOUR_"):
        sys.exit("Set NOTION_PARENT_PAGE (or notion.parent_page in journey.config.json) to the id of the Notion page to build under.")
    return pid


def sales_db(cfg):
    """The lead CRM database id: NOTION_SALES_DB wins over the config."""
    db = os.environ.get("NOTION_SALES_DB") or cfg["notion"].get("sales_db", "")
    if not db or db.startswith("YOUR_"):
        sys.exit("No Sales database yet. Run scripts/00_sales.py first, or set NOTION_SALES_DB.")
    return db


CURRENCY_FORMAT = {"USD": "dollar", "GBP": "pound", "EUR": "euro", "CAD": "canadian_dollar",
                   "AUD": "australian_dollar", "NZD": "new_zealand_dollar", "INR": "rupee",
                   "JPY": "yen", "CHF": "franc", "SGD": "singapore_dollar", "AED": "uae_dirham"}
MONEY = CURRENCY_FORMAT.get((_BIZ.get("currency") or "USD").upper(), "number_with_commas")


def rt(text, bold=False, italic=False, code=False, color="default", link=None):
    """One rich-text run."""
    return {
        "type": "text",
        "text": {"content": text, "link": {"url": link} if link else None},
        "annotations": {"bold": bold, "italic": italic, "code": code,
                        "strikethrough": False, "underline": False, "color": color},
    }


def para(runs, color="default"):
    runs = [rt(runs)] if isinstance(runs, str) else runs
    return {"object": "block", "type": "paragraph",
            "paragraph": {"rich_text": runs, "color": color}}


def heading(text, level=2, color="default", toggle=False):
    k = f"heading_{level}"
    return {"object": "block", "type": k,
            k: {"rich_text": [rt(text)], "color": color, "is_toggleable": toggle}}


def callout(runs, icon="✦", color=GOLD_BG):
    runs = [rt(runs)] if isinstance(runs, str) else runs
    return {"object": "block", "type": "callout",
            "callout": {"rich_text": runs, "icon": {"type": "emoji", "emoji": icon},
                        "color": color}}


def divider():
    return {"object": "block", "type": "divider", "divider": {}}


def bullet(runs, color="default"):
    runs = [rt(runs)] if isinstance(runs, str) else runs
    return {"object": "block", "type": "bulleted_list_item",
            "bulleted_list_item": {"rich_text": runs, "color": color}}


def numbered(runs):
    runs = [rt(runs)] if isinstance(runs, str) else runs
    return {"object": "block", "type": "numbered_list_item",
            "numbered_list_item": {"rich_text": runs, "color": "default"}}


def toggle_block(text, children, color="default"):
    return {"object": "block", "type": "toggle",
            "toggle": {"rich_text": [rt(text, bold=True)], "color": color,
                       "children": children}}


def code_block(text, lang="markdown"):
    return {"object": "block", "type": "code",
            "code": {"rich_text": [rt(text)], "language": lang}}


def quote(runs, color="default"):
    runs = [rt(runs)] if isinstance(runs, str) else runs
    return {"object": "block", "type": "quote", "quote": {"rich_text": runs, "color": color}}


def link_to(page_id):
    return {"object": "block", "type": "link_to_page",
            "link_to_page": {"type": "page_id", "page_id": page_id}}


def columns(*col_children):
    return {"object": "block", "type": "column_list",
            "column_list": {"children": [
                {"object": "block", "type": "column", "column": {"children": list(c)}}
                for c in col_children]}}


def append(block_id, children):
    """Append blocks in chunks of 100."""
    out = []
    for i in range(0, len(children), 100):
        out.append(req("PATCH", f"/blocks/{block_id}/children",
                       {"children": children[i:i + 100]}))
    return out
