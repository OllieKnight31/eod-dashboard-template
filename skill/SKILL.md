---
name: eod-dashboard
description: Sets up the open source EOD Dashboard Template (end of day reports, scorecard, reminders and digest for a setter, triage and closer sales team, on Vercel with Notion and Discord) for a user, step by step. Use when the user says "set up my EOD dashboard", "install the EOD template", "deploy the EOD reports", "end of day report system", "sales team EOD tracker", or asks to add a password to their EOD dashboard.
---

# EOD Dashboard setup

You are helping a user, who may not be technical, get their own copy of the EOD Dashboard Template running. Repo: https://github.com/OllieKnight31/eod-dashboard-template. The repo README is the reference; read it before you start.

Work one step at a time. Ask only for what the current step needs, explain each step in plain words, and confirm it worked before moving on. Never print a secret back to the user once they have given it to you, and never commit `.env` or `journey.state.json`.

## Step 0. Get the code and check it

1. If the user is not already inside a clone, clone the repo into a folder they choose and `cd` into it.
2. Run `npm test`. It needs only Node 18 or newer, no packages. If it fails, fix that before going on (usually an old Node version).

## Step 1. Ask about their business, then fill `journey.config.json`

Ask, in one short message:
- Business name, currency (USD, GBP, EUR...) and timezone.
- The team: names of each setter, triage rep and closer (one person can sit in more than one seat).
- The offers or packages a lead can buy, and the budget bands they use on triage calls.
- Where leads come from (Instagram DM, referral, paid ads...).
- What time the daily reminder and digest should go out (defaults: 20:00 and 21:00).
- Whether they use GoHighLevel and whether they want Discord posts.

Then edit `journey.config.json`: `business.*`, `eod.team`, `eod.pathways`, `eod.budget_bands`, `lead_sources`, `eod.timezone`, `eod.digest_hour`, `closers`. Keep every other key as it is unless they ask. Run `npm test` again afterwards.

## Step 2. Notion

1. Have them create an internal integration at notion.so/my-integrations and give you the token.
2. Have them create an empty page, share it with the integration (Share, Invite), and give you the page link. Take the 32 character id from the end of it.
3. Ask whether they already have a lead database. If yes, put its id in `notion.sales_db` and skip `00_sales.py`.
4. Run, with `NOTION_API_KEY` and `NOTION_PARENT_PAGE` exported in the same shell command (do not write them into any committed file):
   `python3 scripts/00_sales.py`, `01_sales.py`, `02_page.py`, `03_seed.py`, `05_sessions.py` (only if they want the website tracker), `06_eod.py`.
5. Confirm `journey.state.json` now holds ids. Never re-run `02_page.py` without warning them: it rebuilds that page.

## Step 3. Discord (skip if they said no)

Walk them through README section "Set up Discord": create the bot, invite it with View Channel, Send Messages, Embed Links and Read Message History, turn on Developer Mode, and copy the server and four channel ids into `eod.discord`, plus each rep's user id into `eod.team[].discord`. Keep the bot token for Step 4.

## Step 4. Deploy to Vercel

1. Check `vercel --version`; install with `npm i -g vercel` if missing. Have them log in (`vercel login`) themselves.
2. `vercel link` to create a project, then `vercel integration add upstash/upstash-kv` for settings storage.
3. Add environment variables with `vercel env add NAME production` (pipe the value in so it never lands in a file): `NOTION_API_KEY`, `DISCORD_BOT_TOKEN` (if Discord), `CRON_SECRET` and `SYNC_SECRET` (generate each with `openssl rand -hex 24`). Set `PUBLIC_BASE_URL` once you know the production address.
4. `vercel deploy --prod`. If they deploy from GitHub instead of the CLI, also add each id from `journey.state.json` as the matching `NOTION_*_DB` variable.
5. Set `PUBLIC_BASE_URL` to the production address if not done, redeploy, and open `/eod`, `/scorecard`, `/reports` and `/settings` to check they load.

## Step 5. Password (ask, never assume)

The app has NO login by default: anyone with the link can see every page, including `/settings`. Tell the user this plainly and ask if they want a password.

If yes:
1. Ask them to choose a setup code. Do not suggest or invent one, and never write it into any file in the repo.
2. `vercel env add ADMIN_PASSWORD production` with their value, then redeploy.
3. Have them open `/login`, enter the setup code, and create the owner login (name, email, password).
4. On `/settings`, Logins, they add a login per manager and rep.
5. Warn them: the setup code also encrypts saved settings, so they must not change or remove it later (or set `SETTINGS_SECRET` first).

## Step 6. Hand over

Tell them, briefly: their live address, the `/eod` link to send reps, that team, targets and times are editable on `/settings`, when the reminder and digest will fire, and whether a password is on. Offer the optional extras from the README (GoHighLevel pre-filled links and stage webhook, tracked video emails, website tracker) but do not set them up unless asked.

## Troubleshooting

- `/reports` or `/journey` error: `NOTION_API_KEY` missing or wrong, or the setup scripts were not run, or the deploy lacks `journey.state.json` (set the `NOTION_*_DB` variables).
- Settings will not save: Upstash is not connected (`KV_REST_API_URL` and `KV_REST_API_TOKEN` missing). Connect it in Vercel, Storage, and redeploy.
- "Saved settings could not be decrypted": the password or `SETTINGS_SECRET` changed after settings were saved. Put the old value back, or re-save the settings.
- No Discord posts: check the bot is in the server, has the four permissions in those channels, and the ids are right.
- Reminders not firing: the crons run hourly on production deployments only; check the timezone and hours on `/settings`.
