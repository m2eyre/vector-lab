import { ChallengeSpec, TEMPLATES } from '../gen/spec';

/** Objective summary from a spec alone (no generated level needed), for menus. */
export function objectiveTextForTemplate(spec: ChallengeSpec): string {
  switch (spec.template) {
    case 'collect': return 'Sweep one object through every target.';
    case 'sync': return `Land ${spec.objectCount} objects in their targets at the same moment.`;
    case 'split': return `Separate ${spec.objectCount} objects into their matching targets.`;
    case 'chain': return 'Strike a shielded payload into the target.';
    case 'survive': return 'Keep a runaway object out of the plasma.';
    case 'precision': return 'Dock the object gently: arrive too fast and it will not lock.';
    case 'gate': return 'Guide the object through a gate that opens on a cycle.';
    case 'avoid': return 'Guide the object through a field of hazards.';
    case 'narrow': return 'Thread the object through a narrow gap to the target.';
    default: return TEMPLATES[spec.template].blurb;
  }
}
