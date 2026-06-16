-- ============================================================
-- Mission 2028 — UPSC Command Center · Supabase schema
-- Paste into Supabase Studio → SQL Editor → Run. Idempotent.
-- Single-user app, but RLS-locked so data stays private on a public URL.
-- ============================================================

-- Run as a whole. Safe to re-run (uses IF NOT EXISTS / CREATE OR REPLACE).

-- ---------- helper: auto-update updated_at ----------
create or replace function public.set_updated_at()
returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end; $$;

-- ---------- 1. PROFILE ----------
create table if not exists public.profiles (
  id          uuid primary key references auth.users(id) on delete cascade,
  display_name text default 'Om Shisodiya',
  created_at  timestamptz default now()
);

-- ---------- 2. KV STATE (the store seam: focusLog, todos, settings, etc.) ----------
create table if not exists public.app_state (
  user_id uuid not null references auth.users(id) on delete cascade,
  key     text not null,
  value   jsonb not null default '{}'::jsonb,
  updated_at timestamptz default now(),
  primary key (user_id, key)
);

-- ---------- 3. SUBJECTS & TOPICS (UPSC syllabus tree) ----------
create table if not exists public.subjects (
  id        uuid primary key default gen_random_uuid(),
  user_id   uuid not null references auth.users(id) on delete cascade,
  name      text not null,                       -- Polity, Modern History, Geography...
  stage     text not null default 'gs',          -- gs | csat | optional | essay | ethics
  weightage numeric default 1.0,                 -- PYQ-based priority multiplier (editable)
  sort      int default 0,
  created_at timestamptz default now()
);

create table if not exists public.topics (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references auth.users(id) on delete cascade,
  subject_id uuid not null references public.subjects(id) on delete cascade,
  parent_id  uuid references public.topics(id) on delete cascade,  -- self-ref = subtopics
  name       text not null,
  weightage  numeric default 1.0,
  pyq_count  int default 0,                       -- previous-year-question frequency
  sort       int default 0,
  created_at timestamptz default now()
);
create index if not exists topics_subject_idx on public.topics(subject_id);

-- ---------- 4. LECTURES (replaces hardcoded PLAN[]) ----------
create table if not exists public.lectures (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references auth.users(id) on delete cascade,
  subject_id   uuid references public.subjects(id) on delete set null,
  topic_id     uuid references public.topics(id) on delete set null,
  title        text not null,                     -- "Polity — Lecture 12: Fundamental Rights"
  source       text default 'PW · Prarambh',
  sequence     int,                               -- order within subject (for prerequisites)
  duration_min int default 60,
  week         int,
  status       text not null default 'backlog',   -- backlog | upcoming | today | done
  done         boolean not null default false,    -- mirrors store('lectures') doneMap
  done_at      timestamptz,
  created_at   timestamptz default now(),
  updated_at   timestamptz default now()
);
create index if not exists lectures_user_idx on public.lectures(user_id);
create index if not exists lectures_status_idx on public.lectures(user_id, status);
drop trigger if exists lectures_touch on public.lectures;
create trigger lectures_touch before update on public.lectures
  for each row execute function public.set_updated_at();

-- ---------- 5. STUDY SESSIONS (focus timer → real heatmap/streak) ----------
create table if not exists public.study_sessions (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users(id) on delete cascade,
  lecture_id  uuid references public.lectures(id) on delete set null,
  topic_id    uuid references public.topics(id) on delete set null,
  minutes     int not null default 25,
  kind        text default 'focus',               -- focus | revision | mock | reading
  started_at  timestamptz default now(),
  day         date default current_date            -- for fast heatmap aggregation
);
create index if not exists sessions_day_idx on public.study_sessions(user_id, day);

-- ---------- 6. SPACED REPETITION (SM-2 lite) ----------
create table if not exists public.revisions (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references auth.users(id) on delete cascade,
  lecture_id    uuid references public.lectures(id) on delete cascade,
  topic_id      uuid references public.topics(id) on delete cascade,
  ease          numeric not null default 2.5,
  interval_days int not null default 1,
  reps          int not null default 0,
  due_date      date not null default current_date,
  last_review   date,
  created_at    timestamptz default now()
);
create index if not exists revisions_due_idx on public.revisions(user_id, due_date);

-- ---------- 7. MOCK TESTS + SECTIONAL RESULTS ----------
create table if not exists public.mock_tests (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references auth.users(id) on delete cascade,
  name       text not null,
  exam_type  text not null default 'prelims',      -- prelims | csat | mains
  taken_on   date default current_date,
  total_score numeric,
  max_score   numeric,
  created_at timestamptz default now()
);
create table if not exists public.mock_results (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users(id) on delete cascade,
  test_id     uuid not null references public.mock_tests(id) on delete cascade,
  subject     text not null,
  attempted   int default 0,
  correct     int default 0,
  wrong       int default 0,
  score       numeric default 0,                   -- after negative marking
  time_min    int default 0
);
create index if not exists mock_results_test_idx on public.mock_results(test_id);

-- ---------- 8. ANSWER WRITING (Mains practice log) ----------
create table if not exists public.answer_practice (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users(id) on delete cascade,
  topic_id    uuid references public.topics(id) on delete set null,
  question    text not null,
  word_count  int,
  time_min    int,
  score       numeric,                             -- self / mentor score
  rubric      jsonb default '{}'::jsonb,            -- {intro, structure, content, examples, diagram, conclusion}
  written_on  date default current_date,
  created_at  timestamptz default now()
);

-- ---------- 9. CURRENT AFFAIRS ----------
create table if not exists public.current_affairs (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references auth.users(id) on delete cascade,
  topic_id   uuid references public.topics(id) on delete set null,
  headline   text not null,
  note       text,
  source     text,
  ca_date    date default current_date,
  revise     boolean default false,                -- if true, enters SRS
  created_at timestamptz default now()
);
create index if not exists ca_date_idx on public.current_affairs(user_id, ca_date);

-- ---------- 10. PLANNER OUTPUT (Master Planner writes here) ----------
create table if not exists public.plan_days (
  id        uuid primary key default gen_random_uuid(),
  user_id   uuid not null references auth.users(id) on delete cascade,
  day       date not null,
  capacity_min int not null default 0,
  generated_at timestamptz default now(),
  unique (user_id, day)
);
create table if not exists public.plan_blocks (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users(id) on delete cascade,
  plan_day_id uuid not null references public.plan_days(id) on delete cascade,
  lecture_id  uuid references public.lectures(id) on delete set null,
  revision_id uuid references public.revisions(id) on delete set null,
  label       text not null,
  subject     text,
  minutes     int not null default 60,
  kind        text default 'learn',                -- learn | revise | mock | answer
  sort        int default 0,
  done        boolean default false
);
create index if not exists plan_blocks_day_idx on public.plan_blocks(plan_day_id);

-- ---------- 11. RESOURCES (Supabase Storage links per topic) ----------
create table if not exists public.resources (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references auth.users(id) on delete cascade,
  topic_id   uuid references public.topics(id) on delete cascade,
  label      text not null,
  url        text,                                 -- storage path or external link
  created_at timestamptz default now()
);

-- ============================================================
-- ROW LEVEL SECURITY — every table, owner-only
-- ============================================================
do $$
declare t text;
begin
  foreach t in array array[
    'profiles','app_state','subjects','topics','lectures','study_sessions',
    'revisions','mock_tests','mock_results','answer_practice','current_affairs',
    'plan_days','plan_blocks','resources'
  ] loop
    execute format('alter table public.%I enable row level security;', t);
    -- drop existing policy if re-running, then recreate
    execute format('drop policy if exists owner_all on public.%I;', t);
    if t = 'profiles' then
      execute format($f$create policy owner_all on public.%I
        using (id = auth.uid()) with check (id = auth.uid());$f$, t);
    else
      execute format($f$create policy owner_all on public.%I
        using (user_id = auth.uid()) with check (user_id = auth.uid());$f$, t);
    end if;
  end loop;
end $$;

-- ============================================================
-- AUTO-CREATE PROFILE ON SIGNUP
-- ============================================================
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer as $$
begin
  insert into public.profiles (id) values (new.id) on conflict do nothing;
  return new;
end; $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ============================================================
-- ROUTINE FEATURE (pre-Phase 3) — run this block in SQL Editor
-- ============================================================

create table if not exists public.routine_days (
  user_id       uuid not null references auth.users(id) on delete cascade,
  day           date not null,
  day_type      text not null default 'College',
  study_hours   numeric,
  mains_written int,
  attempted     int,
  correct       int,
  wrong         int,
  notes         text,
  updated_at    timestamptz default now(),
  primary key (user_id, day)
);
alter table public.routine_days enable row level security;
drop policy if exists owner_all on public.routine_days;
create policy owner_all on public.routine_days
  using (user_id = auth.uid()) with check (user_id = auth.uid());
create index if not exists routine_days_user_idx on public.routine_days(user_id, day);

-- ============================================================
-- v2 / v3 ADDITIONS — run this block separately in SQL Editor
-- after the initial schema is already in place (idempotent).
-- ============================================================

-- A. Universal Scoring & Ranking (v2) — MCQ columns added in Phase 5
alter table if exists public.scores add column if not exists attempted int;
alter table if exists public.scores add column if not exists correct   int;
alter table if exists public.scores add column if not exists wrong     int;

create table if not exists public.scores (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references auth.users(id) on delete cascade,
  label      text,
  category   text not null default 'mock',  -- prelims|csat|mains|optional|dpp|sectional|quiz
  subject    text,
  score      numeric not null,
  max_score  numeric not null,
  taken_on   date not null default current_date,
  created_at timestamptz default now()
);
alter table public.scores enable row level security;
drop policy if exists owner_all on public.scores;
create policy owner_all on public.scores
  using (user_id = auth.uid()) with check (user_id = auth.uid());
create index if not exists scores_user_date_idx on public.scores(user_id, taken_on);

-- D. Mistake Notebook (v3)
create table if not exists public.mistakes (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references auth.users(id) on delete cascade,
  subject      text,
  question     text not null,
  my_answer    text,
  correct_note text,
  source       text,
  created_at   timestamptz default now()
);
alter table public.mistakes enable row level security;
drop policy if exists owner_all on public.mistakes;
create policy owner_all on public.mistakes
  using (user_id = auth.uid()) with check (user_id = auth.uid());

-- D. Quick Notes (v3)
create table if not exists public.notes (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references auth.users(id) on delete cascade,
  lecture_id uuid references public.lectures(id) on delete cascade,
  topic_id   uuid references public.topics(id) on delete cascade,
  body       text not null,
  created_at timestamptz default now()
);
alter table public.notes enable row level security;
drop policy if exists owner_all on public.notes;
create policy owner_all on public.notes
  using (user_id = auth.uid()) with check (user_id = auth.uid());

-- ============================================================
-- LECTURE PLANNED DATE — per-lecture date assignment for rollover
-- Allows explicit date-pinning of "today" lectures so they cascade
-- to the next day automatically if not completed by midnight IST.
-- Run this in SQL Editor if you haven't yet.
-- ============================================================
alter table public.lectures
  add column if not exists planned_date date;

-- Index for fast rollover queries
create index if not exists lectures_planned_date_idx
  on public.lectures(user_id, planned_date)
  where done = false;

-- ============================================================
-- REALTIME SYNC — cross-device sync for ALL user tables
-- Safe to re-run — exception handler skips tables already in the publication.
-- Ticking a lecture / adding a score / rating a revision on Device A instantly
-- appears on Device B without a manual refresh.
-- ============================================================
do $$
declare t text;
begin
  foreach t in array array[
    'lectures', 'routine_days', 'study_sessions',
    'scores', 'revisions', 'answer_practice', 'current_affairs',
    'mistakes', 'notes', 'app_state'
  ] loop
    begin
      execute format('alter publication supabase_realtime add table public.%I', t);
    exception when others then
      -- error 42710 = duplicate_object (already a member) — safe to ignore
      null;
    end;
  end loop;
end $$;

-- ============================================================
-- DONE. Next: enable magic-link auth in Authentication → Providers,
-- then create a Storage bucket named "resources" (private) for Phase 6.
-- ============================================================
