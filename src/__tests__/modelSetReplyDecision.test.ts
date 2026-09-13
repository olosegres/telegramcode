/**
 * @description Unit cover for the pure `/model`-set reply decision (S4/S6).
 * Every branch of the four-way decision must produce the right copy + ok flag,
 * since all four `bot.ts` model-set paths funnel through it.
 *
 * The deferred-success branch is the bug fix: a model picked with NO live
 * session is a SUCCESS ("saved for next start"), not the old hard error.
 *
 * Both success branches now also carry the SHARED `effort.current_hint` block —
 * the same key the post-start `agent.ready` notice renders — so the level in
 * force and the "/effort to change it" pointer can never drift between the two
 * messages. The live-switch headline moved into the catalog (`model.set_success`)
 * at the same time: it used to be a hardcoded English literal, which would have
 * read as English sitting above a translated effort hint.
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { getModelSetReplyDecision } from '../utils/modelSetReplyDecision';

// Stub: echoes the key + the substituted {model}/{effort} so the tests assert
// which i18n key each branch routed through, without loading translations.
const translateStub = (code: string, vars?: Record<string, string | number>): string =>
  `${code}:${vars?.model ?? vars?.effort ?? ''}`;

test('unsupported adapter → not ok, names the label', () => {
  const out = getModelSetReplyDecision(
    { hasSetModel: false, setModelError: null, isActive: true, adapterLabel: 'Claude Code', displayLabel: 'x/y', effort: 'xhigh' },
    translateStub,
  );
  assert.equal(out.isOk, false);
  // Nothing was switched, so no effort hint may ride along.
  assert.equal(out.message, 'Model switching not supported for Claude Code');
});

test('setModel error → not ok, "Error: <err>" format preserved', () => {
  const out = getModelSetReplyDecision(
    { hasSetModel: true, setModelError: 'No active session. Start an agent first.', isActive: false, adapterLabel: 'Claude Code', displayLabel: 'x/y', effort: 'xhigh' },
    translateStub,
  );
  assert.equal(out.isOk, false);
  assert.equal(out.message, 'Error: No active session. Start an agent first.');
});

test('live success → ok, routes through model.set_success', () => {
  const out = getModelSetReplyDecision(
    { hasSetModel: true, setModelError: null, isActive: true, adapterLabel: 'OpenCode', displayLabel: 'anthropic/claude-opus-4-8', effort: null },
    translateStub,
  );
  assert.equal(out.isOk, true);
  // Load-bearing: the old hardcoded English `Model set to: …` is gone.
  assert.equal(out.message, 'model.set_success:anthropic/claude-opus-4-8');
});

test('deferred success (no session) → ok, routes through model.saved_for_next_start', () => {
  const out = getModelSetReplyDecision(
    { hasSetModel: true, setModelError: null, isActive: false, adapterLabel: 'OpenCode', displayLabel: 'anthropic/claude-opus-4-8', effort: null },
    translateStub,
  );
  // Load-bearing: the pre-fix flow turned this case into a hard error.
  assert.equal(out.isOk, true);
  assert.equal(out.message, 'model.saved_for_next_start:anthropic/claude-opus-4-8');
});

test('live success with an effort level → the shared effort block is appended', () => {
  const out = getModelSetReplyDecision(
    { hasSetModel: true, setModelError: null, isActive: true, adapterLabel: 'OpenCode', displayLabel: 'anthropic/claude-opus-4-8', effort: 'xhigh' },
    translateStub,
  );
  assert.equal(out.isOk, true);
  assert.equal(out.message, 'model.set_success:anthropic/claude-opus-4-8\neffort.current_hint:xhigh');
});

test('deferred success with an effort level → the same effort block', () => {
  const out = getModelSetReplyDecision(
    { hasSetModel: true, setModelError: null, isActive: false, adapterLabel: 'OpenCode', displayLabel: 'anthropic/claude-opus-4-8', effort: 'high' },
    translateStub,
  );
  assert.equal(out.isOk, true);
  assert.equal(out.message, 'model.saved_for_next_start:anthropic/claude-opus-4-8\neffort.current_hint:high');
});

test('effort null (backend without an effort concept) → neither success copy gains a line', () => {
  for (const isActive of [true, false]) {
    const out = getModelSetReplyDecision(
      { hasSetModel: true, setModelError: null, isActive, adapterLabel: 'Claude Code', displayLabel: 'sonnet', effort: null },
      translateStub,
    );
    assert.equal(out.isOk, true);
    assert.ok(!out.message.includes('effort.current_hint'), `unexpected effort line: "${out.message}"`);
    assert.ok(!out.message.includes('\n'), `a single-line copy must stay one line: "${out.message}"`);
  }
});
