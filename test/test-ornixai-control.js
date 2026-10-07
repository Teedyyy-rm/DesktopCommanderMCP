import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { chmod, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  executeZcodeControlRpc,
  handleZcodeControlTool,
  ZcodeControlError,
} from '../dist/tools/ornixai-control-client.js';
import {
  ZCODE_CONTROL_PROTOCOL_NAME,
  ZCODE_CONTROL_PROTOCOL_VERSION,
  ZcodeControlToolSchemas,
  zcodeControlMethod,
} from '../dist/tools/ornixai-control-schemas.js';

async function startFixture(version = ZCODE_CONTROL_PROTOCOL_VERSION, options = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'ornixai-control-test-'));
  const endpointPath = path.join(directory, 'control.sock');
  const credentialFilePath = path.join(directory, 'control.token');
  const token = 'a'.repeat(64);
  await writeFile(credentialFilePath, `${token}\n`, { mode: 0o600 });
  const requests = [];
  const server = createServer((socket) => {
    let buffer = '';
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      for (;;) {
        const index = buffer.indexOf('\n');
        if (index < 0) break;
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        const request = JSON.parse(line);
        requests.push(request);
        const result = request.method === `${ZCODE_CONTROL_PROTOCOL_NAME}/hello`
          ? { protocol_name: ZCODE_CONTROL_PROTOCOL_NAME, protocol_version: version, host_id: 'fixture-host' }
          : { online: true, request_id: request.params.request_id, ...(options.echoToken ? { credential: token } : {}) };
        socket.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result })}\n`);
      }
    });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(endpointPath, resolve);
  });
  if (process.platform !== 'win32') await chmod(endpointPath, options.endpointMode ?? 0o600);
  return {
    directory,
    endpointPath,
    credentialFilePath,
    requests,
    close: async () => {
      await new Promise((resolve) => server.close(resolve));
      await rm(directory, { recursive: true, force: true });
    },
  };
}

async function run() {
  assert.equal(ZcodeControlToolSchemas.zcode_task_start.safeParse({
    workspace_path: '/tmp/project', objective: 'build it', delivery: 'queue', idempotency_key: 'task-start-1234',
  }).success, true);
  assert.equal(ZcodeControlToolSchemas.zcode_task_start.safeParse({
    workspace_path: 'relative/project', objective: 'build it',
  }).success, false);
  assert.equal(ZcodeControlToolSchemas.zcode_task_start.safeParse({
    workspace_path: '/tmp/project', objective: 'build it',
  }).success, false, 'task start requires a caller-stable idempotency key');
  assert.equal(ZcodeControlToolSchemas.zcode_task_send.safeParse({
    session_id: 'session', message: 'continue',
  }).success, false, 'side-effecting follow-up requires an idempotency key');
  assert.equal(zcodeControlMethod('zcode_task_start'), 'ornix-zcode-control/v1/zcode_task_start');

  const fixture = await startFixture();
  try {
    const result = await executeZcodeControlRpc('zcode_runtime_status', {}, fixture);
    assert.deepEqual(result, { online: true, request_id: fixture.requests[1].params.request_id });
    assert.equal(fixture.requests.length, 2, 'protocol hello must precede the operation');
    assert.equal(fixture.requests[0].params.authorization.token, 'a'.repeat(64));
    assert.equal(fixture.requests[1].method, zcodeControlMethod('zcode_runtime_status'));
    assert.doesNotMatch(JSON.stringify(result), /a{32}/, 'credential must not appear in the MCP result');

    const previousEndpoint = process.env.ORNIXAI_CONTROL_ENDPOINT_PATH;
    const previousCredential = process.env.ORNIXAI_CONTROL_CREDENTIAL_FILE;
    process.env.ORNIXAI_CONTROL_ENDPOINT_PATH = fixture.endpointPath;
    process.env.ORNIXAI_CONTROL_CREDENTIAL_FILE = fixture.credentialFilePath;
    try {
      const envConfiguredResult = await executeZcodeControlRpc('zcode_runtime_status', {});
      assert.equal(envConfiguredResult.online, true, 'the renamed environment paths must configure the client');
      assert.equal(fixture.requests.length, 4);
    } finally {
      if (previousEndpoint === undefined) delete process.env.ORNIXAI_CONTROL_ENDPOINT_PATH;
      else process.env.ORNIXAI_CONTROL_ENDPOINT_PATH = previousEndpoint;
      if (previousCredential === undefined) delete process.env.ORNIXAI_CONTROL_CREDENTIAL_FILE;
      else process.env.ORNIXAI_CONTROL_CREDENTIAL_FILE = previousCredential;
    }
  } finally {
    await fixture.close();
  }

  const credentialEcho = await startFixture(ZCODE_CONTROL_PROTOCOL_VERSION, { echoToken: true });
  try {
    const result = await executeZcodeControlRpc('zcode_runtime_status', {}, credentialEcho);
    assert.equal(result.credential, '[REDACTED]', 'a credential echoed by the endpoint must not reach tool results');
  } finally {
    await credentialEcho.close();
  }

  if (process.platform !== 'win32') {
    const unprotectedEndpoint = await startFixture(ZCODE_CONTROL_PROTOCOL_VERSION, { endpointMode: 0o666 });
    try {
      await assert.rejects(
        executeZcodeControlRpc('zcode_runtime_status', {}, unprotectedEndpoint),
        (error) => error instanceof ZcodeControlError && error.code === 'POLICY_DENIED',
      );
      assert.equal(unprotectedEndpoint.requests.length, 0, 'do not send credentials to an unprotected socket');
    } finally {
      await unprotectedEndpoint.close();
    }

    const credentialDirectory = await mkdtemp(path.join(os.tmpdir(), 'ornixai-control-credential-test-'));
    const targetCredential = path.join(credentialDirectory, 'target.token');
    const linkCredential = path.join(credentialDirectory, 'link.token');
    await writeFile(targetCredential, `${'b'.repeat(64)}\n`, { mode: 0o600 });
    await symlink(targetCredential, linkCredential);
    try {
      await assert.rejects(
        executeZcodeControlRpc('zcode_runtime_status', {}, {
          endpointPath: path.join(credentialDirectory, 'control.sock'),
          credentialFilePath: linkCredential,
        }),
        (error) => error instanceof ZcodeControlError && error.code === 'POLICY_DENIED',
      );
    } finally {
      await rm(credentialDirectory, { recursive: true, force: true });
    }
  }

  const incompatible = await startFixture(99);
  try {
    await assert.rejects(
      executeZcodeControlRpc('zcode_runtime_status', {}, incompatible),
      (error) => error instanceof ZcodeControlError && error.code === 'PROTOCOL_VERSION_MISMATCH',
    );
    assert.equal(incompatible.requests.length, 1, 'no operation may be sent after a major-version mismatch');
  } finally {
    await incompatible.close();
  }

  await assert.rejects(
    executeZcodeControlRpc('zcode_runtime_status', {}, { credentialFilePath: '/missing/control-token' }),
    (error) => error instanceof ZcodeControlError && error.code === 'RUNTIME_UNAVAILABLE',
  );

  const offlineStatus = await handleZcodeControlTool('zcode_runtime_status', {});
  assert.equal(offlineStatus.isError, true);
  assert.equal(offlineStatus.structuredContent.error.code, 'RUNTIME_UNAVAILABLE',
    'offline Host must fail closed with a stable status code');
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
