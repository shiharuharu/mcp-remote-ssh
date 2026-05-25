# @shiharu/mcp-remote-ssh

SSH MCP Server — Remote shell operation primitives for AI agents.

```
npx @shiharu/mcp-remote-ssh
```

## Capabilities

| Family | Tools | Description |
|--------|-------|-------------|
| `host_*` | `list` `add` `remove` | Host inventory management; passwords are write-only |
| `exec_*` | `session_start` `exec` `close` | Long-lived shell sessions with shared cwd/env/alias and xtrace by default |
| `screen_*` | `start` `write` `read` `resize` `interrupt` `close` | tmux terminal sessions with TUI support (vim/htop) and reconnect capability |
| `sftp_*` | `upload` `download` | Stateless file transfer |

## Quick Start

### MCP Client Configuration

```json
{
  "mcpServers": {
    "remote-ssh": {
      "command": "npx",
      "args": ["@shiharu/mcp-remote-ssh"]
    }
  }
}
```

### Host Configuration

```json
// ~/.mcp-remote-ssh/config.json
{
  "version": 1,
  "hosts": {
    "prod": {
      "host": "10.0.0.1",
      "username": "root",
      "privateKey": "~/.ssh/id_rsa"
    }
  },
  "defaults": {
    "port": 22,
    "username": "root",
    "privateKey": "~/.ssh/id_rsa"
  }
}
```

Or add hosts via MCP tools:

```
host_add { "name": "prod", "connection": { "host": "10.0.0.1", "username": "root" } }
```

### Usage

```
Agent: exec_session_start { "host": "prod" }
Server: { "sessionId": "abc123", "cwd": "/root" }

Agent: exec { "session_id": "abc123", "command": "cd /var/log && ls" }
Server: { "status": "exited", "exitCode": 0, "data": { "cwd": "/var/log", "stdout": "..." } }

Agent: exec_session_close { "session_id": "abc123" }
```

## Architecture

```
MCP Transport (stdio)
  ├── Tool Router              → Prefix-based dispatch to managers
  └── Result Envelope           → Unified error classification (24 statuses) + isError policy

HostManager                     → config.json CRUD + XDG path resolution
ConnectionManager               → ssh2.Client pool + channel allocation + keepalive (10s)
ExecManager                     → Long-lived shell (no PTY) + sentinel protocol + cwd tracking
ScreenManager                   → Long-lived shell (PTY) + tmux + capture-pane
SftpManager                     → upload/download (stateless)
```

### SSH Keepalive & Disconnect Handling

- 10s interval x 3 missed pings → 30s disconnect detection
- Exec session disconnect → explicit error: "SSH connection lost, reinitialize with exec_session_start"
- Screen session disconnect → tmux session stays alive on remote; reconnect to recover

### Exec Session Model

Each command shares cwd/env/alias state. Defaults to `set -x` (xtrace) + `pipefail`.

```
Command wrapping: { cd /etc && ls; } 2>&1; echo __END__:$?:$(pwd)
Response:          stdout, exitCode, cwd (absolute path)
```

xtrace is on by default — AI agents prefer more context over less. Pass `trace: false` to disable.

## Development

```bash
npm install
npm run build   # tsc
npm start       # node dist/bin/cli.js
```

### Testing

```bash
# Start the MCP server directly (stdio)
node dist/bin/cli.js

# Or use MCP Inspector for interactive testing
npx @modelcontextprotocol/inspector node dist/bin/cli.js
```

## License

MIT
