/**
 * Everything the Supabase Edge Function needs, bundled into one file by `npm run build:edge`.
 * The Anthropic SDK is deliberately not included: it imports Node modules (child_process,
 * worker_threads) that the Edge runtime may not provide. AI-designed dailies are published by
 * the CLI / GitHub Action publisher (server/scripts/publish.ts); the Edge Function publishes
 * procedurally when asked (/cron/publish) or when a day has nothing published.
 */
export { createApi } from './api';
export { SupabaseAuthenticator } from './auth';
export { connect } from './db';
