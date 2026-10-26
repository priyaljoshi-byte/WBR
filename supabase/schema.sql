-- ShopOS Pulse - database schema
-- Run once in Supabase: SQL Editor -> New query -> paste all -> Run.
--
-- Reuses the same Supabase project and the same Google sign-in as
-- shopos-org-KPIs, so nobody gets a second login and department ids stay in
-- lockstep with the org chart and the battle cards.
--
-- The shape of this schema follows one rule: CONFIG IS DATA. Departments,
-- cards, metric definitions and sources are rows, never code. Adding a
-- department or a metric is an INSERT. That is the whole reason this scales
-- without an engineer in the loop.

-- ===========================================================================
-- WHO CAN DO WHAT
-- ===========================================================================
-- Three levels, deliberately few:
--   viewer  - any signed-in @shopos.ai account. Reads everything.
--   owner   - a department's owner. Writes that department's sources, metrics,
--             cards and manual values. Cannot touch another department's.
--   admin   - founder's office. Writes anything, publishes runs, edits decisions.
--
-- Department scoping is enforced here in the database, not in the browser. The
-- UI hiding a button is a convenience; this is the actual gate.

create table if not exists pulse_roles (
  email      text primary key,
  role       text not null check (role in ('viewer','owner','admin')),
  dept_ids   text[] not null default '{}',
  updated_at timestamptz not null default now()
);
alter table pulse_roles enable row level security;

create or replace function pulse_is_admin() returns boolean
  language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from pulse_roles
    where email = auth.jwt() ->> 'email' and role = 'admin'
  );
$$;

create or replace function pulse_owns_dept(d text) returns boolean
  language sql stable security definer set search_path = public as $$
  select pulse_is_admin() or exists (
    select 1 from pulse_roles
    where email = auth.jwt() ->> 'email'
      and role = 'owner'
      and d = any(dept_ids)
  );
$$;

-- Everyone signed in may read the roster; only admins may change it.
drop policy if exists pulse_roles_read on pulse_roles;
create policy pulse_roles_read on pulse_roles for select using (auth.role() = 'authenticated');
drop policy if exists pulse_roles_write on pulse_roles;
create policy pulse_roles_write on pulse_roles for all
  using (pulse_is_admin()) with check (pulse_is_admin());

insert into pulse_roles (email, role, dept_ids) values
  ('priyal.joshi@shopos.ai', 'admin', '{}'),
  ('ajay@shopos.ai',         'admin', '{}'),
  ('sai@shopos.ai',          'admin', '{}')
on conflict (email) do nothing;

-- ===========================================================================
-- CONFIG  - departments, sections, sources, metrics, cards
-- ===========================================================================

create table if not exists pulse_departments (
  id      text primary key,
  pillar  text not null,
  label   text not null,
  owner_email text,
  owner_name  text
);

create table if not exists pulse_sections (
  id    text primary key,
  label text not null,
  blurb text,
  ord   int  not null default 0
);

create table if not exists pulse_sources (
  id          text primary key,
  dept_id     text not null references pulse_departments(id),
  kind        text not null check (kind in ('gsheet','notion','postgres','manual')),
  label       text not null,
  ref         text,                -- spreadsheet id / database id / env var name
  tab         text,
  header_row  int default 1,
  date_column text,
  query       text,                -- postgres only
  config      jsonb not null default '{}'::jsonb,
  notes       text,
  -- Sync health. The dashboard reads these to decide stale vs missing.
  last_synced_at     timestamptz,
  last_sync_status   text check (last_sync_status in ('ok','empty','error')),
  last_sync_error    text,
  last_row_count     int,
  created_by  text,
  created_at  timestamptz not null default now()
);
comment on column pulse_sources.ref is
  'Never a secret. Credentials live in server environment variables; this names which sheet or database to open.';

create table if not exists pulse_metrics (
  id           text primary key,
  dept_id      text not null references pulse_departments(id),
  label        text not null,
  unit         text not null check (unit in ('count','currency_inr','percent','duration')),
  source       jsonb not null,     -- SourceQuery: {ref, tab, agg, column, where}
  denominator  jsonb not null,     -- Denominator: {kind, value|metric|column, label}
  direction    text not null default 'up' check (direction in ('up','down')),
  target       numeric,
  warn_at      numeric,
  crit_at      numeric,
  caption      text not null default '{{raw}}',
  active       boolean not null default true,
  created_by   text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create table if not exists pulse_cards (
  id       text primary key,
  dept_id  text not null references pulse_departments(id),
  section_id text not null references pulse_sections(id),
  title    text not null,
  subtitle text,
  ord      int not null default 0,
  rings    text[] not null default '{}',   -- metric ids, OUTER to INNER, max 3
  tiles    jsonb  not null default '[]'::jsonb,
  active   boolean not null default true
);
-- Three rings is not a style choice. A fourth ring is unreadable at a glance,
-- and a card nobody can read in two seconds does not get read at all.
alter table pulse_cards drop constraint if exists pulse_cards_max_three_rings;
alter table pulse_cards add constraint pulse_cards_max_three_rings
  check (array_length(rings, 1) is null or array_length(rings, 1) <= 3);

-- Config: everyone reads, department owners write their own.
do $$
declare t text;
begin
  foreach t in array array['pulse_departments','pulse_sections','pulse_sources','pulse_metrics','pulse_cards']
  loop
    execute format('alter table %I enable row level security', t);
    execute format('drop policy if exists %I on %I', t || '_read', t);
    execute format(
      'create policy %I on %I for select using (auth.role() = ''authenticated'')', t || '_read', t);
  end loop;
end $$;

drop policy if exists pulse_sources_write on pulse_sources;
create policy pulse_sources_write on pulse_sources for all
  using (pulse_owns_dept(dept_id)) with check (pulse_owns_dept(dept_id));

drop policy if exists pulse_metrics_write on pulse_metrics;
create policy pulse_metrics_write on pulse_metrics for all
  using (pulse_owns_dept(dept_id)) with check (pulse_owns_dept(dept_id));

drop policy if exists pulse_cards_write on pulse_cards;
create policy pulse_cards_write on pulse_cards for all
  using (pulse_owns_dept(dept_id)) with check (pulse_owns_dept(dept_id));

drop policy if exists pulse_departments_write on pulse_departments;
create policy pulse_departments_write on pulse_departments for all
  using (pulse_is_admin()) with check (pulse_is_admin());

drop policy if exists pulse_sections_write on pulse_sections;
create policy pulse_sections_write on pulse_sections for all
  using (pulse_is_admin()) with check (pulse_is_admin());

-- ===========================================================================
-- HISTORY  - runs and snapshots
-- ===========================================================================
-- A snapshot is frozen. Nothing rewrites one. This is what makes "what did we
-- say the number was on 7 September" answerable a year later, and it is why the
-- dashboard loads instantly - the arithmetic already happened.

create table if not exists pulse_runs (
  id           uuid primary key default gen_random_uuid(),
  period_start date not null,
  period_end   date not null,
  started_at   timestamptz not null default now(),
  finished_at  timestamptz,
  status       text not null default 'running' check (status in ('running','ok','partial','failed')),
  triggered_by text not null default 'cron',
  published    boolean not null default false,
  notes        text
);
create index if not exists pulse_runs_period on pulse_runs (period_start desc);

create table if not exists pulse_snapshots (
  id            bigserial primary key,
  run_id        uuid not null references pulse_runs(id) on delete cascade,
  metric_id     text not null,
  period_start  date not null,
  period_end    date not null,
  raw               numeric,
  denominator       numeric,
  normalized        numeric,      -- 0..100, the ring arc
  prior_raw         numeric,
  prior_normalized  numeric,
  delta             numeric,
  health        text not null check (health in ('good','warn','crit','stale','missing','untracked')),
  caption       text,
  row_count     int not null default 0,
  warnings      text[] not null default '{}',
  -- What someone SAID in the meeting, for comparison against what we measured.
  stated_value  numeric,
  stated_by     text,
  computed_at   timestamptz not null default now(),
  unique (run_id, metric_id)
);
create index if not exists pulse_snapshots_metric_period
  on pulse_snapshots (metric_id, period_start desc);

alter table pulse_runs enable row level security;
alter table pulse_snapshots enable row level security;

drop policy if exists pulse_runs_read on pulse_runs;
create policy pulse_runs_read on pulse_runs for select using (auth.role() = 'authenticated');
drop policy if exists pulse_snapshots_read on pulse_snapshots;
create policy pulse_snapshots_read on pulse_snapshots for select using (auth.role() = 'authenticated');

-- Only the service role writes history. No human hand edits a past number;
-- a correction is a new run, so the trail stays intact.
drop policy if exists pulse_runs_write on pulse_runs;
create policy pulse_runs_write on pulse_runs for all
  using (auth.role() = 'service_role') with check (auth.role() = 'service_role');
drop policy if exists pulse_snapshots_write on pulse_snapshots;
create policy pulse_snapshots_write on pulse_snapshots for all
  using (auth.role() = 'service_role') with check (auth.role() = 'service_role');

-- ===========================================================================
-- MEETINGS, DECISIONS, NOTES  - the continuity spine
-- ===========================================================================

create table if not exists pulse_meetings (
  id          uuid primary key default gen_random_uuid(),
  date        date not null,
  kind        text not null default 'wbr',
  attendees   text[] not null default '{}',
  transcript_path text,
  processed_at    timestamptz,
  run_id      uuid references pulse_runs(id)
);

create table if not exists pulse_decisions (
  id          uuid primary key default gen_random_uuid(),
  number      int,
  domain      text not null,
  headline    text not null,
  status      text not null check (status in
    ('NEW','CONFIRMED','CHANGED','REVERSED','COMPLETED','PARTIAL','BLOCKED','DEFERRED','DROPPED','OPEN')),
  carried_in          text,
  evidence            text,
  decided             text,
  before_next_review  text,
  strip               text,
  owner       text,         -- null renders as [OWNER NEEDED]
  due_date    date,         -- null renders as [DATE NEEDED]
  reopen_condition text,
  -- THE ENRICHMENT LINK. Which rings prove this decision worked. With this,
  -- next week's dashboard can state whether the decision moved its numbers,
  -- which is the difference between a log and a feedback loop.
  metric_ids  text[] not null default '{}',
  first_seen_meeting  uuid references pulse_meetings(id),
  last_touched_meeting uuid references pulse_meetings(id),
  previous_state_unverified boolean not null default false,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists pulse_decisions_open on pulse_decisions (status)
  where status not in ('COMPLETED','DROPPED','REVERSED');

create table if not exists pulse_decision_events (
  id          bigserial primary key,
  decision_id uuid not null references pulse_decisions(id) on delete cascade,
  meeting_id  uuid references pulse_meetings(id),
  from_status text,
  to_status   text not null,
  reason      text,
  quote       text,
  at          timestamptz not null default now()
);
create index if not exists pulse_decision_events_decision on pulse_decision_events (decision_id, at);

-- A status change that reverses, changes, defers or drops a decision must say
-- why. Enforced in the database because "we changed our mind in September and
-- nobody wrote down why" is exactly the failure this whole system exists to
-- prevent.
create or replace function pulse_require_reason() returns trigger
  language plpgsql as $$
begin
  if new.to_status in ('CHANGED','REVERSED','DEFERRED','DROPPED')
     and (new.reason is null or btrim(new.reason) = '') then
    raise exception 'a % decision needs a reason', new.to_status;
  end if;
  return new;
end $$;
drop trigger if exists pulse_decision_events_reason on pulse_decision_events;
create trigger pulse_decision_events_reason
  before insert or update on pulse_decision_events
  for each row execute function pulse_require_reason();

create table if not exists pulse_notes (
  id         bigserial primary key,
  card_id    text not null,
  run_id     uuid references pulse_runs(id),
  meeting_id uuid references pulse_meetings(id),
  text       text not null,
  quote      text,
  created_at timestamptz not null default now()
);
create index if not exists pulse_notes_card on pulse_notes (card_id, created_at desc);

create table if not exists pulse_flags (
  id          text primary key,     -- stable: '{kind}:{metric_id}', so a flag
                                    -- persisting two weeks is the same flag
  run_id      uuid references pulse_runs(id),
  dept_id     text references pulse_departments(id),
  owner       text,
  title       text not null,
  body        text,
  kind        text not null check (kind in
    ('missing_data','stale_source','off_target','no_proof','overdue','contradiction','manual')),
  raised_by   text not null default 'engine' check (raised_by in ('engine','transcript','manual')),
  metric_ids  text[] not null default '{}',
  decision_id uuid references pulse_decisions(id),
  raised_at   timestamptz not null default now(),
  resolved_at timestamptz
);
create index if not exists pulse_flags_open on pulse_flags (dept_id) where resolved_at is null;

alter table pulse_meetings        enable row level security;
alter table pulse_decisions       enable row level security;
alter table pulse_decision_events enable row level security;
alter table pulse_notes           enable row level security;
alter table pulse_flags           enable row level security;

do $$
declare t text;
begin
  foreach t in array array['pulse_meetings','pulse_decisions','pulse_decision_events','pulse_notes','pulse_flags']
  loop
    execute format('drop policy if exists %I on %I', t || '_read', t);
    execute format(
      'create policy %I on %I for select using (auth.role() = ''authenticated'')', t || '_read', t);
    execute format('drop policy if exists %I on %I', t || '_write', t);
    execute format(
      'create policy %I on %I for all using (pulse_is_admin() or auth.role() = ''service_role'') '
      || 'with check (pulse_is_admin() or auth.role() = ''service_role'')', t || '_write', t);
  end loop;
end $$;

-- A department owner may resolve a flag aimed at their own department. Chasing
-- is automated; clearing stays human.
drop policy if exists pulse_flags_resolve on pulse_flags;
create policy pulse_flags_resolve on pulse_flags for update
  using (pulse_owns_dept(dept_id)) with check (pulse_owns_dept(dept_id));

-- Manual values: a department owner submits numbers that have no system yet.
create table if not exists pulse_manual_values (
  id          bigserial primary key,
  source_id   text not null references pulse_sources(id),
  dept_id     text not null references pulse_departments(id),
  entered_for date not null,
  payload     jsonb not null,
  entered_by  text not null,
  entered_at  timestamptz not null default now(),
  unique (source_id, entered_for)
);
alter table pulse_manual_values enable row level security;
drop policy if exists pulse_manual_read on pulse_manual_values;
create policy pulse_manual_read on pulse_manual_values for select using (auth.role() = 'authenticated');
drop policy if exists pulse_manual_write on pulse_manual_values;
create policy pulse_manual_write on pulse_manual_values for all
  using (pulse_owns_dept(dept_id)) with check (pulse_owns_dept(dept_id));

-- ===========================================================================
-- READ MODELS
-- ===========================================================================

-- The latest published run. Everything the founder opens reads from here.
create or replace view pulse_current as
  select s.*, m.label, m.dept_id, m.unit, m.direction, r.period_start as run_period_start
  from pulse_snapshots s
  join pulse_metrics m on m.id = s.metric_id
  join pulse_runs r on r.id = s.run_id
  where r.id = (
    select id from pulse_runs where published and status <> 'failed'
    order by period_start desc, started_at desc limit 1
  );

-- Week-on-week movement for every metric linked to a decision. This is the
-- compounding view: not "what is the number" but "has the decision we took
-- actually moved it".
create or replace view pulse_decision_proof as
  select d.id as decision_id, d.headline, d.status, d.owner,
         s.metric_id, m.label as metric_label,
         s.normalized, s.prior_normalized, s.delta, s.health
  from pulse_decisions d
  cross join lateral unnest(d.metric_ids) as metric(metric_id)
  join pulse_current s on s.metric_id = metric.metric_id
  join pulse_metrics m on m.id = metric.metric_id
  where d.status not in ('COMPLETED','DROPPED','REVERSED');

-- Decisions nobody is measuring, and numbers nobody is acting on. The two
-- blind spots that a weekly review tends to grow.
create or replace view pulse_blind_spots as
  select 'decision_without_proof' as kind, d.id::text as ref, d.headline as label
  from pulse_decisions d
  where cardinality(d.metric_ids) = 0
    and d.status not in ('COMPLETED','DROPPED','REVERSED')
  union all
  select 'metric_without_decision', m.id, m.label
  from pulse_metrics m
  where m.active
    and not exists (
      select 1 from pulse_decisions d
      where m.id = any(d.metric_ids) and d.status not in ('COMPLETED','DROPPED','REVERSED')
    );

-- ===========================================================================
-- REALTIME
-- ===========================================================================
do $$
declare t text;
begin
  foreach t in array array['pulse_runs','pulse_snapshots','pulse_flags','pulse_decisions','pulse_notes']
  loop
    begin
      execute format('alter publication supabase_realtime add table %I', t);
    exception when duplicate_object then null;
    end;
  end loop;
end $$;
