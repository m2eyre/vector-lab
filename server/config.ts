import { ModelClient } from './ai';
import { AnthropicModelClient } from './anthropic';

/** Shared wiring for the Node entry points (CLI publisher, dev server). Values come from server-side env vars. */
export { connect } from './db';

export function modelFromEnv(env: (k: string) => string | undefined): ModelClient | null {
  const key = env('ANTHROPIC_API_KEY');
  if (!key) return null;
  return new AnthropicModelClient(key, env('AI_DESIGNER_MODEL') || 'claude-opus-5-5');
}
