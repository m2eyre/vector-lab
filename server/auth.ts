/** Who is calling. Implementations turn a bearer token into a user id, or null. */
export interface AuthUser { id: string; email?: string }
export interface Authenticator {
  verify(token: string): Promise<AuthUser | null>;
}

/**
 * Production authenticator: asks Supabase Auth who the access token belongs to. This works
 * with every Supabase signing-key setup and needs only the public URL and anon key.
 */
export class SupabaseAuthenticator implements Authenticator {
  private cache = new Map<string, { user: AuthUser; until: number }>();
  constructor(private url: string, private anonKey: string) {}

  async verify(token: string): Promise<AuthUser | null> {
    const hit = this.cache.get(token);
    if (hit && hit.until > Date.now()) return hit.user;
    const res = await fetch(`${this.url.replace(/\/$/, '')}/auth/v1/user`, {
      headers: { apikey: this.anonKey, authorization: `Bearer ${token}` },
    });
    if (!res.ok) return null;
    const body = await res.json() as { id?: string; email?: string };
    if (!body.id) return null;
    const user = { id: body.id, email: body.email };
    if (this.cache.size > 500) this.cache.clear();
    this.cache.set(token, { user, until: Date.now() + 60_000 });
    return user;
  }
}

const enc = new TextEncoder();
async function hmacHex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(message)));
  return Array.from(sig).map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * LOCAL DEVELOPMENT ONLY. Issues signed tokens for throwaway users so the whole online flow
 * can be exercised without a Supabase project. Never enabled by the Edge Function.
 */
export class DevAuthenticator implements Authenticator {
  constructor(private secret: string) {}
  async issue(userId: string): Promise<string> {
    return `dev.${userId}.${await hmacHex(this.secret, userId)}`;
  }
  async verify(token: string): Promise<AuthUser | null> {
    const m = /^dev\.([0-9a-f-]{36})\.([0-9a-f]{64})$/.exec(token);
    if (!m) return null;
    return (await hmacHex(this.secret, m[1])) === m[2] ? { id: m[1] } : null;
  }
}

export async function sha256Hex(text: string): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(text)));
  return Array.from(d).map((b) => b.toString(16).padStart(2, '0')).join('');
}
