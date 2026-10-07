# Local coding agents through Orca

Desktop Commander exposes a provider-neutral MCP control surface for ChatGPT Web to start, track, continue, cancel, and read local coding-agent tasks through Orca. The MCP server owns task IDs and report retention. Orca owns agent terminals. Each provider adapter reads that provider's structured session state rather than scraping terminal screens.

## ChatGPT Web request path

```text
ChatGPT Web
  -> Remote Device MCP proxy
  -> Desktop Commander tools/list and tools/call
  -> local_agent_* provider-neutral API
  -> provider adapter
  -> Orca-owned terminal and provider-native session interface
  -> local task/report registry
```

The Remote Device proxy obtains the child server's tools dynamically through MCP `listTools()`. After an update, rebuild and restart the Remote Device child, then confirm the paired ChatGPT Web connector refreshes its tool list. A local `tools/list` result verifies only the local MCP surface; it does not prove ChatGPT Web has refreshed the remote tool cache or completed an end-to-end request.

## MCP tools

| Tool | Purpose |
| --- | --- |
| `local_agent_providers` | List registered providers and their implemented capabilities. |
| `local_agent_start` | Start a task with `provider`, prompt, and absolute Remote Device `repository_path`; returns a persistent `task_id`. |
| `local_agent_list` | Find recent tasks, including completed tasks with reports still retained. |
| `local_agent_status` | Refresh lifecycle state, activity phase, timestamps, session/terminal references, and the Git workspace snapshot. |
| `local_agent_read_report` | Read the current or a selected completed turn's final report. Reads are repeatable. |
| `local_agent_send` | Send a follow-up to the same task/session and return its new `turn_id`. Provider capability metadata defines whether it can steer an active turn or only start a follow-up after completion. |
| `local_agent_cancel` | Request provider cancellation and record a terminal state. |

Task status values are `starting`, `running`, `completed`, `failed`, `interrupted`, and `cancelled`. Status includes the source and last-observed time. The API does not invent percent-complete values, return model reasoning, or equate a missing report with successful completion. Provider session IDs, Orca terminal handles, phase/activity, report readiness, and repository changes remain distinct fields.

Current reports are stored in `~/.claude-server-commander/kilo-agent/tasks.json` with private permissions on POSIX systems. Prompts are not stored; only their SHA-256 fingerprints are retained for session matching. Final reports remain available for 30 days. `local_agent_status` and `local_agent_read_report` do not delete or close completed provider sessions.

## Current provider: Kilo

Kilo starts in the repository's existing clean, synchronized `main` worktree and runs in an Orca-owned TUI terminal. The provider never creates a nested Kilo or Orca worktree. Only one active task per repository is allowed because tasks edit the same checkout. Kilo starts with `--auto`, as previously selected for this workflow.

Kilo status is obtained from `kilo session list` and `kilo export <sessionID>` through short-lived Orca-owned helper terminals. The initial request is matched using a SHA-256 fingerprint, not stored prompt text. Status reports whether a provider session was found, whether Kilo is generating text or executing tools when the session export supports that distinction, and whether the Orca terminal is still alive. When those signals are unavailable, status stays `running` with an explicit last-observed timestamp and monitor error.

`local_agent_send` continues a completed Kilo session with `kilo --session <sessionID> --prompt <message>`. The same DCM `task_id` is kept and a new `turn_id` is returned. Kilo cannot be steered mid-generation through this TUI adapter. `local_agent_cancel` closes the Orca terminal and records `cancelled`; it does not revert files or delete the provider session.

The earlier `kilo_agent` tool remains available for compatibility. New clients should use the `local_agent_*` tools because those provide task discovery, read-only polling, stable report reads, and multi-turn IDs.

## Provider adapter contract

Each adapter is registered by a stable provider ID and implements the same normalized task operations: `start`, `list`, `status`, `readReport`, `send`, `cancel`, and `ownsTask`. It maps its provider's native IDs to DCM's persistent UUID `task_id` and optional `turn_id`. `status` must identify what it observed and preserve `unknown` when a provider has no structured signal. `readReport` returns only user-visible final response text, never reasoning. Unsupported operations are declared in `local_agent_providers` rather than being presented as working.

The provider registry in `src/tools/local-agent.ts` is the extension point. MCP tool names and their common fields should remain stable as adapters are added. Provider-specific details belong in adapter status fields, not in an OpenCode- or Codex-specific ChatGPT tool family.

### OpenCode adapter research

OpenCode exposes a headless HTTP server and OpenAPI schema. An adapter can launch `opencode serve` in an Orca-owned terminal rooted at the chosen repository, then use the local API for session creation, state, messages, asynchronous prompts, aborts, diffs, and the SSE event stream. The server supports health/version checks and HTTP basic authentication; bind to loopback, keep credentials local, and avoid exposing the control API to the network. Prefer structured API events over reading the TUI buffer. See the [OpenCode server API](https://dev.opencode.ai/docs/server/) and [CLI reference](https://dev.opencode.ai/docs/cli/).

### Codex CLI adapter research

Codex `app-server` offers the right session-oriented interface for an adapter: start/resume/list/read threads, start or steer turns, interrupt work, and consume lifecycle, item, message-delta, and tool-progress events. The adapter should pin/check the installed Codex version and generate or validate schemas against that version; the app-server protocol evolves and some methods or fields are experimental. The current docs list stdio JSONL and Unix-socket transports, plus a WebSocket transport. They explicitly flag the app-server command and WebSocket transport as experimental/unsupported for production workloads, so a Codex adapter needs a transport/version qualification gate before being advertised as enabled. For Orca ownership, run the app-server process in an Orca-owned terminal and connect over a local Unix socket or another qualified local transport; do not use terminal screen scraping as the RPC protocol. See the [Codex App Server documentation](https://learn.chatgpt.com/docs/app-server) and [Codex CLI reference](https://learn.chatgpt.com/docs/codex/cli).

## Qualification path for new adapters

1. Implement the provider adapter while preserving the `local_agent_*` contract.
2. Prove provider-native start, progress events, completion, error, report, follow-up, and cancellation behavior with a fake provider.
3. Prove the real provider can be launched/connected through Orca and that task state survives Desktop Commander restarts.
4. Rebuild the MCP server and verify all provider-neutral tools and schemas in `tools/list`.
5. Verify the Remote Device proxy returns the new tools, then exercise the actual ChatGPT Web → Remote Device → Orca flow. Mark this `UNVERIFIED` until the paired Web path succeeds.

The initial implementation registers Kilo only. OpenCode and Codex CLI are researched extension targets, not currently supported providers.
