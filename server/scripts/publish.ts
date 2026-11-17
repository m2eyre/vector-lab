/**
 * Publish daily challenges from any machine that can reach the database (a laptop, a
 * GitHub Action, a cron box). Use this instead of the Edge Function cron when generation
 * needs more CPU time than the Edge runtime allows.
 *
 *   DATABASE_URL=postgres://... ANTHROPIC_API_KEY=... npx tsx server/scripts/publish.ts [--date=YYYY-MM-DD] [--days=2] [--no-ai]
 */
import { isDateKey, shiftDate, utcDateKey } from '../../src/modes/daily';
import { connect, modelFromEnv } from '../config';
import { publishDaily } from '../publish';

const arg = (name: string) => process.argv.find((a) => a.startsWith(`--${name}=`))?.split('=')[1];
const url = process.env.DATABASE_URL ?? process.env.SUPABASE_DB_URL;
if (!url) { console.error('Set DATABASE_URL (or SUPABASE_DB_URL).'); process.exit(1); }
const start = arg('date') ?? utcDateKey();
if (!isDateKey(start)) { console.error('Invalid --date.'); process.exit(1); }
const days = Math.max(1, Math.min(14, Number(arg('days') ?? 2)));
const model = process.argv.includes('--no-ai') ? null : modelFromEnv((k) => process.env[k]);

const sql = connect(url, 1);
try {
  for (let i = 0; i < days; i++) {
    const r = await publishDaily(sql, shiftDate(start, i), { model });
    console.log(`${r.date}: ${r.created ? 'published' : 'already published'} "${r.title}" (${r.source})`);
    for (const e of r.log) console.log(`   [${e.stage}] ${e.outcome}${e.title ? ` "${e.title}"` : ''}${e.reason ? `: ${e.reason}` : ''}`);
  }
} finally {
  await sql.end();
}
