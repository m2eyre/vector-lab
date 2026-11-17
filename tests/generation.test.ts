import { describe, expect, it } from 'vitest';
import { MockAIDesigner, RuleBasedDesigner } from '../src/ai/designer';
import sample from '../src/ai/sampleSpec.json';
import { runHeadless } from '../src/game/runner';
import { generateLevel } from '../src/gen/generator';
import { maxSimilarity, Signature, signatureOf, similarity, SIMILARITY_LIMIT } from '../src/gen/signature';
import { TEMPLATE_IDS, validateSpec } from '../src/gen/spec';
import { buildCandidate } from '../src/gen/templates';
import { validateLevel } from '../src/gen/validate';

const designer = new RuleBasedDesigner();

describe('procedural generation', () => {
  it('the same seed always produces the same level', () => {
    for (const template of ['narrow', 'avoid', 'sync'] as const) {
      const spec = designer.designSync({ seed: 4242, difficulty: 3, history: [], template });
      const a = generateLevel(spec);
      const b = generateLevel(designer.designSync({ seed: 4242, difficulty: 3, history: [], template }));
      expect(JSON.stringify(a.level)).toBe(JSON.stringify(b.level));
      expect(JSON.stringify(a.solution)).toBe(JSON.stringify(b.solution));
    }
    const other = generateLevel(designer.designSync({ seed: 4243, difficulty: 3, history: [], template: 'narrow' }));
    const same = generateLevel(designer.designSync({ seed: 4242, difficulty: 3, history: [], template: 'narrow' }));
    expect(JSON.stringify(other.level)).not.toBe(JSON.stringify(same.level));
  });

  it('every template yields valid, non-trivial, mostly solver-verified levels', () => {
    let verified = 0;
    let total = 0;
    for (const template of TEMPLATE_IDS) {
      for (let i = 0; i < 5; i++) {
        const spec = designer.designSync({ seed: 900 + i * 131 + template.length, difficulty: 1 + i, history: [], template });
        const g = generateLevel(spec);
        const report = validateLevel(g.level);
        expect(report.errors, `${template} #${i}`).toEqual([]);
        expect(runHeadless(g.level, []).state, `${template} #${i} must not solve itself`).toBe('failed');
        total++;
        if (g.level.verified) {
          verified++;
          // The recorded solution must really work and respect the level's tool limits.
          expect(runHeadless(g.level, g.solution!).state).toBe('success');
          expect(g.solution!.length).toBeLessThanOrEqual(g.level.maxDevices);
          for (const t of ['attractor', 'repulsor', 'vortex', 'field'] as const) {
            expect(g.solution!.filter((d) => d.type === t).length).toBeLessThanOrEqual(g.level.tools[t]);
          }
        }
      }
    }
    expect(verified / total).toBeGreaterThan(0.9);
  });

  it('rejects structurally invalid layouts', () => {
    const spec = designer.designSync({ seed: 7, difficulty: 2, history: [], template: 'direct' });
    const level = buildCandidate(spec, 7);
    expect(validateLevel(level).ok).toBe(true);
    const walled = JSON.parse(JSON.stringify(level));
    walled.walls.push({ x: 480, y: 0, w: 40, h: 640 }); // seals the arena in two
    expect(validateLevel(walled).errors.join(' ')).toMatch(/no route|trapped/);
    const outside = JSON.parse(JSON.stringify(level));
    outside.targets[0].x = 1200;
    expect(validateLevel(outside).ok).toBe(false);
    const buried = JSON.parse(JSON.stringify(level));
    buried.walls.push({ x: buried.bodies[0].x - 30, y: buried.bodies[0].y - 30, w: 60, h: 60 });
    expect(validateLevel(buried).ok).toBe(false);
  });
});

describe('variety', () => {
  it('treats same-structure levels as similar even with different seeds', () => {
    const a = signatureOf(designer.designSync({ seed: 1, difficulty: 2, history: [], template: 'direct', modifierCount: 0 }));
    const b = { ...a };
    expect(similarity(a, b)).toBeCloseTo(1, 6);
    const c: Signature = { ...a, template: 'sync', objective: 'sync', interaction: 'timing', tools: ['field'], modifiers: ['ice'], objects: 2 };
    expect(similarity(a, c)).toBeLessThan(0.3);
  });

  it('a long designed sequence avoids near-duplicates and covers every template', () => {
    const history: Signature[] = [];
    const seen = new Set<string>();
    let tooSimilar = 0;
    for (let i = 0; i < 60; i++) {
      const spec = designer.designSync({ seed: 5000 + i, difficulty: 1 + (i % 5), history });
      const sig = signatureOf(spec);
      if (maxSimilarity(sig, history) >= SIMILARITY_LIMIT) tooSimilar++;
      if (history.length) expect(sig.template).not.toBe(history[history.length - 1].template);
      history.push(sig);
      seen.add(spec.template);
    }
    expect(tooSimilar).toBeLessThanOrEqual(3);
    expect(seen.size).toBe(TEMPLATE_IDS.length);
  });
});

describe('AI designer boundary', () => {
  it('accepts the sample spec and builds a playable level from it', () => {
    const checked = validateSpec(sample);
    expect(checked.ok).toBe(true);
    if (checked.ok) {
      const g = generateLevel(checked.spec);
      expect(validateLevel(g.level).ok).toBe(true);
      expect(g.level.modifiers).toContain('crosswind');
    }
  });
  it('rejects or sanitises hostile specs', () => {
    expect(validateSpec({ template: 'rm -rf', difficulty: 3, seed: 1, tools: { attractor: 1 } }).ok).toBe(false);
    expect(validateSpec({ template: 'direct', difficulty: 99, seed: 1, tools: { attractor: 1 } }).ok).toBe(false);
    expect(validateSpec({ template: 'direct', difficulty: 2, seed: 1, tools: {} }).ok).toBe(false);
    const ok = validateSpec({ template: 'direct', difficulty: 2, seed: 1, tools: { attractor: 50, evil: 3 }, modifiers: ['heavy', 'light'], objectCount: 40, script: 'alert(1)' });
    expect(ok.ok).toBe(true);
    if (ok.ok) {
      expect(ok.spec.tools.attractor).toBe(4);
      expect(ok.spec.modifiers).toEqual(['heavy']);
      expect(ok.spec.objectCount).toBe(1);
      expect('script' in ok.spec).toBe(false);
    }
  });
  it('mock AI designer output still flows through validation', async () => {
    const mock = new MockAIDesigner([sample, { template: 'nonsense' }]);
    expect((await mock.design({ seed: 0, difficulty: 3, history: [] })).template).toBe('narrow');
    const fallback = await mock.design({ seed: 1, difficulty: 3, history: [] });
    expect(TEMPLATE_IDS).toContain(fallback.template);
  });
});
