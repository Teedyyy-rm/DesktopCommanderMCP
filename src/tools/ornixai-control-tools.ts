import { zodToJsonSchema } from 'zod-to-json-schema';
import { ZcodeControlToolSchemas } from './ornixai-control-schemas.js';

const descriptions: Record<keyof typeof ZcodeControlToolSchemas, string> = {
  zcode_runtime_status: 'Check whether the authenticated local Zcode Desktop Host control endpoint is online and protocol-compatible.',
  zcode_workspace_list: 'List workspaces exposed by the live Zcode Host and allowed by DesktopCommander workspace scope.',
  zcode_task_start: 'Create a canonical Zcode session and submit its first objective through the native session command path. This tool never launches a shadow agent runtime.',
  zcode_task_list: 'List native Zcode sessions and their normalized lifecycle states. Results are rediscovered from Zcode after reconnect.',
  zcode_task_status: 'Read native Zcode session status and current foreground execution identity.',
  zcode_task_send: 'Continue the same Zcode session using native queue or start-now admission semantics.',
  zcode_task_events: 'Read ordered Zcode conversation events after a resumable log-epoch and sequence cursor.',
  zcode_task_report: 'Read a structured report assembled from canonical Zcode session, event, workspace, and evidence facts.',
  zcode_task_stop: 'Stop the expected native Zcode foreground execution using its current execution identity.',
  zcode_interaction_list: 'List pending native Zcode user-input, permission, plan, or workspace-hook interactions.',
  zcode_interaction_respond: 'Resolve one supported pending Zcode interaction through its native response contract; this does not auto-approve other actions.',
};

const readOnly = new Set<keyof typeof ZcodeControlToolSchemas>([
  'zcode_runtime_status',
  'zcode_workspace_list',
  'zcode_task_list',
  'zcode_task_status',
  'zcode_task_events',
  'zcode_task_report',
  'zcode_interaction_list',
]);

export const zcodeControlToolDefinitions = Object.entries(ZcodeControlToolSchemas).map(([name, schema]) => ({
  name,
  description: descriptions[name as keyof typeof ZcodeControlToolSchemas],
  inputSchema: zodToJsonSchema(schema),
  annotations: {
    title: name.replace(/_/g, ' '),
    readOnlyHint: readOnly.has(name as keyof typeof ZcodeControlToolSchemas),
    destructiveHint: !readOnly.has(name as keyof typeof ZcodeControlToolSchemas),
    openWorldHint: !readOnly.has(name as keyof typeof ZcodeControlToolSchemas),
  },
}));
