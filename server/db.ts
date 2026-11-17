import postgres from 'postgres';

/** Database connection shared by every server entry point. The URL is a server-side secret. */
export function connect(url: string, max = 4) {
  // prepare:false keeps this compatible with Supabase's transaction pooler.
  return postgres(url, { max, prepare: false, onnotice: () => {} });
}
