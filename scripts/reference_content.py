"""
The reference half of the Client Journey: stage definitions, the runbook and
the GoHighLevel wiring.

It lives on a child page rather than the dashboard so the dashboard can open on
a number instead of on a paragraph. Used by 02_page.py.
"""
import os, sys
sys.path.insert(0, os.path.dirname(__file__))
from notion_lib import (rt, para, heading, callout, divider, bullet, numbered,
                        toggle_block, code_block, columns, GOLD, GOLD_BG)


def blocks(CFG, SALES, BASE, BOARD=""):
    STAGES, EXITS = CFG["stages"], CFG["exits"]
    out = []

    out += [
        callout([rt("Everything the dashboard does not need to say out loud. ", bold=True),
                 rt("What each stage means, what moves it, and how the sends are wired.")],
                icon="📖", color=GOLD_BG),
        columns(
            [callout([rt("Runs itself\n", bold=True),
                      rt("Website visit · Application · Initial VSL · Post-triage assets · Payment · Onboarding. Six of the nine need nobody to touch them.")],
                     icon="🤖", color="green_background")],
            [callout([rt("Needs the closer\n", bold=True),
                      rt("Triage call and closing call, filed on the EOD report at the end of each day — outcome, objection, ticket, next step.")],
                     icon="✍️", color="orange_background")],
            [callout([rt("Needs the setter\n", bold=True),
                      rt("Stage one only. DMs, outbound and inbound volume, logged once a day on the setter tab of the same report.")],
                     icon="📣", color="blue_background")],
        ),
        divider(),
    ]

    # ------------------------------------------------ stage by stage
    out += [heading("How a lead moves, stage by stage", 2, color=GOLD)]
    for s in STAGES:
        mark = "🤖" if s["auto"] else "✍️"
        out.append(toggle_block(
            f'{mark}  {s["name"]}  ·  target {s["kpi_target"]}% to the next stage',
            [
                para([rt("What it means. ", bold=True), rt(s["definition"])]),
                para([rt("How it advances. ", bold=True), rt(s["advances_via"])]),
                para([rt("Owner: ", bold=True), rt(s["owner"]),
                      rt("   ·   Target: ", bold=True), rt(f'{s["kpi_target"]}%'),
                      rt("   ·   GHL stages: ", bold=True),
                      rt(", ".join(s["ghl_stages"]) if s["ghl_stages"] else "—")]),
            ]))
    out += [
        callout([rt("Two exits. ", bold=True),
                 rt("✕ Rejected is ours — not a fit, said on a call. ✕ Lost is theirs — price, timing or silence. Keeping them apart is what stops a rejection rate reading as a closing problem.")],
                icon="❌", color="red_background"),
        divider(),
    ]

    # ------------------------------------------------------ the board
    out += [
        heading("The board — every lead, and where they stand", 2, color=GOLD),
        para([rt("Leads live in "), rt("💰 Sales", bold=True),
              rt(", the same database the GoHighLevel sync already writes to. This build added a "),
              rt("Journey Stage", code=True),
              rt(" column and the stamps behind it, so nothing was duplicated and no closer has a second place to look.")]),
        {"object": "block", "type": "link_to_page",
         "link_to_page": {"type": "database_id", "database_id": SALES}},
        bullet([rt("Cards sit in the nine journey columns. Drag one and the move is recorded as "),
                rt("manual", code=True),
                rt(" — the automation will not fight you, but it will correct a stage the evidence contradicts.")]),
        bullet([rt("Stalled", bold=True),
                rt(f" flags any lead untouched for {CFG['stall_days']} days or more. It is the second thing to look at after the red row.")]),
        bullet([rt("Next Action", bold=True), rt(" and "), rt("Next Action Due", bold=True),
                rt(" are written by the closer's EOD report — they are the follow-up queue.")]),
        divider(),
    ]

    # -------------------------------------------------------- runbook
    out += [
        heading("Runbook", 2, color=GOLD),
        toggle_block("How to read a bottleneck", [
            para([rt("A red row means leads reach that stage and do not leave it. Read the row below it too — if stage 4 is red and stage 5 has almost nobody in it, the problem is the VSL, not the closer.")]),
            para([rt("Conversion is measured over the cohort from " + CFG["cohort_start"] + " onwards", bold=True),
                  rt(", because the rows imported from before then came through a funnel with no VSL stages at all and would invent a permanent red at stages 4 and 6.")]),
        ]),
        toggle_block("Changing a KPI target", [
            para([rt("Edit "), rt("KPI Target %", code=True),
                  rt(" straight in the Funnel Health table. Health and Variance recalculate on the spot — nothing needs redeploying.")]),
            para([rt("To change the defaults a rebuild would restore, edit "), rt("journey.config.json", code=True),
                  rt(" in the project and run "), rt("python3 scripts/03_seed.py --reset-targets", code=True), rt(".")]),
        ]),
        toggle_block("What writes to this board", [
            bullet([rt("The website application", bold=True), rt(" → GHL workflow → 💰 Sales row at stage 3.")]),
            bullet([rt("The watch pages", bold=True), rt(" → open / play / watch-depth / completion → stages 4 and 6.")]),
            bullet([rt("The EOD report", bold=True), rt(" → Call EOD Reports row → stages 5 and 7, plus objection, ticket and next step.")]),
            bullet([rt("The closer's EOD report or your payment tool", bold=True), rt(" → stage 8, with tier and cash collected.")]),
            bullet([rt("GoHighLevel", bold=True), rt(" → a GHL to Notion pipeline sync (if you run one) → stages 8 and 9 as the client pipeline advances.")]),
            bullet([rt("The nightly recompute", bold=True), rt(" → re-derives every lead's stage from the evidence on their row and rewrites the funnel table.")]),
        ]),
        toggle_block("Why three stages are counted differently", [
            para([rt("Counting every stage the same way produced two lies, so each is counted from what can actually be observed:")]),
            bullet([rt("Stage 1", bold=True), rt(" — every row in 💰 Sales is already past the DM, so the CRM cannot supply the denominator. It comes from inbound + outbound on the setter EOD tab.")]),
            bullet([rt("Stages 4 and 6", bold=True), rt(" — a lead lifted past a VSL stage by a CRM stage change proves nothing was watched. These count sent vs actually played, so a funnel with no VSL reads no data rather than a false 100%.")]),
            bullet([rt("Stage 2", bold=True), rt(" — site sessions live in analytics, not the CRM. Type the number into Entered; the recompute leaves it alone and derives the rest from it.")]),
        ]),
        toggle_block("If a lead is on the wrong stage", [
            para([rt("Drag the card. The recompute only overrides a manual move when the evidence contradicts it — a signed contract beats a card parked on stage 5.")]),
            para([rt("If a closer's report did not move anyone, the email on the call block matched no row in 💰 Sales. The report still files; add the email to the lead and re-run "),
                  rt("/api?action=recompute", code=True), rt(".")]),
        ]),
        toggle_block("Endpoints", [
            code_block(
                f"{BASE}/eod                      the End of Day report\n"
                f"{BASE}/journey                  live funnel mirror\n"
                f"{BASE}/v/<slug>?c=<contact-id>  a tracked watch page\n\n"
                "POST /api?source=closer_eod      closer report  -> EOD rows + stage moves\n"
                "POST /api?source=setter_eod      setter report  -> Setter Daily Activity\n"
                "POST /api?source=vsl_event       watch-page beacon\n"
                "POST /api?source=ghl_stage       GHL stage change -> journey stage\n"
                "GET  /api?action=recompute&key=  rebuild Funnel Health (cron, nightly)\n"
                "GET  /api?action=health&key=     connectivity check", "plain text"),
        ]),
        divider(),
    ]

    # ---------------------------------------------------- GHL wiring
    out += [
        heading("Sending the assets — the GoHighLevel wiring", 2, color=GOLD),
        para([rt("The link is what makes stages 4 and 6 measurable, and it is a plain merge tag — no per-lead API call, no list to maintain. GoHighLevel substitutes the contact id, the watch page resolves it back to the lead, and the open, the play and the watch depth land on their row.")]),
        code_block("\n".join(f"{BASE}/v/{a['slug']}?c={{{{contact.id}}}}" for a in CFG.get("assets", [])), "plain text"),
        callout([rt("Two ready-made emails are built and waiting. ", bold=True),
                 rt("Brand-styled, table-based HTML that survives Outlook and the GHL builder: "),
                 rt("emails/01-initial-vsl.html", code=True), rt(" and "),
                 rt("emails/02-post-triage-pack.html", code=True),
                 rt(". Paste either into a GHL email template as raw HTML — the link and the first-name tag are already in them.")],
                icon="✉️", color=GOLD_BG),
        toggle_block("Wiring the Initial VSL send (stage 3 → 4)", [
            numbered([rt("Open the GHL workflow your application form already fires.")]),
            numbered([rt("After the existing thank-you email, add a "), rt("Wait", bold=True), rt(" step. An hour is enough; the application confirmation should land first.")]),
            numbered([rt("Add an "), rt("Email", bold=True), rt(" action. Paste "), rt("01-initial-vsl.html", code=True), rt(" into the template as raw HTML.")]),
            numbered([rt("Optional but worth it: add a "), rt("Webhook", bold=True), rt(" action straight after, POST to "),
                      rt(f"{BASE}/api?source=vsl_sent", code=True), rt(" with body "),
                      rt('{"slug":"initial-vsl","t":"c:{{contact.id}}"}', code=True), rt(".")]),
            para([rt("Why step 4 matters. ", bold=True),
                  rt("Without it the system marks the asset as sent the first time someone opens it — which makes the open rate read 100% forever. With it, sent and opened are two different numbers and the open rate becomes real.")]),
        ]),
        toggle_block("Wiring the post-triage pack (stage 5 → 6)", [
            numbered([rt("New workflow, trigger "), rt("Pipeline Stage Changed", bold=True), rt(" → Leads Pipeline → "), rt("Closing Call Booked", code=True), rt(".")]),
            numbered([rt("Email action with "), rt("02-post-triage-pack.html", code=True), rt(".")]),
            numbered([rt("Webhook to "), rt(f"{BASE}/api?source=vsl_sent", code=True), rt(" with "),
                      rt('{"slug":"post-triage-vsl","t":"c:{{contact.id}}"}', code=True), rt(".")]),
            para([rt("The closer filing a triage EOD with "), rt("Qualified — closing call booked", code=True),
                  rt(" is what moves the lead on this board; this workflow is what puts the pack in their inbox.")]),
        ]),
        toggle_block("Reflecting GHL stage changes immediately", [
            para([rt("The nightly recompute already re-derives every lead, so this is optional — it only buys you speed.")]),
            numbered([rt("Open (or create) a GHL workflow triggered by "), rt("Pipeline Stage Changed", bold=True), rt(" on your leads pipeline.")]),
            numbered([rt("Add a "), rt("Webhook", bold=True), rt(" action, POST to "),
                      rt(f"{BASE}/api?source=ghl_stage", code=True), rt(" with body "), rt('{"contact_id":"{{contact.id}}"}', code=True), rt(".")]),
            para([rt("Use the free "), rt("Webhook", code=True), rt(" action, not the premium "), rt("Custom Webhook", code=True),
                  rt(" — the latter bills per execution and this fires on every stage change.")]),
        ]),
        toggle_block("Putting the watch pages on the real domain (optional)", [
            para([rt("If you want the watch links to sit on your own domain, point a subdomain at Vercel:")]),
            numbered([rt("At your DNS provider, add a CNAME: "), rt("watch", code=True), rt(" → "), rt("cname.vercel-dns.com", code=True), rt(".")]),
            numbered([rt("In the Vercel project, Settings → Domains, add "), rt("watch.yourdomain.com", code=True), rt(".")]),
            numbered([rt("Set "), rt("PUBLIC_BASE_URL", code=True), rt(" to the new host and redeploy, then re-run "), rt("python3 scripts/03_seed.py", code=True), rt(" so the Watch page column updates.")]),
        ]),
    ]

    if BOARD:
        out += [divider(),
                callout([rt("The board is a tab on 💰 Sales. ", bold=True),
                         rt("🧭 Client Journey", link=BOARD),
                         rt(" — nine columns in order, cards showing email, phone, next action and the stalled flag.")],
                        icon="🧭", color=GOLD_BG)]
    return out
