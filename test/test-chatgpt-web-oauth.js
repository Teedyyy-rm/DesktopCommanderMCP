import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CHATGPT_WEB_SCOPE } from '../dist/chatgpt-web/oauth.js';
import { createGatewayHarness, REDIRECT_URI, RESOURCE_URL, TEST_ACCESS_KEY } from './chatgpt-web-test-helpers.js';

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function verifyClientRegistrationSurvivesRestart() {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'dc-chatgpt-web-clients-'));
  const clientStorePath = path.join(tempDir, 'oauth-clients.json');
  let firstGateway;
  let restartedGateway;

  try {
    firstGateway = await createGatewayHarness({ clientStorePath });
    const registration = await firstGateway.registerClient();
    assert.equal(registration.response.status, 201);
    const clientId = registration.body.client_id;
    await firstGateway.close();
    firstGateway = undefined;

    const storeMode = (await stat(clientStorePath)).mode & 0o777;
    assert.equal(storeMode, 0o600, 'persisted OAuth client metadata should be private to the gateway user');
    const storedClients = JSON.parse(await readFile(clientStorePath, 'utf8'));
    assert.equal(storedClients.length, 1);
    assert.equal(storedClients[0].client_id, clientId);

    restartedGateway = await createGatewayHarness({ clientStorePath });
    const resumedAuthorization = await restartedGateway.beginAuthorization({ clientId });
    assert.equal(resumedAuthorization.response.status, 200, 'the previous DCR client should remain valid after a gateway restart');
    assert.ok(resumedAuthorization.transaction);
  } finally {
    await firstGateway?.close();
    await restartedGateway?.close();
    await rm(tempDir, { recursive: true, force: true });
  }
}

async function run() {
  await verifyClientRegistrationSurvivesRestart();
  const harness = await createGatewayHarness({ accessTokenTtlSeconds: 1 });
  try {
    const protectedResource = await harness.requestJson('/.well-known/oauth-protected-resource/mcp');
    assert.equal(protectedResource.response.status, 200);
    assert.equal(protectedResource.body.resource, RESOURCE_URL.href);
    assert.deepEqual(protectedResource.body.authorization_servers, ['https://desktop-commander.test/']);

    const authMetadata = await harness.requestJson('/.well-known/oauth-authorization-server');
    assert.equal(authMetadata.response.status, 200);
    assert.deepEqual(authMetadata.body.code_challenge_methods_supported, ['S256']);
    assert.equal(authMetadata.body.registration_endpoint, 'https://desktop-commander.test/register');
    assert.deepEqual(authMetadata.body.scopes_supported, [CHATGPT_WEB_SCOPE]);

    const rejectedClient = await harness.registerClient(['https://attacker.example/oauth/callback']);
    assert.equal(rejectedClient.response.status, 400, 'untrusted DCR callback must be rejected');

    const registration = await harness.registerClient();
    assert.equal(registration.response.status, 201, 'ChatGPT public client callback should register');
    assert.equal(registration.body.token_endpoint_auth_method, 'none');
    assert.ok(registration.body.client_id);
    const clientId = registration.body.client_id;

    const unsupportedScope = await harness.beginAuthorization({ clientId, scope: 'desktop-commander.read' });
    assert.equal(unsupportedScope.response.status, 302);
    assert.equal(new URL(unsupportedScope.response.headers.get('location')).searchParams.get('error'), 'invalid_scope');

    const missingResource = await harness.beginAuthorization({ clientId, resource: 'https://other.example/mcp' });
    assert.equal(missingResource.response.status, 302);
    assert.equal(new URL(missingResource.response.headers.get('location')).searchParams.get('error'), 'invalid_target');

    const failedLoginFlow = await harness.beginAuthorization({ clientId });
    assert.equal(failedLoginFlow.response.status, 200);
    assert.match(
      failedLoginFlow.response.headers.get('content-security-policy'),
      /form-action 'self' https:\/\/chatgpt\.com/,
      'the sign-in form must allow its OAuth redirect to ChatGPT',
    );
    assert.match(failedLoginFlow.html, /Continue to ChatGPT/);
    assert.doesNotMatch(failedLoginFlow.html, /name="accessKey"/);
    assert.doesNotMatch(failedLoginFlow.html, /name="username"/);
    const failedLogin = await harness.submitLogin({
      transaction: failedLoginFlow.transaction,
      accessKey: 'wrong-key',
    });
    assert.equal(failedLogin.response.status, 401, 'incorrect access keys must be rejected');
    assert.match(failedLogin.text, /access key is incorrect/i);
    assert.match(failedLogin.text, /name="transaction"/);

    const noExpiryFlow = await harness.beginAuthorization({ clientId });
    assert.equal(noExpiryFlow.html.includes(TEST_ACCESS_KEY), false, 'the configured key must stay on the server');
    const realDateNow = Date.now;
    Date.now = () => realDateNow() + 11 * 60 * 1000;
    try {
      const defaultKeyLogin = await harness.submitLogin({ transaction: noExpiryFlow.transaction });
      assert.equal(defaultKeyLogin.response.status, 303, 'the configured default key should work without browser entry after ten minutes');
    } finally {
      Date.now = realDateNow;
    }

    const unknownTransaction = await harness.submitLogin({
      transaction: 'not-a-live-authorization-transaction',
      accessKey: TEST_ACCESS_KEY,
    });
    assert.equal(unknownTransaction.response.status, 400, 'an unknown transaction must not be revived by the configured key');
    assert.match(unknownTransaction.text, /no longer available/i);

    const authorization = failedLoginFlow;
    const login = await harness.submitLogin({ transaction: authorization.transaction, accessKey: TEST_ACCESS_KEY });
    assert.equal(login.response.status, 303);
    const replayedLogin = await harness.submitLogin({ transaction: authorization.transaction, accessKey: TEST_ACCESS_KEY });
    assert.equal(replayedLogin.response.status, 303, 'a repeated login submission should reuse the same callback during PKCE exchange');
    assert.equal(replayedLogin.location, login.location, 'a repeated login must not mint another authorization code');
    const redirect = new URL(login.location);
    assert.equal(redirect.origin + redirect.pathname, new URL(REDIRECT_URI).origin + new URL(REDIRECT_URI).pathname);
    assert.equal(redirect.searchParams.get('state'), authorization.state);
    const code = redirect.searchParams.get('code');
    assert.ok(code);

    const badPkce = await harness.exchangeCode({ clientId, code, verifier: 'not-the-original-verifier' });
    assert.equal(badPkce.response.status, 400, 'invalid PKCE verifier must be rejected');
    assert.equal(badPkce.body.error, 'invalid_grant');

    const unknownClient = await harness.exchangeCode({ clientId: 'unknown-client', code, verifier: authorization.verifier });
    assert.equal(unknownClient.response.status, 400, 'unknown OAuth client must be rejected');
    assert.equal(unknownClient.body.error, 'invalid_client');

    const wrongAudience = await harness.exchangeCode({
      clientId,
      code,
      verifier: authorization.verifier,
      resource: 'https://other.example/mcp',
    });
    assert.equal(wrongAudience.response.status, 400, 'token exchange for another audience must be rejected');
    assert.equal(wrongAudience.body.error, 'invalid_grant');

    const tokenResult = await harness.exchangeCode({ clientId, code, verifier: authorization.verifier });
    assert.equal(tokenResult.response.status, 200);
    assert.equal(tokenResult.body.token_type, 'Bearer');
    assert.equal(tokenResult.body.scope, CHATGPT_WEB_SCOPE);
    assert.ok(tokenResult.body.access_token);
    assert.ok(tokenResult.body.refresh_token);

    const completedLoginReplay = await harness.submitLogin({ transaction: authorization.transaction, accessKey: TEST_ACCESS_KEY });
    assert.equal(completedLoginReplay.response.status, 200, 'a repeated login after code exchange should report completion rather than fail as stale');
    assert.match(completedLoginReplay.text, /Authorization already completed/i);

    const missingBearer = await fetch(new URL('/mcp', harness.baseUrl));
    assert.equal(missingBearer.status, 401);
    assert.match(missingBearer.headers.get('www-authenticate'), /resource_metadata=/);

    const verifyAccessToken = harness.oauthProvider.verifyAccessToken.bind(harness.oauthProvider);
    harness.oauthProvider.verifyAccessToken = async (accessToken) => {
      if (accessToken === 'under-scoped-test-token') {
        return {
          token: accessToken,
          clientId,
          scopes: ['desktop-commander.read'],
          expiresAt: Math.floor(Date.now() / 1000) + 60,
          resource: RESOURCE_URL,
        };
      }
      return verifyAccessToken(accessToken);
    };
    const underScopedRequest = await fetch(new URL('/mcp', harness.baseUrl), {
      headers: { Authorization: 'Bearer under-scoped-test-token' },
    });
    assert.equal(underScopedRequest.status, 403, 'a valid token without the full-access scope must not reach MCP');

    await wait(1200);
    const expiredAccessToken = await fetch(new URL('/mcp', harness.baseUrl), {
      headers: { Authorization: `Bearer ${tokenResult.body.access_token}` },
    });
    assert.equal(expiredAccessToken.status, 401, 'expired bearer token must be rejected on the MCP route');

    console.log('✓ ChatGPT Web OAuth metadata, persistent DCR clients, callback allowlist, default env key, non-expiring one-use login, PKCE, audience, scope and token expiry checks passed');
  } finally {
    await harness.close();
  }
}

run().catch((error) => {
  console.error('✗ ChatGPT Web OAuth test failed:', error);
  process.exitCode = 1;
});
