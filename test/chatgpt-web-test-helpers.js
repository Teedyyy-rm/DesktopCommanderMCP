import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { ChatGptWebOAuthProvider, CHATGPT_WEB_SCOPE } from '../dist/chatgpt-web/oauth.js';
import { startChatGptWebGateway } from '../dist/chatgpt-web/gateway.js';

export const PUBLIC_URL = new URL('https://desktop-commander.test');
export const RESOURCE_URL = new URL('/mcp', PUBLIC_URL);
export const REDIRECT_URI = 'https://chatgpt.com/connector_platform_oauth_redirect';
export const CLAUDE_REDIRECT_URI = 'https://claude.ai/api/mcp/auth_callback';
export const TEST_ACCESS_KEY = 'a'.repeat(43);

export async function createGatewayHarness({
  upstreamClientFactory,
  accessTokenTtlSeconds = 60,
  sessionIdleTimeoutMs = 30_000,
  clientStorePath = null,
  toolCallLogger,
} = {}) {
  const oauthProvider = new ChatGptWebOAuthProvider({
    accessKey: TEST_ACCESS_KEY,
    resourceUrl: RESOURCE_URL,
    clientStorePath,
    accessTokenTtlSeconds,
  });
  const gateway = await startChatGptWebGateway({
    publicUrl: PUBLIC_URL,
    port: 0,
    oauthProvider,
    sessionIdleTimeoutMs,
    upstreamClientFactory,
    toolCallLogger,
  });
  const baseUrl = new URL(`http://127.0.0.1:${gateway.port}`);

  const requestJson = async (path, options) => {
    const response = await fetch(new URL(path, baseUrl), options);
    const text = await response.text();
    let body;
    try {
      body = text ? JSON.parse(text) : undefined;
    } catch {
      body = text;
    }
    return { response, body, text };
  };

  const registerClient = async (redirectUris = [REDIRECT_URI], clientName = 'ChatGPT Web test client') => {
    const { response, body } = await requestJson('/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        redirect_uris: redirectUris,
        token_endpoint_auth_method: 'none',
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        client_name: clientName,
        scope: CHATGPT_WEB_SCOPE,
      }),
    });
    return { response, body };
  };

  const beginAuthorization = async ({
    clientId,
    redirectUri = REDIRECT_URI,
    scope = CHATGPT_WEB_SCOPE,
    resource = RESOURCE_URL.href,
  } = {}) => {
    const verifier = randomBytes(32).toString('base64url');
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    const state = randomBytes(12).toString('hex');
    const params = new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      code_challenge: challenge,
      code_challenge_method: 'S256',
      scope,
      resource,
      state,
    });
    const response = await fetch(new URL(`/authorize?${params}`, baseUrl), { redirect: 'manual' });
    const html = await response.text();
    const transaction = /name="transaction" value="([A-Za-z0-9_-]+)"/.exec(html)?.[1];
    return { response, html, transaction, verifier, state };
  };

  const submitLogin = async ({ transaction, accessKey } = {}) => {
    const form = new URLSearchParams({ transaction });
    if (typeof accessKey === 'string') form.set('accessKey', accessKey);
    const response = await fetch(new URL('/login', baseUrl), {
      method: 'POST',
      redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: form,
    });
    return { response, location: response.headers.get('location'), text: await response.text() };
  };

  const exchangeCode = async ({ clientId, code, verifier, redirectUri = REDIRECT_URI, resource = RESOURCE_URL.href } = {}) => {
    const response = await fetch(new URL('/token', baseUrl), {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: clientId,
        code,
        code_verifier: verifier,
        redirect_uri: redirectUri,
        resource,
      }),
    });
    let body;
    try {
      body = await response.json();
    } catch {
      body = undefined;
    }
    return { response, body };
  };

  const authorizeAndGetToken = async (clientId) => {
    const auth = await beginAuthorization({ clientId });
    assert.equal(auth.response.status, 200, 'authorization page should be served');
    assert.ok(auth.transaction, 'authorization page should contain an opaque transaction token');
    const login = await submitLogin({ transaction: auth.transaction });
    assert.equal(login.response.status, 303, 'valid user should finish OAuth authorization');
    const redirected = new URL(login.location);
    assert.equal(redirected.origin + redirected.pathname, new URL(REDIRECT_URI).origin + new URL(REDIRECT_URI).pathname);
    assert.equal(redirected.searchParams.get('state'), auth.state, 'OAuth state should be returned unchanged');
    const tokenResult = await exchangeCode({ clientId, code: redirected.searchParams.get('code'), verifier: auth.verifier });
    assert.equal(tokenResult.response.status, 200, 'valid PKCE exchange should return tokens');
    assert.ok(tokenResult.body.access_token);
    return { ...tokenResult.body, authorization: auth };
  };

  return {
    oauthProvider,
    gateway,
    baseUrl,
    requestJson,
    registerClient,
    beginAuthorization,
    submitLogin,
    exchangeCode,
    authorizeAndGetToken,
    close: () => gateway.close(),
  };
}
