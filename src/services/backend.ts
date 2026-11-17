/**
 * Connection to the VECTOR LAB API. Only public values live here: the API URL, the Supabase
 * project URL and the Supabase *anon* key (which is designed to be shipped to browsers).
 * No service-role key, database URL or AI key is ever read by frontend code.
 */
export interface BackendConfig {
  apiUrl: string;
  supabaseUrl: string | null;
  anonKey: string | null;
  /** Local dev server: sign in with a throwaway name instead of Supabase Auth. */
  devAuth: boolean;
}

export function readBackendConfig(): BackendConfig | null {
  const env = ((import.meta as any).env ?? {}) as Record<string, string | undefined>;
  // A page can also provide the same public values at runtime (useful for the single-file build).
  const rt = ((globalThis as any).__VECTORLAB_CONFIG__ ?? {}) as Record<string, string | undefined>;
  const supabaseUrl = (rt.supabaseUrl ?? env.VITE_SUPABASE_URL ?? '').replace(/\/$/, '') || null;
  const anonKey = rt.anonKey ?? env.VITE_SUPABASE_ANON_KEY ?? null;
  const explicit = (rt.apiUrl ?? env.VITE_API_URL ?? '').replace(/\/$/, '');
  const apiUrl = explicit || (supabaseUrl ? `${supabaseUrl}/functions/v1/api` : '');
  if (!apiUrl) return null;
  return { apiUrl, supabaseUrl, anonKey: anonKey || null, devAuth: !(supabaseUrl && anonKey) };
}

export class ApiError extends Error {
  constructor(readonly status: number, message: string, readonly details?: unknown, readonly body?: any) { super(message); }
  /** True when the server could not be reached at all (as opposed to refusing the request). */
  get offline(): boolean { return this.status === 0; }
}

export class Backend {
  constructor(readonly config: BackendConfig, private getToken: () => Promise<string | null>) {}

  async request<T>(method: string, path: string, body?: unknown, timeoutMs = 15000): Promise<T> {
    const headers: Record<string, string> = {};
    if (this.config.anonKey) headers.apikey = this.config.anonKey;
    const token = await this.getToken().catch(() => null);
    if (token) headers.authorization = `Bearer ${token}`;
    if (body !== undefined) headers['content-type'] = 'application/json';
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    let res: Response;
    try {
      res = await fetch(`${this.config.apiUrl}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: ctl.signal });
    } catch {
      throw new ApiError(0, 'The server could not be reached.');
    } finally {
      clearTimeout(timer);
    }
    let data: any = null;
    try { data = await res.json(); } catch { /* non-JSON error page */ }
    if (!res.ok) throw new ApiError(res.status, data?.error ?? `Request failed (${res.status}).`, data?.details, data);
    return data as T;
  }
  get<T>(path: string): Promise<T> { return this.request<T>('GET', path); }
  post<T>(path: string, body: unknown): Promise<T> { return this.request<T>('POST', path, body); }
  del<T>(path: string): Promise<T> { return this.request<T>('DELETE', path); }
}
