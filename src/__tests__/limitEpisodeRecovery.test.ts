/**
 * @description Unit tests for {@link ../utils/limitEpisodeRecovery} — reading the
 * terminal error out of a json-stream session's `stdout.jsonl` tail, and deciding
 * whether a limit episode that ended BEFORE the bot restarted should be re-armed.
 *
 * The lines below are real stream-json shapes. A provider limit is not inducible on
 * demand, so this table is the load-bearing proof for the boot-recovery path.
 */

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import {
  getLastTerminalErrorText,
  decideLimitEpisodeRecovery,
  limitEpisodeMaxAgeMs,
} from '../utils/limitEpisodeRecovery';
import type { LimitEpisodeMarker } from '../types';

const now = Date.parse('2026-09-24T12:00:00.000Z');
const liveLimitText = "You've hit your session limit · resets 10:50pm (UTC)";

/** The live `stdout.jsonl` identity (size + mtime) a decision is taken against. */
function buildLog(mtimeMs: number, sizeBytes = 4096): LimitEpisodeMarker {
  return { sizeBytes, mtimeMs };
}

/** A terminal `result` frame, error or not. */
function buildResultLine(isError: boolean, text: string): string {
  return JSON.stringify(
    isError ? { type: 'result', is_error: true, result: text } : { type: 'result', is_error: false, result: text },
  );
}

const assistantLine = JSON.stringify({
  type: 'assistant',
  message: { content: [{ type: 'text', text: 'working on it' }] },
});

test('tail: the last terminal error frame wins', () => {
  const tail = [assistantLine, buildResultLine(true, liveLimitText), ''].join('\n');
  assert.equal(getLastTerminalErrorText(tail), liveLimitText);
});

test('tail: reads `api_error_status` in preference to `result` (the adapter\'s own rule)', () => {
  const line = JSON.stringify({ type: 'result', is_error: true, api_error_status: liveLimitText, result: 'x' });
  assert.equal(getLastTerminalErrorText(line), liveLimitText);
});

test('tail: a LATER healthy turn clears the verdict — the session recovered', () => {
  const tail = [
    buildResultLine(true, liveLimitText),
    assistantLine,
    buildResultLine(false, 'all done'),
  ].join('\n');
  assert.equal(getLastTerminalErrorText(tail), null);
});

test('tail: a torn first line (the tail cut mid-JSON) is skipped, not fatal', () => {
  const tail = ['ge":{"content":[{"type":"text"', buildResultLine(true, liveLimitText)].join('\n');
  assert.equal(getLastTerminalErrorText(tail), liveLimitText);
});

test('tail: no terminal frame at all → null', () => {
  assert.equal(getLastTerminalErrorText([assistantLine, assistantLine].join('\n')), null);
  assert.equal(getLastTerminalErrorText(''), null);
});

test('decide: a recent usage-limit error with nothing armed → arm', () => {
  const decision = decideLimitEpisodeRecovery({
    errorText: liveLimitText,
    log: buildLog(now - 60_000),
    now,
    hasArmedRetry: false,
  });
  assert.equal(decision.action, 'arm');
  assert.equal(decision.action === 'arm' ? decision.cls.kind : null, 'usageLimit');
});

test('decide: a thread whose retry is already armed is left alone (no double notice)', () => {
  assert.deepEqual(
    decideLimitEpisodeRecovery({ errorText: liveLimitText, log: buildLog(now - 60_000), now, hasArmedRetry: true }),
    { action: 'skip', reason: 'alreadyArmed' },
  );
});

test('decide: an ANCIENT log is not resurrected', () => {
  assert.deepEqual(
    decideLimitEpisodeRecovery({
      errorText: liveLimitText,
      log: buildLog(now - limitEpisodeMaxAgeMs - 1),
      now,
      hasArmedRetry: false,
    }),
    { action: 'skip', reason: 'stale' },
  );
  // Exactly at the boundary still counts as recent.
  assert.equal(
    decideLimitEpisodeRecovery({
      errorText: liveLimitText,
      log: buildLog(now - limitEpisodeMaxAgeMs),
      now,
      hasArmedRetry: false,
    }).action,
    'arm',
  );
});

test('decide: only the usageLimit class is recovered — transient and auth are not', () => {
  for (const errorText of [
    'API Error: Server is temporarily limiting requests (not your usage limit) · Rate limited',
    'Please run /login to continue',
  ]) {
    assert.deepEqual(
      decideLimitEpisodeRecovery({ errorText, log: buildLog(now - 60_000), now, hasArmedRetry: false }),
      { action: 'skip', reason: 'notUsageLimit' },
      errorText,
    );
  }
});

test('decide: a healthy tail (no error text) → skip', () => {
  assert.deepEqual(
    decideLimitEpisodeRecovery({ errorText: null, log: buildLog(now - 60_000), now, hasArmedRetry: false }),
    { action: 'skip', reason: 'noError' },
  );
});

// ─────────────────────────────────────────────────────────────────────────────
//  The handled-episode marker: recover an episode at most ONCE
// ─────────────────────────────────────────────────────────────────────────────
//
// «⏭ Skip once», a user takeover and a give-up all clear the armed record while
// leaving the SAME trailing error in the log — and hot mode reloads the bot on
// every code change, so without the marker each reload resurrected the settled
// wait. Identity = size + mtime: an unchanged log means nothing has happened.

test('decide: no marker yet → arm (the first boot after the episode)', () => {
  const decision = decideLimitEpisodeRecovery({
    errorText: liveLimitText,
    log: buildLog(now - 60_000),
    handled: undefined,
    now,
    hasArmedRetry: false,
  });
  assert.equal(decision.action, 'arm');
});

test('decide: a marker matching the LIVE log → skip (a reload must not resurrect a settled wait)', () => {
  const log = buildLog(now - 60_000);
  assert.deepEqual(
    decideLimitEpisodeRecovery({ errorText: liveLimitText, log, handled: { ...log }, now, hasArmedRetry: false }),
    { action: 'skip', reason: 'alreadyHandled' },
  );
});

test('decide: a CHANGED log → arm again (either field is enough — new bytes mean a new episode)', () => {
  const handled = buildLog(now - 3_600_000, 4096);
  // Appended frames: bigger file, newer mtime.
  assert.equal(
    decideLimitEpisodeRecovery({
      errorText: liveLimitText,
      log: buildLog(now - 60_000, 8192),
      handled,
      now,
      hasArmedRetry: false,
    }).action,
    'arm',
  );
  // Same size, newer mtime → still a change; the guard needs BOTH to match.
  assert.equal(
    decideLimitEpisodeRecovery({
      errorText: liveLimitText,
      log: buildLog(now - 60_000, 4096),
      handled,
      now,
      hasArmedRetry: false,
    }).action,
    'arm',
  );
  // Same mtime, different size (a truncate-and-reseed) → also a change.
  assert.equal(
    decideLimitEpisodeRecovery({
      errorText: liveLimitText,
      log: buildLog(handled.mtimeMs, 512),
      handled,
      now,
      hasArmedRetry: false,
    }).action,
    'arm',
  );
});

test('decide: a reset time already in the past still arms — the delay clamp handles it', () => {
  // Nothing special is needed for a past reset: `getRetryPlan` clamps the negative
  // delay to zero, so the bot resumes promptly instead of skipping the episode.
  const pastResetNow = Date.parse('2026-09-24T23:30:00.000Z');
  const decision = decideLimitEpisodeRecovery({
    errorText: liveLimitText,
    log: buildLog(pastResetNow - 60_000),
    now: pastResetNow,
    hasArmedRetry: false,
  });
  assert.equal(decision.action, 'arm');
});
