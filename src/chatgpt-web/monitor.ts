import { existsSync } from 'node:fs';
import { emitKeypressEvents } from 'node:readline';
import type { Key } from 'node:readline';
import { resolveEventLogPath } from './event-log.js';
import type { ChatGptWebEventRecord } from './event-log.js';
import { DEFAULT_TAIL_BYTES, eventLogSize, followEvents, readRecentEvents } from './monitor-read.js';
import type { ChatGptWebEventFollower } from './monitor-read.js';
import { pickExpandLevel, render } from './monitor-view.js';
import type { MonitorHeader, MonitorInputMode, MonitorRow } from './monitor-view.js';

const FRAME_INTERVAL_MS = 1000;
const GATEWAY_ALIVE_WINDOW_MS = 30_000;
const MAX_ROWS = 5000;
const MAX_SESSIONS = 16;
const RATE_WINDOW_MS = 60_000;

const CLEAR_LINE = '\x1b[2K\r';
const SHOW_CURSOR = '\x1b[?25h';
const HIDE_CURSOR = '\x1b[?25l';
const RESET_STYLE = '\x1b[0m';

/** Case-insensitive subsequence match, so `f` matches both `read_file` and `find`. */
export function matchesToolName(tool: string, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (needle.length === 0) return true;
  const haystack = tool.toLowerCase();
  let cursor = 0;
  for (const character of needle) {
    if (character === ' ') continue;
    const found = haystack.indexOf(character, cursor);
    if (found === -1) return false;
    cursor = found + 1;
  }
  return true;
}

function searchableText(record: ChatGptWebEventRecord): string {
  try {
    return JSON.stringify({ arguments: record.arguments, result: record.result, error: record.error }) ?? '';
  } catch {
    return `${record.tool} ${record.error ?? ''}`;
  }
}

export function matchesSearch(record: ChatGptWebEventRecord, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (needle.length === 0) return true;
  return searchableText(record).toLowerCase().includes(needle);
}

function buildHeader(records: ChatGptWebEventRecord[], now: number): MonitorHeader {
  let lastTimestamp = 0;
  let ok = 0;
  let errors = 0;
  let inWindow = 0;
  const sessions = new Set<string>();

  for (const record of records) {
    const timestamp = record.ts || 0;
    if (timestamp > lastTimestamp) lastTimestamp = timestamp;
    if (record.status === 'ok') ok += 1;
    else errors += 1;
    if (timestamp >= now - RATE_WINDOW_MS) inWindow += 1;
    const sessionId = record.metadata?.session_id;
    if (sessionId) sessions.add(sessionId);
  }

  return {
    alive: lastTimestamp > 0 && now - lastTimestamp < GATEWAY_ALIVE_WINDOW_MS,
    sessions: Math.min(sessions.size, MAX_SESSIONS),
    maxSessions: MAX_SESSIONS,
    total: records.length,
    ok,
    errors,
    callsPerMinute: inWindow,
    secondsSinceLast: lastTimestamp > 0 ? Math.max(0, Math.round((now - lastTimestamp) / 1000)) : null,
  };
}

export async function runChatGptWebMonitor(logPath: string = resolveEventLogPath()): Promise<void> {
  const input = process.stdin;
  const output = process.stdout;
  const records: ChatGptWebEventRecord[] = [];
  const knownCallIds = new Set<string>();
  const expandLevels = new Map<number, number>();

  let selected = 0;
  let filter = '';
  let search = '';
  let inputMode: MonitorInputMode = 'none';
  let inputBuffer = '';
  let paused = false;
  let following = true;
  let running = true;

  const appendRecord = (record: ChatGptWebEventRecord): void => {
    if (knownCallIds.has(record.callId)) return;
    knownCallIds.add(record.callId);
    records.push(record);
    if (records.length > MAX_ROWS) {
      for (const dropped of records.splice(0, records.length - MAX_ROWS)) knownCallIds.delete(dropped.callId);
    }
  };

  const startingOffset = Math.max(eventLogSize(logPath), 0);
  for (const record of readRecentEvents(logPath, DEFAULT_TAIL_BYTES)) appendRecord(record);

  const visibleRows = (): MonitorRow[] => {
    const rows: MonitorRow[] = [];
    records.forEach((record, index) => {
      if (!matchesToolName(record.tool, filter)) return;
      if (!matchesSearch(record, search)) return;
      rows.push({ record, expandLevel: expandLevels.get(index) ?? 0 });
    });
    return rows;
  };

  let stop: () => void = () => undefined;
  const exited = new Promise<void>((resolve) => {
    stop = () => {
      running = false;
      resolve();
    };
  });

  const draw = (): void => {
    const rows = visibleRows();
    if (rows.length === 0) selected = 0;
    else selected = Math.min(Math.max(selected, 0), rows.length - 1);
    output.write(render({
      rows,
      selected,
      width: output.columns || 100,
      height: output.rows || 30,
      header: buildHeader(records, Date.now()),
      filter,
      search,
      inputMode,
      input: inputBuffer,
      paused,
      following,
      logPath,
      logExists: existsSync(logPath),
      now: Date.now(),
    }));
  };

  const move = (delta: number): void => {
    const rows = visibleRows();
    if (rows.length === 0) return;
    selected = Math.min(Math.max(selected + delta, 0), rows.length - 1);
    following = selected >= rows.length - 1;
  };

  const onKeypress = (_text: string, key: Key | undefined): void => {
    if (!key || !running) return;
    const name = key.name;

    if (inputMode !== 'none') {
      if (key.ctrl && (name === 'c' || name === 'd')) { stop(); return; }
      if (name === 'escape') {
        inputMode = 'none';
        inputBuffer = '';
        return;
      }
      if (name === 'return' || name === 'enter') {
        if (inputMode === 'filter') filter = inputBuffer.trim();
        else search = inputBuffer.trim();
        inputMode = 'none';
        inputBuffer = '';
        selected = 0;
        return;
      }
      if (name === 'backspace') {
        inputBuffer = inputBuffer.slice(0, -1);
        return;
      }
      if (name === 'up' || name === 'down' || name === 'tab') return;
      if (!key.ctrl && !key.meta && key.sequence && key.sequence >= ' ' && key.sequence !== '\x7f') {
        inputBuffer += key.sequence;
      }
      return;
    }

    if (key.ctrl && (name === 'c' || name === 'd')) { stop(); return; }
    if (name === 'up' || key.sequence === 'k') { move(-1); return; }
    if (name === 'down' || key.sequence === 'j') { move(1); return; }
    if (name === 'q') { stop(); return; }
    if (name === 'p') { paused = !paused; return; }
    if (name === 'f') { inputMode = 'filter'; inputBuffer = filter; return; }
    if (key.sequence === '/') { inputMode = 'search'; inputBuffer = search; return; }

    if (name === 'return' || name === 'enter' || key.sequence === ' ') {
      const row = visibleRows()[selected];
      if (!row) return;
      const index = records.indexOf(row.record);
      if (index === -1) return;
      expandLevels.set(index, pickExpandLevel(row, expandLevels.get(index) ?? 0));
    }
  };

  const cleanup = (): void => {
    running = false;
    clearInterval(frameTimer);
    follower?.close();
    input.off('keypress', onKeypress);
    input.off('end', onStdinEnd);
    input.off('close', onStdinEnd);
    input.setEncoding('utf8');
    if (input.isTTY) input.setRawMode(false);
    input.pause();
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
    process.off('SIGWINCH', draw);
    output.write(`${RESET_STYLE}${SHOW_CURSOR}${CLEAR_LINE}`);
  };

  const onSignal = (): void => stop();
  const onStdinEnd = (): void => stop();

  if (input.isTTY) input.setRawMode(true);
  input.setEncoding('utf8');
  input.resume();
  emitKeypressEvents(input);
  input.on('keypress', onKeypress);
  input.on('end', onStdinEnd);
  input.on('close', onStdinEnd);
  output.write(HIDE_CURSOR);

  const follower: ChatGptWebEventFollower = followEvents(logPath, (record) => {
    const previousLength = records.length;
    appendRecord(record);
    if (following && !paused && records.length > previousLength) selected = records.length - 1;
  }, { fromOffset: startingOffset });

  const frameTimer = setInterval(() => {
    if (running) draw();
  }, FRAME_INTERVAL_MS);

  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
  process.on('SIGWINCH', draw);

  draw();

  try {
    await exited;
  } finally {
    cleanup();
  }
}