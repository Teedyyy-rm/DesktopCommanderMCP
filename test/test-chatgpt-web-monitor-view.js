import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ELLIPSIS,
  columnLayout,
  formatColumns,
  formatDuration,
  formatWhat,
  pickExpandLevel,
  render,
  statusLabel,
  stringWidth,
} from '../dist/chatgpt-web/monitor-view.js';

const METADATA = {
  transport: 'streamable_http',
  clientInfo: { name: 'openai-mcp', version: '1.0.0' },
  oauth_client_id: 'client-1',
  origin_instance: 'instance-1',
  gateway_pid: 4242,
  session_id: 'session-1',
};

function record(overrides = {}) {
  return {
    ts: Date.UTC(2026, 0, 2, 3, 4, 5),
    phase: 'completed',
    callId: 'call-1',
    tool: 'read_file',
    status: 'ok',
    durationMs: 1234,
    arguments: { path: '/workspace/desktop-commander/src/chatgpt-web/gateway.ts' },
    result: { content: [{ type: 'text', text: 'file body' }] },
    metadata: METADATA,
    ...overrides,
  };
}

function lines(output) {
  return output.split('\n');
}

function run() {
  // Display width, not string length: the table must not drift on CJK or emoji.
  assert.equal(stringWidth('abc'), 3);
  assert.equal(stringWidth('日本語'), 6);
  assert.equal(stringWidth('✅'), 2);
  assert.equal(stringWidth(ELLIPSIS), 2, 'the truncation marker is two columns wide');

  const rows = [
    { record: record(), expandLevel: 0 },
    { record: record({ callId: 'call-2', tool: 'start_process', arguments: { command: '日本語のコマンド --flag', timeout_ms: 3000 }, durationMs: 45 }), expandLevel: 0 },
    { record: record({ callId: 'call-3', tool: 'read_file', status: 'failed', error: 'boom', result: undefined, arguments: { path: '/tmp/ファイル名.txt' } }), expandLevel: 0 },
  ];

  const width = 120;
  const table = lines(formatColumns(rows, width));
  assert.equal(table.length, 3, 'an unexpanded row is a single line');
  for (const line of table) {
    assert.equal(stringWidth(line), width, `every table line must fill the terminal width: ${JSON.stringify(line)}`);
  }

  const layout = columnLayout(width, rows.reduce((widest, row) => Math.max(widest, stringWidth(row.record.tool)), 0));
  assert.ok(layout.whatWidth > 0, 'the WHAT column should receive the remaining width');

  const longPath = '/workspace/desktop-commander/src/chatgpt-web/monitor-view-with-a-very-long-name.ts';
  const truncated = formatColumns([
    { record: record({ arguments: { path: longPath } }), expandLevel: 0 },
  ], 60);
  assert.ok(truncated.includes(ELLIPSIS), 'an over-long value should be truncated with an ellipsis');
  assert.equal(stringWidth(truncated), 60, 'a truncated row still fills the width');
  assert.ok(!truncated.includes('with-a-very-long-name.ts'), 'truncation must drop the tail of the value');

  // status and duration columns
  assert.equal(statusLabel(rows[0].record), 'ok');
  assert.equal(statusLabel(rows[2].record), 'err');
  assert.equal(statusLabel({ ...rows[0].record, phase: 'started' }), 'RUN');
  assert.equal(formatDuration(220), '220ms');
  assert.equal(formatDuration(1234), '1.2s');
  assert.equal(formatDuration(undefined), '-');
  assert.equal(formatDuration(Number.NaN), '-');

  // Expand level cycles 0 -> 1 -> 2 -> 3 -> 0 and is capped without a result.
  const withResult = rows[0];
  assert.deepEqual(
    [0, 1, 2, 3].map((level) => pickExpandLevel(withResult, level)),
    [1, 2, 3, 0],
    'Enter should walk 0 -> 1 -> 2 -> 3 -> 0',
  );
  const withoutResult = { record: record({ result: undefined, error: undefined }), expandLevel: 0 };
  assert.deepEqual(
    [0, 1, 2, 3].map((level) => pickExpandLevel(withoutResult, level)),
    [1, 2, 0, 0],
    'a record with neither result nor error stops at level 2',
  );

  // Expanding adds detail lines without moving the row above it.
  const collapsed = lines(formatColumns([
    { record: rows[0].record, expandLevel: 0 },
    { record: rows[1].record, expandLevel: 0 },
  ], width));
  const expanded = lines(formatColumns([
    { record: rows[0].record, expandLevel: 0 },
    { record: rows[1].record, expandLevel: 3 },
  ], width));
  assert.ok(expanded.length > 2, 'level 3 should add detail lines');
  assert.equal(expanded[0], collapsed[0], 'expanding a row must not move the rows above it');
  for (const line of expanded) {
    assert.equal(stringWidth(line), width, 'expanded detail lines keep the same width');
  }
  assert.ok(expanded.some((line) => line.includes('call-2')), 'level 1 should show the call summary');
  assert.ok(expanded.some((line) => line.includes('timeout_ms')), 'level 2 should show the arguments');
  assert.ok(expanded.some((line) => line.includes('日本語のコマンド')), 'level 3 should show the result');

  // WHAT column summaries per tool family.
  assert.equal(formatWhat('read_file', { path: '/tmp/a.txt', offset: 2 }), '/tmp/a.txt');
  assert.equal(formatWhat('write_file', { path: '/tmp/a.txt', content: 'x'.repeat(400) }), '/tmp/a.txt');
  assert.equal(formatWhat('move_file', { source: '/tmp/a', destination: '/tmp/b' }), '/tmp/a');
  assert.equal(formatWhat('read_multiple_files', { paths: ['/tmp/a', '/tmp/b'] }), '/tmp/a /tmp/b');
  assert.equal(formatWhat('start_process', { command: 'npm run build', timeout_ms: 3000 }), 'npm run build');
  assert.equal(formatWhat('read_process_output', { pid: 4242, timeout_ms: 1000 }), '4242');
  assert.equal(formatWhat('start_search', { path: '/tmp', pattern: 'TODO' }), 'TODO');
  assert.equal(formatWhat('get_config', {}), '');
  assert.equal(formatWhat('get_config', { scope: 'desktop-commander' }), '{"scope":"desktop-commander"}');

  // The frame is a full-screen redraw padded to the terminal height.
  const frame = render({
    rows,
    selected: 1,
    width,
    height: 20,
    header: {
      alive: true,
      sessions: 2,
      maxSessions: 16,
      total: 3,
      ok: 2,
      errors: 1,
      callsPerMinute: 4,
      secondsSinceLast: 3,
    },
    filter: '',
    search: '',
    inputMode: 'none',
    input: '',
    paused: false,
    following: true,
    logPath: '/tmp/claude-server-commander/chatgpt-web-events.ndjson',
    logExists: true,
    now: Date.UTC(2026, 0, 2, 3, 4, 9),
  });
  assert.ok(frame.startsWith('\x1b[2J\x1b[H'), 'the frame should clear and home the cursor');
  const frameLines = lines(frame);
  assert.equal(frameLines.length, 20, 'the frame should always be exactly the terminal height');
  assert.ok(frame.includes('ALIVE'), 'the header should show gateway liveness');
  assert.ok(frame.includes('sessions 2/16'), 'the header should show the session count');

  const emptyFrame = render({
    rows: [],
    selected: 0,
    width,
    height: 12,
    header: {
      alive: false,
      sessions: 0,
      maxSessions: 16,
      total: 0,
      ok: 0,
      errors: 0,
      callsPerMinute: 0,
      secondsSinceLast: null,
    },
    filter: '',
    search: '',
    inputMode: 'none',
    input: '',
    paused: false,
    following: true,
    logPath: '/tmp/claude-server-commander/chatgpt-web-events.ndjson',
    logExists: false,
    now: Date.UTC(2026, 0, 2, 3, 4, 9),
  });
  assert.ok(
    emptyFrame.includes('systemctl --user start desktop-commander-chatgpt-web.service'),
    'an empty monitor should tell the operator how to start the gateway',
  );

  console.log('✓ ChatGPT Web monitor view aligns CJK columns, cycles expand levels, and summarizes each tool family');
}

try {
  run();
} catch (error) {
  console.error('✗ ChatGPT Web monitor view test failed:', error);
  process.exitCode = 1;
}
