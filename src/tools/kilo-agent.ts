import { execFile } from 'child_process';
import { createHash, randomUUID } from 'crypto';
import { chmod, mkdir, readFile, rename, writeFile } from 'fs/promises';
import os from 'os';
import path from 'path';
import { promisify } from 'util';
import * as lockfile from 'proper-lockfile';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { KiloAgentArgsSchema, type LocalAgentTaskStatus } from './schemas.js';

const execFileAsync = promisify(execFile);
const REPORT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_REPORT_CHARACTERS = 200_000;
const MAX_EVENT_LINE_CHARACTERS = 2_000_000;
const DEFAULT_STATE_DIRECTORY = path.join(os.homedir(), '.claude-server-commander', 'kilo-agent');
const KILO_EXIT_MARKER = '__DC_KILO_RUN_EXIT__';
const KILO_METADATA_EXIT_MARKER = '__DC_KILO_METADATA_EXIT__';
const DELETE_EXIT_MARKER = '__DC_KILO_DELETE_EXIT__';
const KILO_SESSION_LIST_LIMIT = 100;

export type KiloTaskStatus = LocalAgentTaskStatus;
export type KiloSessionCleanupStatus = 'not_eligible' | 'pending' | 'deleted';
export type KiloActivityPhase = 'awaiting_session' | 'processing' | 'executing_tools' | 'generating_response' | 'completed' | 'failed' | 'cancelled';

export interface KiloTaskTurn {
    turn_id: string;
    prompt_sha256: string;
    status: KiloTaskStatus;
    started_at: string;
    updated_at: string;
    completed_at?: string;
    report?: string;
    error?: string;
    exit_code?: number;
}

export interface KiloTaskRecord {
    task_id: string;
    sequence: number;
    status: KiloTaskStatus;
    execution_mode?: 'tui' | 'headless';
    worktree_name?: string;
    repo_root?: string;
    working_directory: string;
    created_at: string;
    updated_at: string;
    worktree_id?: string;
    worktree_path?: string;
    startup_terminal_handle?: string;
    terminal_handle?: string;
    cleanup_terminal_handle?: string;
    session_id?: string;
    prompt_sha256?: string;
    turns?: KiloTaskTurn[];
    current_turn_id?: string;
    baseline_kilo_session_ids?: string[];
    activity_phase?: KiloActivityPhase;
    activity_summary?: string;
    last_observed_at?: string;
    assistant_message_count?: number;
    exit_code?: number;
    completed_at?: string;
    report?: string;
    error?: string;
    session_cleanup: KiloSessionCleanupStatus;
    cleanup_error?: string;
    terminal_close_error?: string;
}

interface PersistedState {
    version: 1;
    next_sequence: number;
    tasks: KiloTaskRecord[];
}

export interface OrcaCliResponse {
    ok: boolean;
    result?: unknown;
    error?: { code?: string; message?: string };
}

export interface KiloAgentManagerOptions {
    cwd?: string;
    stateDirectory?: string;
    platform?: NodeJS.Platform;
    now?: () => number;
    createId?: () => string;
    invokeOrca?: (args: string[], timeoutMs: number, cwd?: string) => Promise<OrcaCliResponse>;
    isGitRepository?: (cwd: string) => Promise<boolean>;
    assertMainCheckout?: (repoRoot: string) => Promise<void>;
}

const invokeOrcaCommand: NonNullable<KiloAgentManagerOptions['invokeOrca']> = async (args, timeoutMs, cwd) => {
    // Linux's system `orca` command is the GNOME screen reader. Use Orca's
    // versioned CLI wrapper outside an Orca-managed terminal.
    const executable = process.env.ORCA_CLI_COMMAND || (process.platform === 'linux' ? 'orca-ide' : 'orca');
    const { stdout } = await execFileAsync(executable, [...args, '--json'], {
        cwd: cwd ?? process.cwd(),
        env: process.env,
        encoding: 'utf8',
        maxBuffer: 32 * 1024 * 1024,
        timeout: timeoutMs,
        windowsHide: true,
    });
    const output = String(stdout).trim();
    const start = output.indexOf('{');
    const end = output.lastIndexOf('}');
    if (start < 0 || end < start) throw new Error(`Orca returned non-JSON output: ${output.slice(0, 500)}`);
    return JSON.parse(output.slice(start, end + 1)) as OrcaCliResponse;
};

async function defaultIsGitRepository(cwd: string): Promise<boolean> {
    try {
        await execFileAsync('git', ['rev-parse', '--is-inside-work-tree'], {
            cwd,
            timeout: 5_000,
            windowsHide: true,
        });
        return true;
    } catch {
        return false;
    }
}

export async function resolveMainWorktreePath(repoRoot: string): Promise<string> {
    const { stdout } = await execFileAsync('git', ['worktree', 'list', '--porcelain'], {
        cwd: repoRoot,
        encoding: 'utf8',
        timeout: 5_000,
        windowsHide: true,
    });
    const entries = String(stdout).trim().split(/\n\s*\n/).filter(Boolean).map((entry) => {
        const worktree = entry.match(/^worktree (.+)$/m)?.[1];
        const branch = entry.match(/^branch (.+)$/m)?.[1];
        return worktree && branch ? { path: path.resolve(worktree), branch } : undefined;
    }).filter((entry): entry is { path: string; branch: string } => entry !== undefined);
    const main = entries.find((entry) => entry.branch === 'refs/heads/main');
    if (!main) throw new Error(`No existing worktree on branch main was found for ${repoRoot}; Kilo will not create one.`);
    return main.path;
}

async function assertCleanSynchronizedMain(repoRoot: string): Promise<void> {
    const { stdout: branchOutput } = await execFileAsync('git', ['branch', '--show-current'], {
        cwd: repoRoot,
        encoding: 'utf8',
        timeout: 5_000,
        windowsHide: true,
    });
    const branch = String(branchOutput).trim();
    if (branch !== 'main') throw new Error(`Kilo can run directly only from branch main; the current branch is ${branch || '(detached)'}.`);

    const { stdout: statusOutput } = await execFileAsync('git', ['status', '--porcelain', '--untracked-files=all'], {
        cwd: repoRoot,
        encoding: 'utf8',
        timeout: 5_000,
        windowsHide: true,
    });
    const dirty = String(statusOutput).trim();
    if (dirty) throw new Error(`The main checkout must be clean before Kilo starts. Commit or otherwise resolve these changes first:\n${dirty.slice(0, 2_000)}`);

    const { stdout: divergenceOutput } = await execFileAsync('git', ['rev-list', '--left-right', '--count', 'main...origin/main'], {
        cwd: repoRoot,
        encoding: 'utf8',
        timeout: 5_000,
        windowsHide: true,
    });
    const divergence = String(divergenceOutput).trim().split(/\s+/).map(Number);
    if (divergence.length !== 2 || divergence[0] !== 0 || divergence[1] !== 0) {
        throw new Error(`Local main must match origin/main before Kilo starts (main...origin/main is ${String(divergenceOutput).trim() || 'unknown'}).`);
    }
}

function errorText(error: unknown): string {
    const message = error instanceof Error ? error.message : String(error);
    return message.slice(0, 2_000);
}

function shortTaskId(taskId: string, length = 8): string {
    return taskId.replace(/-/g, '').slice(-length);
}

function notFound(error: unknown): boolean {
    return typeof error === 'object' && error !== null && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT';
}

function parseState(text: string): PersistedState {
    const value: unknown = JSON.parse(text);
    if (typeof value !== 'object' || value === null) throw new Error('Kilo task registry is not a JSON object');
    const state = value as Partial<PersistedState>;
    if (state.version !== 1 || !Number.isInteger(state.next_sequence) || !Array.isArray(state.tasks)) {
        throw new Error('Kilo task registry has an unsupported or invalid format');
    }
    return state as PersistedState;
}

function resultOf(response: OrcaCliResponse, command: string): unknown {
    if (!response.ok) {
        const detail = response.error?.message || response.error?.code || 'unknown Orca error';
        throw new Error(`Orca ${command} failed: ${detail}`);
    }
    return response.result ?? {};
}

function objectRecord(value: unknown): Record<string, unknown> | undefined {
    return typeof value === 'object' && value !== null ? value as Record<string, unknown> : undefined;
}

function findString(value: unknown, keys: string[], predicate?: (value: string) => boolean): string | undefined {
    if (Array.isArray(value)) {
        for (const child of value) {
            const found = findString(child, keys, predicate);
            if (found) return found;
        }
        return undefined;
    }
    const record = objectRecord(value);
    if (!record) return undefined;
    for (const key of keys) {
        const candidate = record[key];
        if (typeof candidate === 'string' && (!predicate || predicate(candidate))) return candidate;
    }
    for (const child of Object.values(record)) {
        const found = findString(child, keys, predicate);
        if (found) return found;
    }
    return undefined;
}

function findNumber(value: unknown, keys: string[]): number | undefined {
    if (Array.isArray(value)) {
        for (const child of value) {
            const found = findNumber(child, keys);
            if (found !== undefined) return found;
        }
        return undefined;
    }
    const record = objectRecord(value);
    if (!record) return undefined;
    for (const key of keys) if (typeof record[key] === 'number') return record[key] as number;
    for (const child of Object.values(record)) {
        const found = findNumber(child, keys);
        if (found !== undefined) return found;
    }
    return undefined;
}

function posixQuote(value: string): string {
    return `'${value.replace(/'/g, `'\\''`)}'`;
}

function powershellQuote(value: string): string {
    return `'${value.replace(/'/g, `''`)}'`;
}

function buildShellScript(command: string, marker: string, platform: NodeJS.Platform): string {
    if (platform === 'win32') {
        return `& ${command}; $dcKiloExit = $LASTEXITCODE; [Console]::Out.WriteLine("${marker}$dcKiloExit"); exit 0`;
    }
    return `${command}\ndc_kilo_exit=$?\nprintf '\\n${marker}%s\\n' "$dc_kilo_exit"\nexit 0`;
}

export function buildKiloRunTerminalCommand(
    prompt: string,
    platform: NodeJS.Platform = process.platform,
    workingDirectory?: string,
): string {
    const kiloCommand = `kilo run --auto --format json -- ${platform === 'win32' ? powershellQuote(prompt) : posixQuote(prompt)}`;
    const executionCommand = workingDirectory
        ? platform === 'win32'
            ? `Set-Location -LiteralPath ${powershellQuote(workingDirectory)}; if ($?) { & ${kiloCommand} } else { $global:LASTEXITCODE = 1 }`
            : `cd ${posixQuote(workingDirectory)} && ${kiloCommand}`
        : platform === 'win32' ? `& ${kiloCommand}` : kiloCommand;
    const script = buildShellScript(executionCommand, KILO_EXIT_MARKER, platform);
    return platform === 'win32'
        ? `powershell -NoProfile -Command ${powershellQuote(script)}`
        : `sh -c ${posixQuote(script)}`;
}

export function buildKiloTuiTerminalCommand(
    prompt: string,
    platform: NodeJS.Platform = process.platform,
    workingDirectory?: string,
    sessionId?: string,
): string {
    // `kilo` (without the `run` subcommand) opens Kilo's interactive TUI.
    // Do not pass --worktree: Kilo would make another Git worktree itself.
    const quote = platform === 'win32' ? powershellQuote : posixQuote;
    const sessionOption = sessionId ? `--session ${quote(sessionId)} ` : '';
    const kiloCommand = `kilo --auto ${sessionOption}--prompt ${quote(prompt)}`;
    const executionCommand = workingDirectory
        ? platform === 'win32'
            ? `Set-Location -LiteralPath ${powershellQuote(workingDirectory)}; if ($?) { & ${kiloCommand} } else { $global:LASTEXITCODE = 1 }`
            : `cd ${posixQuote(workingDirectory)} && exec ${kiloCommand}`
        : platform === 'win32' ? `& ${kiloCommand}` : `exec ${kiloCommand}`;
    return platform === 'win32'
        ? `powershell -NoProfile -Command ${powershellQuote(executionCommand)}`
        : `sh -c ${posixQuote(executionCommand)}`;
}

function buildKiloMetadataTerminalCommand(
    args: string[],
    platform: NodeJS.Platform,
    workingDirectory: string,
): string {
    const quote = platform === 'win32' ? powershellQuote : posixQuote;
    const kiloCommand = `kilo ${args.map(quote).join(' ')}`;
    const executionCommand = platform === 'win32'
        ? `Set-Location -LiteralPath ${powershellQuote(workingDirectory)}; if ($?) { & ${kiloCommand} } else { $global:LASTEXITCODE = 1 }`
        : `cd ${posixQuote(workingDirectory)} && ${kiloCommand}`;
    const script = buildShellScript(executionCommand, KILO_METADATA_EXIT_MARKER, platform);
    return platform === 'win32'
        ? `powershell -NoProfile -Command ${powershellQuote(script)}`
        : `sh -c ${posixQuote(script)}`;
}

function buildSessionDeleteTerminalCommand(sessionId: string, platform: NodeJS.Platform): string {
    const kiloCommand = `kilo session delete ${platform === 'win32' ? powershellQuote(sessionId) : posixQuote(sessionId)}`;
    const script = buildShellScript(kiloCommand, DELETE_EXIT_MARKER, platform);
    return platform === 'win32'
        ? `powershell -NoProfile -Command ${powershellQuote(script)}`
        : `sh -c ${posixQuote(script)}`;
}

function terminalOutput(value: unknown): string {
    if (typeof value === 'string') return value;
    if (Array.isArray(value)) return value.map(terminalOutput).join('\n');
    const record = objectRecord(value);
    if (!record) return '';
    // Orca's terminal read response nests the visible buffer at
    // `result.terminal.tail`; tests and older responses may use `output`.
    for (const key of ['output', 'text', 'lines', 'content', 'terminalOutput', 'tail', 'terminal']) {
        if (record[key] !== undefined) return terminalOutput(record[key]);
    }
    return '';
}

export interface ParsedKiloTerminalOutput {
    session_id?: string;
    report?: string;
    error?: string;
    exit_code?: number;
}

export function parseKiloTerminalOutput(output: string): ParsedKiloTerminalOutput {
    const clean = output.replace(/\u001b(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007]*(?:\u0007|\u001b\\))/g, '').replace(/\r/g, '');
    const reportParts: string[] = [];
    const seenParts = new Set<string>();
    let sessionId: string | undefined;
    let error: string | undefined;
    let exitCode: number | undefined;

    for (const line of clean.split('\n')) {
        const marker = line.match(new RegExp(`${KILO_EXIT_MARKER}(-?\\d+)`));
        if (marker) exitCode = Number(marker[1]);
        const trimmed = line.trim();
        if (!trimmed.startsWith('{') || trimmed.length > MAX_EVENT_LINE_CHARACTERS) continue;

        let event: Record<string, unknown>;
        try {
            event = JSON.parse(trimmed) as Record<string, unknown>;
        } catch {
            continue;
        }

        if (typeof event.sessionID === 'string' && event.sessionID.length > 0) sessionId = event.sessionID.slice(0, 200);
        if (event.type === 'error') {
            const message = findString(event.error, ['message', 'name']);
            if (message) error = message.slice(0, 2_000);
            continue;
        }
        if (event.type !== 'text') continue;
        const part = objectRecord(event.part);
        if (!part || part.type !== 'text' || typeof part.text !== 'string') continue;
        const time = objectRecord(part.time);
        if (!time || time.end === undefined) continue;
        const partId = typeof part.id === 'string' ? part.id : undefined;
        if (partId && seenParts.has(partId)) continue;
        if (partId) seenParts.add(partId);
        reportParts.push(part.text);
    }

    const report = reportParts.join('\n').trim().slice(0, MAX_REPORT_CHARACTERS);
    return {
        ...(sessionId ? { session_id: sessionId } : {}),
        ...(report ? { report } : {}),
        ...(error ? { error } : {}),
        ...(exitCode !== undefined ? { exit_code: exitCode } : {}),
    };
}

export interface KiloSessionSummary {
    id: string;
    directory?: string;
    created?: number;
}

export interface ParsedKiloSessionExport {
    session_id?: string;
    prompt_sha256?: string;
    completed: boolean;
    activity_phase?: KiloActivityPhase;
    assistant_message_count?: number;
    report?: string;
    error?: string;
}

export function parseKiloSessionList(output: string): KiloSessionSummary[] {
    const clean = output.replace(/\u001b(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007]*(?:\u0007|\u001b\\))/g, '').replace(/\r/g, '');
    const start = clean.indexOf('[');
    const end = clean.lastIndexOf(']');
    if (start < 0 || end < start) throw new Error('Kilo session list did not return a JSON array');
    const sessions: unknown = JSON.parse(clean.slice(start, end + 1));
    if (!Array.isArray(sessions)) throw new Error('Kilo session list returned an unsupported format');
    return sessions.flatMap((value) => {
        const session = objectRecord(value);
        if (typeof session?.id !== 'string') return [];
        return [{
            id: session.id,
            ...(typeof session.directory === 'string' ? { directory: session.directory } : {}),
            ...(typeof session.created === 'number' ? { created: session.created } : {}),
        }];
    });
}

export function parseKiloSessionExport(output: string): ParsedKiloSessionExport {
    const clean = output.replace(/\u001b(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007]*(?:\u0007|\u001b\\))/g, '').replace(/\r/g, '');
    const start = clean.indexOf('{');
    const end = clean.lastIndexOf('}');
    if (start < 0 || end < start) throw new Error('Kilo session export did not return a JSON object');
    const exported: unknown = JSON.parse(clean.slice(start, end + 1));
    const root = objectRecord(exported);
    const info = objectRecord(root?.info);
    const messages = Array.isArray(root?.messages) ? root.messages : [];
    const userMessages = messages.flatMap((value, index) => {
        const message = objectRecord(value);
        const messageInfo = objectRecord(message?.info);
        if (messageInfo?.role !== 'user' || !Array.isArray(message?.parts)) return [];
        const text = message.parts.flatMap((partValue) => {
            const part = objectRecord(partValue);
            return part?.type === 'text' && typeof part.text === 'string' ? [part.text] : [];
        }).join('\n');
        return text ? [{ text, index }] : [];
    });
    const assistantMessages = messages.flatMap((value, index) => {
        const message = objectRecord(value);
        const messageInfo = objectRecord(message?.info);
        return messageInfo?.role === 'assistant' ? [{ info: messageInfo, parts: Array.isArray(message?.parts) ? message.parts : [], index }] : [];
    });
    const lastUser = userMessages.at(-1);
    const assistantAfterLastUser = assistantMessages.filter(({ index }) => lastUser && index > lastUser.index);
    const latestAssistant = assistantAfterLastUser.at(-1);
    const finalMessage = [...assistantAfterLastUser].reverse().find(({ info: messageInfo }) => {
        const time = objectRecord(messageInfo.time);
        return time?.completed !== undefined && (messageInfo.finish === 'stop' || messageInfo.finish === 'error');
    });
    const report = finalMessage?.parts.flatMap((partValue) => {
        const part = objectRecord(partValue);
        return part?.type === 'text' && typeof part.text === 'string' ? [part.text] : [];
    }).join('\n').trim().slice(0, MAX_REPORT_CHARACTERS);
    const finish = finalMessage?.info.finish;
    const latestTime = objectRecord(latestAssistant?.info.time);
    const latestFinish = latestAssistant?.info.finish;
    const completed = Boolean(finalMessage && latestAssistant === finalMessage);
    const activityPhase: KiloActivityPhase = completed
        ? finish === 'error' ? 'failed' : 'completed'
        : !lastUser ? 'processing'
            : !latestAssistant ? 'processing'
                : latestFinish === 'tool-calls' ? 'executing_tools'
                    : latestTime?.completed === undefined ? 'generating_response'
                        : 'processing';
    return {
        ...(typeof info?.id === 'string' ? { session_id: info.id.slice(0, 200) } : {}),
        ...(lastUser ? { prompt_sha256: createHash('sha256').update(lastUser.text).digest('hex') } : {}),
        completed,
        activity_phase: activityPhase,
        assistant_message_count: assistantAfterLastUser.length,
        ...(report ? { report } : {}),
        ...(completed && finish === 'error' ? { error: 'Kilo ended the TUI session with an error.' } : {}),
    };
}

function findCreatedTerminalHandle(value: unknown): string | undefined {
    const record = objectRecord(value);
    if (!record) return undefined;
    for (const key of ['terminalHandle', 'handle']) {
        if (typeof record[key] === 'string') return record[key];
    }
    const terminal = objectRecord(record.terminal);
    if (typeof terminal?.handle === 'string') return terminal.handle;
    return findString(value, ['terminalHandle']);
}

function repoList(value: unknown): Array<{ id: string; path: string }> {
    const record = objectRecord(value);
    if (!record || !Array.isArray(record.repos)) return [];
    return record.repos.flatMap((entry) => {
        const repo = objectRecord(entry);
        if (typeof repo?.id !== 'string' || typeof repo.path !== 'string') return [];
        return [{ id: repo.id, path: repo.path }];
    });
}

function findMainWorktree(value: unknown, repoRoot: string): { id: string; path: string } | undefined {
    const record = objectRecord(value);
    if (!record || !Array.isArray(record.worktrees)) return undefined;
    for (const entry of record.worktrees) {
        const worktree = objectRecord(entry);
        const git = objectRecord(worktree?.git);
        if (typeof worktree?.id !== 'string' || typeof worktree.path !== 'string') continue;
        if (path.resolve(worktree.path) !== path.resolve(repoRoot)) continue;
        const isMain = worktree.isMainWorktree === true || git?.isMainWorktree === true;
        const branch = typeof worktree.branch === 'string' ? worktree.branch : '';
        if (isMain && (branch === 'refs/heads/main' || branch === 'main')) {
            return { id: worktree.id, path: path.resolve(worktree.path) };
        }
    }
    return undefined;
}

export interface GitWorkspaceSnapshot {
    path: string;
    branch?: string;
    head_sha?: string;
    upstream?: string;
    ahead?: number;
    behind?: number;
    dirty: boolean;
    changes: Array<{ status: string; path: string }>;
    changes_truncated: boolean;
}

async function readGitWorkspaceSnapshot(repoRoot: string): Promise<GitWorkspaceSnapshot> {
    const run = async (args: string[]): Promise<string> => {
        const { stdout } = await execFileAsync('git', args, {
            cwd: repoRoot,
            encoding: 'utf8',
            timeout: 5_000,
            windowsHide: true,
            maxBuffer: 2 * 1024 * 1024,
        });
        return String(stdout).trim();
    };
    const [statusOutput, branch, headSha] = await Promise.all([
        run(['status', '--porcelain=v1', '--untracked-files=all']),
        run(['branch', '--show-current']).catch(() => ''),
        run(['rev-parse', 'HEAD']).catch(() => ''),
    ]);
    const upstream = await run(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}']).catch(() => '');
    let ahead: number | undefined;
    let behind: number | undefined;
    if (upstream) {
        const counts = await run(['rev-list', '--left-right', '--count', `HEAD...${upstream}`]).catch(() => '');
        const match = counts.match(/^(\d+)\s+(\d+)$/);
        if (match) {
            ahead = Number(match[1]);
            behind = Number(match[2]);
        }
    }
    const allChanges = statusOutput ? statusOutput.split('\n').flatMap((line) => {
        if (line.length < 4) return [];
        const status = line.slice(0, 2).trim() || '??';
        return [{ status, path: line.slice(3).split(' -> ').at(-1) ?? line.slice(3) }];
    }) : [];
    return {
        path: path.resolve(repoRoot),
        ...(branch ? { branch } : {}),
        ...(headSha ? { head_sha: headSha } : {}),
        ...(upstream ? { upstream } : {}),
        ...(ahead !== undefined ? { ahead } : {}),
        ...(behind !== undefined ? { behind } : {}),
        dirty: allChanges.length > 0,
        changes: allChanges.slice(0, 200),
        changes_truncated: allChanges.length > 200,
    };
}

/**
 * Starts Kilo's interactive TUI in the existing Orca-managed main worktree.
 * Agent processes, metadata helpers, and session cleanup all run in Orca-owned
 * terminals; the task registry serializes access to the shared main checkout.
 */
export class KiloAgentManager {
    private readonly cwd: string;
    private readonly stateDirectory: string;
    private readonly stateFile: string;
    private readonly platform: NodeJS.Platform;
    private readonly now: () => number;
    private readonly createId: () => string;
    private readonly invokeOrca: NonNullable<KiloAgentManagerOptions['invokeOrca']>;
    private readonly isGitRepository: (cwd: string) => Promise<boolean>;
    private readonly assertMainCheckout: NonNullable<KiloAgentManagerOptions['assertMainCheckout']>;
    private state: PersistedState = { version: 1, next_sequence: 1, tasks: [] };
    private writeQueue: Promise<void> = Promise.resolve();
    private operationQueue: Promise<void> = Promise.resolve();

    constructor(options: KiloAgentManagerOptions = {}) {
        this.cwd = path.resolve(options.cwd ?? process.cwd());
        this.stateDirectory = options.stateDirectory ?? DEFAULT_STATE_DIRECTORY;
        this.stateFile = path.join(this.stateDirectory, 'tasks.json');
        this.platform = options.platform ?? process.platform;
        this.now = options.now ?? Date.now;
        this.createId = options.createId ?? randomUUID;
        this.invokeOrca = options.invokeOrca ?? invokeOrcaCommand;
        this.isGitRepository = options.isGitRepository ?? defaultIsGitRepository;
        this.assertMainCheckout = options.assertMainCheckout ?? assertCleanSynchronizedMain;
    }

    start(prompt: string, repositoryPath = this.cwd): Promise<CallToolResult> {
        return this.exclusive(async () => {
            try {
                return await this.withStateLock(() => this.startLocked(prompt, repositoryPath));
            } catch (error) {
                return this.errorResult(`Could not coordinate a Kilo task on main: ${errorText(error)}`);
            }
        });
    }

    status(taskId: string): Promise<CallToolResult> {
        return this.exclusive(async () => {
            try {
                return await this.withStateLock(() => this.statusLocked(taskId, true));
            } catch (error) {
                return this.errorResult(`Could not coordinate Kilo task status: ${errorText(error)}`);
            }
        });
    }

    inspect(taskId: string): Promise<CallToolResult> {
        return this.exclusive(async () => {
            try {
                return await this.withStateLock(() => this.statusLocked(taskId, false));
            } catch (error) {
                return this.errorResult(`Could not inspect Kilo task: ${errorText(error)}`);
            }
        });
    }

    listTasks(filters: { repositoryPath?: string; status?: KiloTaskStatus; limit?: number } = {}): Promise<CallToolResult> {
        return this.exclusive(async () => {
            try {
                return await this.withStateLock(async () => {
                    await this.pruneExpiredTasks();
                    const repositoryPath = filters.repositoryPath ? path.resolve(filters.repositoryPath) : undefined;
                    const tasks = this.state.tasks
                        .filter((task) => !repositoryPath || path.resolve(task.repo_root ?? task.working_directory) === repositoryPath)
                        .filter((task) => !filters.status || task.status === filters.status)
                        .sort((left, right) => right.sequence - left.sequence)
                        .slice(0, Math.min(filters.limit ?? 20, 50))
                        .map((task) => ({
                            task_id: task.task_id,
                            provider: 'kilo',
                            status: task.status,
                            current_turn_id: task.current_turn_id ?? task.turns?.at(-1)?.turn_id ?? 'turn-1',
                            created_at: task.created_at,
                            updated_at: task.updated_at,
                            ...(task.completed_at ? { completed_at: task.completed_at } : {}),
                            repository_path: task.repo_root ?? task.working_directory,
                            worktree_mode: 'main',
                            ...(task.session_id ? { provider_session_id: task.session_id } : {}),
                            report_ready: Boolean(task.report),
                            ...(task.activity_phase ? { activity_phase: task.activity_phase } : {}),
                            ...(task.last_observed_at ? { last_observed_at: task.last_observed_at } : {}),
                        }));
                    return this.jsonResult({ provider: 'kilo', tasks, returned: tasks.length, limit: Math.min(filters.limit ?? 20, 50) });
                });
            } catch (error) {
                return this.errorResult(`Could not list Kilo tasks: ${errorText(error)}`);
            }
        });
    }

    readReport(taskId: string, turnId?: string): Promise<CallToolResult> {
        return this.exclusive(async () => {
            try {
                return await this.withStateLock(async () => {
                    const inspected = await this.inspectTaskLocked(taskId);
                    if (!inspected) return this.errorResult(`Unknown or expired Kilo task_id: ${taskId}`);
                    const task = inspected.task;
                    const turns = this.taskTurns(task);
                    const selected = turnId
                        ? turns.find((turn) => turn.turn_id === turnId)
                        : turns.find((turn) => turn.turn_id === task.current_turn_id) ?? turns.at(-1);
                    if (!selected) return this.errorResult(`Unknown Kilo turn_id for task ${taskId}: ${turnId}`);
                    return this.jsonResult({
                        task_id: task.task_id,
                        provider: 'kilo',
                        turn_id: selected.turn_id,
                        status: selected.status,
                        report_ready: Boolean(selected.report),
                        ...(selected.completed_at ? { completed_at: selected.completed_at } : {}),
                        ...(selected.report ? { report: selected.report } : {}),
                        ...(selected.error ? { error: selected.error } : {}),
                        ...(inspected.monitor_error ? { monitor_error: inspected.monitor_error } : {}),
                        retention_days: 30,
                    }, selected.status === 'failed' || selected.status === 'interrupted');
                });
            } catch (error) {
                return this.errorResult(`Could not read Kilo task report: ${errorText(error)}`);
            }
        });
    }

    send(taskId: string, message: string): Promise<CallToolResult> {
        return this.exclusive(async () => {
            try {
                return await this.withStateLock(() => this.sendLocked(taskId, message));
            } catch (error) {
                return this.errorResult(`Could not send a follow-up to Kilo: ${errorText(error)}`);
            }
        });
    }

    cancel(taskId: string): Promise<CallToolResult> {
        return this.exclusive(async () => {
            try {
                return await this.withStateLock(() => this.cancelLocked(taskId));
            } catch (error) {
                return this.errorResult(`Could not cancel Kilo task: ${errorText(error)}`);
            }
        });
    }

    ownsTask(taskId: string): Promise<boolean> {
        return this.exclusive(async () => {
            try {
                return await this.withStateLock(async () => {
                    await this.pruneExpiredTasks();
                    return this.state.tasks.some((task) => task.task_id === taskId);
                });
            } catch {
                return false;
            }
        });
    }

    private async startLocked(prompt: string, repositoryPath: string): Promise<CallToolResult> {
        await this.pruneExpiredTasks();
        const selectedPath = path.resolve(repositoryPath);
        if (!(await this.isGitRepository(selectedPath))) {
            return this.errorResult(`Kilo main mode requires repository_path to be inside a Git repository on the Remote Device: ${selectedPath}`);
        }

        let repoRoot: string;
        try {
            const selectedGitRoot = await this.getGitRoot(selectedPath);
            repoRoot = await resolveMainWorktreePath(selectedGitRoot);
            await this.assertMainCheckout(repoRoot);
        } catch (error) {
            return this.errorResult(errorText(error));
        }

        const active = this.state.tasks.find((candidate) =>
            candidate.execution_mode === 'tui' &&
            candidate.repo_root === repoRoot &&
            (candidate.status === 'starting' || candidate.status === 'running'),
        );
        if (active) {
            return this.errorResult(`Kilo task ${active.task_id} is still active in main. Call status for that task before starting another task on this checkout.`);
        }

        let repoId: string;
        let mainWorktree: { id: string; path: string };
        try {
            repoId = await this.ensureOrcaRepo(repoRoot);
            const response = resultOf(await this.invokeOrca(['worktree', 'list', '--repo', `id:${repoId}`], 10_000, repoRoot), 'worktree list');
            const found = findMainWorktree(response, repoRoot);
            if (!found) throw new Error(`Orca has no registered main worktree for ${repoRoot}; Kilo did not create a replacement worktree.`);
            mainWorktree = found;
        } catch (error) {
            return this.errorResult(errorText(error));
        }

        const taskId = this.createId();
        const now = new Date(this.now()).toISOString();
        const promptSha256 = createHash('sha256').update(prompt).digest('hex');
        const task: KiloTaskRecord = {
            task_id: taskId,
            sequence: this.state.next_sequence++,
            status: 'starting',
            execution_mode: 'tui',
            repo_root: repoRoot,
            worktree_id: mainWorktree.id,
            worktree_path: mainWorktree.path,
            working_directory: repoRoot,
            created_at: now,
            updated_at: now,
            session_cleanup: 'not_eligible',
            prompt_sha256: promptSha256,
            current_turn_id: 'turn-1',
            turns: [{ turn_id: 'turn-1', prompt_sha256: promptSha256, status: 'starting', started_at: now, updated_at: now }],
            activity_phase: 'awaiting_session',
            activity_summary: 'Waiting for Kilo to create its local session.',
        };
        this.state.tasks.push(task);
        await this.persistState();

        try {
            const before = await this.readKiloSessionList(task, ['session', 'list', '--format', 'json', '--max-count', String(KILO_SESSION_LIST_LIMIT)]);
            task.baseline_kilo_session_ids = before.map((session) => session.id);
            task.updated_at = new Date(this.now()).toISOString();
            await this.persistState();

            const terminalResponse = resultOf(await this.invokeOrca([
                'terminal', 'create',
                '--worktree', `id:${mainWorktree.id}`,
                '--title', `Kilo TUI ${shortTaskId(taskId)}`,
                '--command', buildKiloTuiTerminalCommand(
                    prompt,
                    this.platform,
                    task.working_directory,
                    task.session_id,
                ),
            ], 15_000, task.working_directory), 'terminal create');
            const terminalHandle = findCreatedTerminalHandle(terminalResponse);
            if (!terminalHandle) throw new Error('Orca created the Kilo terminal but did not return its terminal handle');
            task.terminal_handle = terminalHandle;
            task.status = 'running';
            task.activity_phase = 'awaiting_session';
            task.activity_summary = 'Kilo is running in the Orca terminal; waiting for its session state.';
            task.last_observed_at = task.updated_at;
            task.updated_at = new Date(this.now()).toISOString();
            await this.persistState();

            return this.jsonResult({
                task_id: task.task_id,
                status: task.status,
                worktree_id: task.worktree_id,
                worktree_path: task.worktree_path,
                terminal_handle: task.terminal_handle,
                working_directory: task.working_directory,
                execution: 'Kilo TUI is running in the existing Orca main worktree. No new Git worktree was created.',
            });
        } catch (error) {
            task.status = 'failed';
            task.completed_at = new Date(this.now()).toISOString();
            task.updated_at = task.completed_at;
            task.error = errorText(error);
            task.activity_phase = 'failed';
            task.activity_summary = 'Kilo could not start this task.';
            await this.persistState();
            return this.jsonResult({
                task_id: task.task_id,
                status: task.status,
                ...(task.worktree_id ? { worktree_id: task.worktree_id } : {}),
                ...(task.terminal_handle ? { terminal_handle: task.terminal_handle } : {}),
                error: task.error,
            }, true);
        }
    }

    private async inspectTaskLocked(taskId: string): Promise<{
        task: KiloTaskRecord;
        monitor_error?: string;
        workspace?: Awaited<ReturnType<typeof readGitWorkspaceSnapshot>>;
        workspace_error?: string;
    } | undefined> {
        await this.pruneExpiredTasks();
        const task = this.state.tasks.find((candidate) => candidate.task_id === taskId);
        if (!task) return undefined;

        let monitorError: string | undefined;
        if ((task.status === 'running' || task.status === 'starting') && task.terminal_handle) {
            try {
                if (task.execution_mode === 'tui') await this.refreshTuiTask(task);
                else await this.refreshHeadlessTask(task);
            } catch (error) {
                monitorError = `Could not read Kilo session state through Orca; the task remains ${task.status}: ${errorText(error)}`;
                task.last_observed_at = new Date(this.now()).toISOString();
                await this.persistState();
            }
        }

        let workspace: Awaited<ReturnType<typeof readGitWorkspaceSnapshot>> | undefined;
        let workspaceError: string | undefined;
        try {
            workspace = await readGitWorkspaceSnapshot(task.repo_root ?? task.working_directory);
        } catch (error) {
            workspaceError = errorText(error);
        }
        return {
            task,
            ...(monitorError ? { monitor_error: monitorError } : {}),
            ...(workspace ? { workspace } : {}),
            ...(workspaceError ? { workspace_error: workspaceError } : {}),
        };
    }

    private async statusLocked(taskId: string, cleanupOlderSessions: boolean): Promise<CallToolResult> {
        const inspected = await this.inspectTaskLocked(taskId);
        if (!inspected) return this.errorResult(`Unknown or expired Kilo task_id: ${taskId}`);
        const { task, monitor_error: monitorError } = inspected;

        const superseded = this.state.tasks.filter((candidate) =>
            candidate.task_id !== task.task_id &&
            this.sameRepository(candidate, task) &&
            (candidate.status === 'completed' || candidate.status === 'failed' || candidate.status === 'cancelled') &&
            (Boolean(candidate.report) || Boolean(candidate.error)) &&
            (candidate.session_cleanup === 'pending' || this.hasNewerSuccessfulTask(candidate)),
        );
        const eligible = cleanupOlderSessions ? this.state.tasks.filter((candidate) =>
                (candidate.status === 'completed' || candidate.status === 'failed') &&
                this.sameRepository(candidate, task) &&
                Boolean(candidate.session_id) &&
                candidate.session_cleanup !== 'deleted' &&
                (candidate.session_cleanup === 'pending' || this.hasNewerSuccessfulTask(candidate)),
            ) : [];
        const supersededReports = superseded.map((candidate) => ({
            task_id: candidate.task_id,
            status: candidate.status,
            ...(candidate.session_id ? { session_id: candidate.session_id } : {}),
            ...(candidate.report ? { report: candidate.report } : {}),
            ...(candidate.error ? { error: candidate.error } : {}),
            cleanup_status: candidate.session_cleanup,
        }));

        // Persist each old report before Orca is asked to delete its Kilo session.
        for (const candidate of eligible) {
            candidate.session_cleanup = 'pending';
            candidate.cleanup_error = undefined;
            candidate.updated_at = new Date(this.now()).toISOString();
        }
        if (eligible.length > 0) await this.persistState();

        const cleanupStatus = new Map<string, { cleanup_status: KiloSessionCleanupStatus; cleanup_error?: string }>();
        for (const candidate of eligible) {
            try {
                if (candidate.execution_mode === 'tui') await this.closeCompletedTerminal(candidate, true);
                await this.deleteKiloSessionThroughOrca(candidate);
                candidate.session_cleanup = 'deleted';
                candidate.cleanup_error = undefined;
                cleanupStatus.set(candidate.task_id, { cleanup_status: 'deleted' });
                if (candidate.execution_mode !== 'tui') await this.closeCompletedTerminal(candidate);
            } catch (error) {
                candidate.session_cleanup = 'pending';
                candidate.cleanup_error = errorText(error);
                cleanupStatus.set(candidate.task_id, { cleanup_status: 'pending', cleanup_error: candidate.cleanup_error });
            }
            candidate.updated_at = new Date(this.now()).toISOString();
            await this.persistState();
        }

        const response = {
            task_id: task.task_id,
            provider: 'kilo',
            status: task.status,
            current_turn_id: task.current_turn_id ?? task.turns?.at(-1)?.turn_id ?? 'turn-1',
            created_at: task.created_at,
            updated_at: task.updated_at,
            ...(task.last_observed_at ? { last_observed_at: task.last_observed_at } : {}),
            ...(task.activity_phase ? { activity_phase: task.activity_phase } : {}),
            ...(task.activity_summary ? { activity_summary: task.activity_summary } : {}),
            ...(task.assistant_message_count !== undefined ? { assistant_message_count: task.assistant_message_count } : {}),
            worktree_id: task.worktree_id,
            worktree_path: task.worktree_path,
            repository_path: task.repo_root ?? task.working_directory,
            worktree_mode: 'main',
            terminal_handle: task.terminal_handle,
            ...(task.session_id ? { provider_session_id: task.session_id, session_id: task.session_id } : {}),
            ...(task.exit_code !== undefined ? { exit_code: task.exit_code } : {}),
            ...(task.completed_at ? { completed_at: task.completed_at } : {}),
            report_ready: Boolean(task.report),
            ...(task.report ? { report: task.report } : {}),
            ...(task.error ? { error: task.error } : {}),
            ...(monitorError ? { monitor_error: monitorError } : {}),
            ...(inspected.workspace ? { workspace: inspected.workspace } : {}),
            ...(inspected.workspace_error ? { workspace_error: inspected.workspace_error } : {}),
            ...(task.terminal_close_error ? { terminal_close_error: task.terminal_close_error } : {}),
            ...(task.cleanup_error ? { session_cleanup_error: task.cleanup_error } : {}),
            turns: this.taskTurns(task).map((turn) => ({
                turn_id: turn.turn_id,
                status: turn.status,
                started_at: turn.started_at,
                updated_at: turn.updated_at,
                ...(turn.completed_at ? { completed_at: turn.completed_at } : {}),
                report_ready: Boolean(turn.report),
                ...(turn.error ? { error: turn.error } : {}),
            })),
            session_cleanup: task.session_cleanup,
            superseded_reports: supersededReports.map((report) => ({ ...report, ...cleanupStatus.get(report.task_id) })),
        };
        return this.jsonResult(response, task.status === 'failed' || task.status === 'interrupted');
    }

    private async sendLocked(taskId: string, message: string): Promise<CallToolResult> {
        const inspected = await this.inspectTaskLocked(taskId);
        if (!inspected) return this.errorResult(`Unknown or expired Kilo task_id: ${taskId}`);
        const task = inspected.task;
        if (task.status !== 'completed' || !task.session_id) {
            return this.errorResult(`Kilo follow-up messages require a completed task with a matched provider session; current status is ${task.status}.`);
        }
        if (!task.worktree_id) return this.errorResult('Kilo task is missing its Orca main worktree id.');

        try {
            await this.closeCompletedTerminal(task, true);
        } catch (error) {
            return this.errorResult(`Could not close the completed Kilo TUI before continuing its session: ${errorText(error)}`);
        }

        const previousTurns = this.taskTurns(task).map((turn) => ({ ...turn }));
        const turnNumber = previousTurns.length + 1;
        const turnId = `turn-${turnNumber}`;
        const now = new Date(this.now()).toISOString();
        const promptSha256 = createHash('sha256').update(message).digest('hex');
        task.current_turn_id = turnId;
        task.prompt_sha256 = promptSha256;
        task.report = undefined;
        task.error = undefined;
        task.exit_code = undefined;
        task.completed_at = undefined;
        task.status = 'starting';
        task.activity_phase = 'awaiting_session';
        task.activity_summary = 'Waiting for Kilo to resume the session with the follow-up.';
        task.last_observed_at = now;
        task.updated_at = now;
        task.turns = previousTurns;
        task.turns.push({ turn_id: turnId, prompt_sha256: promptSha256, status: 'starting', started_at: now, updated_at: now });
        await this.persistState();

        try {
            const response = resultOf(await this.invokeOrca([
                'terminal', 'create',
                '--worktree', `id:${task.worktree_id}`,
                '--title', `Kilo follow-up ${shortTaskId(task.task_id)} ${turnNumber}`,
                '--command', buildKiloTuiTerminalCommand(message, this.platform, task.working_directory, task.session_id),
            ], 15_000, task.working_directory), 'terminal create for Kilo follow-up');
            const terminalHandle = findCreatedTerminalHandle(response);
            if (!terminalHandle) throw new Error('Orca did not return a terminal handle for the Kilo follow-up');
            task.terminal_handle = terminalHandle;
            task.status = 'running';
            task.activity_summary = 'Kilo resumed the provider session in the Orca terminal.';
            task.updated_at = new Date(this.now()).toISOString();
            await this.persistState();
            return this.jsonResult({
                task_id: task.task_id,
                provider: 'kilo',
                turn_id: turnId,
                status: task.status,
                provider_session_id: task.session_id,
                orca_terminal_handle: task.terminal_handle,
                repository_path: task.repo_root ?? task.working_directory,
                execution: 'Follow-up sent to the existing Kilo session through a new Orca-owned TUI terminal.',
            });
        } catch (error) {
            task.status = 'failed';
            task.completed_at = new Date(this.now()).toISOString();
            task.updated_at = task.completed_at;
            task.error = errorText(error);
            task.activity_phase = 'failed';
            task.activity_summary = 'Kilo could not start the follow-up turn.';
            await this.persistState();
            return this.jsonResult({ task_id: task.task_id, turn_id: turnId, status: task.status, error: task.error }, true);
        }
    }

    private async cancelLocked(taskId: string): Promise<CallToolResult> {
        await this.pruneExpiredTasks();
        const task = this.state.tasks.find((candidate) => candidate.task_id === taskId);
        if (!task) return this.errorResult(`Unknown or expired Kilo task_id: ${taskId}`);
        if (task.status !== 'running' && task.status !== 'starting') {
            return this.errorResult(`Kilo task ${taskId} is not active; current status is ${task.status}.`);
        }
        if (!task.terminal_handle) return this.errorResult('Kilo task has no Orca terminal handle to cancel.');

        try {
            await this.closeCompletedTerminal(task, true);
            const now = new Date(this.now()).toISOString();
            task.status = 'cancelled';
            task.completed_at = now;
            task.updated_at = now;
            task.activity_phase = 'cancelled';
            task.activity_summary = 'Kilo task was cancelled through Orca.';
            await this.persistState();
            return this.jsonResult({ task_id: task.task_id, provider: 'kilo', status: task.status, cancelled_at: now });
        } catch (error) {
            return this.errorResult(`Orca could not close the Kilo task terminal: ${errorText(error)}`);
        }
    }

    private taskTurns(task: KiloTaskRecord): KiloTaskTurn[] {
        if (task.turns?.length) return task.turns;
        const turnId = task.current_turn_id ?? 'turn-1';
        return [{
            turn_id: turnId,
            prompt_sha256: task.prompt_sha256 ?? '',
            status: task.status,
            started_at: task.created_at,
            updated_at: task.updated_at,
            ...(task.completed_at ? { completed_at: task.completed_at } : {}),
            ...(task.report ? { report: task.report } : {}),
            ...(task.error ? { error: task.error } : {}),
            ...(task.exit_code !== undefined ? { exit_code: task.exit_code } : {}),
        }];
    }

    private activityPhaseSummary(task: KiloTaskRecord): string {
        switch (task.activity_phase) {
            case 'awaiting_session': return 'Waiting for Kilo to attach a provider session.';
            case 'executing_tools': return 'Kilo is executing tools in the local session.';
            case 'generating_response': return 'Kilo is generating a response.';
            case 'completed': return 'Kilo completed the current turn.';
            case 'failed': return 'Kilo reported an error for the current turn.';
            case 'cancelled': return 'Kilo task was cancelled through Orca.';
            default: return 'Kilo session is active; detailed provider activity is not currently available.';
        }
    }

    private async refreshHeadlessTask(task: KiloTaskRecord): Promise<void> {
        const terminalResponse = resultOf(await this.invokeOrca([
            'terminal', 'read',
            '--terminal', task.terminal_handle!,
            '--cursor', '0',
            '--limit', '10000',
        ], 15_000, task.working_directory), 'terminal read');
        const parsed = parseKiloTerminalOutput(terminalOutput(terminalResponse));
        if (parsed.exit_code === undefined) {
            task.last_observed_at = new Date(this.now()).toISOString();
            await this.persistState();
            return;
        }
        if (parsed.session_id) task.session_id = parsed.session_id;
        if (parsed.report) task.report = parsed.report;
        task.exit_code = parsed.exit_code;
        task.completed_at = new Date(this.now()).toISOString();
        task.updated_at = task.completed_at;
        if (parsed.exit_code === 0 && parsed.report) {
            task.status = 'completed';
            task.activity_phase = 'completed';
            task.activity_summary = 'Kilo completed the task and returned a final response.';
            task.error = undefined;
        } else {
            task.status = 'failed';
            task.activity_phase = 'failed';
            task.activity_summary = 'Kilo exited without a successful final response.';
            task.error = parsed.error || `Kilo exited with code ${parsed.exit_code} without a final text report.`;
        }
        task.last_observed_at = task.updated_at;
        await this.persistState();
    }

    private async refreshTuiTask(task: KiloTaskRecord): Promise<void> {
        if (!task.worktree_id || !task.terminal_handle || !task.prompt_sha256) {
            throw new Error('Kilo TUI task state is missing its Orca terminal, main worktree, or prompt fingerprint');
        }

        let sessionId = task.session_id;
        let exported: ParsedKiloSessionExport | undefined;
        if (sessionId) {
            exported = await this.readKiloSessionExport(task, sessionId);
            if (exported.prompt_sha256 !== task.prompt_sha256) {
                const terminalResponse = resultOf(await this.invokeOrca([
                    'terminal', 'read', '--terminal', task.terminal_handle, '--cursor', '0', '--limit', '1000',
                ], 15_000, task.working_directory), 'terminal read while waiting for Kilo follow-up');
                const terminal = objectRecord(objectRecord(terminalResponse)?.terminal);
                if (terminal?.status === 'exited') {
                    task.status = 'failed';
                    task.completed_at = new Date(this.now()).toISOString();
                    task.updated_at = task.completed_at;
                    task.error = 'Kilo TUI exited before the follow-up prompt appeared in its session.';
                    task.activity_phase = 'failed';
                    task.activity_summary = 'Kilo exited before the follow-up turn was recorded.';
                } else {
                    task.activity_phase = 'awaiting_session';
                    task.activity_summary = 'Waiting for the follow-up prompt to appear in the resumed Kilo session.';
                    task.last_observed_at = new Date(this.now()).toISOString();
                    task.updated_at = task.last_observed_at;
                }
                await this.persistState();
                return;
            }
        } else {
            const sessions = await this.readKiloSessionList(task, ['session', 'list', '--format', 'json', '--max-count', String(KILO_SESSION_LIST_LIMIT)]);
            const baseline = new Set(task.baseline_kilo_session_ids ?? []);
            const startedAt = Date.parse(task.created_at) - 10_000;
            const candidates = sessions.filter((session) =>
                !baseline.has(session.id) &&
                session.created !== undefined && session.created >= startedAt &&
                typeof session.directory === 'string' && path.resolve(session.directory) === path.resolve(task.working_directory),
            );
            const matches: Array<{ id: string; data: ParsedKiloSessionExport }> = [];
            for (const candidate of candidates) {
                const candidateExport = await this.readKiloSessionExport(task, candidate.id);
                if (candidateExport.prompt_sha256 === task.prompt_sha256) matches.push({ id: candidate.id, data: candidateExport });
            }

            if (matches.length > 1) {
                throw new Error('More than one new Kilo TUI session matches this task; status will retry after the session list settles.');
            }
            if (matches.length === 1) {
                sessionId = matches[0].id;
                exported = matches[0].data;
                task.session_id = sessionId;
                task.updated_at = new Date(this.now()).toISOString();
                await this.persistState();
            } else {
                const terminalResponse = resultOf(await this.invokeOrca([
                    'terminal', 'read', '--terminal', task.terminal_handle, '--cursor', '0', '--limit', '1000',
                ], 15_000, task.working_directory), 'terminal read for Kilo TUI');
                const terminal = objectRecord(objectRecord(terminalResponse)?.terminal);
                if (terminal?.status === 'exited') {
                    task.status = 'failed';
                    task.completed_at = new Date(this.now()).toISOString();
                    task.updated_at = task.completed_at;
                    task.error = 'Kilo TUI exited before its session could be matched to this task.';
                    task.activity_phase = 'failed';
                    task.activity_summary = 'Kilo exited before its provider session could be associated with the task.';
                    await this.closeCompletedTerminal(task);
                }
                task.last_observed_at = new Date(this.now()).toISOString();
                await this.persistState();
                return;
            }
        }

        if (!exported) return;
        task.last_observed_at = new Date(this.now()).toISOString();
        task.assistant_message_count = exported.assistant_message_count;
        task.activity_phase = exported.activity_phase ?? (exported.completed ? 'completed' : 'processing');
        task.activity_summary = this.activityPhaseSummary(task);
        if (!exported.completed) {
            task.updated_at = task.last_observed_at;
            await this.persistState();
            return;
        }
        task.completed_at = new Date(this.now()).toISOString();
        task.updated_at = task.completed_at;
        if (exported.report && !exported.error) {
            task.status = 'completed';
            task.activity_phase = 'completed';
            task.activity_summary = 'Kilo completed this turn and returned a final response.';
            task.report = exported.report;
            task.error = undefined;
        } else {
            task.status = 'failed';
            task.activity_phase = 'failed';
            task.activity_summary = 'Kilo finished the session without a successful final response.';
            task.error = exported.error || 'Kilo TUI finished without a final text report.';
        }
        await this.persistState();
    }

    private async getGitRoot(cwd = this.cwd): Promise<string> {
        const { stdout } = await execFileAsync('git', ['rev-parse', '--show-toplevel'], {
            cwd,
            encoding: 'utf8',
            timeout: 5_000,
            windowsHide: true,
        });
        return String(stdout).trim();
    }

    private async ensureOrcaRepo(repoRoot: string): Promise<string> {
        const listResponse = resultOf(await this.invokeOrca(['repo', 'list'], 10_000, repoRoot), 'repo list');
        const existing = repoList(listResponse).find((repo) => path.resolve(repo.path) === path.resolve(repoRoot));
        if (existing) return existing.id;

        resultOf(await this.invokeOrca(['repo', 'add', '--path', repoRoot], 15_000, repoRoot), 'repo add');
        const refreshed = resultOf(await this.invokeOrca(['repo', 'list'], 10_000, repoRoot), 'repo list');
        const added = repoList(refreshed).find((repo) => path.resolve(repo.path) === path.resolve(repoRoot));
        if (!added) throw new Error(`Orca did not register the Git repository at ${repoRoot}`);
        return added.id;
    }

    private async runKiloMetadataCommand(task: KiloTaskRecord, args: string[], title: string): Promise<string> {
        if (!task.worktree_id) throw new Error('Kilo task is missing its Orca main worktree id');
        const create = resultOf(await this.invokeOrca([
            'terminal', 'create',
            '--worktree', `id:${task.worktree_id}`,
            '--title', `${title} ${shortTaskId(task.task_id)}`,
            '--command', buildKiloMetadataTerminalCommand(args, this.platform, task.working_directory),
        ], 15_000, task.working_directory), 'terminal create for Kilo metadata');
        const handle = findCreatedTerminalHandle(create);
        if (!handle) throw new Error('Orca did not return the terminal handle for the Kilo metadata command');

        try {
            const { output, exitCode } = await this.readTerminalCompletionMarker(
                task,
                handle,
                KILO_METADATA_EXIT_MARKER,
                'terminal read for Kilo metadata',
                20_000,
            );
            if (exitCode !== 0) throw new Error(`Kilo metadata command exited with code ${exitCode}`);
            return output;
        } finally {
            await this.invokeOrca(['terminal', 'close', '--terminal', handle], 10_000, task.working_directory).catch(() => undefined);
        }
    }

    private async readTerminalCompletionMarker(
        task: KiloTaskRecord,
        handle: string,
        markerName: string,
        operation: string,
        timeoutMs: number,
    ): Promise<{ output: string; exitCode: number }> {
        const deadline = Date.now() + timeoutMs;
        let cursor = '0';
        let output = '';
        while (Date.now() < deadline) {
            const response = resultOf(await this.invokeOrca([
                'terminal', 'read', '--terminal', handle, '--cursor', cursor, '--limit', '1000',
            ], 5_000, task.working_directory), operation);
            const terminal = objectRecord(objectRecord(response)?.terminal);
            if (terminal?.truncated === true) {
                throw new Error(`${operation} output was truncated by Orca; refusing to parse an incomplete Kilo session payload`);
            }

            const page = terminalOutput(response);
            const nextCursor = typeof terminal?.nextCursor === 'string' ? terminal.nextCursor : undefined;
            const latestCursor = typeof terminal?.latestCursor === 'string' ? terminal.latestCursor : undefined;
            if (page) {
                // Orca limits terminal.read responses. Page through the retained
                // output instead of parsing a partial JSON export as if it were
                // complete. Older CLI responses without cursors still return a
                // full snapshot, so replace rather than duplicate that snapshot.
                if (nextCursor === undefined || cursor === '0') output = page;
                else output += `${output ? '\n' : ''}${page}`;
            }

            if (terminal?.limited === true && nextCursor !== undefined && latestCursor !== undefined && nextCursor !== latestCursor) {
                if (nextCursor === cursor) throw new Error(`${operation} output pagination did not advance`);
                cursor = nextCursor;
                continue;
            }

            const marker = output.match(new RegExp(`${markerName}(-?\\d+)`));
            if (marker) return { output, exitCode: Number(marker[1]) };

            const exitCode = findNumber(response, ['exitCode', 'exit_code']);
            if (terminal?.status === 'exited') {
                if (exitCode !== undefined) return { output, exitCode };
                throw new Error(`${operation} terminal exited without its completion marker`);
            }

            if (nextCursor !== undefined && nextCursor !== cursor) cursor = nextCursor;

            await new Promise((resolve) => setTimeout(resolve, 250));
        }
        throw new Error(`Timed out waiting for ${operation} completion marker in the Orca terminal`);
    }

    private async readKiloSessionList(task: KiloTaskRecord, args: string[]): Promise<KiloSessionSummary[]> {
        return parseKiloSessionList(await this.runKiloMetadataCommand(task, args, 'Kilo session list'));
    }

    private async readKiloSessionExport(task: KiloTaskRecord, sessionId: string): Promise<ParsedKiloSessionExport> {
        const output = await this.runKiloMetadataCommand(task, ['export', sessionId], 'Kilo session export');
        const exported = parseKiloSessionExport(output);
        if (exported.session_id && exported.session_id !== sessionId) {
            throw new Error(`Kilo exported session ${exported.session_id} while ${sessionId} was requested`);
        }
        return exported;
    }

    private async deleteKiloSessionThroughOrca(task: KiloTaskRecord): Promise<void> {
        if (!task.worktree_id || !task.session_id) throw new Error('Kilo session cleanup is missing its Orca worktree or Kilo session id');
        let cleanupHandle = task.cleanup_terminal_handle;
        if (!cleanupHandle) {
            const create = resultOf(await this.invokeOrca([
                'terminal', 'create',
                '--worktree', `id:${task.worktree_id}`,
                '--title', `Delete Kilo session ${shortTaskId(task.task_id)}`,
                '--command', buildSessionDeleteTerminalCommand(task.session_id, this.platform),
            ], 15_000, task.working_directory), 'terminal create for Kilo session deletion');
            cleanupHandle = findCreatedTerminalHandle(create);
            if (!cleanupHandle) throw new Error('Orca did not return the terminal handle for Kilo session deletion');
            task.cleanup_terminal_handle = cleanupHandle;
            await this.persistState();
        }

        const { exitCode } = await this.readTerminalCompletionMarker(
            task,
            cleanupHandle,
            DELETE_EXIT_MARKER,
            'terminal read for Kilo session deletion',
            10_000,
        );
        if (exitCode !== 0) throw new Error(`Kilo session deletion command exited with code ${exitCode}`);
        // Keep the handle on any read/timeout failure so a later status call
        // resumes observing this same Orca command instead of starting a duplicate.
        await this.invokeOrca(['terminal', 'close', '--terminal', cleanupHandle], 10_000, task.working_directory).catch(() => undefined);
        task.cleanup_terminal_handle = undefined;
        await this.persistState();
    }

    private async closeCompletedTerminal(task: KiloTaskRecord, required = false): Promise<void> {
        if (!task.terminal_handle) return;
        try {
            resultOf(await this.invokeOrca(['terminal', 'close', '--terminal', task.terminal_handle], 10_000, task.working_directory), 'terminal close');
            task.terminal_close_error = undefined;
            task.terminal_handle = undefined;
        } catch (error) {
            task.terminal_close_error = errorText(error);
            if (required) throw error;
        }
    }

    private hasNewerSuccessfulTask(task: KiloTaskRecord): boolean {
        return this.state.tasks.some((candidate) =>
            candidate.sequence > task.sequence && candidate.status === 'completed' && this.sameRepository(candidate, task),
        );
    }

    private sameRepository(left: KiloTaskRecord, right: KiloTaskRecord): boolean {
        if (left.repo_root && right.repo_root) return path.resolve(left.repo_root) === path.resolve(right.repo_root);
        return path.resolve(left.working_directory) === path.resolve(right.working_directory);
    }

    private async withStateLock<T>(operation: () => Promise<T>): Promise<T> {
        await mkdir(this.stateDirectory, { recursive: true, mode: 0o700 });
        const release = await lockfile.lock(this.stateDirectory, {
            stale: 60_000,
            update: 20_000,
            retries: { retries: 30, minTimeout: 100, maxTimeout: 250 },
        });
        try {
            await this.loadState();
            return await operation();
        } finally {
            await release();
        }
    }

    private async loadState(): Promise<void> {
        await mkdir(this.stateDirectory, { recursive: true, mode: 0o700 });
        if (process.platform !== 'win32') await chmod(this.stateDirectory, 0o700).catch(() => undefined);
        try {
            this.state = parseState(await readFile(this.stateFile, 'utf8'));
        } catch (error) {
            if (!notFound(error)) throw new Error(`Could not read Kilo task registry: ${errorText(error)}`);
            this.state = { version: 1, next_sequence: 1, tasks: [] };
        }
        const now = new Date(this.now()).toISOString();
        for (const task of this.state.tasks) {
            // Orca owns the Kilo terminal independently of this MCP process, so a
            // persisted terminal handle remains pollable after a server restart.
            if (task.status === 'starting' && !task.terminal_handle) {
                task.status = 'interrupted';
                task.completed_at = now;
                task.updated_at = now;
                task.error = 'Desktop Commander restarted while Orca was creating the Kilo terminal; inspect the retained Orca terminal.';
            }
        }
        await this.pruneExpiredTasks(false);
        await this.persistState();
    }

    private async pruneExpiredTasks(persist = true): Promise<void> {
        const cutoff = this.now() - REPORT_RETENTION_MS;
        let changed = false;
        const retained: KiloTaskRecord[] = [];
        for (const task of this.state.tasks) {
            for (const turn of task.turns ?? []) {
                if (!turn.report || !turn.completed_at) continue;
                const turnCompletedAt = Date.parse(turn.completed_at);
                if (Number.isFinite(turnCompletedAt) && turnCompletedAt < cutoff) {
                    delete turn.report;
                    changed = true;
                }
            }
            if (task.status === 'starting' || task.status === 'running') {
                retained.push(task);
                continue;
            }
            const date = task.completed_at ?? task.created_at;
            const timestamp = Date.parse(date);
            if (!Number.isFinite(timestamp) || timestamp >= cutoff) {
                retained.push(task);
                continue;
            }
            if (task.report) {
                delete task.report;
                changed = true;
            }
            if (task.session_cleanup === 'pending') retained.push(task);
            else changed = true;
        }
        if (retained.length !== this.state.tasks.length) changed = true;
        this.state.tasks = retained;
        if (persist && changed) await this.persistState();
    }

    private async persistState(): Promise<void> {
        for (const task of this.state.tasks) {
            if (!task.turns?.length) task.turns = this.taskTurns(task);
            const currentTurnId = task.current_turn_id ?? task.turns.at(-1)?.turn_id;
            if (!currentTurnId) continue;
            task.current_turn_id = currentTurnId;
            const currentTurn = task.turns.find((turn) => turn.turn_id === currentTurnId);
            if (!currentTurn) continue;
            currentTurn.prompt_sha256 = task.prompt_sha256 ?? currentTurn.prompt_sha256;
            currentTurn.status = task.status;
            currentTurn.updated_at = task.updated_at;
            if (task.completed_at) currentTurn.completed_at = task.completed_at;
            else delete currentTurn.completed_at;
            if (task.report) currentTurn.report = task.report;
            else delete currentTurn.report;
            if (task.error) currentTurn.error = task.error;
            else delete currentTurn.error;
            if (task.exit_code !== undefined) currentTurn.exit_code = task.exit_code;
            else delete currentTurn.exit_code;
        }
        const write = this.writeQueue.catch(() => undefined).then(async () => {
            await mkdir(this.stateDirectory, { recursive: true, mode: 0o700 });
            const tempPath = `${this.stateFile}.${process.pid}.${randomUUID()}.tmp`;
            await writeFile(tempPath, JSON.stringify(this.state, null, 2), { encoding: 'utf8', mode: 0o600 });
            if (process.platform !== 'win32') await chmod(tempPath, 0o600).catch(() => undefined);
            await rename(tempPath, this.stateFile);
            if (process.platform !== 'win32') await chmod(this.stateFile, 0o600).catch(() => undefined);
        });
        this.writeQueue = write;
        await write;
    }

    private exclusive<T>(operation: () => Promise<T>): Promise<T> {
        const previous = this.operationQueue.catch(() => undefined);
        let release!: () => void;
        this.operationQueue = new Promise<void>((resolve) => { release = resolve; });
        return previous.then(operation).finally(release);
    }

    private jsonResult(value: unknown, isError = false): CallToolResult {
        return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }], ...(isError ? { isError: true } : {}) };
    }

    private errorResult(message: string): CallToolResult {
        return { content: [{ type: 'text', text: message }], isError: true };
    }
}

let defaultManager: KiloAgentManager | undefined;

function getDefaultManager(): KiloAgentManager {
    if (!defaultManager) {
        // Public start calls carry repository_path explicitly; process cwd is
        // only a fallback for direct in-process callers of KiloAgentManager.
        defaultManager = new KiloAgentManager({ cwd: process.cwd() });
    }
    return defaultManager;
}

export async function handleKiloAgent(args: unknown): Promise<CallToolResult> {
    const parsed = KiloAgentArgsSchema.safeParse(args);
    if (!parsed.success) {
        const detail = parsed.error.issues.map((issue) => `${issue.path.join('.') || 'arguments'}: ${issue.message}`).join('; ');
        return { content: [{ type: 'text', text: `Invalid kilo_agent arguments: ${detail}` }], isError: true };
    }
    const manager = getDefaultManager();
    if (parsed.data.action === 'start') return manager.start(parsed.data.prompt, parsed.data.repository_path);
    return manager.status(parsed.data.task_id);
}
