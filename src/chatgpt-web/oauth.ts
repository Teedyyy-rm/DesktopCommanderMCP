import {
  createHash,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';
import {
  chmodSync,
  closeSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import type { Response } from 'express';
import type {
  OAuthServerProvider,
  AuthorizationParams,
} from '@modelcontextprotocol/sdk/server/auth/provider.js';
import type { OAuthRegisteredClientsStore } from '@modelcontextprotocol/sdk/server/auth/clients.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import {
  AccessDeniedError,
  InvalidClientMetadataError,
  InvalidGrantError,
  InvalidScopeError,
  InvalidTargetError,
  InvalidTokenError,
} from '@modelcontextprotocol/sdk/server/auth/errors.js';
import type {
  OAuthClientInformationFull,
  OAuthTokenRevocationRequest,
  OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js';

export const CHATGPT_WEB_SCOPE = 'desktop-commander.full_access';
export const CHATGPT_WEB_SCOPES = [CHATGPT_WEB_SCOPE];
export const CHATGPT_WEB_RESOURCE_PATH = '/mcp';
const AUTHORIZATION_CODE_TTL_MS = 5 * 60 * 1000;
const MAX_COMPLETED_LOGIN_REPLAYS = 256;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const MAX_LOGIN_FAILURES = 10;
const MAX_REGISTERED_CLIENTS = 32;
const MAX_PENDING_LOGINS = 128;
const MAX_AUTHORIZATION_CODES = 256;
const MAX_ACTIVE_TOKENS = 512;

type LoginTransaction = {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  state?: string;
  scopes: string[];
  resource: string;
};

type AuthorizationCode = {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  scopes: string[];
  resource: string;
  loginTransactionKey: string;
  expiresAt: number;
};

type CompletedLogin = {
  redirectUrl: string;
  expiresAt: number;
  authorizationCodeExchanged: boolean;
};

type TokenRecord = {
  clientId: string;
  scopes: string[];
  resource: string;
  expiresAt: number;
  accessTokenHash: string;
  refreshTokenHash: string;
};

type LoginResult =
  | { ok: true; redirectUrl: string }
  | { ok: true; alreadyCompleted: true }
  | { ok: false; status: 400 | 401 | 429 };

export interface ChatGptWebOAuthOptions {
  accessKey: string;
  resourceUrl: URL;
  /** Set to null to disable persisted DCR clients (for isolated tests). */
  clientStorePath?: string | null;
  accessTokenTtlSeconds?: number;
  refreshTokenTtlSeconds?: number;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function token(): string {
  return randomBytes(32).toString('base64url');
}

/** Generate a high-entropy access key suitable for the private gateway env file. */
export function generateChatGptWebAccessKey(): string {
  return token();
}

function hashAccessKey(value: string): Buffer {
  return createHash('sha256').update(value).digest();
}

/**
 * Remote MCP OAuth callback URLs are deliberately allowlisted. This keeps
 * dynamic client registration from turning the single-user login into an open
 * authorization redirect for arbitrary clients.
 */
export function isAllowedRemoteMcpRedirectUri(value: string): boolean {
  try {
    const redirect = new URL(value);
    if (redirect.protocol !== 'https:' ||
      redirect.port || redirect.username || redirect.password || redirect.search || redirect.hash) {
      return false;
    }
    if (redirect.hostname === 'chatgpt.com') {
      return redirect.pathname === '/connector_platform_oauth_redirect' ||
        /^\/connector\/oauth\/[A-Za-z0-9_-]{1,128}$/.test(redirect.pathname);
    }
    return redirect.hostname === 'claude.ai' && redirect.pathname === '/api/mcp/auth_callback';
  } catch {
    return false;
  }
}

const CLAUDE_REMOTE_MCP_REDIRECT_URI = 'https://claude.ai/api/mcp/auth_callback';

function isPersistableOAuthClient(value: Partial<OAuthClientInformationFull>): boolean {
  if (value.token_endpoint_auth_method === 'none') {
    return value.client_secret === undefined && value.client_secret_expires_at === undefined;
  }
  return value.token_endpoint_auth_method === 'client_secret_post' &&
    Array.isArray(value.redirect_uris) &&
    value.redirect_uris.length === 1 &&
    value.redirect_uris[0] === CLAUDE_REMOTE_MCP_REDIRECT_URI &&
    typeof value.client_secret === 'string' && /^[a-f0-9]{64}$/.test(value.client_secret) &&
    (value.client_secret_expires_at === undefined || Number.isFinite(value.client_secret_expires_at));
}

export class ChatGptWebOAuthProvider implements OAuthServerProvider {
  readonly clientsStore: OAuthRegisteredClientsStore;
  private readonly accessKeyDigest: Buffer;
  private readonly resourceUrl: string;
  private readonly clientStorePath: string | null;
  private readonly accessTokenTtlSeconds: number;
  private readonly refreshTokenTtlSeconds: number;
  private readonly clients = new Map<string, OAuthClientInformationFull>();
  private readonly loginTransactions = new Map<string, LoginTransaction>();
  private readonly completedLogins = new Map<string, CompletedLogin>();
  private readonly authorizationCodes = new Map<string, AuthorizationCode>();
  private readonly accessTokens = new Map<string, TokenRecord>();
  private readonly refreshTokens = new Map<string, TokenRecord>();
  private loginWindowStartedAt = Date.now();
  private failedLoginCount = 0;
  private loginLockedUntil = 0;

  constructor(options: ChatGptWebOAuthOptions) {
    if (options.resourceUrl.pathname !== CHATGPT_WEB_RESOURCE_PATH ||
      options.resourceUrl.search || options.resourceUrl.hash) {
      throw new Error('The OAuth resource URL must identify the /mcp endpoint.');
    }
    if (!/^[A-Za-z0-9_-]{43}$/.test(options.accessKey)) {
      throw new Error('DC_CHATGPT_WEB_OAUTH_KEY must be a 43-character base64url key created with `desktop-commander chatgpt-web generate-key`.');
    }

    this.accessKeyDigest = hashAccessKey(options.accessKey);
    this.resourceUrl = options.resourceUrl.href;
    this.clientStorePath = options.clientStorePath === null
      ? null
      : resolve(options.clientStorePath ?? process.env.DC_CHATGPT_WEB_CLIENTS_FILE ??
        join(homedir(), '.config', 'desktop-commander', 'chatgpt-web-oauth-clients.json'));
    this.accessTokenTtlSeconds = options.accessTokenTtlSeconds ?? 60 * 60;
    this.refreshTokenTtlSeconds = options.refreshTokenTtlSeconds ?? 30 * 24 * 60 * 60;
    this.loadClients();

    this.clientsStore = {
      getClient: (clientId) => this.clients.get(clientId),
      registerClient: (client) => this.registerClient(client),
    };
  }

  async authorize(
    client: OAuthClientInformationFull,
    params: AuthorizationParams,
    res: Response,
  ): Promise<void> {
    const resource = params.resource?.href;
    if (!resource || resource !== this.resourceUrl) {
      throw new InvalidTargetError('The authorization request must target this MCP server.');
    }
    if (!/^[A-Za-z0-9_-]{43,128}$/.test(params.codeChallenge)) {
      throw new InvalidGrantError('A valid PKCE S256 challenge is required.');
    }
    const requestedScopes = params.scopes ?? [];
    const scopes = requestedScopes.length ? requestedScopes : [CHATGPT_WEB_SCOPE];
    if (scopes.some((scope) => scope !== CHATGPT_WEB_SCOPE)) {
      throw new InvalidScopeError('Only the full Desktop Commander scope is supported.');
    }
    if (client.scope && scopes.some((scope) => !client.scope!.split(/\s+/).includes(scope))) {
      throw new InvalidScopeError('The requested scope was not registered for this client.');
    }
    if (!isAllowedRemoteMcpRedirectUri(params.redirectUri) ||
      !client.redirect_uris.includes(params.redirectUri)) {
      throw new AccessDeniedError('The supported MCP client callback is not registered.');
    }

    this.pruneExpired();
    while (this.loginTransactions.size >= MAX_PENDING_LOGINS) {
      const oldestTransactionKey = this.loginTransactions.keys().next().value;
      if (oldestTransactionKey === undefined) break;
      this.loginTransactions.delete(oldestTransactionKey);
    }

    const transaction = token();
    this.loginTransactions.set(sha256(transaction), {
      clientId: client.client_id,
      redirectUri: params.redirectUri,
      codeChallenge: params.codeChallenge,
      state: params.state,
      scopes,
      resource,
    });

    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    // OAuth completes with a cross-origin redirect back to the MCP client.
    // Chromium can block that redirect when the initiating form's CSP only allows self.
    res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; form-action 'self' https://chatgpt.com https://claude.ai; base-uri 'none'; frame-ancestors 'none'");
    res.status(200).type('html').send(`<!doctype html>
<html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Desktop Commander sign in</title>
<body><main><h1>Sign in to Desktop Commander</h1>
<p>The gateway will use its configured single-user key to authorize this MCP connection.</p>
<form method="post" action="/login">
<input type="hidden" name="transaction" value="${transaction}">
<button type="submit">Continue to Desktop Commander</button></form></main></body></html>`);
  }

  /** Use an explicitly supplied key or the private gateway key, then consume the one-use authorization. */
  completeLogin(transaction: string, accessKey?: string): LoginResult {
    const now = Date.now();
    this.pruneExpired(now);
    if (now < this.loginLockedUntil) return { ok: false, status: 429 };

    const transactionKey = sha256(transaction);
    const completed = this.completedLogins.get(transactionKey);
    if (completed && completed.expiresAt > now) {
      return completed.authorizationCodeExchanged
        ? { ok: true, alreadyCompleted: true }
        : { ok: true, redirectUrl: completed.redirectUrl };
    }

    const pending = this.loginTransactions.get(transactionKey);
    if (!pending) return { ok: false, status: 400 };
    if (this.authorizationCodes.size >= MAX_AUTHORIZATION_CODES) {
      return { ok: false, status: 429 };
    }

    if (now - this.loginWindowStartedAt >= LOGIN_WINDOW_MS) {
      this.loginWindowStartedAt = now;
      this.failedLoginCount = 0;
      this.loginLockedUntil = 0;
    }

    const suppliedDigest = accessKey ? hashAccessKey(accessKey) : this.accessKeyDigest;
    if (!timingSafeEqual(suppliedDigest, this.accessKeyDigest)) {
      this.failedLoginCount += 1;
      if (this.failedLoginCount >= MAX_LOGIN_FAILURES) {
        this.loginLockedUntil = now + LOGIN_WINDOW_MS;
      }
      return { ok: false, status: this.loginLockedUntil > now ? 429 : 401 };
    }

    this.loginTransactions.delete(transactionKey);
    this.failedLoginCount = 0;
    this.loginWindowStartedAt = now;
    const authorizationCode = token();
    const authorizationCodeHash = sha256(authorizationCode);
    const expiresAt = now + AUTHORIZATION_CODE_TTL_MS;
    this.authorizationCodes.set(authorizationCodeHash, {
      clientId: pending.clientId,
      redirectUri: pending.redirectUri,
      codeChallenge: pending.codeChallenge,
      scopes: pending.scopes,
      resource: pending.resource,
      loginTransactionKey: transactionKey,
      expiresAt,
    });

    const redirect = new URL(pending.redirectUri);
    redirect.searchParams.set('code', authorizationCode);
    if (pending.state) redirect.searchParams.set('state', pending.state);
    while (this.completedLogins.size >= MAX_COMPLETED_LOGIN_REPLAYS) {
      const oldestCompletedKey = this.completedLogins.keys().next().value;
      if (oldestCompletedKey === undefined) break;
      this.completedLogins.delete(oldestCompletedKey);
    }
    this.completedLogins.set(transactionKey, {
      redirectUrl: redirect.href,
      expiresAt,
      authorizationCodeExchanged: false,
    });
    return { ok: true, redirectUrl: redirect.href };
  }

  async challengeForAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
  ): Promise<string> {
    this.pruneExpired();
    const grant = this.authorizationCodes.get(sha256(authorizationCode));
    if (!grant || grant.clientId !== client.client_id || grant.expiresAt <= Date.now()) {
      throw new InvalidGrantError('The authorization code is invalid or expired.');
    }
    return grant.codeChallenge;
  }

  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
    _codeVerifier?: string,
    redirectUri?: string,
    resource?: URL,
  ): Promise<OAuthTokens> {
    const codeHash = sha256(authorizationCode);
    const grant = this.authorizationCodes.get(codeHash);
    if (!grant || grant.clientId !== client.client_id || grant.expiresAt <= Date.now() ||
      grant.redirectUri !== redirectUri || grant.resource !== resource?.href) {
      throw new InvalidGrantError('The authorization code is invalid, expired, or bound to another request.');
    }
    const tokens = this.issueTokens(client.client_id, grant.scopes, grant.resource);
    this.authorizationCodes.delete(codeHash);
    const completed = this.completedLogins.get(grant.loginTransactionKey);
    if (completed) completed.authorizationCodeExchanged = true;
    return tokens;
  }

  async exchangeRefreshToken(
    client: OAuthClientInformationFull,
    refreshToken: string,
    scopes?: string[],
    resource?: URL,
  ): Promise<OAuthTokens> {
    const refreshHash = sha256(refreshToken);
    const record = this.refreshTokens.get(refreshHash);
    if (!record || record.clientId !== client.client_id || record.expiresAt <= Date.now() ||
      record.resource !== resource?.href) {
      throw new InvalidGrantError('The refresh token is invalid, expired, or bound to another resource.');
    }
    const nextScopes = scopes?.length ? scopes : record.scopes;
    if (nextScopes.some((scope) => !record.scopes.includes(scope))) {
      throw new InvalidScopeError('A refresh token cannot grant additional scopes.');
    }
    this.refreshTokens.delete(refreshHash);
    this.accessTokens.delete(record.accessTokenHash);
    return this.issueTokens(record.clientId, nextScopes, record.resource);
  }

  async verifyAccessToken(accessToken: string): Promise<AuthInfo> {
    this.pruneExpired();
    const accessHash = sha256(accessToken);
    const record = this.accessTokens.get(accessHash);
    if (!record || record.expiresAt <= Date.now() || record.resource !== this.resourceUrl) {
      throw new InvalidTokenError('The access token is invalid, expired, or has the wrong audience.');
    }
    return {
      token: accessToken,
      clientId: record.clientId,
      scopes: [...record.scopes],
      expiresAt: Math.floor(record.expiresAt / 1000),
      resource: new URL(record.resource),
    };
  }

  async revokeToken(
    client: OAuthClientInformationFull,
    request: OAuthTokenRevocationRequest,
  ): Promise<void> {
    const hash = sha256(request.token);
    const accessRecord = this.accessTokens.get(hash);
    if (accessRecord?.clientId === client.client_id) {
      this.accessTokens.delete(hash);
      this.refreshTokens.delete(accessRecord.refreshTokenHash);
      return;
    }
    const refreshRecord = this.refreshTokens.get(hash);
    if (refreshRecord?.clientId === client.client_id) {
      this.refreshTokens.delete(hash);
      this.accessTokens.delete(refreshRecord.accessTokenHash);
    }
  }

  private registerClient(
    client: Omit<OAuthClientInformationFull, 'client_id' | 'client_id_issued_at'>,
  ): OAuthClientInformationFull {
    const requestedScopes = client.scope?.split(/\s+/).filter(Boolean) ?? [];
    const isClaudeConfidentialClient = client.token_endpoint_auth_method === 'client_secret_post' &&
      client.redirect_uris.length === 1 &&
      client.redirect_uris[0] === CLAUDE_REMOTE_MCP_REDIRECT_URI &&
      typeof client.client_secret === 'string' && /^[a-f0-9]{64}$/.test(client.client_secret);
    if ((client.token_endpoint_auth_method !== 'none' && !isClaudeConfidentialClient) ||
      client.redirect_uris.length === 0 ||
      client.redirect_uris.some((uri) => !isAllowedRemoteMcpRedirectUri(uri)) ||
      requestedScopes.some((scope) => scope !== CHATGPT_WEB_SCOPE) ||
      client.grant_types?.some((grant) => !['authorization_code', 'refresh_token'].includes(grant)) ||
      client.response_types?.some((responseType) => responseType !== 'code')) {
      throw new InvalidClientMetadataError('Only ChatGPT and Claude Web public clients using their registered HTTPS callbacks are accepted.');
    }
    if (this.clients.size >= MAX_REGISTERED_CLIENTS) {
      throw new InvalidClientMetadataError('The registered client limit has been reached.');
    }

    const fullClient = client as OAuthClientInformationFull;
    if (!fullClient.client_id) {
      throw new InvalidClientMetadataError('The authorization server did not assign a client id.');
    }
    this.clients.set(fullClient.client_id, fullClient);
    try {
      this.persistClients();
    } catch (error) {
      this.clients.delete(fullClient.client_id);
      throw error;
    }
    return fullClient;
  }

  private loadClients(): void {
    if (!this.clientStorePath) return;

    let records: unknown;
    try {
      const stat = lstatSync(this.clientStorePath);
      if (stat.isSymbolicLink() || !stat.isFile()) {
        throw new Error('The OAuth client store must be a regular file, not a symlink.');
      }
      chmodSync(this.clientStorePath, 0o600);
      records = JSON.parse(readFileSync(this.clientStorePath, 'utf8'));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw new Error('Could not load the persisted ChatGPT OAuth client registrations.');
    }

    if (!Array.isArray(records) || records.length > MAX_REGISTERED_CLIENTS) {
      throw new Error('The persisted ChatGPT OAuth client registrations are invalid.');
    }
    for (const record of records) {
      if (!this.isPersistableClient(record)) {
        throw new Error('The persisted ChatGPT OAuth client registrations are invalid.');
      }
      this.clients.set(record.client_id, record);
    }
  }

  private isPersistableClient(value: unknown): value is OAuthClientInformationFull {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const client = value as Partial<OAuthClientInformationFull>;
    if (client.scope !== undefined && typeof client.scope !== 'string') return false;
    const scopes = client.scope?.split(/\s+/).filter(Boolean) ?? [];
    return typeof client.client_id === 'string' && client.client_id.length > 0 && client.client_id.length <= 512 &&
      (client.client_id_issued_at === undefined || Number.isFinite(client.client_id_issued_at)) &&
      isPersistableOAuthClient(client) && Array.isArray(client.redirect_uris) && client.redirect_uris.length > 0 &&
      client.redirect_uris.every((uri) => typeof uri === 'string' && isAllowedRemoteMcpRedirectUri(uri)) &&
      scopes.every((scope) => scope === CHATGPT_WEB_SCOPE) &&
      (client.grant_types === undefined || (Array.isArray(client.grant_types) && client.grant_types.every((grant) => ['authorization_code', 'refresh_token'].includes(grant)))) &&
      (client.response_types === undefined || (Array.isArray(client.response_types) && client.response_types.every((type) => type === 'code')));
  }

  private persistClients(): void {
    if (!this.clientStorePath) return;
    const directory = dirname(this.clientStorePath);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    try {
      const current = lstatSync(this.clientStorePath);
      if (current.isSymbolicLink() || !current.isFile()) {
        throw new Error('The OAuth client store must be a regular file, not a symlink.');
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }

    const temporaryPath = `${this.clientStorePath}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
    const fd = openSync(temporaryPath, 'wx', 0o600);
    try {
      writeFileSync(fd, `${JSON.stringify([...this.clients.values()], null, 2)}\n`, 'utf8');
      fsyncSync(fd);
      closeSync(fd);
    } catch (error) {
      try { closeSync(fd); } catch { /* already closed */ }
      try { unlinkSync(temporaryPath); } catch { /* best effort cleanup */ }
      throw error;
    }

    try {
      renameSync(temporaryPath, this.clientStorePath);
      chmodSync(this.clientStorePath, 0o600);
    } catch (error) {
      try { unlinkSync(temporaryPath); } catch { /* best effort cleanup */ }
      throw error;
    }
  }

  private issueTokens(clientId: string, scopes: string[], resource: string): OAuthTokens {
    this.pruneExpired();
    if (this.accessTokens.size >= MAX_ACTIVE_TOKENS || this.refreshTokens.size >= MAX_ACTIVE_TOKENS) {
      throw new InvalidGrantError('The active token limit has been reached. Please authorize again later.');
    }

    const accessToken = token();
    const refreshToken = token();
    const now = Date.now();
    const record: TokenRecord = {
      clientId,
      scopes: [...scopes],
      resource,
      expiresAt: now + this.accessTokenTtlSeconds * 1000,
      accessTokenHash: sha256(accessToken),
      refreshTokenHash: sha256(refreshToken),
    };
    this.accessTokens.set(record.accessTokenHash, record);
    this.refreshTokens.set(record.refreshTokenHash, {
      ...record,
      expiresAt: now + this.refreshTokenTtlSeconds * 1000,
    });

    return {
      access_token: accessToken,
      token_type: 'Bearer',
      expires_in: this.accessTokenTtlSeconds,
      scope: scopes.join(' '),
      refresh_token: refreshToken,
    };
  }

  private pruneExpired(now = Date.now()): void {
    for (const [key, completed] of this.completedLogins) {
      if (completed.expiresAt <= now) this.completedLogins.delete(key);
    }
    for (const [key, grant] of this.authorizationCodes) {
      if (grant.expiresAt <= now) this.authorizationCodes.delete(key);
    }
    for (const [key, record] of this.accessTokens) {
      if (record.expiresAt <= now) this.accessTokens.delete(key);
    }
    for (const [key, record] of this.refreshTokens) {
      if (record.expiresAt <= now) this.refreshTokens.delete(key);
    }
  }
}
