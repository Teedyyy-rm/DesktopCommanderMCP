import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createEventLogWriter, resolveEventLogPath } from '../dist/chatgpt-web/event-log.js';

const METADATA = {
  transport: 'streamable_http',
  clientInfo: { name: 'openai-mcp', version: '1.0.0' },
  oauth_client_id: 'client-1',
  origin_instance: 'instance-1',
  gateway_pid: 4242,
  session_id: 'session-1',
};

function completed(callId, overrides = {}) {
  return {
    phase: 'completed',
    callId,
    tool: 'read_file',
    status: 'ok',
    durationMs: 1234,
    result: { content: [{ type: 'text', text: 'hello' }] },
    metadata: METADATA,
    ...overrides,
  };
}

function started(callId, tool, args) {
  return { phase: 'started', callId, tool, arguments: args, metadata: METADATA };
}

function readLines(filePath) {
  return readFileSync(filePath, 'utf8').split('\n').filter((line) => line.length > 0);
}

async function run() {
  const directory = mkdtempSync(join(tmpdir(), 'dc-event-log-'));

  // One completed call becomes exactly one NDJSON line, with the arguments
  // carried over from the matching started event.
  const logPath = join(directory, 'events.ndjson');
  const writer = createEventLogWriter({ filePath: logPath, now: () => 1_700_000_000_000 });
  writer.write(started('call-1', 'read_file', { path: '/tmp/a.txt', offset: 2 }));
  writer.write(completed('call-1'));

  const lines = readLines(logPath);
  assert.equal(lines.length, 1, 'one completed call should produce one line');
  const record = JSON.parse(lines[0]);
  assert.equal(record.phase, 'completed');
  assert.equal(record.ts, 1_700_000_000_000, 'the record should carry the writer clock');
  assert.equal(record.callId, 'call-1');
  assert.equal(record.tool, 'read_file');
  assert.equal(record.status, 'ok');
  assert.equal(record.durationMs, 1234);
  assert.deepEqual(record.arguments, { path: '/tmp/a.txt', offset: 2 }, 'arguments should come from the started event');
  assert.equal(record.result.content[0].text, 'hello');
  assert.equal(record.metadata.session_id, 'session-1');

  // The log holds file contents, so it must not be group/world readable.
  assert.equal(statSync(logPath).mode & 0o777, 0o600, 'the event log should be created with mode 600');

  const previousUmask = process.umask(0o000);
  const secondLogPath = join(directory, 'wide-umask.ndjson');
  const wideWriter = createEventLogWriter({ filePath: secondLogPath });
  wideWriter.write(completed('call-wide'));
  assert.equal(statSync(secondLogPath).mode & 0o777, 0o600, 'a permissive umask must not widen the event log');
  process.umask(previousUmask);

  // A failed call still gets a line, carrying the error instead of a result.
  writer.write(completed('call-2', {
    tool: 'start_process',
    status: 'failed',
    result: undefined,
    durationMs: 7,
    error: 'TypeError: boom',
  }));
  const failure = JSON.parse(readLines(logPath)[1]);
  assert.equal(failure.status, 'failed');
  assert.equal(failure.error, 'TypeError: boom');
  assert.equal(failure.result, undefined, 'a failed call must not carry a result field');

  // Trim keeps the byte budget while retaining the newest records.
  const trimPath = join(directory, 'trim.ndjson');
  const trimWriter = createEventLogWriter({ filePath: trimPath, maxBytes: 4096, trimTargetBytes: 1024 });
  for (let index = 0; index < 200; index += 1) {
    const callId = `trim-${index}`;
    trimWriter.write(started(callId, 'read_file', { path: `/tmp/file-${index}.txt` }));
    trimWriter.write(completed(callId, { durationMs: index, result: { content: [{ type: 'text', text: 'x'.repeat(40) }] } }));
  }
  const trimmedLines = readLines(trimPath);
  assert.ok(trimmedLines.length > 0, 'trim must keep at least the newest record');
  assert.ok(statSync(trimPath).size <= 4096, 'the trimmed log should stay within the byte budget');
  assert.ok(trimmedLines.length < 200, 'older records should have been dropped');
  const trimmedRecords = trimmedLines.map((line) => JSON.parse(line));
  assert.doesNotThrow(() => trimmedRecords.forEach((entry) => entry.callId), 'every trimmed line must still be valid JSON');
  assert.equal(trimmedRecords.at(-1).callId, 'trim-199', 'the newest record must survive the trim');
  assert.equal(trimmedRecords.filter((entry) => entry.callId === 'trim-0').length, 0, 'the oldest record should be gone');
  assert.equal(statSync(trimPath).mode & 0o777, 0o600, 'the trimmed file must keep mode 600');

  // A pre-existing corrupt line does not stop the writer from appending.
  const mixedPath = join(directory, 'mixed.ndjson');
  writeFileSync(mixedPath, '{"phase":"completed","tool":"read_file","callId":"legacy"}\nnot json at all\n', { mode: 0o600 });
  const mixedWriter = createEventLogWriter({ filePath: mixedPath });
  mixedWriter.write(started('call-mixed', 'list_directory', { path: '/tmp' }));
  mixedWriter.write(completed('call-mixed'));
  const mixedLines = readLines(mixedPath);
  assert.equal(mixedLines.length, 3, 'the writer should append without rewriting existing lines');
  assert.equal(mixedLines[1], 'not json at all', 'unrelated content must be left alone');
  assert.equal(JSON.parse(mixedLines[2]).callId, 'call-mixed');

  // Logging failures are swallowed: an unwritable path must not throw.
  const blocker = join(directory, 'blocker');
  writeFileSync(blocker, 'not a directory', 'utf8');
  const brokenWriter = createEventLogWriter({ filePath: join(blocker, 'nested', 'events.ndjson') });
  assert.doesNotThrow(() => brokenWriter.write(started('call-broken', 'read_file', { path: '/tmp' })));
  assert.doesNotThrow(() => brokenWriter.write(completed('call-broken')), 'a failed write must not escape the writer');
  assert.doesNotThrow(() => {
    const circular = { content: [] };
    circular.content.push(circular);
    brokenWriter.write(completed('call-circular', { result: circular }));
  }, 'an unserialisable result must not escape the writer');

  const circular = { content: [] };
  circular.content.push(circular);
  const linesBeforeCircular = readLines(logPath).length;
  assert.doesNotThrow(() => writer.write(completed('call-circular', { result: circular })));
  assert.equal(readLines(logPath).length, linesBeforeCircular, 'an unserialisable result must not append a partial line');

  // reset() lets one writer be pointed at a fresh path.
  writer.reset();
  const resetPath = join(directory, 'reset.ndjson');
  const reused = createEventLogWriter({ filePath: resetPath });
  reused.write(completed('call-reset'));
  assert.equal(statSync(resetPath).mode & 0o777, 0o600);
  assert.equal(readLines(resetPath).length, 1);

  // The path honours the environment override.
  const overridePath = join(directory, 'override.ndjson');
  const previousOverride = process.env.DC_CHATGPT_WEB_EVENT_LOG;
  process.env.DC_CHATGPT_WEB_EVENT_LOG = overridePath;
  assert.equal(resolveEventLogPath(), overridePath);
  createEventLogWriter().write(completed('call-override'));
  assert.equal(readLines(overridePath).length, 1, 'the default writer should use the environment override');
  if (previousOverride === undefined) delete process.env.DC_CHATGPT_WEB_EVENT_LOG;
  else process.env.DC_CHATGPT_WEB_EVENT_LOG = previousOverride;

  console.log('✓ ChatGPT Web event log writes NDJSON, trims by byte budget, and locks the file to mode 600');
}

run().catch((error) => {
  console.error('✗ ChatGPT Web event log test failed:', error);
  process.exitCode = 1;
});