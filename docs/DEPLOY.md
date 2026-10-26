# Putting the dashboards online

Two pieces, independent of each other:

1. **A schedule** that runs the numbers the evening before each meeting —
   GitHub Actions.
2. **A host** that serves the result behind a password — Vercel.

About an hour end to end, most of it waiting for DNS.

---

## Read this first

The rendered dashboards are **plain HTML with no login of their own**. They
carry pipeline, revenue and hiring data. Anyone who has the URL can read them,
and a public URL gets found — search engines, link previews in Slack, a
forwarded message.

So the password gate is not optional polish. Do not publish without step 7.

**What a shared password does and does not give you.** It keeps strangers out.
It does not tell you who looked, and it cannot be revoked for one person — if
someone leaves, you change it for everyone or not at all. That is an accepted
trade for now. Revisit it once real revenue numbers are flowing; the upgrade is
Cloudflare Access, which checks Google Workspace identity properly and takes
about thirty minutes.

---

## Step 1 — Make it a git repository

```bash
cd ~/workspace/shopos-pulse
git init
git add .
git commit -m "ShopOS Pulse"
```

`.gitignore` already excludes `.env`. Confirm before you push:

```bash
git ls-files | grep -c "^\.env$"
```

Must print `0`. If it prints `1`, stop and remove it — a committed key stays in
the history even after you delete the file.

---

## Step 2 — Push to a PRIVATE GitHub repo

On github.com: **New repository** → name it `shopos-pulse` → **Private**.

Private matters. The config files name people, departments and targets.

```bash
git remote add origin https://github.com/<your-org>/shopos-pulse.git
git branch -M main
git push -u origin main
```

---

## Step 3 — Add the credentials as GitHub secrets

**Settings → Secrets and variables → Actions → New repository secret.**

| Name | Where it comes from |
|---|---|
| `GOOGLE_SA_EMAIL` | The service account address, from `.env` |
| `GOOGLE_SA_PRIVATE_KEY` | The private key, from `.env`. Paste it whole, including the `BEGIN`/`END` lines |
| `NOTION_API_KEY` | Only if a Notion source is connected |
| `SLOOSH_DB_URL_REST_URL` | Only if the Sloosh database is connected |
| `SLOOSH_DB_URL_REST_KEY` | Same |

Secrets are write-only. Nobody can read them back, including you — if you lose
one, you replace it rather than look it up.

---

## Step 4 — Check the schedule

`.github/workflows/pulse.yml` runs at **14:30 UTC on Sunday through Wednesday**,
which is 20:00 IST — the evening before each meeting.

If your meeting times are not 10:00 IST, adjust the cron line. GitHub cron is
always UTC, and IST is UTC+5:30, so:

```
desired IST time  -  5h30m  =  the UTC time to write
```

The job rebuilds **all four** dashboards each night rather than one. Renders are
deterministic and cheap, and a day-to-meeting mapping is one off-by-one away
from a room opening an empty page on a Monday morning.

---

## Step 5 — Run it once by hand

**Actions → Build the week's dashboards → Run workflow.**

Watch it. Expect it to work even with nothing connected — every metric comes
back `missing`, every card carries a flag, and that is the correct output. A
build that publishes nothing because a source was down is worse than one that
publishes a hole, because then the room has neither the number nor the warning.

The last step prints the fill-in list, so the run log doubles as the setup
checklist.

---

## Step 6 — Connect Vercel

1. <https://vercel.com> → sign in with GitHub.
2. **Add New → Project** → import `shopos-pulse`.
3. Framework preset: **Other**.
4. Build command: **leave empty**. Output directory: **`site`**.

   Not `out`. `site/` is the packaged folder holding the dashboards *and* the
   intake screens *and* the config they read. Point a host at `out/` and every
   intake page 404s, because the app imports from `engine/` and fetches
   `config/*.json`, neither of which lives under `out/`.
5. Deploy.

There is no build step. GitHub Actions already produced the HTML, packaged
`site/` and committed it; Vercel only serves the folder.

`bin/build-site.js` copies an **allowlist** - the dashboards, the app, the two
engine modules the app imports, and the config JSON. Nothing else moves, so
`.env`, `data/` and the CLI cannot reach a public URL by being forgotten. It
also reads every file first and refuses to write `site/` at all if anything
looks like a credential.

---

## Step 7 — Turn the password on, before sharing the URL

**Project → Settings → Deployment Protection → Password Protection.**

Set a password. Apply it to **all deployments**, not just previews — the default
on some plans protects previews only, which leaves production wide open.

This is a paid feature on Vercel. Check the current plan requirement on their
pricing page; if the cost is not worth it, Cloudflare Access is free and
stronger, and you can put it in front of the same Vercel site.

**Then verify it actually works.** Open the production URL in a private browsing
window. You must get a password prompt. If you see a dashboard, the protection
is not on, and you should assume the URL has already been crawled.

---

## Step 8 — Share it

Send the URL and the password to the four teams, in separate messages. Put the
URL in the calendar invite for each meeting so it is where people look.

---

## From then on

Nothing. The job runs each evening, commits the HTML, Vercel redeploys within a
minute or so. If a source breaks, the dashboard still appears with a flag on it
naming whoever owns that number.

To rebuild a past week by hand:

**Actions → Run workflow →** enter any date inside that week.

---

## When something looks wrong

| What you see | What it means |
|---|---|
| Workflow red, no dashboard | Check the Actions log. Usually a missing or mistyped secret. |
| Dashboard builds, every card flagged | Sources are not connected yet. Expected until step 4 of the main setup. |
| "not shared with the Pulse service account" | Share that sheet with `GOOGLE_SA_EMAIL` as a Viewer. |
| A number looks wrong | Check the dashboard footer. Unreadable rows and date problems are listed there, not hidden. |
| Dashboard did not update | Check Vercel deployed the latest commit. The Actions log says whether it pushed anything. |
| No password prompt | Step 7 is not applied to production. Treat the URL as public until fixed. |

---

## A note on what gets committed

The workflow commits `out/`, `site/` and `data/snapshots/` back to the repo. That is
deliberate: snapshots are the history, and keeping them in git means a past week
renders identically forever and you can see exactly when a number changed.

It never commits `.env`, and no credential appears in any published file.
