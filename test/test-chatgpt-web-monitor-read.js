import assert from 'node:assert/strict';
import { appendFileSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  eventLogSize,
  followEvents,
  readRecentEvents,
} from '../dist/chatgpt-web/monitor-read.js';

const POLL_INTERVAL_MS = 20;

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(predicate, timeoutMs = 2000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (predicate()) return;
    await wait(10);
  }
  assert.fail('Timed out waiting for the event follower.');
}

function record(callId, tool = 'read_file') {
  return {
    ts: 1_700_000_000_000,
    phase: 'completed',
    callId,
    tool,
    status: 'ok',
    durationMs: 5,
    arguments: { path: `/${callId}.txt` },
    result: { content: [{ type: 'text', text: callId }] },
  };
}

function line(entry) {
  return `${JSON.stringify(entry)}\n`;
}

async function run() {
  const directory = mkdtempSync(join(tmpdir(), 'dc-monitor-read-'));
  const logPath = join(directory, 'events.ndjson');

  // A missing log is not an error: the monitor opens before the gateway starts.
  assert.deepEqual(readRecentEvents(logPath), [], 'a missing log should read as empty');
  assert.equal(eventLogSize(logPath), -1, 'a missing log should report no size');

  writeFileSync(
    logPath,
    [
      line(record('call-1')),
      '{"phase":"completed","tool":"read_file"\n',
      line(record('call-2')),
      '\n',
      'not json at all\n',
      line(record('call-3')),
    ].join(''),
  );

  const all = readRecentEvents(logPath);
  assert.deepEqual(all.map((entry) => entry.callId), ['call-1', 'call-2', 'call-3'], 'unparsable lines should be skipped, order preserved');

  // The tail window drops the partial first line rather than reporting garbage.
  const lastLine = line(record('call-3'));
  const windowBytes = Buffer.byteLength(lastLine, 'utf8') + 30;
  const tail = readRecentEvents(logPath, windowBytes);
  assert.deepEqual(tail.map((entry) => entry.callId), ['call-3'], 'the window must not start mid-record');
  assert.ok(windowBytes < eventLogSize(logPath), 'the window must be smaller than the file');

  // Following delivers appended records.
  const seen = [];
  const follower = followEvents(logPath, (entry) => seen.push(entry.callId), { pollIntervalMs: POLL_INTERVAL_MS });
  try {
    appendFileSync(logPath, line(record('call-4')));
    await waitFor(() => seen.includes('call-4'));

    // A line split across two appends is delivered exactly once, when complete.
    const partial = line(record('call-5'));
    appendFileSync(logPath, partial.slice(0, Math.floor(partial.length / 2)));
    await wait(POLL_INTERVAL_MS * 4);
    assert.ok(!seen.includes('call-5'), 'an incomplete line must not be delivered');
    appendFileSync(logPath, partial.slice(Math.floor(partial.length / 2)));
    await waitFor(() => seen.includes('call-5'));

    // The writer's trim replaces the file with a shorter tail, which leaves
    // fs.watch stale and the byte offset past the end of the file.
    writeFileSync(logPath, [line(record('call-trimmed-1')), line(record('call-trimmed-2'))].join(''));
    await waitFor(() => seen.includes('call-trimmed-1') && seen.includes('call-trimmed-2'));
    assert.ok(seen.filter((callId) => callId === 'call-trimmed-2').length === 1, 'a recovered record must not be delivered twice');
  } finally {
    follower.close();
  }

  // A follower started before the gateway has written anything picks it up.
  const latePath = join(directory, 'late.ndjson');
  const lateSeen = [];
  const lateFollower = followEvents(latePath, (entry) => lateSeen.push(entry.callId), { pollIntervalMs: POLL_INTERVAL_MS });
  try {
    await wait(POLL_INTERVAL_MS * 3);
    assert.deepEqual(lateSeen, [], 'a missing log should stay silent');
    appendFileSync(latePath, line(record('call-late')));
    await waitFor(() => lateSeen.includes('call-late'));
    assert.deepEqual(readRecentEvents(latePath).map((entry) => entry.callId), ['call-late']);
  } finally {
    lateFollower.close();
  }

  // fromOffset skips the existing history instead of replaying it.
  const resumePath = join(directory, 'resume.ndjson');
  writeFileSync(resumePath, line(record('call-old')));
  const resumed = [];
  const resumeFollower = followEvents(resumePath, (entry) => resumed.push(entry.callId), {
    pollIntervalMs: POLL_INTERVAL_MS,
    fromOffset: eventLogSize(resumePath),
  });
  try {
    await wait(POLL_INTERVAL_MS * 3);
    assert.deepEqual(resumed, [], 'fromOffset should skip records written before the follower started');
    appendFileSync(resumePath, line(record('call-new')));
    await waitFor(() => resumed.includes('call-new'));
    assert.deepEqual(resumed, ['call-new']);
  } finally {
    resumeFollower.close();
  }

  console.log('✓ ChatGPT Web monitor reader tails the event log, skips corrupt lines, and recovers from a trim');
}

run().catch((error) => {
  console.error('✗ ChatGPT Web monitor read test failed:', error);
  process.exitCode = 1;
});