import { z } from 'zod';
import path from 'node:path';

const absolutePath = z.string().trim().min(1).refine((value) => path.isAbsolute(value), {
  message: 'must be an absolute workspace path',
});

export const ZcodeControlToolSchemas = {
  zcode_runtime_status: z.object({}).strict(),
  zcode_workspace_list: z.object({}).strict(),
  zcode_task_start: z.object({
    workspace_path: absolutePath,
    workspace_identity: z.string().trim().min(1).optional(),
    remote_session_id: z.string().trim().min(1).optional(),
    objective: z.string().trim().min(1).max(100_000),
    mode: z.enum(['plan', 'build', 'edit', 'yolo']).optional(),
    model: z.string().trim().min(1).optional(),
    delivery: z.enum(['start_now', 'queue']).default('start_now'),
    workspace_strategy: z.enum(['selected', 'isolated_worktree']).optional(),
    tool_policy: z.enum(['default', 'read_only']).optional(),
    execution_limits: z.object({
      max_turns: z.number().int().positive().max(100).optional(),
      timeout_seconds: z.number().int().positive().max(86_400).optional(),
    }).strict().optional(),
    idempotency_key: z.string().trim().min(8).max(256),
  }).strict(),
  zcode_task_list: z.object({
    workspace_path: absolutePath.optional(),
    workspace_identity: z.string().trim().min(1).optional(),
    remote_session_id: z.string().trim().min(1).optional(),
    status: z.enum([
      'QUEUED', 'STARTING', 'RUNNING', 'WAITING_TOOL', 'WAITING_USER',
      'WAITING_APPROVAL', 'QUIESCING', 'COMPLETED', 'FAILED', 'CANCELLED', 'INTERRUPTED',
    ]).optional(),
    limit: z.number().int().positive().max(100).default(20),
  }).strict(),
  zcode_task_status: z.object({
    session_id: z.string().trim().min(1),
    workspace_path: absolutePath.optional(),
    workspace_identity: z.string().trim().min(1).optional(),
    remote_session_id: z.string().trim().min(1).optional(),
  }).strict(),
  zcode_task_send: z.object({
    session_id: z.string().trim().min(1),
    workspace_path: absolutePath.optional(),
    workspace_identity: z.string().trim().min(1).optional(),
    remote_session_id: z.string().trim().min(1).optional(),
    message: z.string().trim().min(1).max(100_000),
    delivery: z.enum(['queue', 'start_now']).default('queue'),
    idempotency_key: z.string().trim().min(8).max(256),
  }).strict(),
  zcode_task_events: z.object({
    session_id: z.string().trim().min(1),
    workspace_path: absolutePath.optional(),
    workspace_identity: z.string().trim().min(1).optional(),
    remote_session_id: z.string().trim().min(1).optional(),
    cursor: z.object({ log_epoch: z.string().min(1), seq: z.number().int().nonnegative() }).strict().optional(),
    limit: z.number().int().positive().max(100).default(50),
  }).strict(),
  zcode_task_report: z.object({
    session_id: z.string().trim().min(1),
    workspace_path: absolutePath.optional(),
    workspace_identity: z.string().trim().min(1).optional(),
    remote_session_id: z.string().trim().min(1).optional(),
  }).strict(),
  zcode_task_stop: z.object({
    session_id: z.string().trim().min(1),
    workspace_path: absolutePath.optional(),
    workspace_identity: z.string().trim().min(1).optional(),
    remote_session_id: z.string().trim().min(1).optional(),
    expected_run_id: z.string().trim().min(1).optional(),
    idempotency_key: z.string().trim().min(8).max(256),
  }).strict(),
  zcode_interaction_list: z.object({
    session_id: z.string().trim().min(1),
    workspace_path: absolutePath.optional(),
    workspace_identity: z.string().trim().min(1).optional(),
    remote_session_id: z.string().trim().min(1).optional(),
  }).strict(),
  zcode_interaction_respond: z.object({
    session_id: z.string().trim().min(1),
    workspace_path: absolutePath.optional(),
    workspace_identity: z.string().trim().min(1).optional(),
    remote_session_id: z.string().trim().min(1).optional(),
    interaction_id: z.string().trim().min(1),
    answer: z.object({
      option_id: z.string().optional(),
      free_text: z.string().optional(),
      action: z.enum(['accept', 'decline', 'cancel']).optional(),
      content: z.record(z.unknown()).optional(),
    }).strict(),
    idempotency_key: z.string().trim().min(8).max(256),
  }).strict(),
} as const;

export type ZcodeControlToolName = keyof typeof ZcodeControlToolSchemas;

export const ZCODE_CONTROL_PROTOCOL_NAME = 'ornix-zcode-control';
export const ZCODE_CONTROL_PROTOCOL_VERSION = 1;

export function zcodeControlMethod(name: ZcodeControlToolName): string {
  return `${ZCODE_CONTROL_PROTOCOL_NAME}/v${ZCODE_CONTROL_PROTOCOL_VERSION}/${name}`;
}
