/**
 * @description Unit coverage for lifting the freshly-generated compaction summary
 * out of each backend so F2's idle notice can surface its "Where we stopped"
 * closing section:
 *  - OpenCode: `getLatestOpenCodeCompactionSummary` over `GET /message` records
 *    (the assistant message stored with `summary:true`).
 *  - Claude json-stream: `readLatestCompactSummaryFromTranscript` over the
 *    on-disk transcript's `isCompactSummary:true` line.
 *
 * Test case: n/a (no Jira tracker for this project).
 */

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { getLatestOpenCodeCompactionSummary } from '../adapters/openCodeAdapter';
import { readLatestCompactSummaryFromTranscript } from '../adapters/claudeJsonStreamAdapter';

test('getLatestOpenCodeCompactionSummary: returns the newest summary:true assistant text', () => {
  const records = [
    { info: { role: 'user', id: 'u1' }, parts: [{ type: 'text', text: 'hi' }] },
    { info: { role: 'assistant', id: 'a1' }, parts: [{ type: 'text', text: 'a normal answer' }] },
    {
      info: { role: 'assistant', id: 's1', summary: true },
      parts: [{ type: 'text', text: '## Goals\n- ship it\n\n<<<WHERE_WE_STOPPED>>>\nmid-refactor' }],
    },
  ];
  const out = getLatestOpenCodeCompactionSummary(records);
  assert.ok(out);
  assert.ok(out.includes('## Goals'));
  assert.ok(out.includes('mid-refactor'));
});

test('getLatestOpenCodeCompactionSummary: no summary message → null', () => {
  const records = [{ info: { role: 'assistant', id: 'a1' }, parts: [{ type: 'text', text: 'answer' }] }];
  assert.equal(getLatestOpenCodeCompactionSummary(records), null);
  assert.equal(getLatestOpenCodeCompactionSummary('not-an-array'), null);
});

test('getLatestOpenCodeCompactionSummary: prefers the LAST summary when several exist', () => {
  const records = [
    { info: { role: 'assistant', id: 's1', summary: true }, parts: [{ type: 'text', text: 'old summary' }] },
    { info: { role: 'assistant', id: 's2', summary: true }, parts: [{ type: 'text', text: 'new summary' }] },
  ];
  assert.equal(getLatestOpenCodeCompactionSummary(records), 'new summary');
});

test('readLatestCompactSummaryFromTranscript: reads the isCompactSummary line content', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cjson-transcript-'));
  const file = path.join(dir, 'session.jsonl');
  try {
    fs.writeFileSync(
      file,
      [
        JSON.stringify({ type: 'user', message: { role: 'user', content: 'hello' } }),
        JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'hi' }] } }),
        JSON.stringify({
          type: 'user',
          isCompactSummary: true,
          message: { role: 'user', content: 'Summary:\n1. ...\n<<<WHERE_WE_STOPPED>>>\nmid-task\n<<<END_WHERE_WE_STOPPED>>>' },
        }),
      ].join('\n') + '\n',
    );
    const out = readLatestCompactSummaryFromTranscript(file);
    assert.ok(out);
    assert.ok(out.includes('Summary:'));
    assert.ok(out.includes('mid-task'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('readLatestCompactSummaryFromTranscript: unreadable file → null', () => {
  assert.equal(readLatestCompactSummaryFromTranscript('/no/such/transcript.jsonl'), null);
});
