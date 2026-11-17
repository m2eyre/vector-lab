import { EXCLUSIVE_GROUPS, MODIFIER_INFO, TEMPLATES, TEMPLATE_IDS } from '../src/gen/spec';

/**
 * AI challenge designer (server side only).
 *
 * The model is asked for challenge *specifications*: a template id, a difficulty, modifier
 * ids, tool counts and some flavour text. It never produces coordinates, geometry or code.
 * Whatever it returns is treated as untrusted data: publish.ts runs every candidate through
 * validateSpecStrict(), deterministic similarity checks, the procedural generator and the
 * physics solver. The API key is read from the server environment and never reaches the
 * browser.
 */
export interface RecentChallenge {
  date: string;
  title: string;
  template: string;
  difficulty: number;
  objectCount: number;
  modifiers: string[];
  tools: Record<string, number>;
  maxDevices: number;
}

export interface DesignBrief {
  date: string;
  number: number;
  targetDifficulty: number;
  candidates: number;
  /** Recently published challenges, oldest first. */
  recent: RecentChallenge[];
}

export interface ModelClient {
  readonly model: string;
  /** Returns the model's raw, untrusted JSON. May throw when the service is unavailable. */
  propose(brief: DesignBrief): Promise<unknown>;
}

const MODIFIER_IDS = Object.keys(MODIFIER_INFO);

/** JSON Schema the model's output is constrained to. Validation still happens afterwards. */
export const CANDIDATES_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['candidates'],
  properties: {
    candidates: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['title', 'concept', 'template', 'difficulty', 'objectCount', 'modifiers', 'tools', 'maxDevices'],
        properties: {
          title: { type: 'string' },
          concept: { type: 'string' },
          template: { type: 'string', enum: TEMPLATE_IDS },
          difficulty: { type: 'integer' },
          objectCount: { type: 'integer' },
          modifiers: { type: 'array', items: { type: 'string', enum: MODIFIER_IDS } },
          tools: {
            type: 'object',
            additionalProperties: false,
            required: ['attractor', 'repulsor', 'vortex', 'field'],
            properties: {
              attractor: { type: 'integer' }, repulsor: { type: 'integer' },
              vortex: { type: 'integer' }, field: { type: 'integer' },
            },
          },
          maxDevices: { type: 'integer' },
        },
      },
    },
  },
} as const;

const EXAMPLES = [
  { title: 'Glass Keyhole', concept: 'Thread a narrow gap on a zero-drag floor, where every nudge keeps going.', template: 'narrow', difficulty: 3, objectCount: 1, modifiers: ['ice'], tools: { attractor: 1, repulsor: 0, vortex: 0, field: 1 }, maxDevices: 2 },
  { title: 'Brownout Rendezvous', concept: 'Two unequal journeys must end together with weakened generators.', template: 'sync', difficulty: 4, objectCount: 2, modifiers: ['lowPower', 'bumpers'], tools: { attractor: 2, repulsor: 0, vortex: 0, field: 1 }, maxDevices: 3 },
  { title: 'Quiet Carom', concept: 'Strike the shielded payload cleanly with a single push.', template: 'chain', difficulty: 2, objectCount: 2, modifiers: [], tools: { attractor: 0, repulsor: 2, vortex: 0, field: 0 }, maxDevices: 2 },
  { title: 'Gale Circuit', concept: 'Sweep three targets while a crosswind drags the object off line.', template: 'collect', difficulty: 3, objectCount: 1, modifiers: ['crosswind'], tools: { attractor: 1, repulsor: 0, vortex: 1, field: 0 }, maxDevices: 2 },
];

export function buildDesignPrompt(brief: DesignBrief): { system: string; user: string } {
  const templates = TEMPLATE_IDS.map((id) => {
    const t = TEMPLATES[id];
    const objects = t.objects[0] === t.objects[1] ? `${t.objects[0]}` : `${t.objects[0]}-${t.objects[1]}`;
    return `- ${id}: "${t.name}". ${t.blurb} Objective type: ${t.objective}. Core skill: ${t.interaction}. objectCount: ${objects}. Allowed modifiers: ${t.modifiers.join(', ')}.`;
  }).join('\n');
  const modifiers = MODIFIER_IDS.map((id) => `- ${id}: ${MODIFIER_INFO[id as keyof typeof MODIFIER_INFO].rule}.`).join('\n');
  const exclusive = EXCLUSIVE_GROUPS.map((g) => g.join(' / ')).join('; ');
  const system = `You design daily challenges for VECTOR LAB, a top-down 2D physics puzzle game. The player cannot touch the moving objects. Before the simulation starts they place a few force generators, then press run and watch whether the objects reach the goal.

You do not build levels. You write short structured specifications, and a deterministic generator turns a specification into an arena, checks it and proves it solvable with a physics solver. Anything outside the vocabulary below is rejected automatically, so stay strictly inside it.

FORCE GENERATORS (the player's tools)
- attractor: pulls objects toward a point.
- repulsor: pushes objects away from a point.
- vortex: swirls objects around a point while drawing them slowly inward.
- field: a straight strip that pushes objects in one direction.

TEMPLATES (choose exactly one per challenge)
${templates}

MODIFIERS (zero to three per challenge, only ones the chosen template allows)
${modifiers}
Never combine modifiers from the same exclusive group: ${exclusive}.

DIFFICULTY (integer 1 to 5)
1: one clear idea, no modifiers, generous tools.
2: one idea with a small twist; at most one gentle modifier.
3: needs planning; one modifier or a restricted toolkit.
4: two interacting ideas; one or two modifiers and a tight toolkit.
5: expert; two or three modifiers, a minimal toolkit and precise tuning.

TOOLS AND LIMITS
- tools gives how many of each generator the player may place: integers 0 to 3 each, 1 to 6 in total.
- maxDevices is how many generators may be placed in total: 1 to 4 and never more than the total tool count.
- Levels with two or more objects need at least one generator per object.
- A restricted toolkit (one or two generator types) is a strong way to make a challenge feel distinct.

TEXT
- title: 3 to 40 characters, two or three words, letters, digits and spaces only.
- concept: one sentence of 8 to 160 characters describing the idea for the player. Plain text with basic punctuation only.

VARIETY RULES
- Do not reuse the template of any of the three most recent challenges.
- Avoid repeating the same combination of template, modifiers and toolkit as anything in the recent list.
- Each of your candidates must use a different template from your other candidates.
- Prefer a core skill and toolkit that the recent list has not featured lately.`;

  const recent = brief.recent.length
    ? brief.recent.map((r) => `- ${r.date}: ${r.template}, difficulty ${r.difficulty}, modifiers [${r.modifiers.join(', ')}], tools ${JSON.stringify(r.tools)}, maxDevices ${r.maxDevices}`).join('\n')
    : '(none yet)';
  const user = `Design ${brief.candidates} different candidate specifications for daily challenge #${brief.number} (${brief.date}).

Target difficulty: ${brief.targetDifficulty}. Every candidate must be within one step of it.

Recently published challenges, oldest first:
${recent}

Examples of well-formed specifications (do not copy them):
${EXAMPLES.map((e) => JSON.stringify(e)).join('\n')}

Return the candidates in order of preference, best first.`;
  return { system, user };
}

/** Pull the candidate list out of raw model JSON without trusting its shape. */
export function extractCandidates(raw: unknown, limit = 6): unknown[] {
  if (!raw || typeof raw !== 'object') return [];
  const list = (raw as { candidates?: unknown }).candidates;
  return Array.isArray(list) ? list.slice(0, limit) : [];
}
