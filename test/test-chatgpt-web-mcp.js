import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createGatewayHarness } from './chatgpt-web-test-helpers.js';

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(predicate, timeoutMs = 3000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (predicate()) return;
    await wait(25);
  }
  assert.fail('Timed out waiting for MCP session cleanup.');
}

async function run() {
  let childStarts = 0;
  let childCloses = 0;
  const toolCallLogs = [];
  const harness = await createGatewayHarness({
    sessionIdleTimeoutMs: 1200,
    toolCallLogger: (event) => toolCallLogs.push(event),
    upstreamClientFactory: async () => {
      childStarts += 1;
      let closed = false;
      return {
        listTools: async () => ({
          tools: [
            { name: 'echo', description: 'Echo input', inputSchema: { type: 'object', properties: { text: { type: 'string' } } } },
            { name: 'tool_error', description: 'Return MCP tool error content', inputSchema: { type: 'object', properties: {} } },
            { name: 'throw_error', description: 'Simulate upstream JSON-RPC failure', inputSchema: { type: 'object', properties: {} } },
          ],
        }),
        callTool: async ({ name, arguments: args }) => {
          if (name === 'throw_error') throw new Error('simulated upstream failure');
          if (name === 'tool_error') return { isError: true, content: [{ type: 'text', text: 'expected tool error' }] };
          return { content: [{ type: 'text', text: `echo:${args?.text ?? ''}` }] };
        },
        listResources: async () => ({ resources: [{ uri: 'test://resource/1', name: 'test resource' }] }),
        readResource: async ({ uri }) => ({ contents: [{ uri, text: 'resource content' }] }),
        listResourceTemplates: async () => ({ resourceTemplates: [] }),
        listPrompts: async () => ({ prompts: [{ name: 'test_prompt', description: 'A test prompt' }] }),
        getPrompt: async () => ({ messages: [{ role: 'user', content: { type: 'text', text: 'prompt content' } }] }),
        close: async () => {
          if (closed) return;
          closed = true;
          childCloses += 1;
        },
      };
    },
  });

  const clients = [];
  try {
    const address = harness.gateway.httpServer.address();
    assert.equal(address.address, '127.0.0.1', 'gateway must bind IPv4 loopback only');
    assert.equal(address.port, harness.gateway.port);

    const health = await harness.requestJson('/healthz');
    assert.equal(health.response.status, 200, 'gateway health endpoint should be available without OAuth');
    assert.deepEqual(health.body, { status: 'ok', service: 'desktop-commander-chatgpt-web' });

    const preflight = await fetch(new URL('/mcp', harness.baseUrl), {
      method: 'OPTIONS',
      headers: {
        Origin: 'https://inspector.example',
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'authorization,content-type,mcp-session-id',
      },
    });
    assert.equal(preflight.status, 204, 'browser MCP preflight should be accepted');
    assert.match(preflight.headers.get('access-control-allow-headers'), /Authorization/i);

    const unauthorizedInit = await fetch(new URL('/mcp', harness.baseUrl), {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'test', version: '1' } } }),
    });
    assert.equal(unauthorizedInit.status, 401, 'unauthenticated MCP initialization must be rejected');
    assert.equal(childStarts, 0, 'unauthenticated requests must not spawn a Desktop Commander child');

    const registration = await harness.registerClient();
    assert.equal(registration.response.status, 201);
    const tokens = await harness.authorizeAndGetToken(registration.body.client_id);

    const connectMcpClient = async () => {
      const transport = new StreamableHTTPClientTransport(new URL('/mcp', harness.baseUrl), {
        requestInit: { headers: { Authorization: `Bearer ${tokens.access_token}` } },
      });
      const client = new Client({ name: 'mcp-inspector-test', version: '1.0.0' }, { capabilities: {} });
      await client.connect(transport);
      clients.push({ client, transport });
      return { client, transport };
    };

    const first = await connectMcpClient();
    const tools = await first.client.listTools();
    assert.deepEqual(tools.tools.map((tool) => tool.name), ['echo', 'tool_error', 'throw_error']);
    const echo = await first.client.callTool({ name: 'echo', arguments: { text: 'hello' } });
    assert.equal(echo.content[0].text, 'echo:hello');
    const toolError = await first.client.callTool({ name: 'tool_error', arguments: {} });
    assert.equal(toolError.isError, true, 'tool error results should remain tool results, not transport failures');
    assert.equal(toolError.content[0].text, 'expected tool error');
    await assert.rejects(
      () => first.client.callTool({ name: 'throw_error', arguments: {} }),
      (error) => error instanceof Error,
      'upstream JSON-RPC errors should be returned as MCP request failures',
    );
    assert.deepEqual(toolCallLogs.map(({ phase, tool, status }) => ({ phase, tool, status })), [
      { phase: 'started', tool: 'echo', status: undefined },
      { phase: 'completed', tool: 'echo', status: 'ok' },
      { phase: 'started', tool: 'tool_error', status: undefined },
      { phase: 'completed', tool: 'tool_error', status: 'tool_error' },
      { phase: 'started', tool: 'throw_error', status: undefined },
      { phase: 'completed', tool: 'throw_error', status: 'failed' },
    ], 'tool-call logs should show start and outcome for normal, tool-level and transport errors');
    assert.ok(toolCallLogs.filter((event) => event.phase === 'completed').every((event) => event.durationMs >= 0));
    assert.equal(JSON.stringify(toolCallLogs).includes('hello'), false, 'tool arguments and results must not be logged');

    const resources = await first.client.listResources();
    assert.equal(resources.resources[0].uri, 'test://resource/1');
    const resource = await first.client.readResource({ uri: 'test://resource/1' });
    assert.equal(resource.contents[0].text, 'resource content');
    const prompts = await first.client.listPrompts();
    assert.equal(prompts.prompts[0].name, 'test_prompt');
    const prompt = await first.client.getPrompt({ name: 'test_prompt', arguments: {} });
    assert.equal(prompt.messages[0].content.text, 'prompt content');

    const second = await connectMcpClient();
    assert.notEqual(first.transport.sessionId, second.transport.sessionId, 'each initialization must have a unique MCP session');
    assert.equal(childStarts, 2, 'each MCP session must start its own stdio child');

    await first.transport.terminateSession();
    await waitFor(() => childCloses === 1);
    await second.transport.terminateSession();
    await waitFor(() => childCloses === 2);

    const expiring = await connectMcpClient();
    assert.equal(childStarts, 3);
    await waitFor(() => childCloses === 3, 3500);
    assert.ok(expiring.transport.sessionId, 'the idle test session was initialized before cleanup');

    await connectMcpClient();
    assert.equal(childStarts, 4);
    await harness.close();
    await waitFor(() => childCloses === 4);

    console.log('✓ Streamable HTTP initialize, health endpoint, tool-call observability, tool/resource/prompt proxy, errors, CORS, per-session child cleanup, idle expiry, shutdown cleanup and loopback binding passed');
  } finally {
    for (const { client } of clients) await client.close().catch(() => undefined);
    await harness.close();
  }

  let capacityChildStarts = 0;
  let capacityChildCloses = 0;
  const capacityHarness = await createGatewayHarness({
    sessionIdleTimeoutMs: 30_000,
    upstreamClientFactory: async () => {
      capacityChildStarts += 1;
      let closed = false;
      return {
        listTools: async () => ({
          tools: [
            { name: 'echo', description: 'Echo input', inputSchema: { type: 'object', properties: { text: { type: 'string' } } } },
          ],
        }),
        callTool: async ({ arguments: args }) => ({ content: [{ type: 'text', text: `echo:${args?.text ?? ''}` }] }),
        listResources: async () => ({ resources: [] }),
        readResource: async () => ({ contents: [] }),
        listResourceTemplates: async () => ({ resourceTemplates: [] }),
        listPrompts: async () => ({ prompts: [] }),
        getPrompt: async () => ({ messages: [] }),
        close: async () => {
          if (closed) return;
          closed = true;
          capacityChildCloses += 1;
        },
      };
    },
  });
  const capacityClients = [];
  try {
    const registration = await capacityHarness.registerClient();
    const tokens = await capacityHarness.authorizeAndGetToken(registration.body.client_id);
    const connectMcpClient = async () => {
      const transport = new StreamableHTTPClientTransport(new URL('/mcp', capacityHarness.baseUrl), {
        requestInit: { headers: { Authorization: `Bearer ${tokens.access_token}` } },
      });
      const client = new Client({ name: 'mcp-capacity-test', version: '1.0.0' }, { capabilities: {} });
      await client.connect(transport);
      capacityClients.push({ client, transport });
      return { client, transport };
    };

    const oldest = await connectMcpClient();
    const nextOldest = await connectMcpClient();
    await wait(10);
    await oldest.client.listTools();
    for (let index = 0; index < 14; index += 1) await connectMcpClient();
    assert.equal(capacityChildStarts, 16, 'the gateway should admit its configured maximum session count');

    const newest = await connectMcpClient();
    assert.equal(capacityChildStarts, 17, 'a new MCP session should still be admitted at capacity');
    assert.equal(capacityChildCloses, 1, 'admitting a session at capacity should close one idle child');
    assert.equal((await oldest.client.callTool({ name: 'echo', arguments: { text: 'retained' } })).content[0].text, 'echo:retained', 'the recently used session should remain active');
    await assert.rejects(() => nextOldest.client.listTools(), Error, 'the least recently used idle session should be evicted');
    assert.deepEqual((await newest.client.listTools()).tools.map((tool) => tool.name), ['echo']);

    await capacityHarness.close();
    assert.equal(capacityChildCloses, capacityChildStarts, 'gateway shutdown should close every remaining child');
    console.log('✓ MCP session-capacity admission evicts the least recently used idle child and retains active sessions');
  } finally {
    for (const { client } of capacityClients) await client.close().catch(() => undefined);
    await capacityHarness.close();
  }
}

run().catch((error) => {
  console.error('✗ ChatGPT Web MCP gateway test failed:', error);
  process.exitCode = 1;
});
