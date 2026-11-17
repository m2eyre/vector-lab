import { BackendConfig } from './backend';

export interface AuthState {
  status: 'loading' | 'guest' | 'signedIn';
  userId: string | null;
  email: string | null;
}

/** Sign-in boundary. Guests simply never sign in; nothing in the game requires an account. */
export interface AuthService {
  readonly kind: 'supabase' | 'dev';
  getState(): AuthState;
  subscribe(listener: () => void): () => void;
  getToken(): Promise<string | null>;
  /** Email a one-time code / sign-in link. */
  sendCode(email: string): Promise<void>;
  verifyCode(email: string, code: string): Promise<void>;
  /** Dev server only. */
  devLogin(name: string): Promise<void>;
  signOut(): Promise<void>;
}

abstract class BaseAuth {
  protected state: AuthState = { status: 'loading', userId: null, email: null };
  private listeners = new Set<() => void>();
  getState = (): AuthState => this.state;
  subscribe = (l: () => void): (() => void) => { this.listeners.add(l); return () => this.listeners.delete(l); };
  protected set(next: AuthState): void {
    if (next.status === this.state.status && next.userId === this.state.userId) return;
    this.state = next;
    this.listeners.forEach((l) => l());
  }
}

/**
 * Supabase Auth with passwordless email. The same email both creates the account and signs
 * in on other devices. Uses only the public anon key. (Not exercised against a live project
 * in this repository's tests; see README.)
 */
export class SupabaseAuth extends BaseAuth implements AuthService {
  readonly kind = 'supabase' as const;
  private client: Promise<import('@supabase/supabase-js').SupabaseClient>;

  constructor(url: string, anonKey: string) {
    super();
    this.client = import('@supabase/supabase-js').then(({ createClient }) => {
      const c = createClient(url, anonKey, { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, storageKey: 'vectorlab.auth' } });
      c.auth.onAuthStateChange((_event, session) => {
        this.set(session ? { status: 'signedIn', userId: session.user.id, email: session.user.email ?? null } : { status: 'guest', userId: null, email: null });
      });
      c.auth.getSession().then(({ data }) => {
        const s = data.session;
        this.set(s ? { status: 'signedIn', userId: s.user.id, email: s.user.email ?? null } : { status: 'guest', userId: null, email: null });
      });
      return c;
    });
    this.client.catch(() => this.set({ status: 'guest', userId: null, email: null }));
  }

  async getToken(): Promise<string | null> {
    const { data } = await (await this.client).auth.getSession();
    return data.session?.access_token ?? null;
  }
  async sendCode(email: string): Promise<void> {
    const redirect = typeof location !== 'undefined' ? `${location.origin}${location.pathname}` : undefined;
    const { error } = await (await this.client).auth.signInWithOtp({ email, options: { shouldCreateUser: true, emailRedirectTo: redirect } });
    if (error) throw new Error(error.message);
  }
  async verifyCode(email: string, code: string): Promise<void> {
    const { error } = await (await this.client).auth.verifyOtp({ email, token: code.trim(), type: 'email' });
    if (error) throw new Error(error.message);
  }
  async devLogin(): Promise<void> { throw new Error('Dev login is only available on the local dev server.'); }
  async signOut(): Promise<void> { await (await this.client).auth.signOut(); }
}

const DEV_KEY = 'vectorlab.dev.session';

/** Local dev server sign-in: pick a name, get a throwaway account. Not a production method. */
export class DevAuth extends BaseAuth implements AuthService {
  readonly kind = 'dev' as const;
  private token: string | null = null;

  constructor(private config: BackendConfig) {
    super();
    try {
      const saved = JSON.parse(globalThis.localStorage?.getItem(DEV_KEY) ?? 'null');
      if (saved?.token && saved?.userId) { this.token = saved.token; this.state = { status: 'signedIn', userId: saved.userId, email: null }; return; }
    } catch { /* ignore */ }
    this.state = { status: 'guest', userId: null, email: null };
  }

  async getToken(): Promise<string | null> { return this.token; }
  async sendCode(): Promise<void> { throw new Error('Email sign-in needs a Supabase project. Use the dev login on this server.'); }
  async verifyCode(): Promise<void> { throw new Error('Email sign-in needs a Supabase project.'); }
  async devLogin(name: string): Promise<void> {
    const res = await fetch(`${this.config.apiUrl}/dev/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name }) });
    const body = await res.json().catch(() => null);
    if (!res.ok || !body?.token) throw new Error(body?.error ?? 'Dev login failed.');
    this.token = body.token;
    try { globalThis.localStorage?.setItem(DEV_KEY, JSON.stringify({ token: body.token, userId: body.userId })); } catch { /* ignore */ }
    this.set({ status: 'signedIn', userId: body.userId, email: null });
  }
  async signOut(): Promise<void> {
    this.token = null;
    try { globalThis.localStorage?.removeItem(DEV_KEY); } catch { /* ignore */ }
    this.set({ status: 'guest', userId: null, email: null });
  }
}

export function createAuth(config: BackendConfig): AuthService {
  return config.supabaseUrl && config.anonKey ? new SupabaseAuth(config.supabaseUrl, config.anonKey) : new DevAuth(config);
}
