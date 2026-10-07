import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { LocalAgentTaskStatus } from './schemas.js';
import { handleZcodeControlTool } from './ornixai-control-client.js';

function valueOf(result: CallToolResult): Record<string, unknown> | undefined {
  if (result.structuredContent && typeof result.structuredContent === 'object') {
    return result.structuredContent as Record<string, unknown>;
  }
  const text = result.content.find((item) => item.type === 'text')?.text;
  if (!text) return undefined;
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function jsonResult(value: unknown): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }], structuredContent: value as Record<string, unknown> };
}

function localStatus(status: unknown): LocalAgentTaskStatus {
  switch (status) {
    case 'QUEUED':
    case 'STARTING': return 'starting';
    case 'RUNNING':
    case 'WAITING_TOOL':
    case 'WAITING_USER':
    case 'WAITING_APPROVAL':
    case 'QUIESCING': return 'running';
    case 'COMPLETED': return 'completed';
    case 'FAILED': return 'failed';
    case 'CANCELLED': return 'cancelled';
    default: return 'interrupted';
  }
}

function nativeTaskId(value: Record<string, unknown> | undefined): string | undefined {
  const task = value?.task && typeof value.task === 'object' ? value.task as Record<string, unknown> : value;
  const candidate = task?.session_id ?? task?.sessionId ?? task?.task_id ?? task?.taskId;
  return typeof candidate === 'string' ? candidate : undefined;
}

export class ZcodeLocalAgentAdapter {
  readonly id = 'zcode';
  readonly name = 'Zcode';
  readonly transport = 'ornix-zcode-control v1 over local OS IPC';
  readonly capabilities = {
    start: true,
    list: true,
    status: true,
    read_report: true,
    send: true,
    send_semantics: 'in_turn' as const,
    cancel: true,
  };

  async start(objective: string, repositoryPath: string, requestId?: string, idempotencyKey?: string): Promise<CallToolResult> {
    if (!idempotencyKey) return { content: [{ type: 'text', text: 'idempotency_key is required for Zcode task start.' }], isError: true };
    const result = await handleZcodeControlTool('zcode_task_start', {
      workspace_path: repositoryPath,
      objective,
      delivery: 'start_now',
      idempotency_key: `local-agent:start:${idempotencyKey}`,
    }, requestId);
    if (result.isError) return result;
    const value = valueOf(result);
    const taskId = nativeTaskId(value);
    if (!taskId) return { ...result, isError: true };
    return jsonResult({ ...value, provider: 'zcode', task_id: taskId, session_id: taskId });
  }

  async list(filters: { repositoryPath?: string; status?: LocalAgentTaskStatus; limit: number }): Promise<CallToolResult> {
    const result = await handleZcodeControlTool('zcode_task_list', {
      ...(filters.repositoryPath ? { workspace_path: filters.repositoryPath } : {}),
      limit: Math.min(filters.limit, 100),
    });
    if (result.isError) return result;
    const value = valueOf(result) ?? {};
    const tasks = Array.isArray(value.tasks) ? value.tasks : [];
    const normalized = tasks.map((candidate) => {
      const task = candidate && typeof candidate === 'object' ? candidate as Record<string, unknown> : {};
      const taskId = nativeTaskId(task);
      return {
        ...task,
        ...(taskId ? { task_id: taskId, session_id: taskId } : {}),
        provider: 'zcode',
        status: localStatus(task.status),
      };
    }).filter((task) => !filters.status || task.status === filters.status).slice(0, filters.limit);
    return jsonResult({ ...value, tasks: normalized, returned: normalized.length, limit: filters.limit });
  }

  async status(taskId: string): Promise<CallToolResult> {
    return handleZcodeControlTool('zcode_task_status', { session_id: taskId });
  }

  async readReport(taskId: string): Promise<CallToolResult> {
    return handleZcodeControlTool('zcode_task_report', { session_id: taskId });
  }

  async send(taskId: string, message: string, requestId?: string, idempotencyKey?: string): Promise<CallToolResult> {
    if (!idempotencyKey) return { content: [{ type: 'text', text: 'idempotency_key is required for Zcode follow-up.' }], isError: true };
    return handleZcodeControlTool('zcode_task_send', {
      session_id: taskId,
      message,
      delivery: 'queue',
      idempotency_key: `local-agent:send:${idempotencyKey}`,
    }, requestId);
  }

  async cancel(taskId: string, requestId?: string, idempotencyKey?: string): Promise<CallToolResult> {
    if (!idempotencyKey) return { content: [{ type: 'text', text: 'idempotency_key is required for Zcode cancellation.' }], isError: true };
    const statusResult = await this.status(taskId);
    if (statusResult.isError) return statusResult;
    const status = valueOf(statusResult) ?? {};
    const runId = typeof status.run_id === 'string' ? status.run_id : undefined;
    return handleZcodeControlTool('zcode_task_stop', {
      session_id: taskId,
      ...(runId ? { expected_run_id: runId } : {}),
      idempotency_key: `local-agent:stop:${idempotencyKey}`,
    }, requestId);
  }

  async ownsTask(taskId: string): Promise<boolean> {
    const result = await handleZcodeControlTool('zcode_task_status', { session_id: taskId });
    return !result.isError;
  }
}
