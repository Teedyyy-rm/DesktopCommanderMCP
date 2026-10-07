import { randomBytes } from 'node:crypto';
import {
  appendFileSync,
  chmodSync,
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import type { ChatGptWebToolCallMetadata, ChatGptWebToolCallLogEvent } from './gateway.js';

const MAX_EVENT_LOG_BYTES = 32 * 1024 * 1024;
const TRIM_TARGET_BYTES = 28 * 1024 * 1024;
const MAX_PENDING_ARGUMENTS = 512;

export const DEFAULT_EVENT_LOG_FILE_NAME = 'chatgpt-web-events.ndjson';

/**
 * One NDJSON line of the event log: a completed tool call.
 *
 * `ts` and `arguments` are not part of `ChatGptWebToolCallLogEvent`'s
 * completed branch — the gateway only carries arguments on the `started`
 * branch — so the writer pairs them back on here. The monitor needs both:
 * `ts` for the header counters, `arguments` for the WHAT column.
 */
export interface ChatGptWebEventRecord {
  ts: number;
  phase: string;
  callId: string;
  tool: string;
  status?: string;
  durationMs?: number;
  arguments?: Record<string, unknown>;
  result?: unknown;
  error?: string;
  metadata?: ChatGptWebToolCallMetadata;
}

export interface EventLogWriterOptions {
  filePath?: string;
  maxBytes?: number;
  trimTargetBytes?: number;
  now?: () => number;
}

export interface EventLogWriter {
  readonly filePath: string;
  write(event: ChatGptWebToolCallLogEvent): void;
  /** Drops cached file state so a writer can be pointed at a fresh path. */
  reset(): void;
}

export function resolveEventLogPath(): string {
  const configured = process.env.DC_CHATGPT_WEB_EVENT_LOG?.trim();
  return configured ? resolve(configured) : join(homedir(), '.claude-server-commander', DEFAULT_EVENT_LOG_FILE_NAME);
}

/**
 * NDJSON sink for the monitor TUI. One call per line, appended with
 * `appendFileSync` so several gateway instances may share the file, and every
 * failure is swallowed: a broken event log must never take the gateway down.
 */
export function createEventLogWriter(options: EventLogWriterOptions = {}): EventLogWriter {
  const filePath = options.filePath ? resolve(options.filePath) : resolveEventLogPath();
  const maxBytes = options.maxBytes ?? MAX_EVENT_LOG_BYTES;
  const trimTargetBytes = options.trimTargetBytes ?? TRIM_TARGET_BYTES;
  const now = options.now ?? Date.now;
  const pendingArguments = new Map<string, Record<string, unknown>>();

  let directoryEnsured = false;
  let permissionsEnsured = false;

  const ensureDirectory = (): void => {
    if (directoryEnsured) return;
    mkdirSync(dirname(filePath), { recursive: true, mode: 0o700 });
    directoryEnsured = true;
  };

  const ensurePermissions = (): void => {
    if (permissionsEnsured) return;
    try {
      if ((statSync(filePath).mode & 0o077) !== 0) chmodSync(filePath, 0o600);
    } catch {
      // Filesystems without permission bits are not a reason to drop events.
    }
    permissionsEnsured = true;
  };

  const trimIfTooLarge = (): void => {
    let size: number;
    try {
      size = statSync(filePath).size;
    } catch {
      return;
    }
    if (size <= maxBytes) return;

    try {
      const lines = readFileSync(filePath, 'utf8').split('\n').filter((line) => line.length > 0);
      if (lines.length === 0) return;

      const kept: string[] = [];
      let bytes = 0;
      for (let index = lines.length - 1; index >= 0; index -= 1) {
        const lineBytes = Buffer.byteLength(lines[index], 'utf8') + 1;
        if (kept.length > 0 && bytes + lineBytes > trimTargetBytes) break;
        kept.push(lines[index]);
        bytes += lineBytes;
      }
      kept.reverse();

      const temporaryPath = `${filePath}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
      const fd = openSync(temporaryPath, 'wx', 0o600);
      try {
        writeFileSync(fd, `${kept.join('\n')}\n`, 'utf8');
        fsyncSync(fd);
        closeSync(fd);
      } catch (error) {
        try { closeSync(fd); } catch { /* already closed */ }
        try { unlinkSync(temporaryPath); } catch { /* best effort cleanup */ }
        throw error;
      }
      renameSync(temporaryPath, filePath);
      permissionsEnsured = true;
    } catch {
      // A failed trim only costs disk; the append below still succeeds.
    }
  };

  const rememberArguments = (callId: string, args: Record<string, unknown>): void => {
    if (pendingArguments.size >= MAX_PENDING_ARGUMENTS) {
      const oldest = pendingArguments.keys().next();
      if (!oldest.done) pendingArguments.delete(oldest.value);
    }
    pendingArguments.set(callId, args);
  };

  return {
    filePath,
    write(event: ChatGptWebToolCallLogEvent): void {
      try {
        if (event.phase === 'started') {
          rememberArguments(event.callId, event.arguments);
          return;
        }

        const args = pendingArguments.get(event.callId);
        pendingArguments.delete(event.callId);
        const record: ChatGptWebEventRecord = {
          ts: now(),
          phase: 'completed',
          callId: event.callId,
          tool: event.tool,
          ...(args ? { arguments: args } : {}),
          ...(event.status !== undefined ? { status: event.status } : {}),
          ...(event.durationMs !== undefined ? { durationMs: event.durationMs } : {}),
          ...(event.result !== undefined ? { result: event.result } : {}),
          ...(event.error !== undefined ? { error: event.error } : {}),
          metadata: event.metadata,
        };

        ensureDirectory();
        trimIfTooLarge();
        appendFileSync(filePath, `${JSON.stringify(record)}\n`, 'utf8');
        ensurePermissions();
      } catch {
        // Event logging is observability, not a request path.
      }
    },
    reset(): void {
      pendingArguments.clear();
      directoryEnsured = false;
      permissionsEnsured = false;
    },
  };
}