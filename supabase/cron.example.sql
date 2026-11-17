-- Schedule daily publishing from inside Supabase (run once in the SQL editor after replacing
-- the two placeholders). Requires the pg_cron and pg_net extensions (Database > Extensions).
-- Each run publishes today (if missing) and tomorrow, so tomorrow's challenge always exists
-- about twelve hours before it goes live at 00:00 UTC. The second job is a retry.
select cron.schedule('vector-lab-publish', '0 12 * * *', $$
  select net.http_post(
    url := 'https://YOUR-PROJECT-REF.supabase.co/functions/v1/api/cron/publish',
    headers := jsonb_build_object('content-type', 'application/json', 'x-cron-secret', 'YOUR-CRON-SECRET'),
    body := '{}'::jsonb,
    timeout_milliseconds := 120000);
$$);
select cron.schedule('vector-lab-publish-retry', '0 18 * * *', $$
  select net.http_post(
    url := 'https://YOUR-PROJECT-REF.supabase.co/functions/v1/api/cron/publish',
    headers := jsonb_build_object('content-type', 'application/json', 'x-cron-secret', 'YOUR-CRON-SECRET'),
    body := '{}'::jsonb,
    timeout_milliseconds := 120000);
$$);
