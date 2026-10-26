/**
 * The stylesheet, as a string. One source of truth - dashboard.js inlines
 * DASHBOARD_CSS and decisions.js inlines PRINT_CSS, so the output stays a
 * single file with no external <link> and nothing to 404.
 *
 * DASHBOARD_CSS is lifted from the reference documents (shopos-wbr-rings /
 * update-for-binny) unchanged except for the blocks marked PULSE ADDITIONS at
 * the bottom, which cover markup the reference did not have: the health badge,
 * the flagged ring card, and the decision ledger.
 */

export const DASHBOARD_CSS = `
:root{
  --bg:#070707; --line:#242424; --line-soft:#1b1b1b;
  --fg:#f5f5f5; --fg-2:#9b9b9b; --fg-3:#6a6a6a;
  --red:#ff375f; --lime:#c6f432; --cyan:#3ddbff;
  --amber:#ffb454;
  --font:"SF Pro Display","SF Pro","Inter",-apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif;
  --mono:"SF Mono",ui-monospace,"JetBrains Mono",Menlo,monospace;
  --nav:62px;
}
*{box-sizing:border-box}
html{color-scheme:dark;scroll-behavior:smooth}
body{margin:0;background:
   radial-gradient(1100px 620px at 12% -8%, #17171a 0%, transparent 62%),
   radial-gradient(900px 560px at 92% 4%, #14161a 0%, transparent 58%), var(--bg);
  color:var(--fg);font-family:var(--font);-webkit-font-smoothing:antialiased;padding:0 26px 100px}
.wrap{max-width:1180px;margin:0 auto}
h1,h2,h3{margin:0;letter-spacing:-.022em;font-weight:600}
section[id]{scroll-margin-top:calc(var(--nav) + 18px)}
svg.defs{position:absolute;width:0;height:0;overflow:hidden}

/* ---------- nav ---------- */
.nav{position:sticky;top:0;z-index:50;height:var(--nav);margin:0 -26px 30px;padding:0 26px;
  display:flex;align-items:center;gap:22px;
  background:rgba(7,7,7,.76);backdrop-filter:saturate(1.5) blur(16px);
  border-bottom:1px solid var(--line-soft)}
.nav .brand{display:flex;align-items:center;gap:10px;font-size:14px;font-weight:650;letter-spacing:-.015em}
.nav .dot3{display:flex;gap:3px}
.nav .dot3 i{width:7px;height:7px;border-radius:50%}
.nav ul{display:flex;gap:4px;list-style:none;margin:0;padding:0;overflow-x:auto;scrollbar-width:none}
.nav ul::-webkit-scrollbar{display:none}
.nav a{display:block;padding:7px 13px;border-radius:999px;text-decoration:none;white-space:nowrap;
  font-size:13px;color:var(--fg-2);transition:background .15s,color .15s}
.nav a:hover{background:#1c1c1c;color:var(--fg)}
.nav a[aria-current="true"]{background:#232323;color:var(--fg)}
.nav .when{margin-left:auto;font-family:var(--mono);font-size:11.5px;color:var(--fg-3);white-space:nowrap}

.mast{display:flex;align-items:baseline;justify-content:space-between;gap:20px;flex-wrap:wrap;margin:8px 0 34px}
.mast h1{font-size:22px} .mast h1 span{color:var(--fg-3);font-weight:450}
.mast p{margin:10px 0 0;font-size:14px;color:var(--fg-2);max-width:640px;line-height:1.55}
.mast p b{color:var(--fg);font-weight:650}

.sechead{display:flex;align-items:baseline;gap:14px;flex-wrap:wrap;margin:58px 0 20px}
.sechead h2{font-size:17px} .sechead p{margin:0;font-size:13.5px;color:var(--fg-3)}
.lvln{font-family:var(--mono);color:var(--fg-3);font-size:13px;font-weight:500;margin-right:10px}

/* ---------- ring cards ---------- */
.rings{display:grid;grid-template-columns:repeat(2,1fr);gap:16px}
.ring-card{border-radius:22px;padding:22px 24px 20px;
  background:linear-gradient(180deg,#171717 0%,#101010 100%);border:1px solid var(--line);
  box-shadow:0 1px 0 rgba(255,255,255,.045) inset, 0 22px 50px -26px rgba(0,0,0,.95)}
.ring-card header{display:flex;align-items:baseline;justify-content:space-between;gap:14px;margin-bottom:6px}
.ring-card h3{font-size:12.5px;text-transform:uppercase;letter-spacing:.11em;font-weight:650}
.ring-card header span{font-family:var(--mono);font-size:11.5px;color:var(--fg-3)}
.body{display:flex;align-items:center;gap:22px;padding:14px 0 18px}
.ar{flex:0 0 auto}
.ar .fill{transition:stroke-dasharray 1.25s cubic-bezier(.22,1,.3,1)}
.legend{flex:1 1 auto;min-width:0;display:flex;flex-direction:column;gap:14px}
.lg{display:grid;grid-template-columns:auto 1fr auto;align-items:center;gap:11px;row-gap:2px}
.lg i{width:11px;height:11px;border-radius:50%;grid-row:span 2}
.lg .lb{font-size:11.5px;letter-spacing:.09em;text-transform:uppercase;color:var(--fg-2);font-weight:600}
.lg .vl{font-size:21px;font-weight:650;letter-spacing:-.03em;text-align:right;font-variant-numeric:tabular-nums}
.lg .vl em{font-style:normal;font-size:12px;font-weight:450;color:var(--fg-3);margin-left:3px}
.lg .st{grid-column:2 / span 2;font-size:12px;text-align:right;opacity:.92}
.tiles{display:grid;grid-template-columns:repeat(3,1fr);gap:9px;padding-top:16px;border-top:1px solid var(--line-soft)}
.tile{background:#161616;border:1px solid var(--line-soft);border-radius:13px;padding:12px 13px}
.tl{margin:0;font-size:10px;letter-spacing:.12em;color:var(--fg-3);font-weight:600}
.tv{margin:6px 0 2px;font-size:20px;font-weight:650;letter-spacing:-.03em;font-variant-numeric:tabular-nums}
.tu{margin:0;font-size:10px;letter-spacing:.1em;color:var(--fg-3)}
.note{margin:16px 0 0;font-size:13px;line-height:1.55;color:var(--fg-2)}

/* ---------- call cards ---------- */
.grid{display:grid;grid-template-columns:repeat(3,1fr);gap:14px}
.card{border-radius:20px;padding:22px 22px 20px;border:1px solid var(--line);
  background:linear-gradient(180deg,#151515,#0f0f0f);box-shadow:0 1px 0 rgba(255,255,255,.035) inset}
.card h3{font-size:14.5px;margin-bottom:9px}
.card p{margin:0;font-size:13.5px;line-height:1.6;color:var(--fg-2)}
.card .q{color:var(--fg-3);font-size:12.5px;margin-top:12px;line-height:1.55}
.card .bignum{font-size:27px;font-weight:650;letter-spacing:-.03em;margin:0 0 7px;font-variant-numeric:tabular-nums;color:var(--lime)}
.card.flag{border-color:rgba(255,180,84,.38);box-shadow:0 0 22px -6px rgba(255,180,84,.3), 0 1px 0 rgba(255,255,255,.035) inset}
.card.flag .flagtag{display:inline-block;font-family:var(--mono);font-size:10px;letter-spacing:.1em;text-transform:uppercase;color:#ffb454;margin-bottom:9px}

footer{margin-top:46px;padding-top:20px;border-top:1px solid var(--line-soft);
  font-size:12.5px;color:var(--fg-3);line-height:1.7}
footer b{color:var(--fg-2);font-weight:600}

/* ---------- PULSE ADDITIONS ---------- */

/* A flagged ring card wears the same amber as .card.flag. It is a separate
   selector rather than an added .card class so the 22px ring-card geometry
   is not overwritten by .card's 20px box. */
.ring-card.flag{border-color:rgba(255,180,84,.38);
  box-shadow:0 0 22px -6px rgba(255,180,84,.3), 0 1px 0 rgba(255,255,255,.045) inset, 0 22px 50px -26px rgba(0,0,0,.95)}
.hbadge{display:inline-block;font-family:var(--mono);font-size:9.5px;letter-spacing:.1em;
  text-transform:uppercase;color:var(--amber);border:1px solid rgba(255,180,84,.38);
  border-radius:999px;padding:2px 7px;margin-right:9px;vertical-align:1px}

/* decision ledger */
.ledger{display:grid;grid-template-columns:repeat(2,1fr);gap:14px}
.dec{border-radius:20px;padding:20px 22px;border:1px solid var(--line);
  background:linear-gradient(180deg,#151515,#0f0f0f);box-shadow:0 1px 0 rgba(255,255,255,.035) inset}
.dec-top{display:flex;align-items:center;gap:10px;margin-bottom:11px}
.dec h3{font-size:15px;line-height:1.4;letter-spacing:-.018em}
.dec-dom{font-family:var(--mono);font-size:10px;letter-spacing:.11em;text-transform:uppercase;color:var(--fg-3)}
.chip{font-family:var(--mono);font-size:10px;letter-spacing:.1em;text-transform:uppercase;
  border-radius:999px;padding:3px 9px;border:1px solid var(--line);color:var(--fg-2);background:#171717}
.chip-new,.chip-open{color:var(--cyan);border-color:rgba(61,219,255,.35)}
.chip-confirmed,.chip-completed{color:var(--lime);border-color:rgba(198,244,50,.35)}
.chip-changed,.chip-partial,.chip-deferred{color:var(--amber);border-color:rgba(255,180,84,.38)}
.chip-blocked,.chip-reversed,.chip-dropped{color:var(--red);border-color:rgba(255,55,95,.38)}
.dec-meta{margin:9px 0 0;font-size:12px;color:var(--fg-3);font-family:var(--mono)}
.dec-proof{margin:10px 0 0;font-size:12.5px;color:var(--fg-2);line-height:1.55}
.dec-proof .k{font-family:var(--mono);font-size:10px;letter-spacing:.1em;text-transform:uppercase;color:var(--fg-3);margin-right:7px}
.dec-proof em{font-style:normal;color:var(--lime)}
.dec-proof em.none{color:var(--amber)}
.dec-why{margin:9px 0 0;font-size:12.5px;line-height:1.55;color:var(--fg-3)}
.warnmark{color:var(--amber)}

/* ---------- freshness badge ----------
   How the number was maintained, not whether it is right. 'daily' is the
   expected state, so it is rendered almost invisible; only last-minute and
   stale get any weight. A badge that shouted on every card would train the
   eye to skip it, which would waste the one case that matters. */
.fresh{font-family:var(--mono);font-size:9.5px;letter-spacing:.09em;text-transform:uppercase;
  color:var(--fg-3);opacity:.6;margin-right:9px;white-space:nowrap}
.fresh-loud{color:var(--amber);opacity:1;border:1px solid rgba(255,180,84,.3);
  border-radius:999px;padding:2px 7px;vertical-align:1px}

/* ---------- scoreboard ----------
   Five rows, ten seconds. Grid columns are fixed so every row's numbers land
   in the same place and the column can be read straight down. */
.score{border-radius:22px;border:1px solid var(--line);overflow:hidden;
  background:linear-gradient(180deg,#171717 0%,#101010 100%);
  box-shadow:0 1px 0 rgba(255,255,255,.045) inset, 0 22px 50px -26px rgba(0,0,0,.95)}
.shead,.srow{display:grid;grid-template-columns:minmax(150px,1.3fr) minmax(130px,1fr) minmax(110px,1.1fr) minmax(150px,1.3fr) minmax(120px,.9fr);
  gap:18px;align-items:center;padding:14px 22px}
.shead{font-family:var(--mono);font-size:9.5px;letter-spacing:.12em;text-transform:uppercase;
  color:var(--fg-3);border-bottom:1px solid var(--line-soft);padding-top:13px;padding-bottom:12px}
.srow{border-bottom:1px solid var(--line-soft)}
.srow:last-of-type{border-bottom:0}
.srow-flag{box-shadow:inset 3px 0 0 var(--amber)}
.sdept h3{font-size:14.5px;letter-spacing:-.015em}
.sowner{margin:3px 0 0;font-family:var(--mono);font-size:10.5px;color:var(--fg-3)}
.sfrac b{font-size:22px;font-weight:650;letter-spacing:-.03em;font-variant-numeric:tabular-nums}
.sfrac em{font-style:normal;display:block;font-size:11px;color:var(--fg-3);margin-top:2px}
.sbar{display:flex;gap:2px;height:9px;border-radius:999px;overflow:hidden;background:#1a1a1a}
.sbar-empty{background:repeating-linear-gradient(135deg,#1a1a1a 0 5px,#141414 5px 10px)}
.sg{display:block;height:100%}
.sg-good{background:var(--lime)} .sg-warn{background:var(--amber)}
.sg-crit{background:var(--red)}  .sg-stale{background:#6a6a6a}
.sg-missing{background:#3a3a3a}  .sg-untracked{background:#242424}
.sworst-h{display:block;font-family:var(--mono);font-size:9.5px;letter-spacing:.11em;
  text-transform:uppercase;margin-bottom:3px}
.sw-good{color:var(--lime)} .sw-warn{color:var(--amber)} .sw-crit{color:var(--red)}
.sw-stale,.sw-missing{color:var(--fg-3)} .sw-untracked{color:var(--fg-3)}
.sworst-m{font-size:13px;color:var(--fg-2)}
.sworst-none{color:var(--fg-3);font-style:italic}
.sdelta{font-family:var(--mono);font-size:12.5px;font-variant-numeric:tabular-nums}
.sdelta-up{color:var(--lime)} .sdelta-down{color:var(--red)}
.sdelta-flat,.sdelta-none{color:var(--fg-3)}
.sdir .fresh{display:block;margin:5px 0 0}
.stot{padding:15px 22px;border-top:1px solid var(--line-soft);background:#121212;
  font-size:13px;color:var(--fg-2)}
.stot span{font-weight:650;color:var(--fg);font-variant-numeric:tabular-nums}

/* ---------- blockers ----------
   The pair is the content: two named people with the ask between them. */
.blocker .btop{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:10px}
.blocker h3{font-size:15px;line-height:1.35;margin-bottom:12px}
.age{display:inline-flex;align-items:center;gap:7px;margin-left:auto;font-family:var(--mono);
  font-size:10px;letter-spacing:.08em;text-transform:uppercase;white-space:nowrap}
.age .pips{display:inline-flex;gap:3px}
.age .pips i{width:5px;height:5px;border-radius:50%;background:currentColor;opacity:.85}
.age-new{color:var(--fg-3)}
.age-ageing{color:var(--amber)}
.age-old{color:var(--red)}
/* Age as weight, not just a number: the oldest card reads heaviest from across
   the room, which is the whole reason ageing is tracked. */
.blocker-ageing{border-color:rgba(255,180,84,.22)}
.blocker-old{border-color:rgba(255,55,95,.42);
  box-shadow:0 0 26px -6px rgba(255,55,95,.28), 0 1px 0 rgba(255,255,255,.035) inset}
.blocker-old h3{font-weight:700}
.blocker-old .flagtag{color:var(--red)}
.blocker-done{opacity:.55}
/* ---------- cross-meeting ----------
   There is no fifth leadership meeting, so a blocker whose two ends sit in
   different reviews has NO room where both parties are present. It is shown in
   both, and it must never be mistakable for a blocker this room raised: the
   ask is the opposite direction. Cyan, not amber - the colour says "answer
   this", where every amber thing on the page says "chase this". */
.blocker-cross{border-color:rgba(61,219,255,.34)}
.blocker-cross .flagtag{color:var(--cyan)}
.blocker-foreign{border-color:rgba(61,219,255,.55);background:#101618;
  box-shadow:0 0 26px -8px rgba(61,219,255,.3), 0 1px 0 rgba(255,255,255,.035) inset}
.blocker-foreign h3{font-weight:700}
.bforeign{margin:-2px 0 14px;padding:0 0 13px;border-bottom:1px dashed rgba(61,219,255,.3)}
.bforeign-tag{display:inline-block;font-family:var(--mono);font-size:10px;letter-spacing:.1em;
  text-transform:uppercase;color:var(--cyan);border:1px solid rgba(61,219,255,.42);
  border-radius:999px;padding:3px 9px}
.bforeign-who{margin:9px 0 0;font-size:12.5px;line-height:1.55;color:var(--fg-2)}
.bforeign-who b{color:var(--cyan);font-weight:650}
.sechead-sub{margin-top:34px}
.sechead-sub h2{color:var(--cyan)}
.dep-cross{color:var(--cyan)}
.pair{display:flex;align-items:center;gap:11px;flex-wrap:wrap;padding:13px 14px;
  border:1px solid var(--line-soft);border-radius:14px;background:#141414}
.party{display:flex;flex-direction:column;min-width:0}
.pname{font-size:13.5px;font-weight:650;letter-spacing:-.012em;color:var(--fg)}
.pteam{font-family:var(--mono);font-size:9.5px;letter-spacing:.1em;text-transform:uppercase;
  color:var(--fg-3);margin-top:2px}
.party-to .pname{color:var(--cyan)}
.parrow{font-family:var(--mono);font-size:9.5px;letter-spacing:.1em;text-transform:uppercase;
  color:var(--fg-3);padding:0 2px;white-space:nowrap}
.bask{margin:12px 0 0;font-size:13.5px;line-height:1.6;color:var(--fg-2)}
.bimpact{margin:8px 0 0;font-size:12.5px;line-height:1.55;color:var(--fg-3)}
.bmetrics{margin:10px 0 0;font-size:12.5px;color:var(--fg-2)}
.bmetrics .k{font-family:var(--mono);font-size:9.5px;letter-spacing:.1em;text-transform:uppercase;
  color:var(--fg-3);margin-right:7px}
.bmetrics em{font-style:normal;color:var(--lime)}
.bmeta{display:flex;flex-wrap:wrap;gap:12px;margin:14px 0 0;padding-top:11px;
  border-top:1px solid var(--line-soft);font-family:var(--mono);font-size:10.5px;
  letter-spacing:.06em;color:var(--fg-3)}
.bmeta .bstatus{margin-left:auto;text-transform:uppercase}
.depsum h3{font-size:14.5px;margin-bottom:12px}
.deplist{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:9px}
.deplist li{display:flex;align-items:baseline;gap:9px;font-size:13px;color:var(--fg-2)}
.dep-from{font-weight:650;color:var(--fg)}
.dep-arrow{font-family:var(--mono);font-size:9.5px;letter-spacing:.09em;text-transform:uppercase;color:var(--fg-3)}
.dep-to{font-weight:650;color:var(--cyan)}
.dep-n{margin-left:auto;font-family:var(--mono);font-size:11px;color:var(--fg-3);
  border:1px solid var(--line);border-radius:999px;padding:1px 8px}
.depworst{margin:14px 0 0;padding-top:12px;border-top:1px solid var(--line-soft);
  font-size:12.5px;line-height:1.55;color:var(--fg-3)}
.depworst b{color:var(--amber)}

/* ---------- status by subject: the RAG section ----------
   Built to be UNMISTAKABLE for a ring card, because it is not one. Rings are
   arithmetic rendered as an arc; this is a person's opinion rendered as a row.
   So: no card geometry, no arc, no tabular count-up, a flat left rail in the
   call's own colour, and a verbatim reason with a name against it. The eye
   should register "this is a different kind of thing" before it reads a word.

   The colours are the same three the rings use, but only ever as a flat swatch
   or a 3px rail - never as a stroke around a circle - so the two vocabularies
   cannot be confused with each other. --grey is its own value, not a dimmed
   amber: the company's white bullet means not-started, which is a different
   statement from a worry. */
.rg-kind{margin-left:12px;font-family:var(--mono);font-size:9.5px;letter-spacing:.13em;
  text-transform:uppercase;color:var(--amber);border:1px solid rgba(255,180,84,.38);
  border-radius:999px;padding:3px 9px;vertical-align:2px;font-weight:500}
.rg-note{margin:-6px 0 18px;max-width:760px;font-size:12.5px;line-height:1.6;color:var(--fg-3)}
.rg-note b{color:var(--fg-2);font-weight:650}

.rag{border-radius:16px;border:1px dashed var(--line);overflow:hidden;background:#0d0d0d;
  margin-bottom:14px}
.rg-head{display:flex;align-items:baseline;gap:14px;flex-wrap:wrap;
  padding:13px 20px;border-bottom:1px solid var(--line-soft);background:#121212}
.rg-dept{font-size:13.5px;font-weight:650;letter-spacing:-.015em}
.rg-tallies{display:flex;gap:14px;flex-wrap:wrap}
.rg-tally{display:inline-flex;align-items:center;gap:6px;font-family:var(--mono);
  font-size:10.5px;letter-spacing:.06em;color:var(--fg-3)}
.rg-owner{margin-left:auto;font-family:var(--mono);font-size:10px;letter-spacing:.08em;
  text-transform:uppercase;color:var(--fg-3)}

.rg-cols,.rgrow{display:grid;
  grid-template-columns:minmax(150px,1fr) minmax(110px,.7fr) minmax(220px,2.2fr) minmax(110px,.8fr);
  gap:18px;align-items:start;padding:13px 20px}
.rg-cols{font-family:var(--mono);font-size:9.5px;letter-spacing:.12em;text-transform:uppercase;
  color:var(--fg-3);border-bottom:1px solid var(--line-soft);padding-top:11px;padding-bottom:10px}
.rgrow{border-bottom:1px solid var(--line-soft)}
.rgrow:last-of-type{border-bottom:0}
/* the rail, not a border: a judgement wears its colour flat */
.rgrow-red{box-shadow:inset 3px 0 0 var(--red)}
.rgrow-amber{box-shadow:inset 3px 0 0 var(--amber)}
.rgrow-green{box-shadow:inset 3px 0 0 var(--lime)}
.rgrow-grey{box-shadow:inset 3px 0 0 #5a5a5a}
/* A stale call is dimmed rather than removed. The colour is still what was last
   said; it just is not current, and saying so beats hiding it or trusting it. */
.rgrow-stale{opacity:.62}

.rg-call{display:flex;align-items:baseline;gap:9px;flex-wrap:wrap}
.rg-sw{width:10px;height:10px;border-radius:3px;flex:0 0 auto;transform:translateY(1px)}
.rg-red{background:var(--red)} .rg-amber{background:var(--amber)}
.rg-green{background:var(--lime)} .rg-grey{background:#5a5a5a}
.rg-subject{font-size:13.5px;font-weight:650;letter-spacing:-.012em}
.rg-colour{font-family:var(--mono);font-size:9.5px;letter-spacing:.1em;text-transform:uppercase;
  color:var(--fg-3)}
.rg-held{font-family:var(--mono);font-size:11px;color:var(--fg-2)}
.rg-staletag{display:block;margin-top:4px;font-style:normal;font-size:9.5px;
  letter-spacing:.09em;text-transform:uppercase;color:var(--amber)}
/* The reason is the row's payload, so it gets the most space and normal prose
   weight. A measured ring has nothing in this column and never needs one. */
.rg-reason{font-size:13px;line-height:1.55;color:var(--fg-2)}
.rg-by{display:block;margin-top:5px;font-style:normal;font-family:var(--mono);
  font-size:9.5px;letter-spacing:.09em;text-transform:uppercase;color:var(--fg-3)}

.rg-strip{display:inline-flex;gap:3px}
.rg-d{width:11px;height:18px;border-radius:3px;background:#1a1a1a}
.rg-d.rg-red{background:var(--red)} .rg-d.rg-amber{background:var(--amber)}
.rg-d.rg-green{background:var(--lime)} .rg-d.rg-grey{background:#5a5a5a}
/* A day nobody called is hatched, not coloured. Carrying the last colour
   forward would show a calm week for something nobody has looked at. */
.rg-d.rg-none{background:repeating-linear-gradient(135deg,#1c1c1c 0 3px,#131313 3px 6px)}

/* ---------- fixture banner ---------- */
.fixture{margin:0 -26px 0;padding:11px 26px;background:rgba(255,180,84,.1);
  border-bottom:1px solid rgba(255,180,84,.3);color:var(--amber);
  font-family:var(--mono);font-size:11px;letter-spacing:.07em;text-align:center}
.fixture b{font-weight:650}

@media (max-width:980px){
  .rings,.grid,.ledger{grid-template-columns:1fr}
  .nav .brand span{display:none}
  .body{flex-direction:column;align-items:flex-start}
  .shead{display:none}
  .srow{grid-template-columns:1fr 1fr;gap:12px}
  .sdept{grid-column:1 / -1}
  .sworst,.scell{grid-column:1 / -1}
  .rg-cols{display:none}
  .rgrow{grid-template-columns:1fr auto;gap:10px}
  .rg-reason{grid-column:1 / -1}
  .rg-owner{margin-left:0}
}
@media (prefers-reduced-motion:reduce){
  *{transition:none!important;animation:none!important}
  html{scroll-behavior:auto}
}
`;

/**
 * The decision log is a different object: paper, not a screen. White, black
 * type, hairline rules, 16:9 landscape so it projects without letterboxing.
 */
export const PRINT_CSS = `
@page { size: 13.333in 7.5in; margin: 0; }
:root{
  --ink:#000; --ink-2:#444; --ink-3:#767676; --rule:#d8d8d8; --rule-2:#eaeaea;
  --font:"Geist","Inter",-apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif;
}
*{box-sizing:border-box}
html{color-scheme:light}
body.print{margin:0;background:#8f8f8f;color:var(--ink);font-family:var(--font);
  -webkit-font-smoothing:antialiased;padding:28px 0}

.page{position:relative;width:13.333in;height:7.5in;margin:0 auto 28px;background:#fff;
  padding:0.52in 0.62in 0.46in;display:flex;flex-direction:column;overflow:hidden}

.phead{display:grid;grid-template-columns:1fr auto 1fr;align-items:baseline;
  padding-bottom:9px;border-bottom:1px solid var(--rule)}
.phead span{font-size:9.5px;letter-spacing:.14em;text-transform:uppercase;color:var(--ink-3)}
.phead .pdoc{text-align:center;color:var(--ink-2)}
.phead .pno{text-align:right;font-variant-numeric:tabular-nums}

.dlabel{margin:22px 0 0;font-size:10px;letter-spacing:.17em;text-transform:uppercase;color:var(--ink-3)}
.dhead{margin:11px 0 0;font-weight:700;line-height:1.1;letter-spacing:-.025em;max-width:11in}
.dhead .cont{font-weight:400;color:var(--ink-3)}
.dstatus{margin:12px 0 0;font-size:10px;letter-spacing:.13em;text-transform:uppercase;color:var(--ink-3)}

.cols{display:grid;grid-template-columns:repeat(3,1fr);gap:0;margin-top:26px;flex:1 1 auto;min-height:0}
.col{padding:0 30px;break-inside:avoid;page-break-inside:avoid}
.col:first-child{padding-left:0}
.col:last-child{padding-right:0}
.col + .col{border-left:1px solid var(--rule)}
.col h2{font-size:9.5px;letter-spacing:.16em;text-transform:uppercase;color:var(--ink-3);
  font-weight:600;padding-bottom:8px;border-bottom:1px solid var(--rule-2);margin-bottom:12px}
.col p{margin:0 0 10px;font-size:13px;line-height:1.52;color:var(--ink)}
.col p.empty{color:var(--ink-3)}

.strip{background:#000;color:#fff;border-radius:11px;padding:16px 22px;margin-top:14px;
  break-inside:avoid;page-break-inside:avoid;
  -webkit-print-color-adjust:exact;print-color-adjust:exact}
.strip p{margin:0;font-size:15px;line-height:1.4;font-weight:500;letter-spacing:-.012em;color:#fff}

.pfoot{display:flex;justify-content:space-between;gap:20px;margin-top:14px;padding-top:9px;
  border-top:1px solid var(--rule);font-size:9.5px;letter-spacing:.13em;
  text-transform:uppercase;color:var(--ink-3)}

@media print{
  body.print{background:#fff;padding:0;-webkit-print-color-adjust:exact;print-color-adjust:exact}
  .page{margin:0;page-break-before:always;break-before:page;page-break-after:avoid}
  .page:first-of-type{page-break-before:avoid;break-before:auto}
  .strip{-webkit-print-color-adjust:exact;print-color-adjust:exact}
}
`;
