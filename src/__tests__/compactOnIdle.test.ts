/**
 * @description Unit coverage for the pure compact-on-idle helpers (F2):
 * enable resolution (per-thread override vs default-on), the idle-fire guard,
 * and the sentinel-based closing-section extractor. These are the branch-level
 * decisions the bot's idle watchdog + notice rely on.
 */

import { test } from 'node:test';
import * as assert from 'node:assert/strict';

import {
  idleCompactMs,
  resolveCompactOnIdleEnabled,
  checkShouldFireIdleCompaction,
  checkIsBusyForRealTurn,
  buildCompactionInstruction,
  compactionSummaryGuidance,
  extractCompactionClosingSection,
  compactionClosingStartMarker,
  compactionClosingEndMarker,
} from '../utils/compactOnIdle';

/** The all-conditions-met base for the idle-fire guard (D1/D2). */
const fireBase = {
  isEnabled: true,
  isSessionActive: true,
  isBusyForRealTurn: false,
  isLatched: false,
  hasCompletedTurnSinceCompaction: true,
} as const;

test('idleCompactMs is 55 minutes', () => {
  assert.equal(idleCompactMs, 55 * 60 * 1000);
});

test('resolveCompactOnIdleEnabled: default is ON when nothing is set', () => {
  assert.equal(resolveCompactOnIdleEnabled(undefined, undefined), true);
});

test('resolveCompactOnIdleEnabled: an explicit global default false is honored', () => {
  assert.equal(resolveCompactOnIdleEnabled(false, undefined), false);
  assert.equal(resolveCompactOnIdleEnabled(true, undefined), true);
});

test('resolveCompactOnIdleEnabled: a per-thread override always wins over the default', () => {
  assert.equal(resolveCompactOnIdleEnabled(true, false), false);
  assert.equal(resolveCompactOnIdleEnabled(false, true), true);
});

test('checkShouldFireIdleCompaction: fires only when enabled+active+idle+unlatched+has-turn', () => {
  assert.equal(checkShouldFireIdleCompaction({ ...fireBase }), true);
});

test('checkShouldFireIdleCompaction: every negated condition blocks the fire', () => {
  assert.equal(checkShouldFireIdleCompaction({ ...fireBase, isEnabled: false }), false);
  assert.equal(checkShouldFireIdleCompaction({ ...fireBase, isSessionActive: false }), false);
  assert.equal(
    checkShouldFireIdleCompaction({ ...fireBase, isBusyForRealTurn: true }),
    false,
    'a session running a real turn is never compacted',
  );
  assert.equal(
    checkShouldFireIdleCompaction({ ...fireBase, isLatched: true }),
    false,
    'D2: a spent latch fires at most once per user-active period',
  );
  assert.equal(
    checkShouldFireIdleCompaction({ ...fireBase, hasCompletedTurnSinceCompaction: false }),
    false,
    'nothing to compress → skip',
  );
});

test('checkIsBusyForRealTurn: a pending question is NOT a real-turn busy (D1 fires)', () => {
  // The whole D1 pivot: a question-blocked (idle-waiting) session reports busy,
  // but that must NOT block idle compaction — only a genuinely running turn does.
  assert.equal(checkIsBusyForRealTurn({ isBusy: true, hasPendingQuestion: true }), false);
  assert.equal(checkIsBusyForRealTurn({ isBusy: true, hasPendingQuestion: false }), true);
  assert.equal(checkIsBusyForRealTurn({ isBusy: false, hasPendingQuestion: true }), false);
  assert.equal(checkIsBusyForRealTurn({ isBusy: false, hasPendingQuestion: false }), false);
});

test('checkShouldFireIdleCompaction: a pending question at idle still fires (D1)', () => {
  // A question pending → checkIsBusyForRealTurn is false → the guard fires so the
  // watchdog can reject + compact + re-ask.
  const isBusyForRealTurn = checkIsBusyForRealTurn({ isBusy: true, hasPendingQuestion: true });
  assert.equal(checkShouldFireIdleCompaction({ ...fireBase, isBusyForRealTurn }), true);
});

test('buildCompactionInstruction: Claude backends get the D3 summary guidance appended', () => {
  const closing = 'CLOSING';
  const claude = buildCompactionInstruction({
    bakesSummaryGuidance: false,
    summaryGuidance: compactionSummaryGuidance,
    closingSectionInstruction: closing,
  });
  assert.ok(claude);
  assert.ok(claude.includes(compactionSummaryGuidance), 'D3 guidance rides the Claude instruction');
  assert.ok(claude.includes(closing), 'closing section is appended too');
  assert.ok(claude.indexOf(compactionSummaryGuidance) < claude.indexOf(closing), 'guidance before closing');
});

test('buildCompactionInstruction: OpenCode omits the guidance (baked in fork)', () => {
  // OpenCode bakes D3 into its fork prompt, so re-sending it would duplicate the
  // text. A plain manual /compact (no closing) resolves to undefined → byte-identical.
  assert.equal(
    buildCompactionInstruction({
      bakesSummaryGuidance: true,
      summaryGuidance: compactionSummaryGuidance,
      closingSectionInstruction: undefined,
    }),
    undefined,
  );
  const withClosing = buildCompactionInstruction({
    bakesSummaryGuidance: true,
    summaryGuidance: compactionSummaryGuidance,
    closingSectionInstruction: 'CLOSING',
  });
  assert.equal(withClosing, 'CLOSING', 'OpenCode gets only the closing section');
});

test('buildCompactionInstruction: nothing to append → undefined', () => {
  assert.equal(
    buildCompactionInstruction({
      bakesSummaryGuidance: true,
      summaryGuidance: compactionSummaryGuidance,
      closingSectionInstruction: '   ',
    }),
    undefined,
    'whitespace-only closing is ignored',
  );
});

test('compactionSummaryGuidance: is maximally-complete + session-specific (D3)', () => {
  assert.match(compactionSummaryGuidance, /MAXIMALLY COMPLETE/);
  assert.match(compactionSummaryGuidance, /SESSION-SPECIFIC/);
  assert.match(compactionSummaryGuidance, /CLAUDE\.md \/ AGENTS\.md/);
});

test('extractCompactionClosingSection: pulls the text between the sentinel markers', () => {
  const summary = [
    '## Objective',
    '- do the thing',
    '',
    compactionClosingStartMarker,
    'We were fixing the login bug; next: run the e2e suite.',
    'Pending question: proceed? Options: yes / no.',
    compactionClosingEndMarker,
    'Continue the conversation from where it left off.',
  ].join('\n');
  const closing = extractCompactionClosingSection(summary);
  assert.ok(closing);
  assert.ok(closing.includes('login bug'));
  assert.ok(closing.includes('yes / no'));
  // Trailing boilerplate after the end marker must be excluded.
  assert.ok(!closing.includes('Continue the conversation'));
  // The markers themselves are stripped.
  assert.ok(!closing.includes(compactionClosingStartMarker));
  assert.ok(!closing.includes(compactionClosingEndMarker));
});

test('extractCompactionClosingSection: no start marker → null (notice omits the block)', () => {
  assert.equal(extractCompactionClosingSection('## Objective\n- do the thing'), null);
  assert.equal(extractCompactionClosingSection(''), null);
});

test('extractCompactionClosingSection: missing end marker → to end of text', () => {
  const summary = `intro\n${compactionClosingStartMarker}\nwhere we stopped: mid-refactor.`;
  assert.equal(extractCompactionClosingSection(summary), 'where we stopped: mid-refactor.');
});

test('extractCompactionClosingSection: an empty section → null (never a bare block)', () => {
  const summary = `${compactionClosingStartMarker}\n   \n${compactionClosingEndMarker}`;
  assert.equal(extractCompactionClosingSection(summary), null);
});
