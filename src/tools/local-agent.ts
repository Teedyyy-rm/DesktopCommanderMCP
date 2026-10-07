import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import {
    type LocalAgentTaskStatus,
    LocalAgentCancelArgsSchema,
    LocalAgentListArgsSchema,
    LocalAgentProvidersArgsSchema,
    LocalAgentReadReportArgsSchema,
    LocalAgentSendArgsSchema,
    LocalAgentStartArgsSchema,
    LocalAgentTaskArgsSchema,
} from './schemas.js';
import { KiloAgentManager } from './kilo-agent.js';
import { ZcodeLocalAgentAdapter } from './ornixai-local-agent-adapter.js';

export interface LocalAgentCapabilities {
    start: boolean;
    list: boolean;
    status: boolean;
    read_report: boolean;
    send: boolean;
    send_semantics?: 'after_turn' | 'in_turn';
    cancel: boolean;
}

/**
 * Provider adapter boundary for local agents controlled by ChatGPT through
 * Orca. New providers normalize their native lifecycle into this API while
 * keeping provider session IDs and Orca terminal handles internal to status.
 */
export interface LocalAgentProviderAdapter {
    readonly id: string;
    readonly name: string;
    readonly transport?: string;
    readonly capabilities: LocalAgentCapabilities;
    start(prompt: string, repositoryPath: string, requestId?: string, idempotencyKey?: string): Promise<CallToolResult>;
    list(filters: { repositoryPath?: string; status?: LocalAgentTaskStatus; limit: number }): Promise<CallToolResult>;
    status(taskId: string): Promise<CallToolResult>;
    readReport(taskId: string, turnId?: string): Promise<CallToolResult>;
    send(taskId: string, message: string, requestId?: string, idempotencyKey?: string): Promise<CallToolResult>;
    cancel(taskId: string, requestId?: string, idempotencyKey?: string): Promise<CallToolResult>;
    ownsTask(taskId: string): Promise<boolean>;
}

class KiloLocalAgentAdapter implements LocalAgentProviderAdapter {
    readonly id = 'kilo';
    readonly name = 'Kilo';
    readonly transport = 'Orca-owned terminal and provider-native session data';
    readonly capabilities: LocalAgentCapabilities = {
        start: true,
        list: true,
        status: true,
        read_report: true,
        send: true,
        send_semantics: 'after_turn',
        cancel: true,
    };

    private readonly manager = new KiloAgentManager({ cwd: process.cwd() });

    start(prompt: string, repositoryPath: string, _requestId?: string, _idempotencyKey?: string): Promise<CallToolResult> {
        return this.manager.start(prompt, repositoryPath);
    }

    list(filters: { repositoryPath?: string; status?: LocalAgentTaskStatus; limit: number }): Promise<CallToolResult> {
        return this.manager.listTasks({
            ...(filters.repositoryPath ? { repositoryPath: filters.repositoryPath } : {}),
            ...(filters.status ? { status: filters.status } : {}),
            limit: filters.limit,
        });
    }

    status(taskId: string): Promise<CallToolResult> {
        // This path refreshes provider state but does not clean up provider
        // sessions, so polling is safe and repeatable.
        return this.manager.inspect(taskId);
    }

    readReport(taskId: string, turnId?: string): Promise<CallToolResult> {
        return this.manager.readReport(taskId, turnId);
    }

    send(taskId: string, message: string, _requestId?: string, _idempotencyKey?: string): Promise<CallToolResult> {
        return this.manager.send(taskId, message);
    }

    cancel(taskId: string, _requestId?: string, _idempotencyKey?: string): Promise<CallToolResult> {
        return this.manager.cancel(taskId);
    }

    ownsTask(taskId: string): Promise<boolean> {
        return this.manager.ownsTask(taskId);
    }
}

const providers = new Map<string, LocalAgentProviderAdapter>([
    ['kilo', new KiloLocalAgentAdapter()],
    ['zcode', new ZcodeLocalAgentAdapter()],
]);

const jsonResult = (value: unknown): CallToolResult => ({
    content: [{ type: 'text', text: JSON.stringify(value, null, 2) }],
});

const errorResult = (message: string): CallToolResult => ({
    content: [{ type: 'text', text: message }],
    isError: true,
});

function providerFor(id: string): LocalAgentProviderAdapter | undefined {
    return providers.get(id);
}

async function providerForTask(taskId: string): Promise<LocalAgentProviderAdapter | undefined> {
    for (const provider of providers.values()) {
        if (await provider.ownsTask(taskId)) return provider;
    }
    return undefined;
}

function parseArgs<T>(schema: { safeParse(value: unknown): { success: true; data: T } | { success: false; error: { issues: Array<{ path: PropertyKey[]; message: string }> } } }, value: unknown, toolName: string): T | CallToolResult {
    const parsed = schema.safeParse(value);
    if (parsed.success) return parsed.data;
    const detail = parsed.error.issues.map((issue) => `${issue.path.join('.') || 'arguments'}: ${issue.message}`).join('; ');
    return errorResult(`Invalid ${toolName} arguments: ${detail}`);
}

function isToolResult(value: unknown): value is CallToolResult {
    return typeof value === 'object' && value !== null && Array.isArray((value as CallToolResult).content);
}

export function mergeLocalAgentTaskLists(
    results: Array<{ provider: string; result: CallToolResult }>,
    limit: number,
): { tasks: unknown[]; returned: number; limit: number; provider_errors?: Array<{ provider: string; error: string }> } {
    const providerErrors: Array<{ provider: string; error: string }> = [];
    const lists: unknown[] = [];
    for (const { provider, result } of results) {
        const text = result.content.find((item) => item.type === 'text')?.text ?? '';
        if (result.isError) {
            providerErrors.push({ provider, error: text || 'Provider failed to list tasks.' });
            continue;
        }
        try {
            const parsed = JSON.parse(text || '{}') as { tasks?: unknown };
            if (Array.isArray(parsed.tasks)) lists.push(...parsed.tasks);
            else providerErrors.push({ provider, error: 'Provider returned a task list without a tasks array.' });
        } catch (error) {
            providerErrors.push({ provider, error: `Provider returned invalid task-list JSON: ${error instanceof Error ? error.message : String(error)}` });
        }
    }

    const ordered = lists.sort((left, right) => {
        const leftTime = Date.parse(String((left as { created_at?: unknown }).created_at ?? '')) || 0;
        const rightTime = Date.parse(String((right as { created_at?: unknown }).created_at ?? '')) || 0;
        return rightTime - leftTime;
    });
    return {
        tasks: ordered.slice(0, limit),
        returned: Math.min(ordered.length, limit),
        limit,
        ...(providerErrors.length > 0 ? { provider_errors: providerErrors } : {}),
    };
}

export async function handleLocalAgentTool(name: string, rawArgs: unknown, requestId?: string): Promise<CallToolResult> {
    if (name === 'local_agent_providers') {
        const args = parseArgs(LocalAgentProvidersArgsSchema, rawArgs ?? {}, name);
        if (isToolResult(args)) return args;
        return jsonResult({
            providers: [...providers.values()].map((provider) => ({
                id: provider.id,
                name: provider.name,
                adapter: 'registered',
                capabilities: provider.capabilities,
                transport: provider.transport ?? 'provider-native API',
            })),
        });
    }

    if (name === 'local_agent_start') {
        const args = parseArgs(LocalAgentStartArgsSchema, rawArgs, name);
        if (isToolResult(args)) return args;
        const provider = providerFor(args.provider);
        if (!provider) return errorResult(`Unsupported local agent provider: ${args.provider}. Call local_agent_providers to see registered providers.`);
        return provider.start(args.prompt, args.repository_path, requestId, args.idempotency_key);
    }

    if (name === 'local_agent_list') {
        const args = parseArgs(LocalAgentListArgsSchema, rawArgs, name);
        if (isToolResult(args)) return args;
        if (args.provider) {
            const provider = providerFor(args.provider);
            if (!provider) return errorResult(`Unsupported local agent provider: ${args.provider}. Call local_agent_providers to see registered providers.`);
            return provider.list({ repositoryPath: args.repository_path, status: args.status, limit: args.limit });
        }
        const results = await Promise.all([...providers.values()].map(async (provider) => ({
            provider: provider.id,
            result: await provider.list({
                repositoryPath: args.repository_path,
                status: args.status,
                limit: args.limit,
            }),
        })));
        return jsonResult(mergeLocalAgentTaskLists(results, args.limit));
    }

    if (name === 'local_agent_status') {
        const args = parseArgs<{ task_id: string }>(LocalAgentTaskArgsSchema, rawArgs, name);
        if (isToolResult(args)) return args;
        const provider = await providerForTask(args.task_id);
        if (!provider) return errorResult('No local agent provider can resolve this task_id.');
        return provider.status(args.task_id);
    }

    if (name === 'local_agent_cancel') {
        const args = parseArgs<{ task_id: string; idempotency_key?: string }>(LocalAgentCancelArgsSchema, rawArgs, name);
        if (isToolResult(args)) return args;
        const provider = await providerForTask(args.task_id);
        if (!provider) return errorResult('No local agent provider can resolve this task_id.');
        if (!provider.capabilities.cancel) return errorResult(`${provider.name} does not support task cancellation.`);
        if (provider.id === 'zcode' && !args.idempotency_key) {
            return errorResult('idempotency_key is required for Zcode cancellation.');
        }
        return provider.cancel(args.task_id, requestId, args.idempotency_key);
    }

    if (name === 'local_agent_read_report') {
        const args = parseArgs(LocalAgentReadReportArgsSchema, rawArgs, name);
        if (isToolResult(args)) return args;
        const provider = await providerForTask(args.task_id);
        if (!provider) return errorResult('No local agent provider can resolve this task_id.');
        if (!provider.capabilities.read_report) return errorResult(`${provider.name} does not expose persisted final reports.`);
        return provider.readReport(args.task_id, args.turn_id);
    }

    if (name === 'local_agent_send') {
        const args = parseArgs(LocalAgentSendArgsSchema, rawArgs, name);
        if (isToolResult(args)) return args;
        const provider = await providerForTask(args.task_id);
        if (!provider) return errorResult('No local agent provider can resolve this task_id.');
        if (!provider.capabilities.send) return errorResult(`${provider.name} does not support follow-up messages.`);
        if (provider.id === 'zcode' && !args.idempotency_key) {
            return errorResult('idempotency_key is required for Zcode follow-up.');
        }
        return provider.send(args.task_id, args.message, requestId, args.idempotency_key);
    }

    return errorResult(`Unknown local agent tool: ${name}`);
}
