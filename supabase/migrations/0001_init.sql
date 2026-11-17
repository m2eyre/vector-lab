-- VECTOR LAB online schema.
-- All game writes go through the `api` Edge Function, which connects with the database URL
-- (a server-side secret) and validates everything first. Row Level Security is enabled on
-- every table and no insert/update/delete policy exists, so the public anon key can never
-- write, and can only read what the select policies below allow.

create extension if not exists pgcrypto;

create table if not exists public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  display_name text not null check (char_length(display_name) between 2 and 20),
  friend_code text not null unique,
  skin text not null default 'ion',
  created_at timestamptz not null default now()
);

-- One published challenge per UTC date. `level` is the exact arena every player receives.
create table if not exists public.daily_challenges (
  date date primary key,
  number integer not null unique,
  title text not null,
  difficulty smallint not null check (difficulty between 1 and 5),
  seed bigint not null,
  spec jsonb not null,
  level jsonb not null,
  source text not null check (source in ('ai', 'procedural')),
  generator_version integer not null,
  published_at timestamptz not null default now()
);

-- Private design metadata: similarity signature, pipeline log and the solver's reference
-- solution. Never exposed through the API.
create table if not exists public.challenge_metadata (
  date date primary key references public.daily_challenges (date) on delete cascade,
  signature jsonb not null,
  model text,
  similarity real not null default 0,
  most_similar_to date,
  pipeline jsonb not null default '[]'::jsonb,
  reference_solution jsonb
);

create table if not exists public.replays (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  kind text not null check (kind in ('daily', 'unlimited')),
  date date references public.daily_challenges (date) on delete cascade,
  -- Unlimited replays carry their own level; daily replays use the published one.
  level jsonb,
  label text,
  devices jsonb not null,
  sim jsonb not null,
  score integer not null,
  time real not null,
  energy double precision not null,
  devices_used smallint not null,
  steps integer not null,
  created_at timestamptz not null default now(),
  check ((kind = 'daily' and date is not null) or (kind = 'unlimited' and level is not null))
);
create index if not exists replays_user_idx on public.replays (user_id, created_at desc);

-- Every distinct verified daily submission. The unique key blocks exact duplicates.
create table if not exists public.daily_scores (
  id bigint generated always as identity primary key,
  date date not null references public.daily_challenges (date) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade,
  solution_hash text not null,
  score integer not null check (score between 0 and 100000),
  time real not null,
  energy double precision not null,
  devices_used smallint not null,
  replay_id uuid references public.replays (id) on delete set null,
  created_at timestamptz not null default now(),
  unique (date, user_id, solution_hash)
);
create index if not exists daily_scores_user_idx on public.daily_scores (user_id, created_at desc);

-- One row per player per day: their best result on each ranked metric.
create table if not exists public.leaderboard_entries (
  date date not null references public.daily_challenges (date) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade,
  best_score integer not null,
  score_at timestamptz not null default now(),
  score_replay uuid references public.replays (id) on delete set null,
  best_time real not null,
  time_at timestamptz not null default now(),
  time_replay uuid references public.replays (id) on delete set null,
  best_energy double precision not null,
  energy_at timestamptz not null default now(),
  energy_replay uuid references public.replays (id) on delete set null,
  first_score integer not null,
  attempts integer not null default 1,
  primary key (date, user_id)
);
create index if not exists leaderboard_score_idx on public.leaderboard_entries (date, best_score desc, score_at);
create index if not exists leaderboard_time_idx on public.leaderboard_entries (date, best_time, time_at);
create index if not exists leaderboard_energy_idx on public.leaderboard_entries (date, best_energy, energy_at);

create table if not exists public.unlimited_records (
  user_id uuid primary key references public.profiles (id) on delete cascade,
  highest_level integer not null default 0,
  best_run_score bigint not null default 0,
  longest_run integer not null default 0,
  runs_started integer not null default 0,
  current_run jsonb,
  updated_at timestamptz not null default now()
);

create table if not exists public.player_stats (
  user_id uuid primary key references public.profiles (id) on delete cascade,
  simulations integer not null default 0,
  successes integer not null default 0,
  failures integer not null default 0,
  devices_placed integer not null default 0,
  sim_seconds double precision not null default 0,
  best_score integer not null default 0,
  levels_cleared integer not null default 0,
  by_template jsonb not null default '{}'::jsonb,
  dailies_completed integer not null default 0,
  daily_streak integer not null default 0,
  best_streak integer not null default 0,
  last_completed date,
  updated_at timestamptz not null default now()
);

create table if not exists public.progression (
  user_id uuid primary key references public.profiles (id) on delete cascade,
  unlocks jsonb not null default '[]'::jsonb,
  cosmetics jsonb not null default '[]'::jsonb,
  tutorial_done boolean not null default false,
  updated_at timestamptz not null default now()
);

-- One-directional: user_id follows friend_id (added by friend code).
create table if not exists public.friends (
  user_id uuid not null references public.profiles (id) on delete cascade,
  friend_id uuid not null references public.profiles (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_id, friend_id),
  check (user_id <> friend_id)
);

-- Sliding-window rate limiting for write endpoints.
create table if not exists public.rate_events (
  id bigint generated always as identity primary key,
  user_id uuid not null,
  kind text not null,
  at timestamptz not null default now()
);
create index if not exists rate_events_idx on public.rate_events (user_id, kind, at desc);

alter table public.profiles enable row level security;
alter table public.daily_challenges enable row level security;
alter table public.challenge_metadata enable row level security;
alter table public.replays enable row level security;
alter table public.daily_scores enable row level security;
alter table public.leaderboard_entries enable row level security;
alter table public.unlimited_records enable row level security;
alter table public.player_stats enable row level security;
alter table public.progression enable row level security;
alter table public.friends enable row level security;
alter table public.rate_events enable row level security;

-- Read-only policies. Challenges are visible only once their date has arrived, so a
-- pre-generated challenge for tomorrow cannot be fetched early.
drop policy if exists "published challenges are public" on public.daily_challenges;
create policy "published challenges are public" on public.daily_challenges
  for select using (date <= (now() at time zone 'utc')::date);
drop policy if exists "profiles are public" on public.profiles;
create policy "profiles are public" on public.profiles for select using (true);
drop policy if exists "leaderboards are public" on public.leaderboard_entries;
create policy "leaderboards are public" on public.leaderboard_entries for select using (true);
drop policy if exists "own unlimited record" on public.unlimited_records;
create policy "own unlimited record" on public.unlimited_records for select using (auth.uid() = user_id);
drop policy if exists "own stats" on public.player_stats;
create policy "own stats" on public.player_stats for select using (auth.uid() = user_id);
drop policy if exists "own progression" on public.progression;
create policy "own progression" on public.progression for select using (auth.uid() = user_id);
drop policy if exists "own friends" on public.friends;
create policy "own friends" on public.friends for select using (auth.uid() = user_id);
-- challenge_metadata, replays, daily_scores and rate_events have no policies: API only.
