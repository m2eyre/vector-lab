-- LOCAL TESTING ONLY. Supabase provides the `auth` schema; a plain Postgres does not.
-- This creates the minimum the migration refers to so it can be applied and tested locally.
create schema if not exists auth;
create table if not exists auth.users (
  id uuid primary key default gen_random_uuid(),
  email text unique,
  created_at timestamptz not null default now()
);
create or replace function auth.uid() returns uuid language sql stable as
$$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
