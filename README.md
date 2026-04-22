# fiskars-shopify-changelog-digest

Every weekday at ~09:00 Europe/Copenhagen, posts a digest of new [Shopify developer changelog](https://shopify.dev/changelog) entries to a Slack channel. If nothing's new, it still posts a tiny "Nothing new today" note so you know the bot ran.

Runs entirely on GitHub Actions — no server, no cron on your machine.

## How it works

1. `cron: "0 7 * * 1-5"` — GitHub triggers the workflow at 07:00 UTC Mon–Fri (≈09:00 CET / 08:00 CEST).
2. The workflow fetches `https://shopify.dev/changelog/feed.xml`.
3. Each entry's `guid` is diffed against `state/seen.json` (committed to the repo).
4. New entries → Slack Block Kit message. No new entries → "Nothing new today" context message.
5. Updated `state/seen.json` is committed back so tomorrow's run is a true delta.

## Setup (one-time)

### 1. Create the Slack incoming webhook

- Go to [https://api.slack.com/apps](https://api.slack.com/apps) → **Create New App** → _From scratch_.
- Name it e.g. `Shopify Changelog Digest`, pick your workspace.
- **Features → Incoming Webhooks** → activate.
- **Add New Webhook to Workspace** → pick the channel where the digest should post. Copy the webhook URL (starts with `https://hooks.slack.com/services/…`).

### 2. Push this repo to GitHub

From this directory:

```bash
git init
git add -A
git commit -m "chore: initial daily digest scaffold"
# Create the empty repo on GitHub first, then:
git remote add origin git@github.com:<your-org-or-user>/fiskars-shopify-changelog-digest.git
git branch -M main
git push -u origin main
```

### 3. Add the webhook as a repo secret

On GitHub: **Settings → Secrets and variables → Actions → New repository secret**:

- **Name**: `SLACK_WEBHOOK_URL`
- **Secret**: the webhook URL from step 1.

### 4. (Optional) Trigger the first run manually

- **Actions** tab → **Daily Shopify changelog digest** → **Run workflow**.

You should see a post in your Slack channel within a minute. The first run will find everything currently in the feed as "new", so expect a longish message on day one; from day two onwards it's a true delta.

## Running locally

```bash
npm install
npm run build
SLACK_WEBHOOK_URL=https://hooks.slack.com/services/... npm start
# or preview the payload without posting:
npm run dry-run
```

## Tuning

### Schedule

Edit `.github/workflows/daily-digest.yml`:

```yaml
- cron: "0 7 * * 1-5"   # 07:00 UTC Mon-Fri
- cron: "0 7 * * *"     # daily including weekends
- cron: "0 14 * * 1-5"  # 14:00 UTC (afternoon digest)
```

GitHub Actions cron is always UTC. [Crontab guru](https://crontab.guru) is handy for building expressions.

### Slack message format

Message layout is in `src/digest.ts`. The digest header, per-entry sections, and empty-day context message are all straightforward Slack Block Kit payloads — tweak to taste.

### First-run "flood" prevention

The very first run has an empty `state/seen.json`, so every entry the feed returns counts as "new". The feed currently carries ~1,800 entries (many years of history), so you almost certainly don't want to post all of those.

Slack's 50-block-per-message cap means only the 40 newest will actually appear, with an overflow footer ("…and N more") linking to the full changelog. It won't break, but it's a weird-looking first post.

**Recommended**: pre-seed the state locally before pushing, so day one posts "Nothing new today" (or only entries published since your bootstrap):

```bash
# Before pushing to GitHub:
npm install
npm run build
node dist/digest.js --mark-seen-only
git add state/seen.json
git commit -m "chore: bootstrap seen state"
```

That marks every currently-in-feed entry as seen without posting. Tomorrow morning at 09:00 the first real digest runs and will only contain entries published after your bootstrap.

## Files

```
.github/workflows/daily-digest.yml   # scheduled workflow
src/digest.ts                         # fetch → diff → post → persist
state/seen.json                       # entry IDs already posted (source of truth)
```
