-- ShopOS Pulse - tables the intake app needs
-- Run AFTER supabase/schema.sql, in the same Supabase project.
--
-- schema.sql covers the engine's world: config, snapshots, decisions, flags.
-- This file covers the world of a person typing things in - uploads, column
-- maps, hand-kept lists, status calls, and extraction drafts waiting for a
-- human to read them.
--
-- It follows the same RLS pattern throughout, stated once here so every policy
-- below is an instance of it rather than a decision:
--
--   read   - any signed-in account reads everything. Cross-department
--            visibility is the first goal of the meeting, so hiding one team's
--            setup state from another would work against the product.
--   write  - a department owner writes their own department. Admins write
--            anything. Enforced here in the database, because the browser
--            hiding a button is a courtesy and this is the actual gate.
--   frozen - a committed draft is never edited, by anyone, including admins.
--            Same rule as a snapshot, same reason: if the record of what a
--            human approved can be rewritten afterwards, it stops being a
--            record of what a human approved.

-- ===========================================================================
-- 0. Corrections to schema.sql that the app surfaces
-- ===========================================================================
-- These are not new features. engine/types.js already defines these values and
-- config/catalog.json already uses them; the original CHECK constraints were
-- written before the catalogue grew US segments and duration-in-days metrics,
-- so an honest write from the Targets screen would be rejected.

alter table pulse_metrics drop constraint if exists pulse_metrics_unit_check;
alter table pulse_metrics add constraint pulse_metrics_unit_check
  check (unit in ('count','currency_inr','currency_usd','percent','duration','duration_days'));

-- types.js Flag.kind carries no_target and last_minute. Without them the engine
-- cannot write the very flags that this app's Targets and Sources screens exist
-- to clear.
alter table pulse_flags drop constraint if exists pulse_flags_kind_check;
alter table pulse_flags add constraint pulse_flags_kind_check
  check (kind in ('missing_data','stale_source','off_target','no_target','last_minute',
                  'no_proof','overdue','contradiction','manual'));

-- sources.json carries a segment and two different date columns per source.
-- The freshness classification is meaningless without row_timestamp_column.
alter table pulse_sources add column if not exists segment text;
alter table pulse_sources add column if not exists row_timestamp_column text;
alter table pulse_sources add column if not exists last_freshness text
  check (last_freshness in ('daily','weekly','last_minute','stale','unknown'));
comment on column pulse_sources.last_freshness is
  'How the data was maintained, not whether it is right. Written by the run, read by the Sources screen. See engine/freshness.js.';

-- ===========================================================================
-- 1. Shared helper
-- ===========================================================================
-- pulse_owns_dept() already exists in schema.sql. This adds the one predicate
-- the app needs that it does not: "signed in at all".
create or replace function pulse_is_signed_in() returns boolean
  language sql stable as $$ select auth.role() = 'authenticated' $$;

-- ===========================================================================
-- 2. Uploaded CSV payloads
-- ===========================================================================
-- A CSV upload is a reading, not a source. It is kept whole and immutable so
-- that "where did this number come from" has an answer that is not "someone's
-- Downloads folder, since overwritten".

create table if not exists pulse_uploads (
  id          bigserial primary key,
  source_id   text not null references pulse_sources(id) on delete cascade,
  dept_id     text not null references pulse_departments(id),
  filename    text not null,
  columns     text[] not null default '{}',
  row_count   int not null default 0,
  rows        jsonb not null default '[]'::jsonb,
  -- What was known about this file's date columns at the moment of upload:
  -- which order each was read in, on what basis, and how many cells could not
  -- be read. Kept WITH the rows so "which way did we read that column in
  -- October" has an answer in March. See engine/dates.js.
  date_report jsonb not null default '[]'::jsonb,
  -- Set once the run has read this upload into a snapshot.
  consumed_at timestamptz,
  uploaded_by text,
  uploaded_at timestamptz not null default now()
);
create index if not exists pulse_uploads_source on pulse_uploads (source_id, uploaded_at desc);
alter table pulse_uploads enable row level security;

drop policy if exists pulse_uploads_read on pulse_uploads;
create policy pulse_uploads_read on pulse_uploads for select using (pulse_is_signed_in());

drop policy if exists pulse_uploads_insert on pulse_uploads;
create policy pulse_uploads_insert on pulse_uploads for insert
  with check (pulse_owns_dept(dept_id));

-- Deliberately no UPDATE policy. An upload is a reading taken at a moment. A
-- correction is a new upload, which keeps the trail, exactly as a correction to
-- a snapshot is a new run.
drop policy if exists pulse_uploads_delete on pulse_uploads;
create policy pulse_uploads_delete on pulse_uploads for delete
  using (pulse_is_admin());

-- ===========================================================================
-- 3. Column mappings
-- ===========================================================================
-- The catalogue asks for `updated_on`. The sheet says `Date of Joining` with a
-- stray backtick. This table is the whole reason connecting a spreadsheet does
-- not require a code change.

create table if not exists pulse_column_mappings (
  source_id        text primary key references pulse_sources(id) on delete cascade,
  dept_id          text not null references pulse_departments(id),
  -- { "<column the metric needs>": "<column the file actually has>" | null }
  mapping          jsonb not null default '{}'::jsonb,
  detected_columns text[] not null default '{}',
  -- 05/10/2026 is 5 October or 10 May depending on who typed it, and plain
  -- JavaScript reads it as 10 May. Values match DATE_ORDERS in engine/dates.js
  -- exactly; 'auto' means "infer it from the column's own rows", which is what
  -- the engine does and what should normally be left alone.
  date_order       text not null default 'auto' check (date_order in ('auto','DMY','MDY')),
  updated_by       text,
  updated_at       timestamptz not null default now()
);
alter table pulse_column_mappings enable row level security;

drop policy if exists pulse_column_mappings_read on pulse_column_mappings;
create policy pulse_column_mappings_read on pulse_column_mappings for select using (pulse_is_signed_in());
drop policy if exists pulse_column_mappings_write on pulse_column_mappings;
create policy pulse_column_mappings_write on pulse_column_mappings for all
  using (pulse_owns_dept(dept_id)) with check (pulse_owns_dept(dept_id));

-- ===========================================================================
-- 4. Hand-kept lists
-- ===========================================================================
-- Brand | Stage | Next | Owner. The per-row table the review carries by hand
-- because no system holds it. Keeping it here rather than in a document is what
-- lets "which rows have no owner" be a number instead of a reading exercise.

create table if not exists pulse_lists (
  id         text primary key,
  source_id  text references pulse_sources(id) on delete set null,
  dept_id    text not null references pulse_departments(id),
  label      text not null,
  columns    text[] not null default '{}',
  rows       jsonb  not null default '[]'::jsonb,
  updated_by text,
  updated_at timestamptz not null default now()
);
alter table pulse_lists enable row level security;

drop policy if exists pulse_lists_read on pulse_lists;
create policy pulse_lists_read on pulse_lists for select using (pulse_is_signed_in());
drop policy if exists pulse_lists_write on pulse_lists;
create policy pulse_lists_write on pulse_lists for all
  using (pulse_owns_dept(dept_id)) with check (pulse_owns_dept(dept_id));

-- ===========================================================================
-- 5. Status calls - Red / Amber / Green / White
-- ===========================================================================
-- A subject is a brand OR a track. One table with a kind column, because
-- Performance Marketing calls brands and other functions call tracks in exactly
-- the same way, and two tables would mean two screens.

create table if not exists pulse_status_subjects (
  id      text primary key,
  label   text not null,
  kind    text not null default 'brand' check (kind in ('brand','track')),
  dept_id text not null references pulse_departments(id),
  active  boolean not null default true,
  ord     int not null default 0
);
alter table pulse_status_subjects enable row level security;

drop policy if exists pulse_status_subjects_read on pulse_status_subjects;
create policy pulse_status_subjects_read on pulse_status_subjects for select using (pulse_is_signed_in());
drop policy if exists pulse_status_subjects_write on pulse_status_subjects;
create policy pulse_status_subjects_write on pulse_status_subjects for all
  using (pulse_owns_dept(dept_id)) with check (pulse_owns_dept(dept_id));

create table if not exists pulse_status_calls (
  id         bigserial primary key,
  subject_id text not null references pulse_status_subjects(id) on delete cascade,
  dept_id    text not null references pulse_departments(id),
  -- R off track / A wobbling / G on track / W not started, no signal.
  -- W is NOT a soft amber. Amber means somebody looked and it is wobbling;
  -- white means nobody has looked, or there is nothing yet to look at. A brand
  -- untouched for a week must not read as a mildly concerning one.
  status     text not null check (status in ('R','A','G','W')),
  -- NOT NULL, and the check rejects whitespace. A colour with no reason is
  -- exactly as useful on Friday as no call at all, so the database refuses it
  -- rather than leaving the browser to be the only thing asking.
  reason     text not null check (btrim(reason) <> ''),
  set_for    date not null default current_date,
  set_by     text,
  created_at timestamptz not null default now(),
  unique (subject_id, set_for)
);
create index if not exists pulse_status_calls_recent on pulse_status_calls (subject_id, set_for desc);
alter table pulse_status_calls enable row level security;

drop policy if exists pulse_status_calls_read on pulse_status_calls;
create policy pulse_status_calls_read on pulse_status_calls for select using (pulse_is_signed_in());
drop policy if exists pulse_status_calls_write on pulse_status_calls;
create policy pulse_status_calls_write on pulse_status_calls for all
  using (pulse_owns_dept(dept_id)) with check (pulse_owns_dept(dept_id));

-- ===========================================================================
-- 6. Meeting kinds
-- ===========================================================================
-- config/meetings.json does not exist yet. The org runs several reviews a week,
-- so rather than hard-coding a list the app reads this table and falls back to
-- the single weekly WBR in org.json when it is empty. Adding a meeting is a row.

create table if not exists pulse_meeting_kinds (
  id          text primary key,
  label       text not null,
  short_label text,
  kind        text not null default 'wbr',
  cadence     text not null default 'weekly',
  day         text,
  time_of_day text,
  dept_ids    text[] not null default '{}',
  blurb       text,
  ord         int not null default 0
);
alter table pulse_meeting_kinds enable row level security;

drop policy if exists pulse_meeting_kinds_read on pulse_meeting_kinds;
create policy pulse_meeting_kinds_read on pulse_meeting_kinds for select using (pulse_is_signed_in());
drop policy if exists pulse_meeting_kinds_write on pulse_meeting_kinds;
create policy pulse_meeting_kinds_write on pulse_meeting_kinds for all
  using (pulse_is_admin()) with check (pulse_is_admin());

insert into pulse_meeting_kinds (id, label, short_label, kind, cadence, day, time_of_day, blurb, ord) values
  ('wbr', 'Weekly business review', 'WBR', 'wbr', 'weekly', 'monday', '10:00',
   'The whole leadership group. Scoreboard, blockers, decisions.', 1)
on conflict (id) do nothing;

-- ===========================================================================
-- 7. Extraction drafts - the review step, persisted
-- ===========================================================================
-- An LLM writing straight into a decision log is how the log stops being
-- trusted. So the model's output lands HERE first, with a per-item accept /
-- edit / reject recorded against it, and only a human pressing Commit moves
-- anything into pulse_decisions.
--
-- The draft is kept after commit, rejections included. That is the point: next
-- week's extraction can see that a suggestion was already looked at and
-- declined, instead of offering it again as new.

create table if not exists pulse_extraction_drafts (
  id           uuid primary key default gen_random_uuid(),
  meeting_kind text not null default 'wbr',
  meeting_date date not null,
  meeting_ref  text,
  -- Exactly what the model returned, untouched. The audit trail of what was
  -- proposed, as distinct from what was approved.
  payload      jsonb not null,
  -- What the human did to each item.
  review       jsonb not null default '{}'::jsonb,
  status       text not null default 'draft' check (status in ('draft','committed','discarded')),
  report       text,
  created_by   text,
  created_at   timestamptz not null default now(),
  committed_at timestamptz
);
create index if not exists pulse_extraction_drafts_recent
  on pulse_extraction_drafts (meeting_date desc, created_at desc);
alter table pulse_extraction_drafts enable row level security;

drop policy if exists pulse_extraction_drafts_read on pulse_extraction_drafts;
create policy pulse_extraction_drafts_read on pulse_extraction_drafts for select using (pulse_is_signed_in());

drop policy if exists pulse_extraction_drafts_insert on pulse_extraction_drafts;
create policy pulse_extraction_drafts_insert on pulse_extraction_drafts for insert
  with check (pulse_is_signed_in() and created_by = auth.jwt() ->> 'email');

-- Only your own draft, and only while it is still a draft.
drop policy if exists pulse_extraction_drafts_update on pulse_extraction_drafts;
create policy pulse_extraction_drafts_update on pulse_extraction_drafts for update
  using (status = 'draft' and (created_by = auth.jwt() ->> 'email' or pulse_is_admin()))
  with check (created_by = auth.jwt() ->> 'email' or pulse_is_admin());

-- FROZEN. A committed draft is the record of what a human approved. If that can
-- be rewritten afterwards it is no longer a record of anything. Admins included.
create or replace function pulse_freeze_committed_draft() returns trigger
  language plpgsql as $$
begin
  if old.status = 'committed' then
    raise exception
      'this draft was committed on % and cannot be edited. Add a new draft instead - a correction is a new review, not a rewrite of an old one.',
      old.committed_at;
  end if;
  return new;
end $$;
drop trigger if exists pulse_extraction_drafts_frozen on pulse_extraction_drafts;
create trigger pulse_extraction_drafts_frozen
  before update or delete on pulse_extraction_drafts
  for each row execute function pulse_freeze_committed_draft();

-- ===========================================================================
-- 8. Blockers
-- ===========================================================================
-- engine/types.js defines Blocker and BlockerEvent as first-class objects and
-- transcript/blockers.js produces them, but schema.sql never had tables for
-- them. The review screen commits blockers, so they need somewhere to land.

create table if not exists pulse_blockers (
  id          uuid primary key default gen_random_uuid(),
  title       text not null,
  raised_by   text not null references pulse_departments(id),
  -- org.json blockers.require_needs_from. "I am blocked" with no named other
  -- end is not actionable, it is a mood. Nullable in the column so a transcript
  -- can record one honestly as [OWNER NEEDED]; the intake form is what refuses
  -- to let a person file one without naming the other end.
  needs_from  text,
  what        text,
  impact      text,
  metric_ids  text[] not null default '{}',
  raised_at   date not null default current_date,
  status      text not null default 'open'
    check (status in ('open','resolved_in_room','owner_assigned','escalated','dropped','carried')),
  owner       text,
  due_date    date,
  resolution  text,
  resolved_at timestamptz,
  first_seen_meeting   uuid references pulse_meetings(id),
  last_touched_meeting uuid references pulse_meetings(id),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists pulse_blockers_open on pulse_blockers (raised_at)
  where status not in ('resolved_in_room','dropped');

-- A blocker resolved in the room needs the resolution written down. One that is
-- not returns next week as the same blocker with its age reset to one, which is
-- precisely the failure that ageing exists to make visible.
alter table pulse_blockers drop constraint if exists pulse_blockers_resolution_required;
alter table pulse_blockers add constraint pulse_blockers_resolution_required
  check (status <> 'resolved_in_room' or btrim(coalesce(resolution,'')) <> '');

create table if not exists pulse_blocker_events (
  id          bigserial primary key,
  blocker_id  uuid not null references pulse_blockers(id) on delete cascade,
  meeting_id  uuid references pulse_meetings(id),
  from_status text,
  to_status   text not null,
  reason      text,
  quote       text,
  age_weeks   int,
  at          timestamptz not null default now()
);

alter table pulse_blockers       enable row level security;
alter table pulse_blocker_events enable row level security;

do $$
declare t text;
begin
  foreach t in array array['pulse_blockers','pulse_blocker_events']
  loop
    execute format('drop policy if exists %I on %I', t || '_read', t);
    execute format('create policy %I on %I for select using (auth.role() = ''authenticated'')', t || '_read', t);
    execute format('drop policy if exists %I on %I', t || '_write', t);
    execute format(
      'create policy %I on %I for all using (pulse_is_admin() or auth.role() = ''service_role'') '
      || 'with check (pulse_is_admin() or auth.role() = ''service_role'')', t || '_write', t);
  end loop;
end $$;

-- A department owner may raise and update a blocker their own team is blocked
-- by. Raising a dependency is not an admin act - being unable to is the exact
-- reason blockers end up buried inside one team's written update.
drop policy if exists pulse_blockers_own on pulse_blockers;
create policy pulse_blockers_own on pulse_blockers for all
  using (pulse_owns_dept(raised_by)) with check (pulse_owns_dept(raised_by));

-- ===========================================================================
-- 9. This week in numbers
-- ===========================================================================
-- Three to five headline counts with captions - "5 new US brand POCs in
-- production". They map onto the dashboard's tiles and no sheet produces them.

create table if not exists pulse_week_numbers (
  id           bigserial primary key,
  meeting_kind text not null default 'wbr',
  week_of      date not null,
  -- [{ "value": "5", "caption": "new US brand POCs in production" }, ...]
  items        jsonb not null default '[]'::jsonb,
  entered_by   text,
  updated_at   timestamptz not null default now(),
  unique (meeting_kind, week_of)
);
alter table pulse_week_numbers enable row level security;

drop policy if exists pulse_week_numbers_read on pulse_week_numbers;
create policy pulse_week_numbers_read on pulse_week_numbers for select using (pulse_is_signed_in());
drop policy if exists pulse_week_numbers_write on pulse_week_numbers;
create policy pulse_week_numbers_write on pulse_week_numbers for all
  using (pulse_is_signed_in()) with check (pulse_is_signed_in());

-- ===========================================================================
-- 10. Top 3 priorities for next week, per person
-- ===========================================================================
-- Forward commitments with a name on them. Stored per department per week so
-- "who has not filled this in" is a query rather than a reading exercise - the
-- failure mode being that a hand-written section gets items from exactly one
-- lead out of several and nothing says so.

create table if not exists pulse_priorities (
  id         bigserial primary key,
  dept_id    text not null references pulse_departments(id),
  owner_name text,
  week_of    date not null,
  items      jsonb not null default '[]'::jsonb,
  entered_by text,
  updated_at timestamptz not null default now(),
  unique (dept_id, week_of)
);
alter table pulse_priorities enable row level security;

drop policy if exists pulse_priorities_read on pulse_priorities;
create policy pulse_priorities_read on pulse_priorities for select using (pulse_is_signed_in());
drop policy if exists pulse_priorities_write on pulse_priorities;
create policy pulse_priorities_write on pulse_priorities for all
  using (pulse_owns_dept(dept_id)) with check (pulse_owns_dept(dept_id));

-- ===========================================================================
-- 11. Seed - the five departments and nine sources from config/
-- ===========================================================================
-- config/*.json is the seed; once deployed the same rows live here and
-- department heads edit them through the UI. Without this the intake screens
-- have nothing to foreign-key against on day one.

insert into pulse_departments (id, pillar, label) values
  ('india_sales',    'revenue', 'India Sales'),
  ('us_sales',       'revenue', 'US Sales'),
  ('perf_marketing', 'revenue', 'Performance Marketing'),
  ('sloosh',         'product', 'Sloosh Product & Marketing'),
  ('hiring',         'people',  'Hiring')
on conflict (id) do nothing;

insert into pulse_sections (id, label, blurb, ord) values
  ('scoreboard', 'Scoreboard', 'Against target, by line of business. Two minutes.', 1),
  ('lines',      'Lines of business', 'Each team''s rings. Read before the meeting, not presented in it.', 2),
  ('blockers',   'Blockers and dependencies', 'Who is waiting on whom. This is the part the room is for.', 3),
  ('decisions',  'Decisions', 'Carried forward, changed, closed.', 4)
on conflict (id) do nothing;

-- ref stays at the placeholder on purpose. An unconnected source must read as
-- unconnected on the setup screen, which is what puts it on somebody's list.
insert into pulse_sources (id, dept_id, kind, label, ref, tab, header_row, date_column, row_timestamp_column, segment) values
  ('india_crm',         'india_sales',    'gsheet',   'India pipeline',         'REPLACE_WITH_SPREADSHEET_ID', 'Deals', 1, 'updated_on', 'updated_on', null),
  ('india_crm_created', 'india_sales',    'gsheet',   'India pipeline created', 'REPLACE_WITH_SPREADSHEET_ID', 'Deals', 1, 'created_on', 'updated_on', null),
  ('us_crm',            'us_sales',       'gsheet',   'US pipeline',            'REPLACE_WITH_SPREADSHEET_ID', 'Deals', 1, 'updated_on', 'updated_on', null),
  ('us_crm_created',    'us_sales',       'gsheet',   'US pipeline created',    'REPLACE_WITH_SPREADSHEET_ID', 'Deals', 1, 'created_on', 'updated_on', null),
  ('ads_india',         'perf_marketing', 'gsheet',   'Paid media - India',     'REPLACE_WITH_SPREADSHEET_ID', null,    1, 'date',       null,         'india'),
  ('ads_us',            'perf_marketing', 'gsheet',   'Paid media - US',        'REPLACE_WITH_SPREADSHEET_ID', null,    1, 'date',       null,         'us'),
  ('sloosh_db',         'sloosh',         'postgres', 'Sloosh product data',    'SLOOSH_DB_URL',               null,    1, 'created_at', 'updated_at', null),
  ('sloosh_board',      'sloosh',         'notion',   'Sloosh delivery board',  'REPLACE_WITH_DATABASE_ID',    null,    1, 'Done on',    '_last_edited', null),
  ('hiring_tracker',    'hiring',         'gsheet',   'Hiring tracker',         'REPLACE_WITH_SPREADSHEET_ID', 'Roles', 1, 'updated_on', 'updated_on', null)
on conflict (id) do nothing;

-- ===========================================================================
-- 12. Read models for the setup screens
-- ===========================================================================

-- What `pulse check` prints, as a query. The landing page and the CLI must
-- never disagree about whose turn it is to do something.
create or replace view pulse_setup_owed as
  select d.id as dept_id, d.label as dept_label,
         coalesce(d.owner_name, '[OWNER NEEDED]') as owner_name,
         (select count(*) from pulse_sources s
            where s.dept_id = d.id and (s.ref is null or s.ref like 'REPLACE_WITH%')) as sources_unconnected,
         (select count(*) from pulse_metrics m
            where m.dept_id = d.id and m.active and m.target is null) as targets_unset,
         (case when d.owner_name is null or d.owner_name = '[OWNER NEEDED]' then 1 else 0 end) as owner_unnamed
  from pulse_departments d;

-- A brand or track sitting on red all week is a decision waiting to be made.
create or replace view pulse_status_week as
  select s.id as subject_id, s.label, s.kind, s.dept_id,
         count(c.*) filter (where c.set_for > current_date - 7) as calls_this_week,
         count(c.*) filter (where c.set_for > current_date - 7 and c.status = 'R') as reds_this_week,
         max(c.set_for) as last_called
  from pulse_status_subjects s
  left join pulse_status_calls c on c.subject_id = s.id
  where s.active
  group by s.id, s.label, s.kind, s.dept_id;

-- ===========================================================================
-- 13. Realtime
-- ===========================================================================
do $$
declare t text;
begin
  foreach t in array array['pulse_status_calls','pulse_uploads','pulse_extraction_drafts','pulse_blockers']
  loop
    begin
      execute format('alter publication supabase_realtime add table %I', t);
    exception when duplicate_object then null;
    end;
  end loop;
end $$;
