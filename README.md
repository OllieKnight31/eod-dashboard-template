# EOD Dashboard Template

A free, open source end of day (EOD) reporting system for a sales team with **setters**, **triage reps** and **closers**. Your team files a short report after every call and signs off at the end of each day. You get a live dashboard, a scorecard against daily targets, automatic Discord reminders and a nightly digest. There is also an optional client journey tracker that shows where every lead sits in your funnel.

It runs as one small app on Vercel (free plan is fine), stores reports in Notion, and posts to Discord.

**No login by default.** Out of the box anyone with the link can use it. If you want a password, set one environment variable (see [Adding a password](#adding-a-password-optional)).

Everything about your business (name, team, offers, Notion and Discord ids) lives in one file, `journey.config.json`, or in environment variables. You never need to edit the code.

## What you get

| Page | What it is |
|---|---|
| `/eod` | The report form. Three seats: setter, triage, closer. **Log a call** files one report per lead straight after the call. **End of day sign-off** files the day's numbers, wins and blockers. Call counts on the sign-off come from the reports already filed, so nothing is typed twice. |
| `/reports` | The EOD dashboard: what was filed, by whom, the call funnel, and who is late. |
| `/scorecard` | Everyone against their daily targets, by period, seat and person. Team totals, one card per person, change against the previous period, and On target / Below / Critical labels. |
| `/settings` | The team for each seat (with Discord ids), daily targets, reminder and digest times, and logins if you turned them on. Changes go live within 30 seconds, no redeploy. |
| `/journey` | Optional. A nine stage client journey funnel with conversion against target at every stage. |
| `/v/<slug>?c=<contact id>` | Optional. A tracked video watch page you send to leads. Opens, plays, watch depth and completion land on the lead's record. |
| `/t.js` | Optional. A website tracker: one row per visit and how far the visitor got through your application form. |
| `/login` | Only used if you add a password. |

### What filing a report does

Every call report is tied to one lead in your Notion **Sales** database (picked by live search, opened from a pre-filled link, or typed in as a new lead). Filing it:

1. Writes a row to **Call EOD Reports**.
2. Updates the lead: next call date and type, triage outcome, tier, budget, deal size, cash collected, loss reason.
3. Moves the lead along the journey board and sets its CRM `Stage`.
4. Posts a card to Discord: setter reports to the setter channel, triage and closing reports to the closer channel.

| Report and outcome | CRM stage written |
|---|---|
| Setter: triage call booked | Triage Call Booked |
| Setter: not interested / not qualified | Lost / Rejected |
| Triage: closing call booked | Closing Call Booked |
| Triage: follow-up / no-show | Follow-Up / No-Show |
| Closer: won with cash | Closed |
| Closer: won, no cash yet | Awaiting Payment |
| Closer: lost | Lost |

### The daily rhythm

- **Reminder** (default 20:00, Monday to Friday): pings anyone in Discord who has filed nothing, and asks anyone with calls logged to sign off.
- **Digest** (default 21:00): posts each rep's totals, a status dot, "n of m on target", and who has not reported.
- **Recompute**: rebuilds the journey funnel table in Notion once a day.
- **Collection reminders**: a won deal with a collection date tags the closer three, two and one day before.

`vercel.json` holds one cron per hour. Each job only acts in its own local hour, so reminder times and timezone are ordinary settings and it all works on the free Vercel Hobby plan.

## What you need

- A free [Vercel](https://vercel.com) account
- A [Notion](https://notion.so) workspace
- A [Discord](https://discord.com) server (optional: leave the channel ids blank and reports still save to Notion)
- [Node.js](https://nodejs.org) 18 or newer and Python 3 on your computer, for the one-off setup
- GoHighLevel is optional

## Setup, step by step

### 1. Get the code

```bash
git clone https://github.com/OllieKnight31/eod-dashboard-template.git
cd eod-dashboard-template
npm test        # quick offline check that everything works
```

There are no packages to install: the app uses only what comes with Node.

### 2. Fill in your details

Open `journey.config.json` and change at least:

- `business.name` (shown on every page), `business.currency` (for example `USD`, `GBP`, `EUR`) and `business.locale` (for example `en-US`, `en-GB`).
- `eod.team`: one entry per person per seat (`setter`, `triage`, `closer`). You can change the team later on `/settings`.
- `eod.pathways` (the offers a lead can buy), `eod.budget_bands`, `lead_sources`.
- `eod.timezone` and `eod.digest_hour`.

The full list of keys is under [Everything you can customise](#everything-you-can-customise).

### 3. Set up Notion

1. Go to notion.so/my-integrations, create an internal integration and copy its token.
2. Create an empty Notion page (for example "Sales System"), click **Share**, **Invite**, and pick your integration.
3. Copy the page id from the page's URL (the 32 characters at the end).
4. Run the setup scripts in order. They build every database for you:

```bash
export NOTION_API_KEY=your_notion_token
export NOTION_PARENT_PAGE=your_page_id
export PUBLIC_BASE_URL=https://your-eod-app.example.com   # your Vercel address, once you have it

python3 scripts/00_sales.py      # creates the Sales database (skip if you have one; put its id in notion.sales_db)
python3 scripts/01_sales.py      # adds the journey columns to Sales
python3 scripts/02_page.py       # builds the Client Journey page and its databases
python3 scripts/03_seed.py       # adds the stage rows and the video rows
python3 scripts/05_sessions.py   # creates Site Sessions (only if you use the website tracker)
python3 scripts/06_eod.py        # creates the EOD report databases and the EOD Reports page
```

The scripts save the ids they create into `journey.state.json`. Every script is safe to run again except `02_page.py`, which rebuilds its page.

Optional: `scripts/config_views.js` and `scripts/make_board_view.js` tidy up the Notion views by driving a logged-in Chrome tab. Skip them if you are happy to arrange the views by hand.

### 4. Set up Discord (optional)

1. Go to discord.com/developers, **New Application**, **Bot**, **Reset Token**, and copy the token.
2. Under **OAuth2**, **URL Generator**: tick scope `bot` and permissions View Channel, Send Messages, Embed Links, Read Message History. Open the link and add the bot to your server.
3. Create or pick four channels: setter EOD, closer EOD, daily standup, logs.
4. Turn on Developer Mode (User Settings, Advanced). Right click each channel and the server, **Copy ID**, and paste them into `eod.discord` in `journey.config.json`. Add each rep's Discord user id to `eod.team` (or later on `/settings`) so reminders can @mention them.

### 5. Deploy to Vercel

```bash
npm i -g vercel
vercel link                                   # create a new project
vercel integration add upstash/upstash-kv     # free storage for your settings
```

Then add your environment variables in Vercel (**Settings**, **Environment Variables**). The full list with notes is in `.env.example`.

| Variable | Needed? | What it is |
|---|---|---|
| `NOTION_API_KEY` | Yes | Your Notion integration token |
| `PUBLIC_BASE_URL` | Yes | Your app's address, for example `https://your-eod-app.example.com` |
| `KV_REST_API_URL`, `KV_REST_API_TOKEN` | Yes | Added for you by the Upstash integration. Without them `/settings` cannot save. |
| `DISCORD_BOT_TOKEN` | For Discord | Your Discord bot token |
| `CRON_SECRET` | Recommended | Any long random string. Protects the scheduled jobs. |
| `SYNC_SECRET` | Optional | Any long random string. Lets scripts and tests call the API. |
| `BUSINESS_NAME` | Optional | Overrides `business.name` |
| `ADMIN_PASSWORD` | Optional | Turns logins on. See below. |
| `GHL_TOKEN` | Optional | GoHighLevel token for payment collection tasks |

Make a random string with `openssl rand -hex 24`.

Deploy:

```bash
vercel deploy --prod
```

The Vercel CLI uploads `journey.state.json` for you. If you deploy from GitHub instead, that file is not in the repo, so copy each id from it into the matching `NOTION_*_DB` variable.

### 6. Start using it

1. Open your app's address. With no password set you go straight in.
2. Open `/settings` and check the team, targets, reminder and digest times.
3. Send your reps the `/eod` link.

## Adding a password (optional)

By default the app has **no login**: anyone who has the link can open every page, including `/settings`. That is fine for a small trusted team, but anyone you share the link with can see your numbers.

To lock it:

1. In Vercel, add an environment variable `ADMIN_PASSWORD` (or `ACCESS_PASSWORD`) and give it any value you like. This is your **setup code**.
2. Make sure Upstash storage is connected (step 5), then redeploy.
3. Open `/login`. The first visit asks for the setup code, then your name, email and a password. That makes you the **owner**.
4. On `/settings`, under **Logins**, add a login for each manager and rep.

With logins on, the roles are:

| Role | Sees | Cannot |
|---|---|---|
| Owner (one) | Everything, including `/settings` and logins | |
| Manager | Reports, everyone's scorecard, client journey, every seat on the report | Settings, logins |
| Setter / Triage / Closer | Their own report in their own name, their own scorecard | Anyone else's numbers, any dashboard |

The server enforces every rule, not just the pages. Things to know:

- The setup code also encrypts your saved settings. Once logins exist, do not change or remove it, or set a separate `SETTINGS_SECRET` first.
- Lost the owner password? Go to `/login` and use the setup code again to reset the owner.
- To turn logins off again, remove the variable and redeploy. Settings saved while it was set were encrypted with it, so they fall back to the defaults in `journey.config.json` until you save them again.

No password is ever stored in the code or the docs. You choose it.

## Run it on your computer

```bash
cp .env.example .env            # fill in at least NOTION_API_KEY for real data
set -a && source .env && set +a
npm run dev                     # http://localhost:3237
```

Locally, settings (and logins, if on) are kept in a `.data/` folder instead of Upstash. The pages that read Notion (`/reports`, `/journey`, scorecard data) need a real `NOTION_API_KEY` and the setup scripts run first. The report form, settings and watch pages work without.

Tests:

```bash
npm test                                          # offline: syntax check plus open and password modes
node scripts/e2e_eod.js && node scripts/e2e_eod.js --cleanup   # live, against a deployment
node scripts/e2e.js && node scripts/e2e.js --cleanup
```

The live tests need `SYNC_SECRET` and `PUBLIC_BASE_URL`; they create a test lead and clean it up afterwards.

## GoHighLevel (optional)

- **Pre-filled report links.** `/eod?report=triage&c={{contact.id}}` opens the form already on that lead. Put it in a GHL workflow that fires when the calendar event ends. Also `?e=<base64url email>`, `?l=<notion page id>`, `?rep=Name`, `?mode=signoff`.
- **Stage changes.** A workflow on Pipeline Stage Changed with a Webhook action: POST `https://your-eod-app.example.com/api?source=ghl_stage`, body `{"contact_id":"{{contact.id}}"}`.
- **Watch page emails.** `python3 emails/_build.py` writes two emails with tracked links (change `SENDER` at the top first). Paste them into GHL email templates as raw HTML. Add a Webhook after each send: POST `/api?source=vsl_sent` with `{"slug":"initial-vsl","t":"c:{{contact.id}}"}`.
- **Website tracker.** Add `<script src="https://your-eod-app.example.com/t.js" defer></script>` to your site.
- **Outside forms.** Set `INBOUND_KEY` and a form can file reports with `Authorization: Bearer <that key>`.

## Everything you can customise

| Key in `journey.config.json` | What it controls |
|---|---|
| `business.name` | Name on every page, watch pages and emails (env `BUSINESS_NAME` wins) |
| `business.website`, `business.tagline` | Masthead link and tagline on watch pages |
| `business.currency`, `business.locale` | Money and date formatting everywhere |
| `business.logo_url`, `footer_logo_url`, `favicon_url`, `cover_url`, `og_image_url` | Optional images. Blank shows the name as a text logo |
| `public_base` | Your app's address, used in links (env `PUBLIC_BASE_URL` wins) |
| `notion.parent_page`, `notion.sales_db` | Where the setup scripts build, and your lead database |
| `ghl.location`, `ghl.leads_pipeline`, `ghl.members_pipeline` | Optional GoHighLevel ids |
| `eod.team` | Who sits in each seat, their Discord id, and nicknames (`aka`) |
| `eod.discord.*` | Server and channel ids for setter EOD, closer EOD, digest, logs |
| `eod.roles` | Optional Discord role ids |
| `eod.timezone`, `eod.digest_hour` | Local time for the reminder, digest and recompute |
| `eod.pathways` | Offers or packages on the triage and closing reports |
| `eod.budget_bands` | Budget choices on the triage report |
| `lead_sources` | Source choices on the reports and in Notion |
| `stages`, `exits` | The nine journey stages, their targets, and which CRM stages map to each |
| `stage_floor`, `exit_stages` | CRM stage name to the lowest journey stage it implies, or to an exit |
| `assets` | Watch pages (slug, title, blurb, video URL) |
| `closers` | Default closer names |
| `site_pages` | Website paths the tracker names |
| `booking_url`, `closing_booking_url` | Booking buttons on watch pages |
| `cohort_start`, `import_dates`, `stall_days`, `session_min_sample` | Funnel maths |

Colours: the colour variables sit at the top of each file in `public/` (`:root`) and in `lib/brand.js`. The default is a neutral black and white.

Daily targets and reminder times are easiest to set on `/settings`. They can also be set as environment variables (`KPI_*`, `NUDGE_*`, `SCORECARD_*`, `REMINDERS`, `TIMEZONE`, `ROSTER_JSON`).

The collection reminder crons in `vercel.json` (08:00 and 09:00 UTC) suit a 09:00 send in UK time. Move them for other timezones.

## How it is built

```
journey.config.json     the one config: business, team, offers, stages, Notion and Discord ids
journey.state.json      written by the setup scripts: Notion ids (gitignored)
api/index.js            every endpoint, one Vercel function
lib/eod.js              reports and sign-offs: rows, lead updates, CRM stage, journey move
lib/discord.js          Discord posts and cards
lib/scorecard.js        scorecard data, target scoring, the missed-report reminder
lib/digest.js           the hourly scheduler: reminder, digest, recompute
lib/reminders.js        payment collection reminders
lib/reports.js          /reports
lib/journey.js          stage logic, funnel maths, the recompute
lib/dashboard.js        /journey
lib/watch.js            watch pages and their tracking
lib/site.js             website sessions from t.js
lib/auth.js             optional logins, sessions, role rules
lib/live.js             team, targets and schedule in force (config defaults plus /settings)
lib/store.js            storage for settings and logins (Upstash; .data/ locally)
lib/notion.js           Notion client
lib/brand.js            look and feel for the server pages
public/                 eod-report, scorecard, settings, login pages, auth.js, brand.js, t.js
emails/                 two GHL emails carrying tracked watch links
scripts/                Notion setup (00 to 06), tests, local preview
skill/                  Claude Code skill that walks you through setup
```

A lead's journey stage is worked out from the evidence on their row (application date, video viewed, triage date, closing date, payment), never just trusted from a column. A CRM stage can push a lead forward but never back, so the board repairs itself after a bad import.

### Endpoints

| Call | Access (when logins are on) |
|---|---|
| `POST /api?source=call_report`, `signoff` | signed in (reps: own seat, own name) |
| `GET /api?action=board`, `leads`, `lead`, `scorecard_data` | signed in (reps get only their own) |
| `GET /api?action=settings`, `users`; `POST source=settings`, `user_save`, `user_delete` | owner |
| `GET /api?action=config` | open: brand; plus team and lists when signed in |
| `GET /api?action=cron`, `nudge`, `reminders` | `CRON_SECRET`, or Vercel's cron caller when `CRON_SECRET` is blank |
| `GET /api?action=nightly`, `recompute`, `health` | `&key=$SYNC_SECRET` or `CRON_SECRET` |
| `POST /api?source=vsl_event`, `vsl_sent`, `ghl_stage` | open (webhooks and watch pages) |
| `POST /api?source=site_view`, `form_step` | open, CORS (t.js) |

With logins off, every "signed in" and "owner" row above is open to anyone with the link. Webhook paths always return 200, because an error makes GHL retry forever.

## Using it with Claude Code

This repo includes a Claude Code skill that walks you through setup step by step:

```bash
./install.sh
```

Then in Claude Code, say "set up my EOD dashboard".

## Licence

MIT. See [LICENSE](LICENSE).
