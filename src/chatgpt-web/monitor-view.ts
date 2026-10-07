import type { ChatGptWebEventRecord } from './event-log.js';

const ANSI = {
  reset: '\x1b[0m',
  clear: '\x1b[2J\x1b[H',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  inverse: '\x1b[7m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
  gray: '\x1b[90m',
} as const;

export const ELLIPSIS = '…';
const ELLIPSIS_WIDTH = 2;

const MARKER_WIDTH = 1;
const STATUS_WIDTH = 3;
const DURATION_WIDTH = 6;
const TIME_WIDTH = 8;
const TOOL_MIN_WIDTH = 8;
const TOOL_MAX_WIDTH = 24;
const MAX_DETAIL_LINES = 12;

const FILE_TOOLS = new Set([
  'read_file', 'read_multiple_files', 'write_file', 'write_pdf', 'edit_block',
  'get_file_info', 'move_file', 'create_directory', 'list_directory',
]);
const PROCESS_TOOLS = new Set([
  'start_process', 'read_process_output', 'interact_with_process',
  'kill_process', 'force_terminate', 'list_processes', 'list_sessions',
]);
const SEARCH_TOOLS = new Set([
  'start_search', 'get_more_search_results', 'stop_search', 'list_searches',
]);

export interface MonitorRow {
  record: ChatGptWebEventRecord;
  expandLevel: number;
}

export interface MonitorHeader {
  alive: boolean;
  sessions: number;
  maxSessions: number;
  total: number;
  ok: number;
  errors: number;
  callsPerMinute: number;
  secondsSinceLast: number | null;
}

export type MonitorInputMode = 'none' | 'filter' | 'search';

export interface MonitorViewState {
  rows: MonitorRow[];
  selected: number;
  width: number;
  height: number;
  header: MonitorHeader;
  filter: string;
  search: string;
  inputMode: MonitorInputMode;
  input: string;
  paused: boolean;
  following: boolean;
  logPath: string;
  logExists: boolean;
  now: number;
}

interface Segment {
  text: string;
  color?: string;
}

const WIDE_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x1100, 0x115f], [0x231a, 0x231b], [0x2329, 0x232a], [0x23e9, 0x23ec],
  [0x23f0, 0x23f0], [0x23f3, 0x23f3], [0x23f8, 0x23fa], [0x25aa, 0x25ab],
  [0x25b6, 0x25b6], [0x25c0, 0x25c0], [0x25fb, 0x25fe], [0x2600, 0x2604],
  [0x2614, 0x2615], [0x2648, 0x2653], [0x267f, 0x267f], [0x2693, 0x2693],
  [0x26a1, 0x26a1], [0x26aa, 0x26ab], [0x26bd, 0x26be], [0x26c4, 0x26c5],
  [0x26ce, 0x26ce], [0x26d4, 0x26d4], [0x26ea, 0x26ea], [0x26f2, 0x26f3],
  [0x26f5, 0x26f5], [0x26fa, 0x26fa], [0x26fd, 0x26fd], [0x2702, 0x2702],
  [0x2705, 0x2705], [0x2708, 0x270d], [0x270f, 0x270f], [0x2712, 0x2712],
  [0x2714, 0x2714], [0x2716, 0x2716], [0x271d, 0x271d], [0x2721, 0x2721],
  [0x2728, 0x2728], [0x2733, 0x2734], [0x2744, 0x2744], [0x2747, 0x2747],
  [0x274c, 0x274c], [0x274e, 0x274e], [0x2753, 0x2755], [0x2757, 0x2757],
  [0x2795, 0x2797], [0x27b0, 0x27b0], [0x27bf, 0x27bf], [0x2b1b, 0x2b1c],
  [0x2b50, 0x2b50], [0x2b55, 0x2b55], [0x2e80, 0x303e], [0x3041, 0x33ff],
  [0x3400, 0x4dbf], [0x4e00, 0x9fff], [0xa000, 0xa4cf], [0xa960, 0xa97f],
  [0xac00, 0xd7a3], [0xf900, 0xfaff], [0xfe10, 0xfe19], [0xfe30, 0xfe6f],
  [0xff00, 0xff60], [0xffe0, 0xffe6], [0x1f000, 0x1faff], [0x20000, 0x3fffd],
];

function isWideCodePoint(codePoint: number): boolean {
  for (const [start, end] of WIDE_RANGES) {
    if (codePoint < start) return false;
    if (codePoint <= end) return true;
  }
  return false;
}

function codePointDisplayWidth(codePoint: number): number {
  if (codePoint === 0x200d) return 0;
  if (codePoint === 0xfe0e || codePoint === 0xfe0f) return 0;
  if ((codePoint >= 0x0300 && codePoint <= 0x036f) || (codePoint >= 0x1ab0 && codePoint <= 0x1aff)) return 0;
  if (codePoint === 0x2026) return ELLIPSIS_WIDTH;
  if (codePoint < 0x20 || (codePoint >= 0x7f && codePoint <= 0x9f)) return 0;
  return isWideCodePoint(codePoint) ? 2 : 1;
}

/** Terminal column count, so emoji and CJK arguments do not break alignment. */
export function stringWidth(text: string): number {
  let width = 0;
  for (const character of text) {
    width += codePointDisplayWidth(character.codePointAt(0) ?? 0);
  }
  return width;
}

function sanitizeCell(text: string): string {
  return text.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
}

function sliceToWidth(text: string, maxWidth: number): string {
  if (maxWidth <= 0) return '';
  let width = 0;
  let result = '';
  for (const character of text) {
    const next = width + codePointDisplayWidth(character.codePointAt(0) ?? 0);
    if (next > maxWidth) break;
    width = next;
    result += character;
  }
  return result;
}

export function truncateToWidth(text: string, width: number): string {
  if (width <= 0) return '';
  if (stringWidth(text) <= width) return text;
  if (width <= ELLIPSIS_WIDTH) return sliceToWidth(text, width);
  return `${sliceToWidth(text, width - ELLIPSIS_WIDTH)}${ELLIPSIS}`;
}

function pad(text: string, width: number, align: 'left' | 'right' = 'left'): string {
  const clipped = truncateToWidth(sanitizeCell(text), width);
  const filler = ' '.repeat(Math.max(0, width - stringWidth(clipped)));
  return align === 'right' ? filler + clipped : clipped + filler;
}

function segmentsToPlain(segments: Segment[]): string {
  return segments.map((segment) => segment.text).join('');
}

function segmentsToAnsi(segments: Segment[], highlight: boolean): string {
  const body = segments
    .map((segment) => (segment.color ? `${segment.color}${segment.text}${ANSI.reset}` : segment.text))
    .join('');
  return highlight ? `${ANSI.inverse}${body}${ANSI.reset}` : body;
}

export function columnLayout(width: number, toolWidth: number): { toolWidth: number; whatWidth: number } {
  const tool = Math.min(Math.max(toolWidth, TOOL_MIN_WIDTH), TOOL_MAX_WIDTH);
  const fixed = MARKER_WIDTH + 1 + STATUS_WIDTH + 1 + DURATION_WIDTH + 2 + TIME_WIDTH + 2 + tool + 2;
  return { toolWidth: tool, whatWidth: Math.max(0, width - fixed) };
}

export function statusLabel(record: ChatGptWebEventRecord): string {
  if (record.phase !== 'completed') return 'RUN';
  return record.status === 'ok' ? 'ok' : 'err';
}

export function statusColor(label: string): string {
  if (label === 'ok') return ANSI.green;
  if (label === 'RUN') return ANSI.yellow;
  return ANSI.red;
}

export function formatDuration(durationMs: number | undefined): string {
  if (typeof durationMs !== 'number' || !Number.isFinite(durationMs) || durationMs < 0) return '-';
  if (durationMs < 1000) return `${Math.round(durationMs)}ms`;
  if (durationMs < 60_000) return `${(durationMs / 1000).toFixed(1)}s`;
  const minutes = Math.floor(durationMs / 60_000);
  const seconds = Math.floor((durationMs % 60_000) / 1000);
  return `${minutes}m${String(seconds).padStart(2, '0')}s`;
}

export function formatClock(timestamp: number): string {
  if (!Number.isFinite(timestamp) || timestamp <= 0) return '--:--:--';
  const date = new Date(timestamp);
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function scalarToText(value: unknown): string | undefined {
  if (typeof value === 'string') return value.trim() || undefined;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) {
    const text = value.filter((entry) => typeof entry === 'string' || typeof entry === 'number').join(' ');
    return text.trim() || undefined;
  }
  return undefined;
}

/** One-line summary of a call for the WHAT column, grouped by tool family. */
export function formatWhat(tool: string, args: Record<string, unknown> | undefined): string {
  const source = args ?? {};
  const keys = FILE_TOOLS.has(tool)
    ? ['path', 'source', 'destination', 'paths', 'files']
    : PROCESS_TOOLS.has(tool)
      ? ['command', 'sessionId', 'pid']
      : SEARCH_TOOLS.has(tool)
        ? ['pattern', 'searchId']
        : [];

  for (const key of keys) {
    const text = scalarToText(source[key]);
    if (text) return text;
  }

  const entries = Object.entries(source).filter(([, value]) => value !== undefined && value !== null);
  if (entries.length === 0) return '';
  try {
    return JSON.stringify(Object.fromEntries(entries.slice(0, 4))) ?? '';
  } catch {
    return '';
  }
}

function resultToLines(result: unknown): string[] {
  if (result !== null && typeof result === 'object' && Array.isArray((result as { content?: unknown }).content)) {
    const text = (result as { content: Array<{ text?: unknown }> }).content
      .map((entry) => (typeof entry?.text === 'string' ? entry.text : ''))
      .filter((entry) => entry.length > 0)
      .join('\n');
    if (text.length > 0) return text.split('\n');
  }
  try {
    return (JSON.stringify(result, null, 2) ?? '').split('\n');
  } catch {
    return ['[unserialisable result]'];
  }
}

function capLines(lines: string[], maxLines: number): string[] {
  if (lines.length <= maxLines) return lines;
  return [...lines.slice(0, maxLines), `${ELLIPSIS} ${lines.length - maxLines} more lines`];
}

function summaryLines(record: ChatGptWebEventRecord): string[] {
  const session = record.metadata?.session_id ?? '-';
  const client = record.metadata?.clientInfo ? `${record.metadata.clientInfo.name} ${record.metadata.clientInfo.version}` : '-';
  return [
    `call ${record.callId}  status ${record.status ?? '-'}  session ${session}  client ${client}  pid ${record.metadata?.gateway_pid ?? '-'}`,
  ];
}

/**
 * Expand level for a row, cycling 0 → 1 → 2 → 3 → 0. Level 3 needs a result or
 * an error to show, so a row without either stops at level 2.
 */
export function maxExpandLevel(row: MonitorRow): number {
  const { record } = row;
  const hasDetail = (record.result !== undefined && record.result !== null) ||
    (typeof record.error === 'string' && record.error.length > 0);
  return hasDetail ? 3 : 2;
}

export function pickExpandLevel(row: MonitorRow, current: number): number {
  const max = maxExpandLevel(row);
  const base = Number.isFinite(current) ? Math.trunc(current) : 0;
  const next = base + 1;
  return next > max ? 0 : next;
}

function whatLines(row: MonitorRow, whatWidth: number): string[] {
  const { record } = row;
  const lines = [formatWhat(record.tool, record.arguments)];
  if (row.expandLevel < 1) return lines;

  lines.push(...summaryLines(record));
  if (row.expandLevel < 2) return lines;

  try {
    lines.push(...capLines(JSON.stringify(record.arguments ?? {}, null, 2).split('\n'), MAX_DETAIL_LINES));
  } catch {
    lines.push('[unserialisable arguments]');
  }
  if (row.expandLevel < 3) return lines;

  const detail: string[] = [];
  if (typeof record.error === 'string' && record.error.length > 0) detail.push(record.error);
  if (record.result !== undefined) detail.push(...resultToLines(record.result));
  lines.push(...capLines(detail.length > 0 ? detail : ['[no result recorded]'], MAX_DETAIL_LINES));
  return lines;
}

function rowLinePrefixes(row: MonitorRow, selected: boolean, layout: { toolWidth: number }): Segment[] {
  const label = statusLabel(row.record);
  return [
    { text: selected ? '›' : ' ', color: selected ? ANSI.cyan : undefined },
    { text: ' ' },
    { text: pad(label, STATUS_WIDTH), color: statusColor(label) },
    { text: ' ' },
    { text: pad(formatDuration(row.record.durationMs), DURATION_WIDTH, 'right') },
    { text: '  ' },
    { text: pad(formatClock(row.record.ts), TIME_WIDTH), color: ANSI.gray },
    { text: '  ' },
    { text: pad(row.record.tool, layout.toolWidth, 'right'), color: selected ? ANSI.bold : undefined },
    { text: '  ' },
  ];
}

export function widestToolName(rows: MonitorRow[]): number {
  return rows.reduce((widest, row) => Math.max(widest, stringWidth(row.record.tool)), 0);
}

export function formatColumns(rows: MonitorRow[], width: number): string {
  return tableLines(rows, -1, width).map((entry) => segmentsToPlain(entry.segments)).join('\n');
}

interface TableLine {
  segments: Segment[];
  rowIndex: number;
}

function tableLines(rows: MonitorRow[], selected: number, width: number): TableLine[] {
  const layout = columnLayout(width, widestToolName(rows));
  const lines: TableLine[] = [];

  rows.forEach((row, rowIndex) => {
    const prefix = rowLinePrefixes(row, rowIndex === selected, layout);
    const what = whatLines(row, layout.whatWidth);
    what.forEach((text, index) => {
      const segments = index === 0
        ? [...prefix, { text: pad(text, layout.whatWidth) }]
        : [{ text: ' '.repeat(MARKER_WIDTH + 1 + STATUS_WIDTH + 1 + DURATION_WIDTH + 2 + TIME_WIDTH + 2 + layout.toolWidth + 2) },
           { text: pad(text, layout.whatWidth) }];
      lines.push({ segments, rowIndex });
    });
  });

  return lines;
}

function truncatePlain(text: string, width: number): string {
  return truncateToWidth(sanitizeCell(text), width);
}

function headerLines(state: MonitorViewState, width: number): Segment[][] {
  const { header } = state;
  const alive = header.alive
    ? { text: ' ALIVE ', color: ANSI.green }
    : { text: ' IDLE  ', color: ANSI.gray };
  const sinceLast = header.secondsSinceLast === null
    ? 'never'
    : `${header.secondsSinceLast < 60 ? `${Math.round(header.secondsSinceLast)}s` : `${Math.round(header.secondsSinceLast / 60)}m`} ago`;

  const counters =
    `calls ${header.total}   ok ${header.ok}   err ${header.errors}   ` +
    `${header.callsPerMinute.toFixed(1)}/min   last ${sinceLast}   sessions ${header.sessions}/${header.maxSessions}`;

  const flags: string[] = [];
  if (state.paused) flags.push('PAUSED');
  if (state.following) flags.push('FOLLOW');
  if (state.filter) flags.push(`filter:${state.filter}`);
  if (state.search) flags.push(`search:${state.search}`);

  return [
    [{ text: truncatePlain('Desktop Commander · ChatGPT Web gateway', width) }, { text: ' ' }, alive],
    [{ text: truncatePlain(counters, width), color: ANSI.dim }],
    [{ text: truncatePlain(state.logPath, Math.max(0, width - flags.join(' ').length - 2)), color: ANSI.gray },
     { text: flags.length > 0 ? ` ${flags.join(' ')}` : '', color: ANSI.yellow }],
  ];
}

function hintLines(state: MonitorViewState, width: number): Segment[][] {
  if (state.rows.length > 0) return [];
  if (state.logExists) {
    return [
      [{ text: 'Waiting for tool calls…', color: ANSI.dim }],
    ];
  }
  return [
    [{ text: 'No event log yet. Start the gateway:', color: ANSI.dim }],
    [{ text: truncatePlain('  systemctl --user start desktop-commander-chatgpt-web.service', width), color: ANSI.cyan }],
    [{ text: truncatePlain('  (or: desktop-commander chatgpt-web)', width), color: ANSI.gray }],
  ];
}

function footerLines(state: MonitorViewState, width: number): Segment[] {
  if (state.inputMode !== 'none') {
    const label = state.inputMode === 'filter' ? 'filter' : 'search';
    return [
      { text: `${label}> `, color: ANSI.cyan },
      { text: state.input },
      { text: '   (Enter apply · Esc cancel)', color: ANSI.gray },
    ];
  }
  return [{ text: truncatePlain('↑↓/jk move · Enter/Space expand · f filter · / search · p pause · q quit', width), color: ANSI.dim }];
}

/**
 * Full-screen frame. Every line is padded to the terminal height so that
 * expanding a row never shifts the rest of the table.
 */
export function render(state: MonitorViewState): string {
  const width = Math.max(20, state.width);
  const height = Math.max(4, state.height);
  const chrome = 3 + 1 + 1 + 1 + (state.inputMode !== 'none' ? 1 : 0);
  const tableHeight = Math.max(1, height - chrome);

  const rows = state.rows;
  const selected = Math.min(Math.max(state.selected, 0), Math.max(rows.length - 1, 0));
  const all = tableLines(rows, selected, width);

  let top = 0;
  if (all.length > tableHeight) {
    const firstSelected = all.findIndex((line) => line.rowIndex === selected);
    let lastSelected = firstSelected;
    for (let index = firstSelected + 1; index < all.length && all[index].rowIndex === selected; index += 1) {
      lastSelected = index;
    }
    if (firstSelected >= 0 && lastSelected >= top + tableHeight) {
      top = Math.max(0, lastSelected - tableHeight + 1);
    } else if (firstSelected >= tableHeight) {
      top = firstSelected - tableHeight + 1;
    }
  }

  const visible = all.slice(top, top + tableHeight).map((line) => segmentsToAnsi(line.segments, line.rowIndex === selected));
  while (visible.length < tableHeight) visible.push('');

  const frame = [
    ...headerLines(state, width).map((segments) => segmentsToAnsi(segments, false)),
    '',
    ...hintLines(state, width).map((segments) => segmentsToAnsi(segments, false)),
    ...visible,
    '',
    segmentsToAnsi(footerLines(state, width), false),
  ];

  while (frame.length < height) frame.push('');

  return `${ANSI.clear}${frame.slice(0, height).join('\n')}`;
}