import { readFileSync } from 'node:fs';
import postgres from 'postgres';
import { createApi, ApiContext } from '../../server/api';
import { DevAuthenticator } from '../../server/auth';

export const TEST_DB = process.env.TEST_DATABASE_URL ?? 'postgres://vl:vl@127.0.0.1:5432/vectorlab_test';

/** Fresh schema in an isolated Postgres schema-per-suite database state. */
export async function freshDatabase() {
  const sql = postgres(TEST_DB, { max: 4, prepare: false, onnotice: () => {} });
  await sql.unsafe('drop schema if exists public cascade; create schema public; drop schema if exists auth cascade; create extension if not exists pgcrypto;');
  await sql.unsafe(readFileSync('server/dev/local-auth-stub.sql', 'utf8'));
  await sql.unsafe(readFileSync('supabase/migrations/0001_init.sql', 'utf8'));
  return sql;
}

export function testApi(sql: postgres.Sql, over: Partial<ApiContext> = {}) {
  const devAuth = new DevAuthenticator('test-secret');
  const handle = createApi({ sql, auth: devAuth, devAuth, model: null, cronSecret: 'cron-test', ...over });
  const call = async (method: string, path: string, opts: { token?: string; body?: unknown; headers?: Record<string, string> } = {}) => {
    const headers: Record<string, string> = { ...(opts.headers ?? {}) };
    if (opts.token) headers.authorization = `Bearer ${opts.token}`;
    if (opts.body !== undefined) headers['content-type'] = 'application/json';
    const res = await handle(new Request(`http://test.local/functions/v1/api${path}`, { method, headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body) }));
    return { status: res.status, body: await res.json() as any };
  };
  const login = async (name: string) => (await call('POST', '/dev/login', { body: { name } })).body as { token: string; userId: string };
  return { call, login };
}
