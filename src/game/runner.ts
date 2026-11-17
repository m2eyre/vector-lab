import { Simulation } from '../physics/simulation';
import { Device } from '../physics/types';
import { Level } from './level';
import { FailReason, ObjectiveTracker, RunState } from './objectives';

export interface HeadlessResult {
  state: RunState;
  failReason: FailReason | null;
  time: number;
  energy: number;
  fitness: number;
  steps: number;
}

/**
 * Runs a level to completion with no rendering. Used by the solver, the tests and replay
 * verification. It always terminates: the tracker fails a run on timeout or when it stalls.
 */
export function runHeadless(level: Level, devices: Device[]): HeadlessResult {
  const sim = new Simulation(level, devices);
  sim.collectEvents = false;
  const tracker = new ObjectiveTracker(level, sim);
  // Same order as the live game loop: step, then evaluate the objective.
  do sim.step(); while (tracker.update() === 'running');
  return {
    state: tracker.state,
    failReason: tracker.failReason,
    time: tracker.finishTime,
    energy: sim.energy,
    fitness: tracker.fitness(),
    steps: sim.steps,
  };
}
