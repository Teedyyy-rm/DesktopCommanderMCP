import { randomUUID } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { configManager } from '../config-manager.js';
import {
  ZCODE_CONTROL_PROTOCOL_NAME,
  ZCODE_CONTROL_PROTOCOL_VERSION,
  ZcodeControlToolSchemas,
  zcodeControlMethod,
  type ZcodeControlToolName,
} from './ornixai-control-schemas.js';

const MAX_FRAME_BYTES = 2 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 15_000;
const CONTROL_ENDPOINT_ENV = 'ORNIXAI_CONTROL_ENDPOINT_PATH';
const CONTROL_CREDENTIAL_ENV = 'ORNIXAI_CONTROL_CREDENTIAL_FILE';
const EXTERNAL_ERROR_CODES = new Set([
  'RUNTIME_UNAVAILABLE', 'WORKSPACE_NOT_FOUND', 'WORKSPACE_NOT_AUTHORIZED',
  'WORKSPACE_IDENTITY_MISMATCH', 'SESSION_NOT_FOUND', 'SESSION_BUSY',
  'TASK_NOT_FOUND', 'STALE_OWNER', 'POLICY_DENIED', 'APPROVAL_REQUIRED',
  'INTERACTION_NOT_FOUND', 'INVALID_STATE', 'TIMEOUT', 'TRANSPORT_CLOSED',
  'PROTOCOL_VERSION_MISMATCH', 'INTERNAL_ERROR',
]);

export interface ZcodeControlClientOptions {
  endpointPath?: string;
  credentialFilePath?: string;
}

export class ZcodeControlError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'ZcodeControlError';
  }
}

interface JsonRpcResponse {
  jsonrpc?: unknown;
  id?: unknown;
  result?: unknown;
  error?: { code?: unknown; message?: unknown; data?: unknown };
}

function errorResult(code: string, message: string): CallToolResult {
  const value = { error: { code, message } };
  return {
    content: [{ type: 'text', text: JSON.stringify(value) }],
    structuredContent: value,
    isError: true,
  };
}

function jsonResult(value: unknown): CallToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    structuredContent: value as Record<string, unknown>,
  };
}

function stableCode(error: JsonRpcResponse['error']): string {
  const data = error?.data;
  if (data && typeof data === 'object' && 'external_code' in data) {
    const code = (data as { external_code?: unknown }).external_code;
    if (typeof code === 'string' && EXTERNAL_ERROR_CODES.has(code)) return code;
  }
  return 'INTERNAL_ERROR';
}

async function readCredential(filePath: string | undefined): Promise<string> {
  if (!filePath || !path.isAbsolute(filePath)) {
    throw new ZcodeControlError('RUNTIME_UNAVAILABLE', 'Zcode control endpoint is not configured.');
  }
  let fileHandle;
  try {
    const entry = await lstat(filePath);
    if (entry.isSymbolicLink()) {
      throw new ZcodeControlError('POLICY_DENIED', 'Zcode control credential must not be a symbolic link.');
    }
    const noFollow = process.platform === 'win32' ? 0 : fsConstants.O_NOFOLLOW;
    fileHandle = await open(filePath, fsConstants.O_RDONLY | noFollow);
  } catch (error) {
    if (error instanceof ZcodeControlError) throw error;
    if (error && typeof error === 'object' && 'code' in error && (error as NodeJS.ErrnoException).code === 'ELOOP') {
      throw new ZcodeControlError('POLICY_DENIED', 'Zcode control credential must not be a symbolic link.');
    }
    throw new ZcodeControlError('RUNTIME_UNAVAILABLE', 'Zcode control credential is unavailable.');
  }
  try {
    const fileStat = await fileHandle.stat();
    if (!fileStat.isFile() || fileStat.size > 4096) {
      throw new ZcodeControlError('POLICY_DENIED', 'Zcode control credential file is invalid.');
    }
    if (typeof process.getuid === 'function' && fileStat.uid !== process.getuid()) {
      throw new ZcodeControlError('POLICY_DENIED', 'Zcode control credential must be owned by the current user.');
    }
    if (process.platform !== 'win32' && (fileStat.mode & 0o077) !== 0) {
      throw new ZcodeControlError('POLICY_DENIED', 'Zcode control credential permissions must be owner-only.');
    }
    const token = (await fileHandle.readFile('utf8')).trim();
    if (token.length < 32 || token.length > 2048 || /\s/.test(token)) {
      throw new ZcodeControlError('POLICY_DENIED', 'Zcode control credential has an invalid format.');
    }
    return token;
  } finally {
    await fileHandle.close();
  }
}

function connectLocal(endpoint: string): net.Socket {
  if (!endpoint || !path.isAbsolute(endpoint)) {
    throw new ZcodeControlError('RUNTIME_UNAVAILABLE', 'Zcode control endpoint is not configured.');
  }
  return net.createConnection({ path: endpoint });
}

async function verifyLocalEndpoint(endpoint: string): Promise<void> {
  if (process.platform === 'win32') return;
  let endpointStat;
  try {
    endpointStat = await lstat(endpoint);
  } catch {
    throw new ZcodeControlError('RUNTIME_UNAVAILABLE', 'Zcode Desktop control endpoint is offline.');
  }
  if (!endpointStat.isSocket()) {
    throw new ZcodeControlError('POLICY_DENIED', 'Zcode control endpoint must be a local socket.');
  }
  if (typeof process.getuid === 'function' && endpointStat.uid !== process.getuid()) {
    throw new ZcodeControlError('POLICY_DENIED', 'Zcode control endpoint must be owned by the current user.');
  }
  if ((endpointStat.mode & 0o077) !== 0) {
    throw new ZcodeControlError('POLICY_DENIED', 'Zcode control endpoint permissions must be owner-only.');
  }
}

function waitForConnect(socket: net.Socket, timeoutMs = REQUEST_TIMEOUT_MS): Promise<void> {
  return new Promise((resolve, reject) => {
    const cleanup = (): void => {
      clearTimeout(timer);
      socket.off('connect', onConnect);
      socket.off('error', onError);
    };
    const onConnect = (): void => {
      cleanup();
      resolve();
    };
    const onError = (): void => {
      cleanup();
      reject(new ZcodeControlError('TRANSPORT_CLOSED', 'Zcode control connection failed.'));
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new ZcodeControlError('TIMEOUT', 'Zcode control connection timed out.'));
      socket.destroy();
    }, timeoutMs);
    socket.once('connect', onConnect);
    socket.once('error', onError);
  });
}

function redactCredential(value: unknown, credential: string): unknown {
  if (typeof value === 'string') return value.split(credential).join('[REDACTED]');
  if (Array.isArray(value)) return value.map((item) => redactCredential(item, credential));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [
      key.split(credential).join('[REDACTED]'),
      redactCredential(item, credential),
    ]));
  }
  return value;
}

function readLine(socket: net.Socket, timeoutMs = REQUEST_TIMEOUT_MS): Promise<string> {
  return new Promise((resolve, reject) => {
    let buffer = Buffer.alloc(0);
    const cleanup = (): void => {
      clearTimeout(timer);
      socket.off('data', onData);
      socket.off('error', onError);
      socket.off('close', onClose);
    };
    const onData = (chunk: Buffer): void => {
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length > MAX_FRAME_BYTES) {
        cleanup();
        reject(new ZcodeControlError('INVALID_STATE', 'Zcode control response exceeded the size limit.'));
        socket.destroy();
        return;
      }
      const newline = buffer.indexOf(0x0a);
      if (newline < 0) return;
      const line = buffer.subarray(0, newline).toString('utf8').trim();
      cleanup();
      resolve(line);
    };
    const onError = (): void => {
      cleanup();
      reject(new ZcodeControlError('TRANSPORT_CLOSED', 'Zcode control connection failed.'));
    };
    const onClose = (): void => {
      cleanup();
      reject(new ZcodeControlError('TRANSPORT_CLOSED', 'Zcode control connection closed.'));
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new ZcodeControlError('TIMEOUT', 'Zcode control request timed out.'));
      socket.destroy();
    }, timeoutMs);
    socket.on('data', onData);
    socket.once('error', onError);
    socket.once('close', onClose);
  });
}

async function exchange(socket: net.Socket, request: Record<string, unknown>): Promise<JsonRpcResponse> {
  const line = `${JSON.stringify(request)}\n`;
  if (Buffer.byteLength(line) > MAX_FRAME_BYTES) {
    throw new ZcodeControlError('INVALID_STATE', 'Zcode control request exceeded the size limit.');
  }
  await new Promise<void>((resolve, reject) => {
    socket.write(line, 'utf8', (error) => error ? reject(error) : resolve());
  });
  const responseText = await readLine(socket);
  let response: JsonRpcResponse;
  try {
    response = JSON.parse(responseText) as JsonRpcResponse;
  } catch {
    throw new ZcodeControlError('INVALID_STATE', 'Zcode control returned invalid JSON-RPC data.');
  }
  if (response.jsonrpc !== '2.0' || response.id !== request.id) {
    throw new ZcodeControlError('INVALID_STATE', 'Zcode control response correlation did not match.');
  }
  if (response.error) {
    throw new ZcodeControlError(stableCode(response.error), 'Zcode control request was rejected.');
  }
  return response;
}

export async function executeZcodeControlRpc(
  name: ZcodeControlToolName,
  params: Record<string, unknown>,
  options: ZcodeControlClientOptions = {},
): Promise<unknown> {
  const endpoint = options.endpointPath?.trim() ?? process.env[CONTROL_ENDPOINT_ENV]?.trim();
  if (!endpoint) throw new ZcodeControlError('RUNTIME_UNAVAILABLE', 'Zcode Desktop control endpoint is not configured.');
  const credentialFile = options.credentialFilePath?.trim() ?? process.env[CONTROL_CREDENTIAL_ENV]?.trim();
  const token = await readCredential(credentialFile);
  await verifyLocalEndpoint(endpoint);
  const socket = connectLocal(endpoint);
  try {
    await waitForConnect(socket);
    const helloId = randomUUID();
    const helloResponse = await exchange(socket, {
      jsonrpc: '2.0',
      id: helloId,
      method: `${ZCODE_CONTROL_PROTOCOL_NAME}/hello`,
      params: {
        protocol_name: ZCODE_CONTROL_PROTOCOL_NAME,
        protocol_version: ZCODE_CONTROL_PROTOCOL_VERSION,
        authorization: { kind: 'bearer', token },
      },
    });
    const hello = helloResponse.result as Record<string, unknown> | undefined;
    if (
      hello?.protocol_name !== ZCODE_CONTROL_PROTOCOL_NAME ||
      hello.protocol_version !== ZCODE_CONTROL_PROTOCOL_VERSION
    ) {
      throw new ZcodeControlError('PROTOCOL_VERSION_MISMATCH', 'Zcode Desktop control protocol version is incompatible.');
    }
    const requestId = randomUUID();
    const request = {
      ...params,
      protocol_name: ZCODE_CONTROL_PROTOCOL_NAME,
      protocol_version: ZCODE_CONTROL_PROTOCOL_VERSION,
      request_id: requestId,
      trace_id: randomUUID(),
    };
    const response = await exchange(socket, {
      jsonrpc: '2.0',
      id: requestId,
      method: zcodeControlMethod(name),
      params: request,
    });
    return redactCredential(response.result, token);
  } catch (error) {
    if (error instanceof ZcodeControlError) throw error;
    if (error && typeof error === 'object' && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new ZcodeControlError('RUNTIME_UNAVAILABLE', 'Zcode Desktop control endpoint is offline.');
    }
    throw new ZcodeControlError('TRANSPORT_CLOSED', 'Zcode Desktop control endpoint is unavailable.');
  } finally {
    socket.destroy();
  }
}

async function callZcodeControl(
  name: ZcodeControlToolName,
  params: Record<string, unknown>,
  externalRequestId?: string,
): Promise<unknown> {
  return executeZcodeControlRpc(name, {
    ...params,
    ...(externalRequestId ? { external_request_id: externalRequestId } : {}),
  });
}

async function authorizedWorkspaceRoots(): Promise<string[]> {
  const config = await configManager.getConfig();
  const configured = Array.isArray(config.allowedDirectories) ? config.allowedDirectories : [];
  if (configured.length === 0) {
    throw new ZcodeControlError('WORKSPACE_NOT_AUTHORIZED', 'Configure an explicit allowedDirectories scope before controlling Zcode workspaces.');
  }
  const roots: string[] = [];
  for (const configuredPath of configured) {
    if (typeof configuredPath !== 'string' || !configuredPath.trim()) continue;
    try {
      const expanded = configuredPath === '~' || configuredPath.startsWith('~/')
        ? path.join(os.homedir(), configuredPath.slice(1))
        : configuredPath;
      roots.push(await realpath(expanded));
    } catch {
      // Missing roots do not grant access; invalid configured entries are ignored.
    }
  }
  return [...new Set(roots)];
}

async function authorizeWorkspace(inputPath: string | undefined, roots: string[]): Promise<string | undefined> {
  if (!inputPath) return undefined;
  if (!path.isAbsolute(inputPath)) throw new ZcodeControlError('WORKSPACE_NOT_AUTHORIZED', 'Workspace path must be absolute.');
  let realPath: string;
  try {
    realPath = await realpath(inputPath);
  } catch {
    throw new ZcodeControlError('WORKSPACE_NOT_FOUND', 'Workspace path does not exist.');
  }
  const allowed = roots.some((root) => {
    const relative = path.relative(root, realPath);
    return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
  });
  if (!allowed) throw new ZcodeControlError('WORKSPACE_NOT_AUTHORIZED', 'Workspace path is outside DesktopCommander allowedDirectories.');
  return realPath;
}

export async function handleZcodeControlTool(
  name: string,
  rawArgs: unknown,
  externalRequestId?: string,
): Promise<CallToolResult> {
  if (!(name in ZcodeControlToolSchemas)) return errorResult('INVALID_STATE', `Unknown Zcode tool: ${name}`);
  const toolName = name as ZcodeControlToolName;
  const parsed = ZcodeControlToolSchemas[toolName].safeParse(rawArgs ?? {});
  if (!parsed.success) {
    const detail = parsed.error.issues.map((issue) => `${issue.path.join('.') || 'arguments'}: ${issue.message}`).join('; ');
    return errorResult('INVALID_STATE', `Invalid ${toolName} arguments: ${detail}`);
  }
  try {
    const roots = toolName === 'zcode_runtime_status' ? [] : await authorizedWorkspaceRoots();
    const args = parsed.data as Record<string, unknown>;
    const workspacePath = await authorizeWorkspace(
      typeof args.workspace_path === 'string' ? args.workspace_path : undefined,
      roots,
    );
    const result = await callZcodeControl(toolName, {
      ...args,
      ...(workspacePath ? { workspace_path: workspacePath } : {}),
      authorization_scope: { allowed_workspace_roots: roots },
    }, externalRequestId);
    return jsonResult(result ?? {});
  } catch (error) {
    if (error instanceof ZcodeControlError) return errorResult(error.code, error.message);
    return errorResult('INTERNAL_ERROR', 'Zcode control request failed.');
  }
}
