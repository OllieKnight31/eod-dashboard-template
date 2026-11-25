#!/usr/bin/env python3
"""
Generates the two GoHighLevel emails (run: python3 emails/_build.py) that carry the tracked asset links.

Table-based, inline-styled HTML — the only thing that survives Outlook and the
GHL email builder intact. The link carries {{contact.id}}, which is what makes
a send attributable: the watch page resolves that to the lead and stamps the
open, the play and the watch depth onto their row.
"""
import json, os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CFG = json.load(open(os.path.join(ROOT, "journey.config.json")))
BIZ = CFG.get("business", {})
NAME = os.environ.get("BUSINESS_NAME") or BIZ.get("name") or "Your Brand"
BASE = CFG.get("public_base") or "https://your-eod-app.example.com"
LOGO = BIZ.get("logo_url") or ""
# Who signs the emails. Change these two lines per client.
SENDER = "Your Name"
SENDER_TITLE = f"Founder, {NAME}"

GOLD, INK, CREAM, MUTED = "#A3A3A3", "#0A0A0A", "#F5F5F5", "#A3A3A3"

TPL = """<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>{subject}</title></head>
<body style="margin:0;padding:0;background:{ink};">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:{ink};">
<tr><td align="center" style="padding:34px 16px 46px;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:560px;">

    <tr><td align="center" style="padding:0 0 30px;">
      {logo_html}
    </td></tr>

    <tr><td style="border-top:1px solid rgba(163,163,163,.3);"></td></tr>

    <tr><td style="padding:32px 0 0;">
      <p style="margin:0 0 14px;font-family:'Helvetica Neue',Arial,sans-serif;font-size:10px;
        letter-spacing:.26em;text-transform:uppercase;color:{gold};">{kicker}</p>
      <h1 style="margin:0 0 18px;font-family:Georgia,'Times New Roman',serif;font-weight:normal;
        font-size:29px;line-height:1.18;color:{cream};">{headline}</h1>
      {body}
    </td></tr>

    <tr><td align="left" style="padding:30px 0 6px;">
      <table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
        <td style="background:{gold};">
          <a href="{link}" style="display:inline-block;padding:15px 32px;
            font-family:'Helvetica Neue',Arial,sans-serif;font-size:11px;font-weight:600;
            letter-spacing:.18em;text-transform:uppercase;color:{ink};text-decoration:none;">{cta}</a>
        </td>
      </tr></table>
    </td></tr>

    <tr><td style="padding:16px 0 0;">
      <p style="margin:0;font-family:'Helvetica Neue',Arial,sans-serif;font-size:12px;
        line-height:1.6;color:{muted};">Or paste this into your browser:<br>
        <a href="{link}" style="color:{gold};text-decoration:none;word-break:break-all;">{link}</a></p>
    </td></tr>

    <tr><td style="padding:34px 0 0;border-top:1px solid rgba(163,163,163,.2);margin-top:30px;">
      <p style="margin:26px 0 0;font-family:'Helvetica Neue',Arial,sans-serif;font-size:12px;
        line-height:1.65;color:{muted};">{signoff}</p>
    </td></tr>

    <tr><td align="center" style="padding:36px 0 0;">
      <p style="margin:0;font-family:'Helvetica Neue',Arial,sans-serif;font-size:11px;color:#6E6862;">
        {name} &middot; This link was prepared for you and is not public.</p>
    </td></tr>

  </table>
</td></tr></table>
</body></html>"""

P = ('<p style="margin:0 0 15px;font-family:\'Helvetica Neue\',Arial,sans-serif;'
     'font-size:15px;line-height:1.68;color:#D8D2C8;">{}</p>')

EMAILS = [
    {
        "file": "01-initial-vsl.html",
        "slug": "initial-vsl",
        "subject": "Before we speak, {{contact.first_name}}",
        "kicker": "Before your call",
        "headline": "Watch this before we speak",
        "cta": "Watch it now",
        "body": "".join(P.format(t) for t in [
            "{{contact.first_name}}, your application has been read, and we would like to speak.",
            "Before that call, there is one short video worth your time. It covers what we do, who it is built for, and what the conversation ahead of us is for. Most of what people ask on a first call is answered in it, which means our call can be about you instead.",
            "It was prepared for you and the link is yours alone.",
        ]),
        "signoff": f"See you on the call.<br><br>{SENDER}<br>{SENDER_TITLE}",
    },
    {
        "file": "02-post-triage-pack.html",
        "slug": "post-triage-vsl",
        "subject": "Everything we discussed",
        "kicker": "After our conversation",
        "headline": "Everything we talked through, in one place",
        "cta": "Open the pack",
        "body": "".join(P.format(t) for t in [
            "{{contact.first_name}}, good to speak.",
            "Here is the pack I promised: how each option actually differs, what it includes, and how the work gets built around you rather than sold to you.",
            "Watch it before our next conversation and come with the questions it raises. That call is where we decide what fits, so the more specific you are, the better it goes.",
        ]),
        "signoff": f"Speak soon.<br><br>{SENDER}<br>{SENDER_TITLE}",
    },
]

for e in EMAILS:
    link = f'{BASE}/v/{e["slug"]}?c={{{{contact.id}}}}'
    html = TPL.format(subject=e["subject"], kicker=e["kicker"], headline=e["headline"],
                      body=e["body"], link=link, cta=e["cta"], signoff=e["signoff"],
                      logo_html=(f'<img src="{LOGO}" alt="{NAME}" width="132" style="display:block;border:0;width:132px;height:auto;">' if LOGO else f'<p style="margin:0;font-family:Georgia,serif;font-size:22px;color:{CREAM};">{NAME}</p>'),
                      name=NAME, gold=GOLD, ink=INK, cream=CREAM, muted=MUTED)
    path = os.path.join(os.path.dirname(os.path.abspath(__file__)), e["file"])
    open(path, "w").write(html)
    print(f'  {e["file"]}  subject: {e["subject"]}')
    print(f'      link: {link}')
