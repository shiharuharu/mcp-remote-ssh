# @shiharu/mcp-remote-ssh

SSH MCP Server — 为 AI Agent 提供远程 Shell 操作原语。

```
npx @shiharu/mcp-remote-ssh
```

## 能力

| 工具族 | 工具 | 说明 |
|--------|------|------|
| `host_*` | `list` `add` `remove` | 主机清单管理，密码只写不回显 |
| `exec_*` | `session_start` `exec` `close` | 长期 shell session，共享 cwd/env/alias，XML 输出 |
| `screen_*` | `start` `write` `read` `resize` `interrupt` `close` | tmux 终端 session，支持 TUI（vim/htop），断线可恢复 |
| `sftp_*` | `upload` `download` | 文件传输 |

## 快速开始

### 配置 MCP Client

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

### 配置主机

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

或通过 MCP 工具添加：

```
host_add { "name": "prod", "connection": { "host": "10.0.0.1", "username": "root" } }
```

### 使用

```
Agent: exec_session_start { "host": "prod" }
Server: { "sessionId": "abc123", "cwd": "/root" }

Agent: exec { "session_id": "abc123", "command": "cd /var/log && ls" }
Server: { "status": "exited", "exitCode": 0, "data": { "cwd": "/var/log", "stdout": "..." } }

Agent: exec_session_close { "session_id": "abc123" }
```

## 开发

```bash
npm install
npm run build   # tsc
npm start       # node dist/bin/cli.js
```

### 测试

```bash
# 直接启动 MCP server (stdio)
node dist/bin/cli.js

# 或使用 MCP Inspector 进行交互式调试
npx @modelcontextprotocol/inspector node dist/bin/cli.js
```

## 架构

```
MCP Transport (stdio)
  ├── Tool Router              → 按前缀路由到 Manager
  └── Result Envelope           → 统一错误分类 (24 状态) + isError 策略

HostManager                     → config.json CRUD + XDG 探测
ConnectionManager               → ssh2.Client 池 + channel 分配 + keepalive (10s)
ExecManager                     → 长期 shell (no PTY) + sentinel 协议 + cwd 追踪
ScreenManager                   → 长期 shell (PTY) + tmux + capture-pane
SftpManager                     → upload/download (无状态)
```

### SSH 保活 & 断线处理

- keepalive 10 秒间隔 × 3 次 → 30 秒检测断线
- Exec Session 断线 → 明确错误 "SSH connection lost, reinitialize with exec_session_start"
- Screen Session 断线 → tmux 绑定 PTY，SSH 断开自动清理

### Exec Session 模型

每条命令共享 cwd/env/alias 状态。默认 `pipefail`。

```
Shell:    set -o pipefail
包装:     { cd /etc && ls; } 2>&1; echo __VIA__:$?:$(pwd)
输出:     XML-like 文本，原生换行不转义，如：
          <result status="success" exitCode="0" durationMs="42">
            <cwd>/etc</cwd>
            <stdout>
          <cmd>ls</cmd>
          cron.d  hosts  resolv.conf
            </stdout>
          </result>
```

Trace 模式（默认）：在 stdout 前追加 `<cmd>` 标签做语义隔离。传 `trace: false` 关闭。

## License

MIT
