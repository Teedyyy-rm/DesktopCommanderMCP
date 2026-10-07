import { z } from "zod";
import path from 'path';
import { ZcodeControlToolSchemas } from './ornixai-control-schemas.js';

// Config tools schemas
export const GetConfigArgsSchema = z.object({
  // 'ui' marks calls the config-editor widget fires programmatically; they are
  // excluded from tool-call telemetry (see isUiOriginCall in server.ts).
  origin: z.enum(['ui', 'llm']).optional(),
});

export const SetConfigValueArgsSchema = z.object({
  key: z.string(),
  value: z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.array(z.string()),
    z.null(),
  ]),
  // 'ui' marks widget-fired calls; excluded from tool-call telemetry.
  origin: z.enum(['ui', 'llm']).optional(),
});

// Empty schemas
export const ListProcessesArgsSchema = z.object({});

// Terminal tools schemas
export const StartProcessArgsSchema = z.object({
  command: z.string(),
  timeout_ms: z.number(),
  shell: z.string().optional(),
  verbose_timing: z.boolean().optional(),
  // 'ui' marks widget-fired calls (e.g. open-in-folder/editor buttons);
  // excluded from tool-call telemetry (see isUiOriginCall in server.ts).
  origin: z.enum(['ui', 'llm']).optional(),
});

export const ReadProcessOutputArgsSchema = z.object({
  pid: z.number(),
  timeout_ms: z.number().optional(),
  offset: z.number().optional(),   // Line offset: 0=from last read, positive=absolute, negative=tail
  length: z.number().optional(),   // Max lines to return (default from config.fileReadLineLimit)
  verbose_timing: z.boolean().optional(),
});

export const ForceTerminateArgsSchema = z.object({
  pid: z.number(),
});

export const ListSessionsArgsSchema = z.object({});

export const KillProcessArgsSchema = z.object({
  pid: z.number(),
});

// Filesystem tools schemas
export const ReadFileArgsSchema = z.object({
  path: z.string(),
  isUrl: z.boolean().optional().default(false),
  offset: z.number().optional().default(0),
  length: z.number().optional().default(1000),
  sheet: z.string().optional(),  // String only for MCP client compatibility (Cursor doesn't support union types in JSON Schema)
  range: z.string().optional(),
  options: z.record(z.any()).optional(),
  // Whether the call came from the file-preview UI (refresh/navigation) or the
  // LLM. 'ui' calls are excluded from tool-call telemetry; see isUiOriginCall
  // in server.ts.
  origin: z.enum(['ui', 'llm']).optional(),
});

export const ReadMultipleFilesArgsSchema = z.object({
  paths: z.array(z.string()),
});

export const WriteFileArgsSchema = z.object({
  path: z.string(),
  content: z.string(),
  mode: z.enum(['rewrite', 'append']).default('rewrite'),
  // 'ui' when fired by the file-preview UI, else 'llm'. 'ui' calls are
  // excluded from tool-call telemetry; see isUiOriginCall in server.ts.
  origin: z.enum(['ui', 'llm']).optional(),
});

// PDF modification schemas - exported for reuse
export const PdfInsertOperationSchema = z.object({
  type: z.literal('insert'),
  pageIndex: z.number(),
  markdown: z.string().optional(),
  sourcePdfPath: z.string().optional(),
  pdfOptions: z.object({}).passthrough().optional(),
});

export const PdfDeleteOperationSchema = z.object({
  type: z.literal('delete'),
  pageIndexes: z.array(z.number()),
});

export const PdfOperationSchema = z.union([PdfInsertOperationSchema, PdfDeleteOperationSchema]);

export const WritePdfArgsSchema = z.object({
  path: z.string(),
  // Preprocess content to handle JSON strings that should be parsed as arrays
  content: z.preprocess(
    (val) => {
      // If it's a string that looks like JSON array, parse it
      if (typeof val === 'string' && val.trim().startsWith('[')) {
        try {
          return JSON.parse(val);
        } catch {
          // If parsing fails, return as-is (might be markdown content)
          return val;
        }
      }
      // Otherwise return as-is
      return val;
    },
    z.union([z.string(), z.array(PdfOperationSchema)])
  ),
  outputPath: z.string().optional(),
  options: z.object({}).passthrough().optional(), // Allow passing options to md-to-pdf
});

export const CreateDirectoryArgsSchema = z.object({
  path: z.string(),
});

export const ListDirectoryArgsSchema = z.object({
  path: z.string(),
  depth: z.number().optional().default(2),
  // 'ui' when fired by the file-preview UI, else 'llm'. 'ui' calls are
  // excluded from tool-call telemetry; see isUiOriginCall in server.ts.
  origin: z.enum(['ui', 'llm']).optional(),
});

export const MoveFileArgsSchema = z.object({
  source: z.string(),
  destination: z.string(),
});

export const GetFileInfoArgsSchema = z.object({
  path: z.string(),
});

// Edit tools schema - SIMPLIFIED from three modes to two
// Previously supported: text replacement, location-based edits (edits array), and range rewrites
// Now supports only: text replacement and range rewrites
// Removed 'edits' array parameter - location-based surgical edits were complex and unnecessary
// Range rewrites are more powerful and cover all structured file editing needs
export const EditBlockArgsSchema = z.object({
  file_path: z.string(),
  // Text file string replacement
  old_string: z.string().optional(),
  new_string: z.string().optional(),
  expected_replacements: z.number().optional().default(1),
  // Structured file range rewrite (Excel, etc.)
  range: z.string().optional(),
  content: z.any().optional(),
  options: z.record(z.any()).optional(),
  // 'ui' when fired by the file-preview UI, else 'llm'. 'ui' calls are
  // excluded from tool-call telemetry; see isUiOriginCall in server.ts.
  origin: z.enum(['ui', 'llm']).optional(),
}).refine(
  data => {
    // Helper to check if value is actually provided (not undefined, not empty string)
    const hasValue = (v: unknown) => v !== undefined && v !== '';
    return (hasValue(data.old_string) && data.new_string !== undefined) ||
           (hasValue(data.range) && hasValue(data.content));
  },
  { message: "Must provide either (old_string + new_string) or (range + content)" }
);

// Send input to process schema
export const InteractWithProcessArgsSchema = z.object({
  pid: z.number(),
  input: z.string(),
  timeout_ms: z.number().optional(),
  wait_for_prompt: z.boolean().optional(),
  verbose_timing: z.boolean().optional(),
});

// Usage stats schema
export const GetUsageStatsArgsSchema = z.object({});

// Feedback tool schema - no pre-filled parameters, all user input
export const GiveFeedbackArgsSchema = z.object({
  // No parameters needed - form will be filled manually by user
  // Only auto-filled hidden fields remain:
  // - tool_call_count (auto)
  // - days_using (auto) 
  // - platform (auto)
  // - client_id (auto)
});

// Search schemas (renamed for natural language)
export const StartSearchArgsSchema = z.object({
  path: z.string(),
  pattern: z.string(),
  searchType: z.enum(['files', 'content']).default('files'),
  filePattern: z.string().optional(),
  ignoreCase: z.boolean().optional().default(true),
  maxResults: z.number().optional(),
  includeHidden: z.boolean().optional().default(false),
  contextLines: z.number().optional().default(5),
  timeout_ms: z.number().optional(), // Match process naming convention
  earlyTermination: z.boolean().optional(), // Stop search early when exact filename match is found (default: true for files, false for content)
  literalSearch: z.boolean().optional().default(false), // Force literal string matching (-F flag) instead of regex
  // 'ui' marks widget-fired calls (e.g. markdown link-target search);
  // excluded from tool-call telemetry (see isUiOriginCall in server.ts).
  origin: z.enum(['ui', 'llm']).optional(),
});

export const GetMoreSearchResultsArgsSchema = z.object({
  sessionId: z.string(),
  offset: z.number().optional().default(0),    // Same as file reading
  length: z.number().optional().default(100),  // Same as file reading (but smaller default)
});

export const StopSearchArgsSchema = z.object({
  sessionId: z.string(),
});

export const ListSearchesArgsSchema = z.object({});

// Prompts tool schema - SIMPLIFIED (only get_prompt action)
export const GetPromptsArgsSchema = z.object({
  action: z.enum(['get_prompt']),
  promptId: z.string(),
  // Disabled to check if it makes sense or should be removed or changed
  // anonymous_user_use_case: z.string().optional(),
});

// Start and monitor a Kilo TUI session in Orca's existing main worktree.
export const KiloAgentArgsSchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('start'),
    prompt: z.string().trim().min(1).max(100_000),
    repository_path: z.string().trim().min(1).max(4_096).refine((value) => path.isAbsolute(value), 'must be an absolute Remote Device path'),
  }),
  z.object({
    action: z.literal('status'),
    task_id: z.string().uuid(),
  }),
]);

// MCP requires the root input schema to be an object; keep the discriminated
// Zod union for runtime validation and publish an equivalent object schema.
export const KiloAgentInputSchema = {
  type: 'object',
  properties: {
    action: { type: 'string', enum: ['start', 'status'] },
    prompt: { type: 'string', minLength: 1, maxLength: 100_000 },
    repository_path: { type: 'string', minLength: 1, maxLength: 4_096, description: 'Absolute path to the intended Git repository on the Remote Device.' },
    task_id: { type: 'string', format: 'uuid' },
  },
  required: ['action'],
  oneOf: [
    { properties: { action: { const: 'start' } }, required: ['prompt', 'repository_path'] },
    { properties: { action: { const: 'status' } }, required: ['task_id'] },
  ],
  additionalProperties: false,
} as const;

const AgentProviderIdSchema = z.string().trim().min(1).max(40).regex(/^[a-z][a-z0-9-]*$/, 'must be a lowercase provider id');
const AgentTaskIdSchema = z.string().uuid();
export const LOCAL_AGENT_STATUSES = ['starting', 'running', 'completed', 'failed', 'interrupted', 'cancelled'] as const;
export type LocalAgentTaskStatus = typeof LOCAL_AGENT_STATUSES[number];

export const LocalAgentProvidersArgsSchema = z.object({}).strict();
export const LocalAgentStartArgsSchema = z.object({
  provider: AgentProviderIdSchema,
  prompt: z.string().trim().min(1).max(100_000),
  repository_path: z.string().trim().min(1).max(4_096).refine((value) => path.isAbsolute(value), 'must be an absolute Remote Device path'),
  idempotency_key: z.string().trim().min(8).max(256).optional(),
}).strict().superRefine((args, context) => {
  if (args.provider === 'zcode' && !args.idempotency_key) {
    context.addIssue({ code: 'custom', path: ['idempotency_key'], message: 'is required for Zcode task start' });
  }
});
export const LocalAgentListArgsSchema = z.object({
  provider: AgentProviderIdSchema.optional(),
  repository_path: z.string().trim().min(1).max(4_096).refine((value) => path.isAbsolute(value), 'must be an absolute Remote Device path').optional(),
  status: z.enum(LOCAL_AGENT_STATUSES).optional(),
  limit: z.number().int().min(1).max(50).optional().default(20),
}).strict();
export const LocalAgentTaskArgsSchema = z.object({ task_id: AgentTaskIdSchema }).strict();
export const LocalAgentCancelArgsSchema = z.object({
  task_id: AgentTaskIdSchema,
  idempotency_key: z.string().trim().min(8).max(256).optional(),
}).strict();
export const LocalAgentReadReportArgsSchema = z.object({
  task_id: AgentTaskIdSchema,
  turn_id: z.string().trim().min(1).max(40).regex(/^turn-[1-9][0-9]*$/).optional(),
}).strict();
export const LocalAgentSendArgsSchema = z.object({
  task_id: AgentTaskIdSchema,
  message: z.string().trim().min(1).max(100_000),
  idempotency_key: z.string().trim().min(8).max(256).optional(),
}).strict();

// Tool history schema
export const GetRecentToolCallsArgsSchema = z.object({
  maxResults: z.number().min(1).max(1000).optional().default(50),
  toolName: z.string().optional(),
  since: z.string().datetime().optional(),
});

export const TrackUiEventArgsSchema = z.object({
  event: z.string().min(1).max(80),
  component: z.string().optional().default('file_preview'),
  params: z.record(z.union([z.string(), z.number(), z.boolean(), z.null()])).optional().default({}),
});

/**
 * Map of tool name -> argument schema, used by the dispatcher to detect and warn
 * about parameters a caller sent that the tool does not support. Keep in sync
 * with the tool definitions in server.ts.
 */
export const toolArgSchemas: Record<string, z.ZodTypeAny> = {
  get_config: GetConfigArgsSchema,
  set_config_value: SetConfigValueArgsSchema,
  read_file: ReadFileArgsSchema,
  read_multiple_files: ReadMultipleFilesArgsSchema,
  write_file: WriteFileArgsSchema,
  write_pdf: WritePdfArgsSchema,
  create_directory: CreateDirectoryArgsSchema,
  list_directory: ListDirectoryArgsSchema,
  move_file: MoveFileArgsSchema,
  start_search: StartSearchArgsSchema,
  get_more_search_results: GetMoreSearchResultsArgsSchema,
  stop_search: StopSearchArgsSchema,
  list_searches: ListSearchesArgsSchema,
  get_file_info: GetFileInfoArgsSchema,
  edit_block: EditBlockArgsSchema,
  start_process: StartProcessArgsSchema,
  read_process_output: ReadProcessOutputArgsSchema,
  interact_with_process: InteractWithProcessArgsSchema,
  force_terminate: ForceTerminateArgsSchema,
  list_sessions: ListSessionsArgsSchema,
  list_processes: ListProcessesArgsSchema,
  kill_process: KillProcessArgsSchema,
  get_usage_stats: GetUsageStatsArgsSchema,
  get_recent_tool_calls: GetRecentToolCallsArgsSchema,
  give_feedback_to_desktop_commander: GiveFeedbackArgsSchema,
  get_prompts: GetPromptsArgsSchema,
  track_ui_event: TrackUiEventArgsSchema,
  kilo_agent: KiloAgentArgsSchema,
  local_agent_providers: LocalAgentProvidersArgsSchema,
  local_agent_start: LocalAgentStartArgsSchema,
  local_agent_list: LocalAgentListArgsSchema,
  local_agent_status: LocalAgentTaskArgsSchema,
  local_agent_read_report: LocalAgentReadReportArgsSchema,
  local_agent_send: LocalAgentSendArgsSchema,
  local_agent_cancel: LocalAgentCancelArgsSchema,
  ...ZcodeControlToolSchemas,
};
