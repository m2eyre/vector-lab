/**
 * Local development server: the same API the Supabase Edge Function serves, on Node, against
 * a local Postgres, with throwaway dev logins instead of Supabase Auth.
 *
 *   npm run db:local      # create the schema in the local database
 *   npm run dev:api       # http://localhost:8787
 *   VITE_API_URL=http://localhost:8787 npm run dev
 */
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { ModelClient } from './ai';
import { createApi } from './api';
import { DevAuthenticator } from './auth';
import { connect, modelFromEnv } from './config';

const env = (k: string) => process.env[k];
const sql = connect(env('DATABASE_URL') ?? 'postgres://vl:vl@127.0.0.1:5432/vectorlab_test');
const devAuth = new DevAuthenticator(env('DEV_AUTH_SECRET') ?? 'local-dev-only-secret');

// Testing aid: VL_FAKE_AI=<file.json> replays a canned model response instead of calling the API.
let model: ModelClient | null = modelFromEnv(env);
if (env('VL_FAKE_AI')) {
  const file = env('VL_FAKE_AI')!;
  model = { model: 'fake-canned', propose: async () => JSON.parse(readFileSync(file, 'utf8')) };
}

const handle = createApi({ sql, auth: devAuth, devAuth, model, cronSecret: env('CRON_SECRET') ?? 'dev-cron-secret' });
const port = Number(env('PORT') ?? 8787);

createServer(async (req, res) => {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) { size += c.length; if (size > 200_000) { res.writeHead(413).end(); return; } chunks.push(c as Buffer); }
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string') headers.set(k, v);
  const body = req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS' ? undefined : Buffer.concat(chunks);
  const response = await handle(new Request(`http://localhost:${port}${req.url}`, { method: req.method, headers, body }));
  res.writeHead(response.status, Object.fromEntries(response.headers.entries()));
  res.end(Buffer.from(await response.arrayBuffer()));
}).listen(port, () => console.log(`[vector-lab] dev API on http://localhost:${port} (AI designer: ${model ? model.model : 'not configured'})`));
