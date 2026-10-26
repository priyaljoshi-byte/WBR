-- ============================================================================
-- TEMPORARY: open write access, for setup day only.
-- ============================================================================
--
-- Run this AFTER schema.sql, schema-app.sql and seed-from-config.sql.
-- (Or just run setup-all.sql, which is all four in order.)
--
-- WHAT THIS DOES
-- It lets anyone who loads the site write to the INTAKE tables, with no login.
-- That is what makes the tool usable today while Google sign-in is still
-- unwired. The site currently has no password either, so in practice this means
-- anyone who finds the URL.
--
-- WHAT IT DELIBERATELY DOES NOT DO
-- It does NOT open pulse_snapshots or pulse_runs (the weekly numbers), and
-- nothing can be DELETED from the meeting record. A setup convenience
-- must not be able to rewrite what the numbers said last week, because the
-- entire value of this system rests on a past week being unchangeable. Intake
-- is replaceable; history is not.
--
-- HOW TO CLOSE IT
-- Scroll to the bottom and run the REVOKE block. Do that tomorrow, after
-- sign-in works. The whole point of a temporary policy is that somebody
-- actually removes it.
-- ============================================================================

-- A marker row, so it is obvious from inside the database that this is on and
-- when it was turned on. A temporary change with no trace is a permanent one.
create table if not exists pulse_open_access_notice (
  id          int primary key default 1,
  opened_at   timestamptz not null default now(),
  opened_by   text,
  reason      text,
  closed_at   timestamptz,
  constraint one_row check (id = 1)
);
insert into pulse_open_access_notice (id, opened_by, reason)
values (1, 'setup', 'Intake open without auth so departments can connect sources before sign-in is wired')
on conflict (id) do update set opened_at = now(), closed_at = null;

-- ---------------------------------------------------------------------------
-- Three tiers. A table not named here stays exactly as schema.sql left it.
-- ---------------------------------------------------------------------------
-- 1. INTAKE - read and write freely. Everything a setup screen saves.
-- 2. MEETING RECORD - read, add and edit, never delete. The Add a meeting
--    screen writes these; pulse_decision_events is add-only, because a log
--    that can be edited is not a log.
-- 3. REFERENCE - read only. The screens need these to render.
-- Closed entirely: pulse_snapshots, pulse_runs (the weekly numbers history)
-- and pulse_roles (who is an admin).
do $$
declare t text;
begin
  foreach t in array array[
    'pulse_sources','pulse_metrics','pulse_cards','pulse_manual_values',
    'pulse_selections','pulse_uploads','pulse_column_mappings','pulse_lists',
    'pulse_status_subjects','pulse_status_calls','pulse_week_numbers',
    'pulse_priorities','pulse_extraction_drafts'
  ]
  loop
    if to_regclass(t) is null then raise notice 'skipping % (does not exist yet)', t; continue; end if;
    execute format('alter table %I enable row level security', t);
    execute format('drop policy if exists %I on %I', t || '_open_today', t);
    execute format('create policy %I on %I for all to anon, authenticated using (true) with check (true)', t || '_open_today', t);
  end loop;

  foreach t in array array['pulse_meetings','pulse_decisions','pulse_notes','pulse_blockers','pulse_blocker_events','pulse_decision_events']
  loop
    if to_regclass(t) is null then raise notice 'skipping % (does not exist yet)', t; continue; end if;
    execute format('alter table %I enable row level security', t);
    execute format('drop policy if exists %I on %I', t || '_open_read', t);
    execute format('create policy %I on %I for select to anon, authenticated using (true)', t || '_open_read', t);
    execute format('drop policy if exists %I on %I', t || '_open_add', t);
    execute format('create policy %I on %I for insert to anon, authenticated with check (true)', t || '_open_add', t);
    if t <> 'pulse_decision_events' then
      execute format('drop policy if exists %I on %I', t || '_open_edit', t);
      execute format('create policy %I on %I for update to anon, authenticated using (true) with check (true)', t || '_open_edit', t);
    end if;
  end loop;

  foreach t in array array['pulse_departments','pulse_sections','pulse_meeting_kinds','pulse_flags']
  loop
    if to_regclass(t) is null then raise notice 'skipping % (does not exist yet)', t; continue; end if;
    execute format('drop policy if exists %I on %I', t || '_open_read', t);
    execute format('create policy %I on %I for select to anon, authenticated using (true)', t || '_open_read', t);
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- Prove the history is still shut.
-- ---------------------------------------------------------------------------
do $$
declare leaked text;
begin
  select string_agg(tablename || '.' || policyname, ', ')
    into leaked
  from pg_policies
  where schemaname = 'public'
    and 'anon' = any(roles)
    and (
      tablename in ('pulse_snapshots','pulse_runs','pulse_roles')
      or (tablename = 'pulse_decision_events' and cmd in ('UPDATE','DELETE','ALL'))
      or (tablename in ('pulse_meetings','pulse_decisions','pulse_notes','pulse_blockers','pulse_blocker_events') and cmd in ('DELETE','ALL'))
    );

  if leaked is not null then
    raise exception 'History is writable by anon: %. Drop these before using the site.', leaked;
  end if;

  raise notice 'History tables remain closed to anonymous writes. Good.';
end $$;

-- A select at the end, so the SQL editor shows a visible result.
select 'Open mode is ON since ' || opened_at::text || ' - run the block at the bottom of schema-open-today.sql to close it.' as status
from pulse_open_access_notice where id = 1;


-- ============================================================================
-- RUN THIS TOMORROW, once sign-in works.
-- ============================================================================
-- Copy from here down into the SQL editor and run it. Nothing else changes;
-- the normal policies in schema.sql take over again.
--
-- do $$
-- declare r record;
-- begin
--   for r in select tablename, policyname from pg_policies
--            where schemaname = 'public' and policyname like 'pulse\_%\_open\_%'
--   loop
--     execute format('drop policy if exists %I on %I', r.policyname, r.tablename);
--   end loop;
-- end $$;
--
-- update pulse_open_access_notice set closed_at = now() where id = 1;
--
-- select case when closed_at is null
--             then 'STILL OPEN - the drop did not run'
--             else 'Closed at ' || closed_at::text
--        end as status
-- from pulse_open_access_notice where id = 1;
-- ============================================================================
