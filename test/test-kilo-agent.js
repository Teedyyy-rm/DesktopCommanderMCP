import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  KiloAgentManager,
  buildKiloRunTerminalCommand,
  buildKiloTuiTerminalCommand,
  handleKiloAgent,
  parseKiloSessionExport,
  parseKiloSessionList,
  parseKiloTerminalOutput,
  resolveMainWorktreePath,
} from '../dist/tools/kilo-agent.js';
import {
  KiloAgentArgsSchema,
  LocalAgentListArgsSchema,
  LocalAgentCancelArgsSchema,
  LocalAgentReadReportArgsSchema,
  LocalAgentSendArgsSchema,
  LocalAgentStartArgsSchema,
  LocalAgentTaskArgsSchema,
} from '../dist/tools/schemas.js';
import { handleLocalAgentTool, mergeLocalAgentTaskLists } from '../dist/tools/local-agent.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TASK_IDS = [
  '00000000-0000-4000-8000-000000000001',
  '00000000-0000-4000-8000-000000000002',
  '00000000-0000-4000-8000-000000000003',
];

function jsonEvent(type, sessionID, part = undefined) {
  return JSON.stringify({ type, timestamp: 1, sessionID, ...(part ? { part } : {}) });
}

function completedOutput(sessionID, report, exitCode = 0) {
  return [
    jsonEvent('reasoning', sessionID, { type: 'reasoning', text: 'private reasoning must not be saved' }),
    jsonEvent('text', sessionID, { id: 'final-part', type: 'text', text: report, time: { end: 1 } }),
    `__DC_KILO_RUN_EXIT__${exitCode}`,
  ].join('\n');
}

function parseToolResult(result) {
  return JSON.parse(result.content[0].text);
}

class FakeOrca {
  constructor(root = ROOT) {
    this.root = root;
    this.calls = [];
    this.terminals = new Map();
    this.runs = [];
    this.sessions = [];
    this.exports = new Map();
    this.nextHandle = 1;
    this.failNextDeleteRead = false;
    this.failNextMetadataRead = false;
    this.metadataReadDelay = 0;
    this.stateFile = undefined;
    this.cwdValues = new Set();
    this.registered = true;
    this.failTuiCreate = false;
  }

  async invoke(args, timeoutMs, cwd) {
    this.calls.push({ args: [...args], timeoutMs, cwd });
    this.cwdValues.add(cwd);
    const command = args.slice(0, 2).join(' ');
    if (command === 'repo list') {
      return { ok: true, result: { repos: this.registered ? [{ id: 'repo-ornix', path: this.root }] : [] } };
    }
    if (command === 'repo add') {
      this.registered = true;
      return { ok: true, result: { id: 'repo-ornix', path: this.root } };
    }
    if (command === 'worktree list') {
      return { ok: true, result: { worktrees: [{ id: `repo-ornix::${this.root}`, path: this.root, isMainWorktree: true, branch: 'refs/heads/main' }] } };
    }
    if (command === 'terminal create') {
      const title = args[args.indexOf('--title') + 1];
      const terminalCommand = args[args.indexOf('--command') + 1];
      const handle = `terminal-${this.nextHandle++}`;
      if (title.startsWith('Delete Kilo session')) {
        this.terminals.set(handle, { kind: 'delete', title, output: '__DC_KILO_DELETE_EXIT__0' });
        if (this.stateFile) {
          const state = JSON.parse(await readFile(this.stateFile, 'utf8'));
          assert.ok(state.tasks.some((task) => task.report && task.session_cleanup === 'pending'), 'persist the old report before asking Orca to delete the Kilo session');
        }
      } else if (title.startsWith('Kilo session list')) {
        const output = `${JSON.stringify(this.sessions, null, 2)}\n__DC_KILO_METADATA_EXIT__0`;
        this.terminals.set(handle, { kind: 'metadata', title, output });
      } else if (title.startsWith('Kilo session export')) {
        const sessionId = [...this.exports.keys()].find((id) => terminalCommand.includes(id));
        const exported = sessionId ? this.exports.get(sessionId) : undefined;
        const output = `Exporting session: ${sessionId ?? 'missing'}\n${JSON.stringify(exported ?? {}, null, 2)}\n__DC_KILO_METADATA_EXIT__0`;
        this.terminals.set(handle, { kind: 'metadata', title, output });
      } else {
        if (this.failTuiCreate) return { ok: false, error: { code: 'terminal_failed', message: 'simulated Orca TUI terminal creation failure' } };
        assert.match(terminalCommand, /kilo --auto .*--prompt/i, 'Kilo must start or resume its TUI in an Orca-owned terminal');
        assert.doesNotMatch(terminalCommand, /--worktree/i, 'Kilo must open the existing main checkout without creating a nested worktree');
        assert.ok(terminalCommand.includes(this.root), 'Kilo TUI should start in the existing main checkout');
        const worktree = args[args.indexOf('--worktree') + 1];
        assert.equal(worktree, `id:repo-ornix::${this.root}`, 'Orca terminal should attach to the registered main worktree');
        const run = { handle, title, command: terminalCommand, worktree, complete: false };
        this.runs.push(run);
        this.terminals.set(handle, { kind: 'tui', title, run });
      }
      return { ok: true, result: { terminal: { handle } } };
    }
    if (command === 'terminal wait') {
      const timeout = args[args.indexOf('--timeout-ms') + 1];
      assert.match(timeout, /^\d+$/, 'Orca CLI timeout arguments must be plain decimal digits');
      const terminal = this.terminals.get(args[args.indexOf('--terminal') + 1]);
      if (terminal?.kind === 'delete' && this.failNextDeleteWait) {
        this.failNextDeleteWait = false;
        return { ok: false, error: { code: 'simulated_failure', message: 'temporary Orca terminal wait error' } };
      }
      return { ok: true, result: {} };
    }
    if (command === 'terminal read') {
      const terminal = this.terminals.get(args[args.indexOf('--terminal') + 1]);
      if (terminal?.kind === 'delete' && this.failNextDeleteRead) {
        this.failNextDeleteRead = false;
        return { ok: false, error: { code: 'simulated_failure', message: 'temporary Orca terminal read error' } };
      }
      if (terminal?.kind === 'metadata' && this.failNextMetadataRead) {
        this.failNextMetadataRead = false;
        return { ok: false, error: { code: 'temporary_read_error', message: 'temporary Orca terminal read error' } };
      }
      if (terminal?.kind === 'metadata') {
        terminal.readCount = (terminal.readCount ?? 0) + 1;
        if (terminal.readCount <= this.metadataReadDelay) {
          return { ok: true, result: { terminal: { status: 'running', tail: [] } } };
        }
      }
      const output = terminal?.output ?? '';
      return { ok: true, result: { terminal: { status: terminal?.kind === 'tui' ? 'running' : 'exited', tail: output ? output.split('\n') : [] } } };
    }
    if (command === 'terminal close') {
      const handle = args[args.indexOf('--terminal') + 1];
      this.calls.push({ closed: handle, title: this.terminals.get(handle)?.title });
      return { ok: true, result: {} };
    }
    return { ok: false, error: { code: 'unexpected', message: `Unexpected Orca command: ${args.join(' ')}` } };
  }

  completeTuiRun(index, sessionID, prompt, report, { finish = 'stop', created = Date.now() } = {}) {
    const run = this.runs[index];
    run.complete = true;
    this.sessions.unshift({ id: sessionID, directory: this.root, created });
    this.exports.set(sessionID, {
      info: { id: sessionID },
      messages: [
        { info: { role: 'user' }, parts: [{ type: 'text', text: prompt }] },
        { info: { role: 'assistant', time: { completed: created + 1 }, finish }, parts: [
          { type: 'reasoning', text: 'private reasoning must not be saved' },
          ...(report ? [{ type: 'text', text: report }] : []),
        ] },
      ],
    });
  }

  completeTuiFollowup(sessionID, firstPrompt, firstReport, nextPrompt, nextReport, { created = Date.now() } = {}) {
    this.exports.set(sessionID, {
      info: { id: sessionID },
      messages: [
        { info: { role: 'user' }, parts: [{ type: 'text', text: firstPrompt }] },
        { info: { role: 'assistant', time: { completed: created - 2 }, finish: 'stop' }, parts: [{ type: 'text', text: firstReport }] },
        { info: { role: 'user' }, parts: [{ type: 'text', text: nextPrompt }] },
        { info: { role: 'assistant', time: { completed: created + 1 }, finish: 'stop' }, parts: [
          { type: 'reasoning', text: 'follow-up reasoning must not be saved' },
          { type: 'text', text: nextReport },
        ] },
      ],
    });
  }
}

async function makeManager({ directory, cwd = ROOT, orca = new FakeOrca(), ids = [...TASK_IDS], now = () => Date.now(), isGitRepository = async () => true, assertMainCheckout = async () => {} } = {}) {
  const stateDirectory = directory ?? await mkdtemp(path.join(os.tmpdir(), 'dc-kilo-agent-'));
  const manager = new KiloAgentManager({
    cwd,
    stateDirectory,
    invokeOrca: orca.invoke.bind(orca),
    createId: () => ids.shift() ?? '00000000-0000-4000-8000-000000000099',
    now,
    isGitRepository,
    assertMainCheckout,
  });
  orca.stateFile = path.join(stateDirectory, 'tasks.json');
  return { manager, orca, stateDirectory };
}

async function waitFor(predicate, timeoutMs = 5_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail('Timed out waiting for MCP server response');
}

async function toolsListIncludesKiloAgent() {
  const server = spawn(process.execPath, [path.join(ROOT, 'dist', 'index.js')], { cwd: ROOT, stdio: ['pipe', 'pipe', 'pipe'] });
  const messages = [];
  const stderr = [];
  let buffer = '';
  server.stderr.setEncoding('utf8');
  server.stderr.on('data', (chunk) => stderr.push(chunk));
  server.stdout.setEncoding('utf8');
  server.stdout.on('data', (chunk) => {
    buffer += chunk;
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.trim()) continue;
      try { messages.push(JSON.parse(line)); } catch { /* ignore non-protocol noise */ }
    }
  });
  server.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'kilo-agent-test', version: '1' } } })}\n`);
  try {
    await waitFor(() => messages.some((message) => message.id === 1), 10_000).catch((error) => {
      error.message += `; stdout remainder=${buffer}; messages=${JSON.stringify(messages)}; stderr=${stderr.join('')}`;
      throw error;
    });
    server.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })}\n`);
    await waitFor(() => messages.some((message) => message.id === 2), 10_000);
    const response = messages.find((message) => message.id === 2);
    const tool = response.result.tools.find((candidate) => candidate.name === 'kilo_agent');
    assert.ok(tool, 'tools/list should publish kilo_agent');
    assert.match(tool.description, /through Orca/i);
    assert.match(tool.description, /Kilo TUI/i);
    assert.match(tool.description, /existing main worktree/i);
    assert.match(tool.description, /never creates a Git worktree/i);
    const schema = JSON.stringify(tool.inputSchema);
    for (const value of ['start', 'status', 'prompt', 'repository_path', 'task_id']) assert.ok(schema.includes(value), `tool schema should include ${value}`);
    assert.ok(tool.inputSchema.oneOf[0].required.includes('repository_path'), 'start must require an explicit target repository');

    const expectedAgentTools = [
      'local_agent_providers',
      'local_agent_start',
      'local_agent_list',
      'local_agent_status',
      'local_agent_read_report',
      'local_agent_send',
      'local_agent_cancel',
      'zcode_runtime_status',
      'zcode_workspace_list',
      'zcode_task_start',
      'zcode_task_list',
      'zcode_task_status',
      'zcode_task_send',
      'zcode_task_events',
      'zcode_task_report',
      'zcode_task_stop',
      'zcode_interaction_list',
      'zcode_interaction_respond',
    ];
    for (const name of expectedAgentTools) {
      assert.ok(response.result.tools.some((candidate) => candidate.name === name), `tools/list should publish ${name}`);
    }
    const statusTool = response.result.tools.find((candidate) => candidate.name === 'local_agent_status');
    assert.ok(statusTool.description.includes('canonical Zcode session'));
    const followupTool = response.result.tools.find((candidate) => candidate.name === 'local_agent_send');
    assert.ok(followupTool.description.includes('native queue admission'));

    server.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'local_agent_providers', arguments: {} } })}\n`);
    await waitFor(() => messages.some((message) => message.id === 3), 10_000);
    const providerCall = messages.find((message) => message.id === 3);
    assert.equal(providerCall.result.isError, undefined);
    assert.deepEqual(JSON.parse(providerCall.result.content[0].text).providers.map((provider) => provider.id), ['kilo', 'zcode']);

    server.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'local_agent_start', arguments: { provider: 'opencode', repository_path: ROOT, prompt: 'no side effects' } } })}\n`);
    await waitFor(() => messages.some((message) => message.id === 4), 10_000);
    const rejectedProvider = messages.find((message) => message.id === 4);
    assert.equal(rejectedProvider.result.isError, true, 'unregistered providers must fail through the MCP dispatcher');
  } finally {
    server.kill();
  }
}

async function run() {
  assert.equal(KiloAgentArgsSchema.safeParse({ action: 'start', repository_path: ROOT, prompt: '  do the task  ' }).success, true);
  assert.equal(KiloAgentArgsSchema.safeParse({ action: 'start', repository_path: 'Ornix-TTS', prompt: 'do the task' }).success, false);
  assert.equal(KiloAgentArgsSchema.safeParse({ action: 'start', prompt: 'do the task' }).success, false);
  assert.equal(KiloAgentArgsSchema.safeParse({ action: 'start', prompt: '  ' }).success, false);
  assert.equal(KiloAgentArgsSchema.safeParse({ action: 'status', task_id: 'not-a-uuid' }).success, false);
  assert.equal(LocalAgentStartArgsSchema.safeParse({ provider: 'kilo', repository_path: ROOT, prompt: 'task' }).success, true);
  assert.equal(LocalAgentStartArgsSchema.safeParse({ provider: 'kilo', repository_path: 'relative', prompt: 'task' }).success, false);
  assert.equal(LocalAgentStartArgsSchema.safeParse({ provider: 'zcode', repository_path: ROOT, prompt: 'task' }).success, false,
    'Zcode compatibility starts require a caller-stable idempotency key');
  assert.equal(LocalAgentStartArgsSchema.safeParse({ provider: 'zcode', repository_path: ROOT, prompt: 'task', idempotency_key: 'stable-start-key' }).success, true);
  assert.equal(LocalAgentListArgsSchema.safeParse({ provider: 'open-code' }).success, true);
  assert.equal(LocalAgentTaskArgsSchema.safeParse({ task_id: TASK_IDS[0] }).success, true);
  assert.equal(LocalAgentReadReportArgsSchema.safeParse({ task_id: TASK_IDS[0], turn_id: 'turn-2' }).success, true);
  assert.equal(LocalAgentReadReportArgsSchema.safeParse({ task_id: TASK_IDS[0], turn_id: 'bad-turn' }).success, false);
  assert.equal(LocalAgentSendArgsSchema.safeParse({ task_id: TASK_IDS[0], message: 'follow up' }).success, true);
  assert.equal(LocalAgentCancelArgsSchema.safeParse({ task_id: TASK_IDS[0] }).success, true,
    'Kilo cancellation keeps its existing input contract');
  const providers = parseToolResult(await handleLocalAgentTool('local_agent_providers', {}));
  assert.deepEqual(providers.providers.map((provider) => provider.id), ['kilo', 'zcode']);
  assert.equal(providers.providers[0].capabilities.send_semantics, 'after_turn');
  assert.equal(providers.providers[1].transport, 'ornix-zcode-control v1 over local OS IPC');
  assert.equal(providers.providers[1].capabilities.send_semantics, 'in_turn');
  const mergedTasks = mergeLocalAgentTaskLists([
    { provider: 'kilo', result: { content: [{ type: 'text', text: JSON.stringify({ tasks: [{ task_id: TASK_IDS[0], created_at: '2026-10-03T00:00:00.000Z' }] }) }] } },
    { provider: 'opencode', result: { content: [{ type: 'text', text: 'OpenCode server unavailable' }], isError: true } },
  ], 20);
  assert.deepEqual(mergedTasks.tasks.map((task) => task.task_id), [TASK_IDS[0]]);
  assert.deepEqual(mergedTasks.provider_errors, [{ provider: 'opencode', error: 'OpenCode server unavailable' }],
    'a provider failure must not look like an empty task list');
  assert.equal((await handleLocalAgentTool('local_agent_start', { provider: 'opencode', repository_path: ROOT, prompt: 'x' })).isError, true,
    'an unregistered future provider must fail clearly instead of falling back to Kilo');
  const invalidCall = await handleKiloAgent({ action: 'start', prompt: '' });
  assert.equal(invalidCall.isError, true, 'invalid input should return an MCP tool error');

  const parsed = parseKiloTerminalOutput([
    jsonEvent('reasoning', 'session-private', { type: 'reasoning', text: 'do not include' }),
    jsonEvent('text', 'session-private', { id: 'a', type: 'text', text: 'final answer', time: { end: 1 } }),
    jsonEvent('error', 'session-private', undefined),
    '__DC_KILO_RUN_EXIT__0',
  ].join('\n'));
  assert.equal(parsed.session_id, 'session-private');
  assert.equal(parsed.report, 'final answer');
  assert.doesNotMatch(JSON.stringify(parsed), /reasoning|do not include/);
  assert.equal(parsed.exit_code, 0);
  assert.equal(parseKiloTerminalOutput('__DC_KILO_RUN_EXIT__1').exit_code, 1);

  const sessionList = parseKiloSessionList(JSON.stringify([
    { id: 'session-new', directory: ROOT, created: 1_800_000_000_001 },
    { id: 'session-old', directory: ROOT },
  ]));
  assert.equal(sessionList[0].id, 'session-new');
  const sessionExport = parseKiloSessionExport(`Exporting session: session-new\n${JSON.stringify({
    info: { id: 'session-new' },
    messages: [
      { info: { role: 'user' }, parts: [{ type: 'text', text: 'prompt to fingerprint' }] },
      { info: { role: 'assistant', finish: 'tool-calls', time: { completed: 1 } }, parts: [{ type: 'reasoning', text: 'private reasoning' }] },
      { info: { role: 'assistant', finish: 'stop', time: { completed: 2 } }, parts: [
        { type: 'reasoning', text: 'private reasoning' },
        { type: 'text', text: 'final TUI response' },
      ] },
    ],
  })}`);
  assert.equal(sessionExport.session_id, 'session-new');
  assert.equal(sessionExport.completed, true);
  assert.equal(sessionExport.report, 'final TUI response');
  assert.ok(sessionExport.prompt_sha256);
  assert.doesNotMatch(JSON.stringify(sessionExport), /private reasoning/);
  const runningToolExport = parseKiloSessionExport(JSON.stringify({
    info: { id: 'session-running' },
    messages: [
      { info: { role: 'user' }, parts: [{ type: 'text', text: 'inspect this change' }] },
      { info: { role: 'assistant', finish: 'tool-calls', time: { completed: 3 } }, parts: [
        { type: 'reasoning', text: 'hidden reasoning' },
        { type: 'tool', tool: 'read_file' },
      ] },
    ],
  }));
  assert.equal(runningToolExport.completed, false);
  assert.equal(runningToolExport.activity_phase, 'executing_tools');
  assert.equal(runningToolExport.assistant_message_count, 1);
  assert.doesNotMatch(JSON.stringify(runningToolExport), /hidden reasoning|read_file/);
  const nextTurnPendingExport = parseKiloSessionExport(JSON.stringify({
    info: { id: 'session-multi-turn' },
    messages: [
      { info: { role: 'user' }, parts: [{ type: 'text', text: 'first prompt' }] },
      { info: { role: 'assistant', finish: 'stop', time: { completed: 4 } }, parts: [{ type: 'text', text: 'first answer' }] },
      { info: { role: 'user' }, parts: [{ type: 'text', text: 'follow-up prompt' }] },
    ],
  }));
  assert.equal(nextTurnPendingExport.completed, false, 'a completed earlier turn must not mark a pending follow-up done');
  assert.equal(nextTurnPendingExport.report, undefined);

  const command = buildKiloTuiTerminalCommand("inspect 'quoted' text; echo should-not-run", 'linux', ROOT);
  assert.match(command, /kilo --auto --prompt/);
  assert.doesNotMatch(command, /should-not-run'\s*;/, 'shell quoting should keep prompt punctuation inside the TUI prompt argument');
  assert.ok(command.includes(ROOT));
  assert.doesNotMatch(command, /--worktree/);
  const legacyCommand = buildKiloRunTerminalCommand('legacy session', 'linux');
  assert.match(legacyCommand, /kilo run --auto --format json --/);

  const nonGit = await makeManager({
    cwd: '/outside/repository',
    isGitRepository: async () => false,
  });
  const blocked = await nonGit.manager.start('do work');
  assert.equal(blocked.isError, true);
  assert.match(blocked.content[0].text, /inside a Git repository/);
  assert.equal(nonGit.orca.calls.length, 0, 'non-Git cwd should fail before invoking Orca');
  await rm(nonGit.stateDirectory, { recursive: true, force: true });

  const routeFixture = await mkdtemp(path.join(os.tmpdir(), 'dc-kilo-main-route-'));
  const routeMain = path.join(routeFixture, 'Ornix-TTS');
  const routeTaskWorktree = path.join(routeFixture, 'orca-task-worktree');
  await mkdir(routeMain, { recursive: true });
  execFileSync('git', ['init', '--quiet', '--initial-branch=main', routeMain]);
  execFileSync('git', ['config', 'user.name', 'Kilo route test'], { cwd: routeMain });
  execFileSync('git', ['config', 'user.email', 'kilo-route-test@example.invalid'], { cwd: routeMain });
  await writeFile(path.join(routeMain, 'README.md'), 'main checkout fixture\n');
  execFileSync('git', ['add', 'README.md'], { cwd: routeMain });
  execFileSync('git', ['commit', '--quiet', '-m', 'fixture'], { cwd: routeMain });
  execFileSync('git', ['worktree', 'add', '--quiet', '-b', 'agent-task', routeTaskWorktree], { cwd: routeMain });
  try {
    assert.equal(await resolveMainWorktreePath(routeTaskWorktree), routeMain, 'a task worktree path should resolve to its existing main checkout');
    const routeOrca = new FakeOrca(routeMain);
    const routeManager = await makeManager({ orca: routeOrca, assertMainCheckout: async () => {} });
    try {
      const started = parseToolResult(await routeManager.manager.start('route into main', routeTaskWorktree));
      assert.equal(started.status, 'running');
      assert.equal(started.worktree_path, routeMain);
      assert.equal(routeOrca.runs.length, 1);
      assert.ok(routeOrca.runs[0].command.includes(routeMain));
      assert.ok(!routeOrca.runs[0].command.includes(routeTaskWorktree));
      assert.deepEqual([...routeOrca.cwdValues], [routeMain], 'Orca commands should use the resolved main checkout');
    } finally {
      await rm(routeManager.stateDirectory, { recursive: true, force: true });
    }
  } finally {
    await rm(routeFixture, { recursive: true, force: true });
  }

  const dirtyMain = await makeManager({ assertMainCheckout: async () => { throw new Error('main checkout must be clean'); } });
  try {
    const blockedMain = await dirtyMain.manager.start('do not launch from dirty main');
    assert.equal(blockedMain.isError, true);
    assert.match(blockedMain.content[0].text, /main checkout must be clean/);
    assert.equal(dirtyMain.orca.calls.length, 0, 'main branch validation must happen before Orca is called');
  } finally {
    await rm(dirtyMain.stateDirectory, { recursive: true, force: true });
  }

  const launchFailureOrca = new FakeOrca();
  launchFailureOrca.failTuiCreate = true;
  const launchFailure = await makeManager({ orca: launchFailureOrca });
  try {
    const result = parseToolResult(await launchFailure.manager.start('cannot launch'));
    assert.equal(result.status, 'failed');
    assert.match(result.error, /simulated Orca TUI terminal creation failure/);
    assert.equal(launchFailureOrca.calls.some((call) => call.args?.[0] === 'worktree' && call.args?.[1] === 'create'), false);
  } finally {
    await rm(launchFailure.stateDirectory, { recursive: true, force: true });
  }

  const registerRepo = new FakeOrca();
  registerRepo.registered = false;
  const registration = await makeManager({ orca: registerRepo });
  try {
    const result = parseToolResult(await registration.manager.start('register then launch'));
    assert.equal(result.status, 'running');
    assert.ok(registerRepo.calls.some((call) => call.args?.join(' ').startsWith('repo add --path ')), 'an unregistered Remote Device repository should be added through Orca');
    assert.equal(registerRepo.runs.length, 1);
  } finally {
    await rm(registration.stateDirectory, { recursive: true, force: true });
  }

  const { manager, orca, stateDirectory } = await makeManager();
  try {
    orca.metadataReadDelay = 2;
    const first = parseToolResult(await manager.start('first prompt'));
    assert.equal(first.status, 'running');
    assert.equal(first.worktree_id, `repo-ornix::${ROOT}`);
    assert.equal(first.worktree_path, ROOT);
    assert.ok(first.terminal_handle);
    assert.deepEqual([...orca.cwdValues], [ROOT], 'Orca CLI calls should inherit the Remote Device working directory');
    assert.equal(orca.runs.length, 1);
    const metadataTerminal = [...orca.terminals.entries()].find(([, terminal]) => terminal.kind === 'metadata');
    assert.ok(metadataTerminal, 'Kilo session metadata should run in an Orca terminal');
    assert.equal(metadataTerminal[1].readCount, 3, 'poll Orca terminal output until the metadata completion marker appears');
    assert.equal(orca.calls.some((call) => call.args?.[0] === 'terminal' && call.args?.[1] === 'wait' && call.args.includes(metadataTerminal[0])), false,
      'metadata collection must not wait for the persistent Orca shell to exit');
    assert.equal(orca.calls.some((call) => call.args?.[0] === 'worktree' && call.args?.[1] === 'create'), false, 'a new Orca worktree must never be created');
    const secondWhileActive = await manager.start('second prompt');
    assert.equal(secondWhileActive.isError, true);
    assert.match(secondWhileActive.content[0].text, /still active in main/);
    assert.equal(orca.runs.length, 1, 'only one TUI agent may edit the main checkout at a time');

    const stillRunning = parseToolResult(await manager.status(first.task_id));
    assert.equal(stillRunning.status, 'running');
    assert.ok(orca.calls.some((call) => call.args?.[0] === 'terminal' && call.args?.[1] === 'read' && call.args.includes(first.terminal_handle)));
    assert.equal(orca.calls.some((call) => call.args?.[0] === 'terminal' && call.args?.[1] === 'wait' && call.args.includes(first.terminal_handle)), false,
      'status must poll session data without waiting for the persistent TUI terminal to exit');
    assert.equal(orca.calls.some((call) => call.args?.[0] === 'terminal' && call.args?.[1] === 'create' && call.args.includes('--title') && call.args[call.args.indexOf('--title') + 1]?.startsWith('Delete Kilo')), false);

    orca.failNextMetadataRead = true;
    const transientMonitorError = parseToolResult(await manager.status(first.task_id));
    assert.equal(transientMonitorError.status, 'running', 'a temporary Orca metadata read error must not mark a running Kilo task interrupted');
    assert.match(transientMonitorError.monitor_error, /temporary Orca terminal read error/);
    assert.equal(parseToolResult(await manager.status(first.task_id)).status, 'running', 'a later status call should retry the metadata read');

    orca.completeTuiRun(0, 'kilo-session-first', 'first prompt', 'first report');
    const firstCompleted = parseToolResult(await manager.status(first.task_id));
    assert.equal(firstCompleted.status, 'completed');
    assert.equal(firstCompleted.report, 'first report');
    const saved = await readFile(path.join(stateDirectory, 'tasks.json'), 'utf8');
    assert.doesNotMatch(saved, /first prompt|private reasoning/);
    assert.match(saved, /first report/);

    const second = parseToolResult(await manager.start('second prompt'));
    assert.equal(second.status, 'running');
    assert.equal(orca.runs.length, 2);
    assert.equal(parseToolResult(await manager.status(second.task_id)).status, 'running');
    orca.completeTuiRun(1, 'kilo-session-second', 'second prompt', 'second report');
    const secondCompleted = parseToolResult(await manager.status(second.task_id));
    assert.equal(secondCompleted.status, 'completed');
    assert.deepEqual(secondCompleted.superseded_reports.map((item) => item.report), ['first report']);
    assert.equal(secondCompleted.superseded_reports[0].cleanup_status, 'deleted');
    const calls = orca.calls;
    const firstTerminalCloseIndex = calls.findIndex((call) => call.closed === first.terminal_handle);
    const deleteCreateIndex = calls.findIndex((call) => call.args?.[0] === 'terminal' && call.args?.[1] === 'create' && call.args?.[call.args.indexOf('--title') + 1]?.startsWith('Delete Kilo session'));
    assert.ok(firstTerminalCloseIndex > -1 && deleteCreateIndex > firstTerminalCloseIndex, 'close the old TUI before Orca deletes its Kilo session');

    const repeated = parseToolResult(await manager.status(second.task_id));
    assert.deepEqual(repeated.superseded_reports.map((item) => item.report), ['first report'], 'retained reports should be returned by repeated status calls');
    assert.equal(repeated.superseded_reports[0].cleanup_status, 'deleted');
  } finally {
    await rm(stateDirectory, { recursive: true, force: true });
  }

  const failedRun = await makeManager();
  try {
    const launched = parseToolResult(await failedRun.manager.start('fail intentionally'));
    failedRun.orca.completeTuiRun(0, 'failed-session', 'fail intentionally', '');
    const status = parseToolResult(await failedRun.manager.status(launched.task_id));
    assert.equal(status.status, 'failed');
    assert.match(status.error, /without a final text report/);
  } finally {
    await rm(failedRun.stateDirectory, { recursive: true, force: true });
  }

  const conversation = await makeManager();
  try {
    const firstTurn = parseToolResult(await conversation.manager.start('first conversation turn'));
    conversation.orca.completeTuiRun(0, 'multi-turn-session', 'first conversation turn', 'first turn report');
    const completedFirstTurn = parseToolResult(await conversation.manager.inspect(firstTurn.task_id));
    assert.equal(completedFirstTurn.status, 'completed');
    assert.equal(completedFirstTurn.provider_session_id, 'multi-turn-session');
    assert.equal(completedFirstTurn.workspace.path, ROOT);
    assert.equal(completedFirstTurn.worktree_mode, 'main');
    assert.equal(completedFirstTurn.report_ready, true);
    assert.equal(conversation.orca.calls.some((call) => call.args?.[0] === 'terminal' && call.args?.[1] === 'create' && call.args[call.args.indexOf('--title') + 1]?.startsWith('Delete Kilo session')), false,
      'read-only generic status must not delete a provider session');

    const reportRead1 = parseToolResult(await conversation.manager.readReport(firstTurn.task_id));
    const reportRead2 = parseToolResult(await conversation.manager.readReport(firstTurn.task_id));
    assert.equal(reportRead1.report, 'first turn report');
    assert.equal(reportRead2.report, reportRead1.report, 'report reads should be idempotent');
    assert.equal(reportRead1.turn_id, 'turn-1');

    const followup = parseToolResult(await conversation.manager.send(firstTurn.task_id, 'second conversation turn'));
    assert.equal(followup.task_id, firstTurn.task_id, 'follow-up keeps the canonical task_id');
    assert.equal(followup.turn_id, 'turn-2');
    assert.equal(followup.status, 'running');
    assert.ok(conversation.orca.runs[1].command.includes('--session'));
    assert.ok(conversation.orca.runs[1].command.includes('multi-turn-session'));
    assert.doesNotMatch(conversation.orca.runs[1].command, /--worktree/);

    conversation.orca.completeTuiFollowup('multi-turn-session', 'first conversation turn', 'first turn report', 'second conversation turn', 'second turn report');
    const completedFollowup = parseToolResult(await conversation.manager.inspect(firstTurn.task_id));
    assert.equal(completedFollowup.status, 'completed');
    assert.equal(completedFollowup.report, 'second turn report');
    assert.deepEqual(completedFollowup.turns.map((turn) => turn.turn_id), ['turn-1', 'turn-2']);
    assert.deepEqual(completedFollowup.turns.map((turn) => turn.report_ready), [true, true]);
    assert.doesNotMatch(JSON.stringify(await readFile(path.join(conversation.stateDirectory, 'tasks.json'), 'utf8')), /follow-up reasoning/);
    assert.equal(parseToolResult(await conversation.manager.readReport(firstTurn.task_id, 'turn-1')).report, 'first turn report');
    assert.equal(parseToolResult(await conversation.manager.readReport(firstTurn.task_id, 'turn-2')).report, 'second turn report');

    const listed = parseToolResult(await conversation.manager.listTasks({ repositoryPath: ROOT, limit: 5 }));
    assert.equal(listed.tasks.length, 1);
    assert.equal(listed.tasks[0].task_id, firstTurn.task_id);
    assert.equal(listed.tasks[0].report_ready, true);

    const active = parseToolResult(await conversation.manager.start('cancel active session'));
    const cancelled = parseToolResult(await conversation.manager.cancel(active.task_id));
    assert.equal(cancelled.status, 'cancelled');
    const cancelledStatus = parseToolResult(await conversation.manager.inspect(active.task_id));
    assert.equal(cancelledStatus.status, 'cancelled');
    assert.equal(cancelledStatus.terminal_handle, undefined);
  } finally {
    await rm(conversation.stateDirectory, { recursive: true, force: true });
  }

  const retry = await makeManager({ ids: [...TASK_IDS] });
  try {
    const first = parseToolResult(await retry.manager.start('first'));
    retry.orca.completeTuiRun(0, 'retry-session', 'first', 'retry report');
    parseToolResult(await retry.manager.status(first.task_id));
    const second = parseToolResult(await retry.manager.start('second'));
    retry.orca.completeTuiRun(1, 'newer-session', 'second', 'newer report');
    retry.orca.failNextDeleteRead = true;
    const failedCleanup = parseToolResult(await retry.manager.status(second.task_id));
    assert.equal(failedCleanup.superseded_reports[0].cleanup_status, 'pending');
    assert.match(failedCleanup.superseded_reports[0].cleanup_error, /temporary Orca terminal read error/);
    const deleteTerminalCreatesAfterFailure = retry.orca.calls.filter((call) =>
      call.args?.[0] === 'terminal' && call.args?.[1] === 'create' && call.args[call.args.indexOf('--title') + 1]?.startsWith('Delete Kilo'),
    ).length;
    const retriedCleanup = parseToolResult(await retry.manager.status(second.task_id));
    assert.equal(retriedCleanup.superseded_reports[0].cleanup_status, 'deleted', 'the next status call should retry failed cleanup');
    const deleteTerminalCreatesAfterRetry = retry.orca.calls.filter((call) =>
      call.args?.[0] === 'terminal' && call.args?.[1] === 'create' && call.args[call.args.indexOf('--title') + 1]?.startsWith('Delete Kilo'),
    ).length;
    assert.equal(deleteTerminalCreatesAfterRetry, deleteTerminalCreatesAfterFailure, 'resume waiting in the existing Orca cleanup terminal instead of starting a duplicate');
  } finally {
    await rm(retry.stateDirectory, { recursive: true, force: true });
  }

  let now = 1_800_000_000_000;
  const expired = await makeManager({ now: () => now });
  try {
    const result = parseToolResult(await expired.manager.start('old task'));
    expired.orca.completeTuiRun(0, 'old-session', 'old task', 'old report', { created: now + 1 });
    parseToolResult(await expired.manager.status(result.task_id));
    now += 31 * 24 * 60 * 60 * 1000;
    const status = await expired.manager.status(result.task_id);
    assert.equal(status.isError, true, 'completed reports should expire after 30 days');
    assert.match(status.content[0].text, /Unknown or expired/);
    const saved = JSON.parse(await readFile(path.join(expired.stateDirectory, 'tasks.json'), 'utf8'));
    assert.equal(saved.tasks.length, 0);
  } finally {
    await rm(expired.stateDirectory, { recursive: true, force: true });
  }

  const sharedDirectory = await mkdtemp(path.join(os.tmpdir(), 'dc-kilo-agent-lock-'));
  const sharedOrca = new FakeOrca();
  const firstManager = await makeManager({ directory: sharedDirectory, orca: sharedOrca, ids: [TASK_IDS[0]] });
  const secondManager = await makeManager({ directory: sharedDirectory, orca: sharedOrca, ids: [TASK_IDS[1]] });
  try {
    const starts = await Promise.all([
      firstManager.manager.start('serialized prompt one'),
      secondManager.manager.start('serialized prompt two'),
    ]);
    assert.equal(starts.filter((result) => !result.isError).length, 1, 'independent MCP workers must serialize against the shared main checkout');
    assert.equal(sharedOrca.runs.length, 1, 'cross-process state locking must prevent duplicate TUI agents');
  } finally {
    await rm(sharedDirectory, { recursive: true, force: true });
  }

  await toolsListIncludesKiloAgent();
  console.log('✓ Kilo agent starts its TUI in the existing clean main worktree, serializes tasks, reports only final text, retries cleanup, and publishes a valid MCP tool');
}

run().catch((error) => {
  console.error('✗ Kilo agent test failed:', error);
  process.exitCode = 1;
});
