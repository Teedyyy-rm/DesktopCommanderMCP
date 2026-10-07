import { createServer as createHttpServer, type Server as HttpServer } from 'node:http';
import { randomBytes, randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express, { type Express, type Request, type Response } from 'express';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  CallToolRequestSchema,
  GetPromptRequestSchema,
  isInitializeRequest,
  ListPromptsRequestSchema,
  ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { getOAuthProtectedResourceMetadataUrl, mcpAuthRouter } from '@modelcontextprotocol/sdk/server/auth/router.js';
import { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js';
import type { ChatGptWebOAuthProvider } from './oauth.js';
import { CHATGPT_WEB_RESOURCE_PATH, CHATGPT_WEB_SCOPE, CHATGPT_WEB_SCOPES } from './oauth.js';

const MAX_SESSIONS = 16;
const DEFAULT_SESSION_IDLE_TIMEOUT_MS = 30 * 60 * 1000;
const MCP_BODY_LIMIT = '1mb';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export interface ChatGptWebGatewayOptions {
  publicUrl: URL;
  oauthProvider: ChatGptWebOAuthProvider;
  /** Bind address is intentionally fixed to IPv4 loopback. */
  port: number;
  sessionIdleTimeoutMs?: number;
  /** Injection point used by protocol tests; production creates a stdio child. */
  upstreamClientFactory?: () => Promise<Client>;
  /** Optional structured tool-call log sink; production writes concise lines to stdout. */
  toolCallLogger?: (event: ChatGptWebToolCallLogEvent) => void;
}

export interface ChatGptWebToolCallMetadata {
  transport: 'streamable_http';
  clientInfo: { name: string; version: string };
  oauth_client_id: string;
  origin_instance: string;
  gateway_pid: number;
  session_id?: string;
}

export type ChatGptWebToolCallLogEvent =
  | { phase: 'started'; callId: string; tool: string; arguments: Record<string, unknown>; metadata: ChatGptWebToolCallMetadata }
  | { phase: 'completed'; callId: string; tool: string; status: 'ok' | 'tool_error' | 'failed'; durationMs: number; result?: unknown; error?: string; metadata: ChatGptWebToolCallMetadata };

interface ProxySession {
  id?: string;
  clientId: string;
  clientInfo: { name: string; version: string };
  upstream: Client;
  frontServer: Server;
  transport: StreamableHTTPServerTransport;
  activeRequests: number;
  lastActivityAt: number;
  closing: boolean;
  idleTimer?: NodeJS.Timeout;
}

export interface ChatGptWebGateway {
  app: Express;
  httpServer: HttpServer;
  port: number;
  close(): Promise<void>;
}

/** Keep the ChatGPT Web MCP child isolated while forwarding explicit tool configuration. */
export function buildChatGptWebChildEnvironment(source: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const childEnvironment: Record<string, string> = { DC_CHATGPT_WEB_CHILD: 'true' };
  for (const key of [
    'DESKTOP_COMMANDER_DISABLE_TELEMETRY',
    'KILO_AGENT_WORKING_DIRECTORY',
    // Locator paths are configuration, not credentials. The control token is
    // read from the owner-only file by the child and is never copied here.
    'ORNIXAI_CONTROL_ENDPOINT_PATH',
    'ORNIXAI_CONTROL_CREDENTIAL_FILE',
  ] as const) {
    const value = source[key];
    if (value) childEnvironment[key] = value;
  }
  return childEnvironment;
}

async function createLocalDesktopCommanderClient(): Promise<Client> {
  const entrypoint = path.resolve(__dirname, '..', 'index.js');
  // Keep the child environment allowlisted rather than inheriting unrelated
  // gateway credentials. The configured Kilo repository must reach this
  // per-session process, which is where kilo_agent resolves its working tree.
  const childEnvironment = buildChatGptWebChildEnvironment();
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [entrypoint, '--no-onboarding'],
    cwd: process.cwd(),
    stderr: 'inherit',
    env: childEnvironment,
  });
  const client = new Client(
    { name: 'desktop-commander-chatgpt-web-gateway', version: '1.0.0' },
    { capabilities: {} },
  );
  try {
    await client.connect(transport);
    return client;
  } catch (error) {
    await client.close().catch(() => undefined);
    throw error;
  }
}

function jsonError(res: Response, status: number, code: string, message: string): void {
  res.status(status).json({ error: { code, message } });
}

/** Default text sink: the journal format operators already read with journalctl. */
export function formatChatGptWebToolCallLogEvent(event: ChatGptWebToolCallLogEvent): void {
  const call = `tool ${event.tool}`;
  if (event.phase === 'started') {
    console.info(`🔧 Received tool call ${event.callId}: ${event.tool} ${JSON.stringify(event.arguments)} metadata: ${JSON.stringify(event.metadata)}`);
  } else if (event.status === 'failed') {
    console.error(`❌ Tool call ${call} failed after ${event.durationMs}ms: ${event.error ?? 'Unknown error'}`);
  } else {
    console.info(`✅ Tool call ${event.tool} completed:\n ${JSON.stringify(event.result)}`);
  }
}

export function createChatGptWebApp(options: ChatGptWebGatewayOptions): {
  app: Express;
  closeSessions(): Promise<void>;
  getActiveSessionCount(): number;
} {
  const app = express();
  const sessions = new Map<string, ProxySession>();
  const activeSessions = new Set<ProxySession>();
  const pendingSessionCreations = new Set<Promise<ProxySession>>();
  let pendingSessions = 0;
  let admissionQueue = Promise.resolve();
  let shuttingDown = false;
  const publicUrl = new URL(options.publicUrl.href);
  const resourceUrl = new URL(CHATGPT_WEB_RESOURCE_PATH, publicUrl);
  const idleTimeoutMs = options.sessionIdleTimeoutMs ?? DEFAULT_SESSION_IDLE_TIMEOUT_MS;
  const gatewayInstanceId = randomBytes(12).toString('hex');

  if (publicUrl.protocol !== 'https:' || publicUrl.pathname !== '/' || publicUrl.username || publicUrl.password || publicUrl.search || publicUrl.hash) {
    throw new Error('DC_CHATGPT_WEB_PUBLIC_URL must be an HTTPS origin without a path, credentials, query, or fragment.');
  }
  if (!Number.isInteger(options.port) || options.port < 0 || options.port > 65535) {
    throw new Error('The ChatGPT Web gateway port must be an integer between 0 and 65535.');
  }
  if (!Number.isFinite(idleTimeoutMs) || idleTimeoutMs < 1000) {
    throw new Error('The MCP session idle timeout must be at least one second.');
  }

  app.disable('x-powered-by');
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    next();
  });
  app.get('/healthz', (_req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.status(200).json({ status: 'ok', service: 'desktop-commander-chatgpt-web' });
  });
  app.use(express.urlencoded({ extended: false, limit: '8kb' }));
  app.use((req, res, next) => {
    const requestPath = req.path;
    if (!['/authorize', '/login', '/token', '/register', '/revoke'].includes(requestPath)) return next();
    res.once('finish', () => {
      console.info(`[ChatGPT Web OAuth] ${req.method} ${requestPath} completed with status=${res.statusCode}`);
    });
    next();
  });
  app.use(mcpAuthRouter({
    provider: options.oauthProvider,
    issuerUrl: publicUrl,
    baseUrl: publicUrl,
    resourceServerUrl: resourceUrl,
    scopesSupported: CHATGPT_WEB_SCOPES,
    resourceName: 'Desktop Commander (self-hosted)',
  }));

  app.post('/login', (req, res) => {
    const body = req.body as Record<string, unknown>;
    const transaction = typeof body.transaction === 'string' ? body.transaction : '';
    const accessKey = typeof body.accessKey === 'string' ? body.accessKey : undefined;
    const result = options.oauthProvider.completeLogin(transaction, accessKey);
    if (!result.ok) {
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'");
      const message = result.status === 429
        ? 'Sign-in is temporarily rate limited. Try again later.'
        : result.status === 400
          ? 'This sign-in request is no longer available. Start a new connection from ChatGPT.'
          : 'The access key is incorrect. Try again.';
      const retryForm = result.status === 401 && /^[A-Za-z0-9_-]{43}$/.test(transaction)
        ? `<form method="post" action="/login" autocomplete="off"><input type="hidden" name="transaction" value="${transaction}"><label>Access key <input name="accessKey" type="password" autocomplete="off" required autofocus></label><button type="submit">Try again</button></form>`
        : result.status === 400
          ? '<p>Return to ChatGPT and start the connection again from the app.</p>'
          : '<p>Return to ChatGPT and try again later.</p>';
      res.status(result.status).type('html').send(`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Sign in failed</title><body><h1>Sign in failed</h1><p>${message}</p>${retryForm}</body></html>`);
      return;
    }
    res.setHeader('Cache-Control', 'no-store');
    if ('alreadyCompleted' in result) {
      console.info('[ChatGPT Web OAuth] Replayed login submission acknowledged after token exchange.');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Content-Security-Policy', "default-src 'none'; base-uri 'none'; frame-ancestors 'none'");
      res.status(200).type('html').send('<!doctype html><html lang="en"><meta charset="utf-8"><title>Desktop Commander connected</title><body><h1>Authorization already completed</h1><p>Return to ChatGPT to continue using Desktop Commander.</p></body></html>');
      return;
    }
    console.info('[ChatGPT Web OAuth] Login accepted; redirecting to the ChatGPT callback.');
    res.redirect(303, result.redirectUrl);
  });

  const bearerAuth = requireBearerAuth({
    verifier: options.oauthProvider,
    requiredScopes: [CHATGPT_WEB_SCOPE],
    resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(resourceUrl),
  });

  const logToolCall = options.toolCallLogger ?? formatChatGptWebToolCallLogEvent;

  // MCP clients such as the Inspector run in a browser and preflight requests
  // carrying Authorization and MCP session headers. No cookies are used, so a
  // wildcard origin is safe here; possession of a scoped bearer token is still
  // required for every MCP request.
  app.use(CHATGPT_WEB_RESOURCE_PATH, (req, res, next) => {
    if (req.method !== 'OPTIONS') {
      res.once('finish', () => {
        if (res.statusCode >= 400) {
          console.error(`[ChatGPT Web MCP] ${req.method} /mcp completed with status=${res.statusCode}`);
        }
      });
    }
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Accept, Authorization, Content-Type, Last-Event-ID, MCP-Protocol-Version, Mcp-Session-Id');
    res.setHeader('Access-Control-Expose-Headers', 'Mcp-Session-Id, MCP-Protocol-Version, WWW-Authenticate');
    if (req.method === 'OPTIONS') {
      res.status(204).end();
      return;
    }
    next();
  });

  const closeSession = async (session: ProxySession): Promise<void> => {
    if (session.closing) return;
    session.closing = true;
    if (session.idleTimer) clearTimeout(session.idleTimer);
    if (session.id && sessions.get(session.id) === session) sessions.delete(session.id);
    activeSessions.delete(session);
    try {
      await session.frontServer.close();
    } catch {
      // Continue to close the local stdio child even if the HTTP transport failed.
    }
    try {
      await session.upstream.close();
    } catch {
      // A child may already have exited; teardown remains best effort.
    }
  };

  const reserveSessionSlot = async (): Promise<void> => {
    let releaseAdmission!: () => void;
    const previousAdmission = admissionQueue;
    admissionQueue = new Promise<void>((resolve) => {
      releaseAdmission = resolve;
    });
    await previousAdmission;

    try {
      if (shuttingDown) throw new Error('The gateway is shutting down.');
      if (sessions.size + pendingSessions >= MAX_SESSIONS) {
        const oldestIdleSession = [...activeSessions]
          .filter((session) => session.id !== undefined && !session.closing && session.activeRequests === 0)
          .sort((left, right) => left.lastActivityAt - right.lastActivityAt)[0];

        if (oldestIdleSession) {
          console.info('[ChatGPT Web MCP] Evicting the least recently used idle session to admit a new session.');
          await closeSession(oldestIdleSession);
        }
      }
      if (sessions.size + pendingSessions >= MAX_SESSIONS) {
        throw new Error('The gateway has reached its active session limit.');
      }
      pendingSessions += 1;
    } finally {
      releaseAdmission();
    }
  };

  const scheduleIdleClose = (session: ProxySession): void => {
    if (session.idleTimer) clearTimeout(session.idleTimer);
    if (session.closing || session.activeRequests > 0) return;
    session.idleTimer = setTimeout(() => {
      void closeSession(session);
    }, idleTimeoutMs);
    session.idleTimer.unref();
  };

  const createSession = async (clientId: string, clientInfo: { name: string; version: string }): Promise<ProxySession> => {
    await reserveSessionSlot();
    let reservationReleased = false;
    const releaseReservation = () => {
      if (reservationReleased) return;
      reservationReleased = true;
      pendingSessions = Math.max(0, pendingSessions - 1);
    };

    let upstream: Client | undefined;
    let session: ProxySession | undefined;
    try {
      upstream = await (options.upstreamClientFactory ?? createLocalDesktopCommanderClient)();
      if (shuttingDown) {
        await upstream.close().catch(() => undefined);
        throw new Error('The gateway is shutting down.');
      }
      const frontServer = new Server(
        { name: 'desktop-commander-chatgpt-web', version: '1.0.0' },
        { capabilities: { tools: {}, resources: {}, prompts: {} } },
      );

      frontServer.setRequestHandler(ListToolsRequestSchema, async (request) =>
        upstream!.listTools(request.params));
      frontServer.setRequestHandler(CallToolRequestSchema, async (request) => {
        const callId = randomUUID();
        const tool = request.params.name;
        const args = request.params.arguments ?? {};
        const startedAt = Date.now();
        const metadata: ChatGptWebToolCallMetadata = {
          transport: 'streamable_http',
          clientInfo: session!.clientInfo,
          oauth_client_id: session!.clientId,
          origin_instance: gatewayInstanceId,
          gateway_pid: process.pid,
          ...(session!.id ? { session_id: session!.id } : {}),
        };
        logToolCall({ phase: 'started', callId, tool, arguments: args, metadata });
        try {
          const result = await upstream!.callTool({
            ...request.params,
            _meta: {
              ...(request.params._meta ?? {}),
              desktop_commander_call_id: callId,
            },
          });
          logToolCall({
            phase: 'completed',
            callId,
            tool,
            status: result.isError ? 'tool_error' : 'ok',
            durationMs: Math.max(0, Date.now() - startedAt),
            result,
            metadata,
          });
          return result;
        } catch (error) {
          const details = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
          logToolCall({
            phase: 'completed',
            callId,
            tool,
            status: 'failed',
            durationMs: Math.max(0, Date.now() - startedAt),
            error: details,
            metadata,
          });
          throw error;
        }
      });
      frontServer.setRequestHandler(ListResourcesRequestSchema, async (request) =>
        upstream!.listResources(request.params));
      frontServer.setRequestHandler(ReadResourceRequestSchema, async (request) =>
        upstream!.readResource(request.params));
      frontServer.setRequestHandler(ListResourceTemplatesRequestSchema, async (request) =>
        upstream!.listResourceTemplates(request.params));
      frontServer.setRequestHandler(ListPromptsRequestSchema, async (request) =>
        upstream!.listPrompts(request.params));
      frontServer.setRequestHandler(GetPromptRequestSchema, async (request) =>
        upstream!.getPrompt(request.params));

      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomBytes(24).toString('base64url'),
        onsessioninitialized: (sessionId) => {
          if (!session) return;
          session.id = sessionId;
          releaseReservation();
          sessions.set(sessionId, session);
          scheduleIdleClose(session);
        },
        onsessionclosed: (sessionId) => {
          if (session?.id === sessionId) void closeSession(session);
        },
      });
      session = {
        clientId,
        clientInfo,
        upstream,
        frontServer,
        transport,
        activeRequests: 0,
        lastActivityAt: Date.now(),
        closing: false,
      };
      activeSessions.add(session);
      await frontServer.connect(transport);
      if (shuttingDown) {
        await closeSession(session);
        throw new Error('The gateway is shutting down.');
      }
      frontServer.onclose = () => {
        if (session) void closeSession(session);
      };
      return session;
    } catch (error) {
      releaseReservation();
      if (session) await closeSession(session);
      else if (upstream) await upstream.close().catch(() => undefined);
      throw error;
    }
  };

  const createTrackedSession = (clientId: string, clientInfo: { name: string; version: string }): Promise<ProxySession> => {
    const creation = createSession(clientId, clientInfo);
    pendingSessionCreations.add(creation);
    void creation.then(
      () => pendingSessionCreations.delete(creation),
      () => pendingSessionCreations.delete(creation),
    );
    return creation;
  };

  const handleMcpRequest = async (req: Request, res: Response): Promise<void> => {
    const authInfo = req.auth;
    if (!authInfo) {
      jsonError(res, 401, 'unauthorized', 'A valid bearer token is required.');
      return;
    }

    const sessionId = req.get('mcp-session-id');
    let session: ProxySession | undefined;
    if (sessionId) {
      session = sessions.get(sessionId);
      if (!session || session.closing || session.clientId !== authInfo.clientId) {
        jsonError(res, 404, 'session_not_found', 'The MCP session does not exist.');
        return;
      }
    } else if (req.method === 'POST' && isInitializeRequest(req.body)) {
      try {
        session = await createTrackedSession(authInfo.clientId, req.body.params.clientInfo);
      } catch (error) {
        const details = error instanceof Error ? error.message : String(error);
        console.error(`[ChatGPT Web MCP] Local Desktop Commander session startup failed: ${details}`);
        jsonError(res, 503, 'session_unavailable', 'A local Desktop Commander session could not be started.');
        return;
      }
    } else {
      jsonError(res, 400, 'session_required', 'Send an MCP initialize request before using this endpoint.');
      return;
    }

    session.lastActivityAt = Date.now();
    const isActiveRequest = req.method === 'POST';
    if (isActiveRequest) {
      session.activeRequests += 1;
      if (session.idleTimer) clearTimeout(session.idleTimer);
    } else {
      // A GET may hold an SSE stream open for the life of the client. It counts
      // as activity when opened but must not suppress idle cleanup indefinitely.
      scheduleIdleClose(session);
    }
    try {
      await session.transport.handleRequest(req, res, req.method === 'POST' ? req.body : undefined);
    } catch (error) {
      const details = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
      console.error(`[ChatGPT Web MCP] MCP request failed: ${details}`);
      if (!res.headersSent) jsonError(res, 502, 'upstream_error', 'The local Desktop Commander session failed.');
    } finally {
      if (isActiveRequest) {
        session.activeRequests = Math.max(0, session.activeRequests - 1);
        scheduleIdleClose(session);
      }
    }
  };

  app.post(CHATGPT_WEB_RESOURCE_PATH, bearerAuth, express.json({ limit: MCP_BODY_LIMIT }), (req, res) => {
    void handleMcpRequest(req, res);
  });
  app.get(CHATGPT_WEB_RESOURCE_PATH, bearerAuth, (req, res) => {
    void handleMcpRequest(req, res);
  });
  app.delete(CHATGPT_WEB_RESOURCE_PATH, bearerAuth, (req, res) => {
    void handleMcpRequest(req, res);
  });
  app.all(CHATGPT_WEB_RESOURCE_PATH, (_req, res) => {
    res.setHeader('Allow', 'GET, POST, DELETE');
    jsonError(res, 405, 'method_not_allowed', 'Use GET, POST, or DELETE for the MCP endpoint.');
  });

  app.use((error: unknown, _req: Request, res: Response, _next: express.NextFunction) => {
    if (res.headersSent) return;
    const status = typeof error === 'object' && error !== null && 'status' in error && error.status === 413
      ? 413
      : 400;
    jsonError(res, status, status === 413 ? 'request_too_large' : 'invalid_request',
      status === 413 ? 'The request body is too large.' : 'The request could not be parsed.');
  });

  return {
    app,
    closeSessions: async () => {
      shuttingDown = true;
      await Promise.all([...pendingSessionCreations].map((creation) => creation.catch(() => undefined)));
      await Promise.all([...activeSessions].map((session) => closeSession(session)));
    },
    getActiveSessionCount: () => sessions.size,
  };
}

export async function startChatGptWebGateway(options: ChatGptWebGatewayOptions): Promise<ChatGptWebGateway> {
  const gateway = createChatGptWebApp(options);
  const httpServer = createHttpServer(gateway.app);
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => reject(error);
    httpServer.once('error', onError);
    httpServer.listen(options.port, '127.0.0.1', () => {
      httpServer.off('error', onError);
      resolve();
    });
  });
  const address = httpServer.address();
  if (!address || typeof address === 'string') {
    await gateway.closeSessions();
    throw new Error('The ChatGPT Web gateway did not obtain a TCP port.');
  }

  let closed = false;
  return {
    app: gateway.app,
    httpServer,
    port: address.port,
    close: async () => {
      if (closed) return;
      closed = true;
      await gateway.closeSessions();
      await new Promise<void>((resolve, reject) => {
        httpServer.close((error) => error ? reject(error) : resolve());
      });
    },
  };
}
