import type { StateStore } from '../state';
import { getRebindResumeAction } from './rebindResume';
import type { SchedulerEngine } from './engine';
import type { ScheduleRecord } from './types';

/**
 * @description Re-base every scheduled job after the operator changes the
 * instance timezone.
 *
 * Why this cannot just call the engine's `rearmAll()`: that is the BOOT replay.
 * It arms each job from its STORED `nextRunAt`, and a `nextRunAt` already in the
 * past is treated as a MISSED run — it fires a catch-up, announcing and pinning
 * "missed at HH:MM" into the topic and delivering the prompt to the agent. After
 * a zone change a stored `nextRunAt` is routinely in the past (moving from UTC
 * to a zone three hours ahead puts every job earlier than it was), so `rearmAll`
 * would spam bogus catch-ups for runs that were never actually missed.
 *
 * The correct sequence is recompute FIRST, then arm: each job's next occurrence
 * is derived from `now` under the new zone (cron expressions are wall-clock, so
 * "every day at 9am" stays 9am and simply lands on a different instant), the
 * fresh value is persisted, and only then is the timer armed — at a strictly
 * future instant, which the engine never mistakes for a missed run.
 *
 * PAUSED jobs are recomputed too. They are skipped by the arm step (the engine
 * leaves a paused job disarmed by design), but their stored `nextRunAt` must
 * still move: otherwise a later resume would arm a stale pre-change instant.
 */

/**
 * @name TimezoneRecomputeDeps
 * @description Everything the recompute needs from the outside world, injected
 * so it is testable against a fake store and a real engine with a fake clock —
 * the only way to assert the load-bearing property, that NO delivery fires.
 */
export interface TimezoneRecomputeDeps {
  store: Pick<StateStore, 'getSchedules' | 'upsertSchedule' | 'removeSchedule' | 'flush'>;
  engine: Pick<SchedulerEngine, 'armJob' | 'disarmJob'>;
  /** Current epoch ms. Injected so tests run on a fake clock. */
  now: () => number;
}

/**
 * @name TimezoneRecomputeResult
 * @description What the pass did, for the `/timezone` confirmation line.
 * `recomputed` counts jobs whose `nextRunAt` was re-derived and persisted;
 * `removed` counts jobs dropped because the new computation left no future
 * occurrence at all.
 */
export interface TimezoneRecomputeResult {
  recomputed: number;
  removed: number;
}

/**
 * @description Recompute + re-arm every persisted job for the new timezone.
 *
 * Per job the decision is {@link getRebindResumeAction} — the SAME rule the
 * rebind path already applies, deliberately reused rather than restated: derive
 * the next occurrence strictly from `now`, and drop the record when there is
 * none (an expired one-shot has no future instant, so it cannot be re-armed and
 * must not linger as a husk).
 *
 * A job's `isPaused` / `pauseReason` are preserved untouched — this pass changes
 * WHEN a job runs, never WHETHER it is active.
 */
export async function recomputeSchedulesForTimezoneChange(
  deps: TimezoneRecomputeDeps,
): Promise<TimezoneRecomputeResult> {
  const { store, engine, now } = deps;
  const nowMs = now();
  const records = Object.values(store.getSchedules());

  let recomputed = 0;
  let removed = 0;

  for (const record of records) {
    const action = getRebindResumeAction(record, nowMs);
    if (action.kind === 'remove') {
      await store.removeSchedule(record.id);
      engine.disarmJob(record.id);
      removed += 1;
      continue;
    }
    const updated: ScheduleRecord = {
      ...record,
      nextRunAt: action.nextRunAt,
      updatedAt: new Date(nowMs).toISOString(),
    };
    await store.upsertSchedule(updated);
    // `armJob` is the single arming authority: it leaves a paused record
    // disarmed, so paused jobs get the fresh `nextRunAt` without waking up.
    engine.armJob(updated);
    recomputed += 1;
  }

  if (records.length > 0) await store.flush();
  return { recomputed, removed };
}
