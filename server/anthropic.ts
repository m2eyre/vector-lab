import Anthropic from '@anthropic-ai/sdk';
import { buildDesignPrompt, CANDIDATES_SCHEMA, DesignBrief, ModelClient } from './ai';

// Kept apart from ai.ts so that the Supabase Edge Function bundle never includes the SDK
// (it pulls in child_process and worker_threads). The AI designer runs from the CLI /
// GitHub Action publisher instead; see server/scripts/publish.ts.

/** Calls the Claude API through the official SDK. Constructed only when ANTHROPIC_API_KEY is set. */
export class AnthropicModelClient implements ModelClient {
  private client: Anthropic;
  constructor(apiKey: string, readonly model = 'claude-opus-5-5') {
    this.client = new Anthropic({ apiKey, maxRetries: 2, timeout: 90_000 });
  }

  async propose(brief: DesignBrief): Promise<unknown> {
    const { system, user } = buildDesignPrompt(brief);
    // Server-side fallbacks: if the primary model declines, the API re-runs the request on
    // Anthropic's recommended fallback model inside the same call.
    const response = await this.client.beta.messages.create({
      model: this.model,
      max_tokens: 16000,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      system,
      messages: [{ role: 'user', content: user }],
      output_config: { effort: 'medium', format: { type: 'json_schema', schema: CANDIDATES_SCHEMA } },
    });
    if (response.stop_reason === 'refusal') throw new Error('model declined the request');
    if (response.stop_reason === 'max_tokens') throw new Error('model output was cut off');
    const text = response.content.filter((b) => b.type === 'text').map((b) => (b as { text: string }).text).join('');
    if (!text) throw new Error('model returned no text');
    return JSON.parse(text);
  }
}

