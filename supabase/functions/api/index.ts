// VECTOR LAB API as a Supabase Edge Function.
//
// server.bundle.js is generated from /server and /src by `npm run build:edge`; run that
// before `supabase functions deploy api`. Secrets are read from the function environment:
//   SUPABASE_URL, SUPABASE_DB_URL                     provided by Supabase automatically
//   SUPABASE_ANON_KEY or SUPABASE_PUBLISHABLE_KEYS      provided by Supabase automatically
//   PUBLIC_API_KEY      optional; your publishable/anon key, only if neither of the above exists
//   CRON_SECRET         required for POST /cron/publish
//   ALLOWED_ORIGIN      optional; restrict CORS to your site's origin
// @ts-nocheck  (this file runs on Deno; the rest of the repo is type-checked with tsc)
import { connect, createApi, SupabaseAuthenticator } from './server.bundle.js';

const env = (k: string) => Deno.env.get(k) || undefined;
const need = (k: string) => {
  const v = env(k);
  if (!v) throw new Error(`Missing environment variable ${k}`);
  return v;
};

// The public key is only used as the `apikey` header when asking Supabase Auth who a token
// belongs to. Projects with the legacy keys disabled have no SUPABASE_ANON_KEY, so fall back
// to the publishable key that Supabase injects, then to a manually set PUBLIC_API_KEY.
function publicKey(): string {
  const legacy = env('SUPABASE_ANON_KEY');
  if (legacy) return legacy;
  try {
    const keys = JSON.parse(env('SUPABASE_PUBLISHABLE_KEYS') ?? '{}');
    const first = keys.default ?? Object.values(keys)[0];
    if (typeof first === 'string' && first) return first;
  } catch { /* fall through */ }
  return need('PUBLIC_API_KEY');
}

// Any setup failure (a missing variable, a bad database URL) is reported as JSON on every
// request instead of crashing the worker, so it can be read straight from /health.
let handle: (req: Request) => Promise<Response>;
try {
  handle = createApi({
    sql: connect(need('SUPABASE_DB_URL'), 2),
    auth: new SupabaseAuthenticator(need('SUPABASE_URL'), publicKey()),
    // The AI designer runs from the GitHub Action publisher, not here (see server/edge-entry.ts).
    model: null,
    cronSecret: env('CRON_SECRET') ?? null,
    allowedOrigin: env('ALLOWED_ORIGIN'),
  });
} catch (err) {
  const message = `API setup failed: ${String((err as Error)?.message ?? err)}`;
  console.error(message);
  handle = async () => new Response(JSON.stringify({ error: message }), {
    status: 500,
    headers: { 'content-type': 'application/json', 'access-control-allow-origin': '*' },
  });
}

Deno.serve((req) => handle(req));
