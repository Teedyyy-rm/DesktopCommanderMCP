# Kilo agent through Orca

Kilo is currently the only provider registered for Desktop Commander's provider-neutral [`local_agent_*` control API](./local-agent-control.md).

Start a coding task from ChatGPT Web:

```json
{
  "provider": "kilo",
  "repository_path": "/workspace/ornix-tts",
  "prompt": "Inspect the current changes, fix the failing focused test, and report the changed files and verification results."
}
```

Use `local_agent_list` to recover task IDs. Then poll `local_agent_status` and fetch the response with `local_agent_read_report`. Follow up on a completed session with `local_agent_send` using its `task_id`; read a previous turn with its `turn_id`. To stop an active task, use `local_agent_cancel`.

Kilo runs in an Orca-owned TUI terminal in the existing clean, synchronized `main` worktree. The adapter omits Kilo's `--worktree` flag, enables the previously selected `--auto` behavior, and allows one active Kilo task per repository. Status is derived from Kilo's structured session export, Orca terminal metadata, and Git workspace state. Reports are stored locally for 30 days; polling and report reads do not delete Kilo sessions.

The older `kilo_agent` MCP tool with `action: "start"` or `action: "status"` remains available for compatibility, but new clients should use `local_agent_*`. See the [provider architecture and OpenCode/Codex extension research](./local-agent-control.md).
