import { ChallengeSpec } from '../gen/spec';
import { Level } from '../game/level';
import { DailyChallenge } from '../modes/daily';
import { SubmitResult } from '../services/online';
import { Replay } from '../services/storage';

export type Session =
  | { mode: 'daily'; level: Level; challenge: DailyChallenge; isToday: boolean }
  | { mode: 'unlimited'; level: Level; spec: ChallengeSpec; levelNumber: number }
  | { mode: 'tutorial'; level: Level }
  /** Watching a saved solution. With `rival`, a second solution runs alongside as a ghost. */
  | { mode: 'replay'; level: Level; replay: Replay; rival?: Replay };

/** What happened to a daily score after the run, as far as the server is concerned. */
export type Submission =
  | { status: 'none' }
  | { status: 'sending' }
  | { status: 'verified'; result: SubmitResult }
  | { status: 'guest' }
  | { status: 'local'; reason: string }
  | { status: 'error'; message: string };

/** Two replays can only be compared if they are solutions to the very same arena. */
export function sameLevel(a: Level, b: Level): boolean {
  return a.seed === b.seed && a.template === b.template && JSON.stringify([a.bodies, a.walls, a.targets, a.hazards]) === JSON.stringify([b.bodies, b.walls, b.targets, b.hazards]);
}
