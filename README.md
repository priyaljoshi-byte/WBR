# ShopOS Pulse

A dashboard that is already correct when you open it.

Every department's numbers get read automatically before the meeting. The rings
show health. Flags name the person whose number is missing. The meeting
transcript feeds back in, so the decision log carries forward week over week
instead of starting fresh every Monday.

Nobody updates a deck.

---

## The one idea to understand

Everything on this dashboard is one piece of arithmetic:

```
ring = raw  ÷  denominator  ×  100
```

Four of five channels live is a ring at 80. Forty-six of two hundred target
accounts is a ring at 23. ₹1.32 Cr of a ₹4.47 Cr pipeline is a ring at 30.

That is the whole normalization rule. It is why every ring on every card is
comparable even though the underlying numbers are counts, rupees and people.
Each ring carries its own denominator in the caption underneath, so you never
have to guess what the 80 was out of.

**Ring colour is positional, not a health signal.** Outer ring is always red,
middle is always lime, inner is always cyan. That way your eye can compare the
same slot across cards. Health shows up as a flag and a border, which is what
you actually scan for.

---

## The four moving parts

Each one is swappable without touching the others.

**1. Connectors — where the raw data lives**
A department head points Pulse at a Google Sheet or a Notion database. Pulse
stores the link, never the data, and never a password. Each connector knows how
to fetch rows and nothing else.

**2. Metric definitions — what number we are reading**
A metric is a recipe: which source, which column, how to roll it up, what it is
a fraction of, what the target is, and which direction is good. Department heads
pick from a catalogue you control, so two teams cannot quietly define "qualified
lead" two different ways.

**3. The run — go read everything**
A scheduled job fires fourteen hours before the meeting. It pulls every source,
computes every metric, compares against last week, and **saves the result as a
snapshot**.

**4. The read — the dashboard**
Rendered from snapshots. Instant, because the work already happened.

---

## Why snapshots matter more than they sound

A snapshot is frozen. Nothing ever rewrites one.

This means last week's number cannot silently change when someone edits a
spreadsheet row. "What did we say pipeline was on 7 September" has an answer a
year later. And a correction is a new run, not an edit, so the trail survives.

Most dashboards recompute live and quietly lose their own history. This one
does not.

---

## How the meeting makes it smarter

This is the part that compounds.

After each meeting the transcript goes in, and five things come out:

**Decisions, with continuity.** Not a summary. The log compares what was decided
this week against what was already on the books, and marks each one NEW,
CONFIRMED, CHANGED, REVERSED, COMPLETED, PARTIAL, BLOCKED, DEFERRED, DROPPED or
OPEN. A changed or reversed decision has to say why — the database rejects it
otherwise.

**The note under each card.** The engine knows a number moved. Only the room
knows why. "The drop is at checkout, not at the top" comes from the meeting.

**Stated versus measured.** When someone says a number out loud, Pulse catches
it and compares it to what the data actually said. A gap raises a flag with the
verbatim quote. This is the one that earns its keep: it catches the week the
team's story starts drifting from the numbers.

**Decisions linked to rings.** Every decision points at the metrics that would
prove it worked. Next week the dashboard can tell you whether it did.

**Blind spots.** Decisions nobody is measuring. Numbers nobody is acting on.
Both lists tend to grow quietly, and both are worth seeing.

So the system is richer in week six than week one: decision history accumulates,
decision-to-metric links accumulate, and you build a track record of which
sources tell the truth.

---

## Flags raise themselves

The "Still need from Sai" section stops being something you write by hand.

| What happened | What Pulse does |
|---|---|
| A source has not synced since before this period | Marks the metric stale, flags the department owner |
| A source errored or returned nothing | Marks it missing, flags it with the actual error |
| A metric is below its critical threshold | Flags it off-target |
| A metric is below warning **and falling** | Flags it. Below warning but improving stays quiet — that is noise |
| A commitment has no owner or no date | Flags `[OWNER NEEDED]` / `[DATE NEEDED]` |
| A decision has no metric linked | Flags it as unproveable |
| A decision's due date passed with no evidence | Flips it to BLOCKED |
| Someone stated a number that does not match the data | Flags the contradiction, with the quote |

Flag ids are stable across runs, so a flag that persists for two weeks is
recognisably the same flag rather than a fresh one each Monday.

---

## Who can change what

Enforced in the database, not in the browser.

- **viewer** — any signed-in `@shopos.ai` account. Reads everything.
- **owner** — a department head. Writes their own department's sources, metrics,
  cards and manual values. Cannot touch another department's.
- **admin** — founder's office. Writes anything, publishes runs, edits decisions.

Nobody, including admins, can hand-edit a past snapshot.

Sign-in reuses the Google login already running in `shopos-org-KPIs`, and
department ids are the same twelve from the org chart, so Pulse, the org chart
and the battle cards never drift apart.

---

## Adding things

Adding a department, a metric, a card or a data source is a row in a table.
Never a code change. That rule is the entire reason this scales without an
engineer in the loop.

```
config/org.json       pillars, departments, sections, owners, meeting cadence
config/catalog.json   the metric library and the cards built from it
config/sources.json   which sheet or database each department uses
.env                  every actual credential. Nothing in config/ is a secret.
```

Those JSON files are the seed. Once the app is deployed the same rows live in
Supabase and department heads edit them through the UI.

---

## Layout

```
config/       departments, metric catalogue, sources
connectors/   gsheet, notion, postgres, manual - all return the same shape
engine/       normalize, health, flags, snapshots. Pure arithmetic, no network.
transcript/   extraction spec, decision continuity, stated-vs-measured
render/       ring cards, flag cards, decision log, full dashboard
supabase/     schema and row-level security
bin/          the CLI
data/         snapshots and decisions when running without Supabase
```

`engine/types.js` is the contract. Every module speaks those shapes and nothing
else. That boundary is why a new data source is one file here and no changes
anywhere else.

---

## Running it

```bash
cp .env.example .env     # fill in credentials
npm test                 # the arithmetic is tested, including every reference ring value
npm run pulse:dry        # run a period without writing anything
npm run pulse            # run and publish
npm run meeting -- path/to/transcript.md
```

---

## Status

Engine, renderer, connectors, transcript layer and schema are built. Not yet
connected to live sources — `config/sources.json` still holds placeholder ids,
and the sample render in `out/` uses fixture numbers from an old September
review purely to prove the format. Nothing in it is a current reading.
