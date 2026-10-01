import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createGatewayHarness } from './chatgpt-web-test-helpers.js';

async function waitForChildExit(pid, timeoutMs = 3000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if (error?.code === 'ESRCH') return;
      throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail(`stdio worker process ${pid} did not exit after its MCP session closed`);
}

async function waitFor(predicate, timeoutMs = 6000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail('Timed out waiting for the local stdio client to close.');
}

async function run() {
  const testHome = await mkdtemp(path.join(os.tmpdir(), 'dc-chatgpt-web-child-'));
  const previousHome = process.env.HOME;
  const previousTelemetrySetting = process.env.DESKTOP_COMMANDER_DISABLE_TELEMETRY;
  const originalClose = StdioClientTransport.prototype.close;
  const closedWorkerPids = [];
  let harness;
  let mcpClient;
  let upstreamCloseObserved = false;

  process.env.HOME = testHome;
  process.env.DESKTOP_COMMANDER_DISABLE_TELEMETRY = '1';
  StdioClientTransport.prototype.close = async function (...args) {
    const pid = this.pid;
    try {
      return await originalClose.apply(this, args);
    } finally {
      if (pid) closedWorkerPids.push(pid);
      upstreamCloseObserved = true;
    }
  };

  try {
    harness = await createGatewayHarness();
    const registration = await harness.registerClient();
    assert.equal(registration.response.status, 201);
    const tokens = await harness.authorizeAndGetToken(registration.body.client_id);

    const transport = new StreamableHTTPClientTransport(new URL('/mcp', harness.baseUrl), {
      requestInit: { headers: { Authorization: `Bearer ${tokens.access_token}` } },
    });
    mcpClient = new Client({ name: 'desktop-commander-stdio-child-test', version: '1.0.0' }, { capabilities: {} });
    await mcpClient.connect(transport);

    const tools = await mcpClient.listTools();
    assert.ok(tools.tools.length >= 20, 'the real Desktop Commander worker should expose the existing tool catalogue');
    assert.ok(tools.tools.some((tool) => tool.name === 'get_usage_stats'));
    const result = await mcpClient.callTool({ name: 'get_usage_stats', arguments: {} });
    assert.notEqual(result.isError, true, 'a safe, read-only sample tool should execute through the local stdio worker');

    await transport.terminateSession();
    await waitFor(() => upstreamCloseObserved);
    assert.equal(closedWorkerPids.length, 1, 'exactly one local stdio worker should serve this session');
    await waitForChildExit(closedWorkerPids[0]);

    console.log('✓ A real Desktop Commander stdio worker exposes tools, runs a read-only call, and exits when its HTTP MCP session closes');
  } finally {
    if (harness) await harness.close();
    if (mcpClient) await mcpClient.close().catch(() => undefined);
    StdioClientTransport.prototype.close = originalClose;
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousTelemetrySetting === undefined) delete process.env.DESKTOP_COMMANDER_DISABLE_TELEMETRY;
    else process.env.DESKTOP_COMMANDER_DISABLE_TELEMETRY = previousTelemetrySetting;
    await rm(testHome, { recursive: true, force: true });
  }
}

run().catch((error) => {
  console.error('✗ ChatGPT Web stdio child test failed:', error);
  process.exitCode = 1;
});
