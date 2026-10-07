import { closeSync, openSync, readSync, statSync, watch, type FSWatcher } from 'node:fs';
import { basename, dirname } from 'node:path';
import type { ChatGptWebEventRecord } from './event-log.js';

const NEWLINE = 0x0a;

export const DEFAULT_TAIL_BYTES = 1024 * 1024;
export const DEFAULT_POLL_INTERVAL_MS = 500;
const MAX_PENDING_BYTES = 8 * 1024 * 1024;

export interface ChatGptWebEventFollower {
  close(): void;
}

export interface FollowEventsOptions {
  pollIntervalMs?: number;
  /** First byte position to deliver; defaults to the current end of file. */
  fromOffset?: number;
}

function parseEventLine(line: string): ChatGptWebEventRecord | undefined {
  const trimmed = line.trim();
  if (trimmed.length === 0) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined;
  const candidate = parsed as Partial<ChatGptWebEventRecord>;
  if (typeof candidate.tool !== 'string' || typeof candidate.callId !== 'string') return undefined;
  return candidate as ChatGptWebEventRecord;
}

export function eventLogSize(filePath: string): number {
  try {
    return statSync(filePath).size;
  } catch {
    return -1;
  }
}

/**
 * Reads at most `maxBytes` from the end of the log. The leading fragment of
 * the window is dropped whether it is a partial line or the empty string
 * before a line boundary, and unparsable lines are skipped, so a corrupt or
 * partially written tail can never break the monitor.
 */
export function readRecentEvents(filePath: string, maxBytes: number = DEFAULT_TAIL_BYTES): ChatGptWebEventRecord[] {
  let fd: number | undefined;
  try {
    fd = openSync(filePath, 'r');
    const size = statSync(filePath).size;
    if (size === 0 || maxBytes <= 0) return [];

    const start = Math.max(0, size - maxBytes);
    const buffer = Buffer.allocUnsafe(size - start);
    const bytesRead = readSync(fd, buffer, 0, buffer.length, start);
    const lines = buffer.subarray(0, bytesRead).toString('utf8').split('\n');
    if (start > 0) lines.shift();
    else if (lines[lines.length - 1] === '') lines.pop();

    const events: ChatGptWebEventRecord[] = [];
    for (const line of lines) {
      const event = parseEventLine(line);
      if (event) events.push(event);
    }
    return events;
  } catch {
    return [];
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* already closed */ }
    }
  }
}

/**
 * Tails the log from a byte offset. `fs.watch` only accelerates delivery — the
 * interval poll is the source of truth, because the writer's trim replaces the
 * file with `renameSync` and a file watch does not survive that.
 */
export function followEvents(
  filePath: string,
  onEvent: (event: ChatGptWebEventRecord) => void,
  options: FollowEventsOptions = {},
): ChatGptWebEventFollower {
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const maxOffset = Math.max(eventLogSize(filePath), 0);
  let offset = Math.max(options.fromOffset ?? maxOffset, 0);
  let pending = Buffer.alloc(0);
  let closed = false;
  let watcher: FSWatcher | undefined;

  const drain = (): void => {
    if (closed) return;
    let size: number;
    try {
      size = statSync(filePath).size;
    } catch {
      // The gateway may not have started yet; the next tick retries.
      return;
    }

    if (size < offset) {
      // Truncated or replaced by the writer's trim: re-read from the start.
      offset = 0;
      pending = Buffer.alloc(0);
    }
    if (size <= offset) return;

    let fd: number | undefined;
    let chunk: Buffer;
    try {
      fd = openSync(filePath, 'r');
      chunk = Buffer.allocUnsafe(size - offset);
      const bytesRead = readSync(fd, chunk, 0, chunk.length, offset);
      offset += bytesRead;
      chunk = chunk.subarray(0, bytesRead);
    } catch {
      return;
    } finally {
      if (fd !== undefined) {
        try { closeSync(fd); } catch { /* already closed */ }
      }
    }

    pending = Buffer.concat([pending, chunk]);
    if (pending.length > MAX_PENDING_BYTES) {
      // A line this long is not a tool call; skip it rather than grow forever.
      pending = Buffer.alloc(0);
      return;
    }

    const lastNewline = pending.lastIndexOf(NEWLINE);
    if (lastNewline === -1) return;
    const complete = pending.subarray(0, lastNewline);
    pending = pending.subarray(lastNewline + 1);

    for (const line of complete.toString('utf8').split('\n')) {
      const event = parseEventLine(line);
      if (event) onEvent(event);
    }
  };

  const timer = setInterval(drain, pollIntervalMs);
  timer.unref();

  try {
    watcher = watch(dirname(filePath), { persistent: false }, (_eventType, changed) => {
      if (changed && changed !== basename(filePath)) return;
      drain();
    });
  } catch {
    // A missing directory just leaves the poll as the only trigger.
  }

  drain();

  return {
    close(): void {
      if (closed) return;
      closed = true;
      clearInterval(timer);
      try { watcher?.close(); } catch { /* already closed */ }
    },
  };
}