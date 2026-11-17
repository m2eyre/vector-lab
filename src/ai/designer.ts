import { combineSeed, RNG } from '../core/rng';
import { ToolCounts } from '../game/level';
import { DeviceType } from '../physics/types';
import { maxSimilarity, Signature, signatureOf, SIMILARITY_LIMIT } from '../gen/signature';
import { ChallengeSpec, EXCLUSIVE_GROUPS, ModifierId, TEMPLATES, TemplateId, TEMPLATE_IDS, validateSpec } from '../gen/spec';

/**
 * Challenge designer boundary.
 *
 *   designer (rule-based or AI)  ->  ChallengeSpec JSON  ->  generator  ->  physics validation
 *
 * A designer only ever returns a ChallengeSpec. It cannot place geometry or run code, and
 * everything it returns passes through validateSpec() before the generator sees it.
 *
 * The rule-based designer below runs in the browser (offline play, Unlimited Mode) and is
 * the server's fallback. The AI designer lives on the server only (server/ai.ts), because it
 * needs a private API key; its output goes through the stricter validateSpecStrict().
 */
export interface DesignRequest {
  seed: number;
  difficulty: number;
  /** Signatures of recently played challenges, oldest first. */
  history: Signature[];
  allowedTemplates?: TemplateId[];
  allowedModifiers?: ModifierId[];
  allowedTools?: DeviceType[];
  /** Force a template (the daily schedule uses this to guarantee rotation). */
  template?: TemplateId;
  /** How many modifiers to aim for; defaults from difficulty. */
  modifierCount?: number;
}

export interface ChallengeDesigner {
  readonly name: string;
  design(req: DesignRequest): Promise<ChallengeSpec>;
}

/** Tool kits: which generators a level offers is itself a source of variety. */
const KITS: { name: string; tools: Partial<ToolCounts> }[] = [
  { name: 'pull', tools: { attractor: 2 } },
  { name: 'push', tools: { repulsor: 2 } },
  { name: 'stream', tools: { field: 2 } },
  { name: 'push-pull', tools: { attractor: 1, repulsor: 1 } },
  { name: 'spin', tools: { vortex: 1, attractor: 1 } },
  { name: 'stream-pull', tools: { field: 1, attractor: 1 } },
  { name: 'stream-spin', tools: { field: 1, vortex: 1 } },
  { name: 'trio', tools: { attractor: 1, repulsor: 1, field: 1 } },
  { name: 'full', tools: { attractor: 1, repulsor: 1, vortex: 1, field: 1 } },
  { name: 'double-stream', tools: { field: 2, attractor: 1 } },
];

const ADJECTIVES: Partial<Record<ModifierId, string[]>> = {
  bumpers: ['Pinball', 'Ricochet'], hazards: ['Volatile', 'Plasma'], movers: ['Clockwork', 'Restless'],
  gel: ['Viscous', 'Slow'], ice: ['Superfluid', 'Glass'], crosswind: ['Crosswind', 'Gale'],
  frictionless: ['Frictionless', 'Zero-Drag'], heavy: ['Heavy', 'Dense'], light: ['Featherweight', 'Drift'],
  launched: ['Hot-Start', 'Runaway'], tightClock: ['Rapid', 'Countdown'], lowPower: ['Brownout', 'Low-Power'],
};
const PLAIN_ADJ = ['Quiet', 'First', 'Clean', 'Open', 'Baseline', 'Calibrated'];
const NOUNS: Record<TemplateId, string[]> = {
  direct: ['Detour', 'Bend', 'Bypass'], narrow: ['Needle', 'Keyhole', 'Slipstream'], collect: ['Circuit', 'Sweep', 'Rounds'],
  precision: ['Touchdown', 'Soft Dock', 'Feather Landing'], gate: ['Airlock', 'Shutter', 'Interval'], avoid: ['Minefield', 'Corridor', 'Slalom'],
  sync: ['Rendezvous', 'Unison', 'Twin Arrival'], chain: ['Break Shot', 'Relay', 'Carom'], split: ['Divergence', 'Fork', 'Parting'],
  survive: ['Containment', 'Holding Pattern', 'Orbit Keep'],
};

/**
 * Deterministic rule-based designer. This is the production designer today and also the
 * fallback whenever a remote AI designer is unavailable or returns something invalid.
 */
export class RuleBasedDesigner implements ChallengeDesigner {
  readonly name = 'rule-based';

  async design(req: DesignRequest): Promise<ChallengeSpec> {
    return this.designSync(req);
  }

  designSync(req: DesignRequest): ChallengeSpec {
    let best: ChallengeSpec | null = null;
    let bestSim = Infinity;
    // Propose several concepts and keep the one least like recent history.
    for (let attempt = 0; attempt < 14; attempt++) {
      const spec = this.propose(req, new RNG(combineSeed(req.seed, `design-${attempt}`)));
      const sim = maxSimilarity(signatureOf(spec), req.history);
      if (sim < bestSim) { best = spec; bestSim = sim; }
      if (sim < SIMILARITY_LIMIT) break;
    }
    return best!;
  }

  private propose(req: DesignRequest, rng: RNG): ChallengeSpec {
    const difficulty = Math.max(1, Math.min(5, Math.round(req.difficulty)));
    const templates = req.allowedTemplates?.length ? req.allowedTemplates : TEMPLATE_IDS;
    const recent = req.history.slice(-2).map((h) => h.template);
    let fresh = templates.filter((t) => !recent.includes(t));
    // With very few templates unlocked, at least avoid repeating the previous one.
    if (!fresh.length) fresh = templates.filter((t) => t !== recent[recent.length - 1]);
    const template = req.template ?? rng.pick(fresh.length ? fresh : templates);
    const info = TEMPLATES[template];

    const objectCount = info.objects[0] === info.objects[1] ? info.objects[0] : difficulty >= 4 && rng.chance(0.6) ? info.objects[1] : info.objects[0];

    // Modifiers: more of them as difficulty rises, never two from an exclusive group.
    const wanted = req.modifierCount ?? (difficulty <= 1 ? 0 : difficulty <= 3 ? 1 : 2);
    const pool = rng.shuffle(info.modifiers.filter((m) => !req.allowedModifiers || req.allowedModifiers.includes(m)));
    const modifiers: ModifierId[] = [];
    for (const m of pool) {
      if (modifiers.length >= wanted) break;
      if (EXCLUSIVE_GROUPS.some((g) => g.includes(m) && g.some((x) => modifiers.includes(x)))) continue;
      modifiers.push(m);
    }

    // Tools: pick a kit that only uses allowed generators.
    const allowed = req.allowedTools ?? (['attractor', 'repulsor', 'vortex', 'field'] as DeviceType[]);
    let kits = KITS.filter((k) => Object.keys(k.tools).every((t) => allowed.includes(t as DeviceType)));
    if (difficulty <= 1) kits = kits.filter((k) => k.tools.attractor) .concat(kits.filter((k) => k.name === 'full'));
    if (!kits.length) kits = [{ name: 'pull', tools: { attractor: 2 } }];
    const kit = rng.pick(kits);
    const tools: ToolCounts = { attractor: 0, repulsor: 0, vortex: 0, field: 0, ...kit.tools };
    // Multi-object levels need at least one device per object to be fair.
    let total = tools.attractor + tools.repulsor + tools.vortex + tools.field;
    const need = Math.max(2, objectCount + (template === 'collect' ? 1 : 0));
    const present = (Object.keys(kit.tools) as DeviceType[]);
    while (total < need) { tools[rng.pick(present)]++; total++; }
    const maxDevices = Math.min(4, total);

    const adj = modifiers.length ? rng.pick(ADJECTIVES[rng.pick(modifiers)] ?? PLAIN_ADJ) : rng.pick(PLAIN_ADJ);
    const title = `${adj} ${rng.pick(NOUNS[template])}`;
    const concept = `${info.blurb} Kit: ${kit.name}.`;
    const checked = validateSpec({ version: 1, seed: req.seed, title, concept, template, difficulty, objectCount, modifiers, tools, maxDevices });
    if (!checked.ok) throw new Error(`rule-based designer produced an invalid spec: ${checked.errors.join(', ')}`);
    return checked.spec;
  }
}

/** Mock of an AI designer for demos and tests: returns canned specs, clearly not a real model. */
export class MockAIDesigner implements ChallengeDesigner {
  readonly name = 'mock-ai';
  constructor(private canned: unknown[], private fallback = new RuleBasedDesigner()) {}
  async design(req: DesignRequest): Promise<ChallengeSpec> {
    const raw = this.canned[req.seed % Math.max(1, this.canned.length)];
    const checked = validateSpec({ ...(raw as object), seed: req.seed });
    return checked.ok ? checked.spec : this.fallback.design(req);
  }
}
