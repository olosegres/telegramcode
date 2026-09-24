/**
 * @description Unit tests for {@link ../utils/autoContinueOnLimit} — the
 * `/auto_continue_limits` resolver and the «skip once» button's stale-tap guard.
 *
 * The armed-state paths cannot be driven live (a real provider usage limit is not
 * inducible on demand), so the decision table below is the load-bearing proof that
 * a stale keyboard can never cancel a later episode.
 */

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import {
  resolveAutoContinueOnLimitEnabled,
  buildSkipArmedRetryCallbackData,
  parseSkipArmedRetryCallbackData,
  getArmedRetrySkipDecision,
  skipArmedRetryCallbackPrefix,
} from '../utils/autoContinueOnLimit';
import { checkIsCallbackDataWithinLimit } from '../utils/modelPickerPlan';

const armedFireAt = Date.parse('2026-09-24T22:50:00.000Z');

test('resolve: unset everywhere → ON (the auto-resume was unconditional before the toggle)', () => {
  assert.equal(resolveAutoContinueOnLimitEnabled(undefined, undefined), true);
});

test('resolve: the instance default applies when the thread has no override', () => {
  assert.equal(resolveAutoContinueOnLimitEnabled(false, undefined), false);
  assert.equal(resolveAutoContinueOnLimitEnabled(true, undefined), true);
});

test('resolve: a per-thread override always wins — including an explicit false', () => {
  assert.equal(resolveAutoContinueOnLimitEnabled(true, false), false);
  assert.equal(resolveAutoContinueOnLimitEnabled(false, true), true);
});

test('skip callback data: round-trips and fits Telegram\'s 64-byte cap', () => {
  const data = buildSkipArmedRetryCallbackData(armedFireAt);
  assert.ok(data.startsWith(skipArmedRetryCallbackPrefix));
  assert.equal(parseSkipArmedRetryCallbackData(data), armedFireAt);
  assert.ok(checkIsCallbackDataWithinLimit(data), `callback_data too long: "${data}"`);
});

test('skip callback data: foreign / malformed data parses to null, never to a number', () => {
  assert.equal(parseSkipArmedRetryCallbackData('acl_on'), null);
  assert.equal(parseSkipArmedRetryCallbackData(`${skipArmedRetryCallbackPrefix}abc`), null);
  assert.equal(parseSkipArmedRetryCallbackData(`${skipArmedRetryCallbackPrefix}`), null);
});

test('skip decision: armed AND matching → skip', () => {
  assert.equal(
    getArmedRetrySkipDecision({ armedFireAt, requestedFireAt: armedFireAt }),
    'skip',
  );
});

test('skip decision: armed but a DIFFERENT episode → expired (never cancels the newer wait)', () => {
  // The exact bug the baked `fireAt` prevents: an untouched older picker stays
  // tappable and would otherwise drop a resume the user never asked to drop.
  assert.equal(
    getArmedRetrySkipDecision({ armedFireAt: armedFireAt + 3_600_000, requestedFireAt: armedFireAt }),
    'expired',
  );
});

test('skip decision: nothing armed → expired', () => {
  assert.equal(getArmedRetrySkipDecision({ armedFireAt: null, requestedFireAt: armedFireAt }), 'expired');
});
