/**
 * transport.ts — MCP stdio transport + tool registration
 *
 * Creates an MCP server using @modelcontextprotocol/sdk, registers all
 * 14 tools with their JSON input schemas, and connects via stdio.
 *
 * Tools are organised by prefix:
 *   host_*        → Host management (list, add, remove)
 *   exec_*        → Shell command execution (session start, exec, close)
 *   screen_*      → tmux terminal sessions (start, write, read, resize, interrupt, close)
 *   sftp_*        → File transfer (upload, download)
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { routeToolCall } from "./router.js";
import { toXml } from "./envelope.js";

// ─── Tool definitions ────────────────────────────────────────────────────────

/**
 * All 14 tools registered with the MCP server.
 *
 * Each tool has:
 * - `name`       — unique identifier, using `<prefix>_<action>` convention.
 * - `description` — human-readable summary shown to the LLM agent.
 * - `inputSchema` — JSON Schema for type-safe argument validation.
 */
const TOOLS = [
  // ═══ Host management ═══════════════════════════════════════════════════

  {
    name: "host_list",
    description:
      "List all configured SSH hosts. Returns name, host, port, username, and " +
      "private key path for each entry. Passwords are never returned.",
    inputSchema: {
      type: "object" as const,
      properties: {},
      required: [],
    },
  },

  {
    name: "host_add",
    description:
      "Add or update a named SSH host in the configuration. The connection object " +
      "must include host, username, and either privateKey or password.",
    inputSchema: {
      type: "object" as const,
      properties: {
        name: {
          type: "string",
          description: "Logical name for this host entry.",
        },
        connection: {
          type: "object",
          description:
            "SSH connection parameters (host, port, username, privateKey, password).",
          properties: {
            host: {
              type: "string",
              description: "IP address or hostname of the remote server.",
            },
            port: {
              type: "number",
              description: "SSH port. Defaults to 22.",
            },
            username: {
              type: "string",
              description: "SSH username for authentication.",
            },
            privateKey: {
              type: "string",
              description:
                "Path to SSH private key file. ~ is expanded automatically.",
            },
            password: {
              type: "string",
              description: "Password for SSH authentication (write-only).",
            },
          },
          required: ["host", "username"],
        },
      },
      required: ["name", "connection"],
    },
  },

  {
    name: "host_remove",
    description: "Remove a named SSH host from the configuration.",
    inputSchema: {
      type: "object" as const,
      properties: {
        name: {
          type: "string",
          description: "Logical name of the host to remove.",
        },
      },
      required: ["name"],
    },
  },

  // ═══ Exec sessions ═════════════════════════════════════════════════════

  {
    name: "exec_session_start",
    description:
      "Start a persistent shell session on a remote host. " +
      "Use this for non-interactive commands: file operations, system administration, " +
      "package management, logs, etc. NOT for interactive TUI programs (use screen_session_start for those). " +
      "The session shares cwd, env, and aliases across all exec calls within it. " +
      "Session lifecycle: start → exec (multiple) → close. " +
      "Returns session_id and initial working directory.",
    inputSchema: {
      type: "object" as const,
      properties: {
        host: {
          type: "string",
          description: "Logical host name configured in host_add.",
        },
        cwd: {
          type: "string",
          description:
            "Initial working directory (optional). Defaults to the remote home.",
        },
        trace: {
          type: "boolean",
          description:
            "Enable shell tracing (set -x) for Agent observability. Default: true.",
        },
      },
      required: ["host"],
    },
  },

  {
    name: "exec",
    description:
      "Execute a non-interactive command in an existing shell session. " +
      "Shell tracing (set -x + pipefail) is ON by default — every command step appears in stderr prefixed with '+'. " +
      "Use this for: file ops (ls, cat, mv, rm, chmod, mkdir), systemctl, apt/yum, git, docker, grep, awk, etc. " +
      "NOT for: vim, nano, top, htop, less, fzf, or any interactive TUI — use screen_session_start for those. " +
      "Commands share cwd/env/aliases across calls. Returns stdout, stderr, exit code, and post-command cwd (absolute path).",
    inputSchema: {
      type: "object" as const,
      properties: {
        session_id: {
          type: "string",
          description: "Session ID returned by exec_session_start.",
        },
        command: {
          type: "string",
          description: "The shell command to execute on the remote host.",
        },
        stdin: {
          type: "string",
          description: "Content to write to the command's stdin (optional).",
        },
        timeout: {
          type: "number",
          description:
            "Maximum execution time in milliseconds. On timeout the command " +
            "receives Ctrl-C, then SIGKILL after 2s (optional).",
        },
        trace: {
          type: "boolean",
          description:
            "Enable shell tracing (set -x) for this command. Default: true.",
        },
      },
      required: ["session_id", "command"],
    },
  },

  {
    name: "exec_session_close",
    description:
      "Close an exec session. Always close sessions when done — they hold SSH connections. " +
      "The session's shell state (cwd, env, aliases) is permanently lost.",
    inputSchema: {
      type: "object" as const,
      properties: {
        session_id: {
          type: "string",
          description: "Session ID to close.",
        },
      },
      required: ["session_id"],
    },
  },

  // ═══ Screen sessions ═══════════════════════════════════════════════════

  {
    name: "screen_session_start",
    description:
      "Start an interactive terminal session (tmux) on a remote host. " +
      "Use this for TUI programs: vim, nano, top, htop, less, fzf, python REPL, sudo prompts. " +
      "NOT for non-interactive commands — use exec_session_start for those. " +
      "Auto-detects and installs tmux if missing. Session persists across SSH disconnects. " +
      "Session lifecycle: start → write/read/resize/interrupt (multiple) → close.",
    inputSchema: {
      type: "object" as const,
      properties: {
        host: {
          type: "string",
          description: "Logical host name configured in host_add.",
        },
        cols: {
          type: "number",
          description: "Terminal columns. Default: 120.",
        },
        rows: {
          type: "number",
          description: "Terminal rows. Default: 90.",
        },
        term: {
          type: "string",
          description: "TERM environment variable. Default: xterm-256color.",
        },
      },
      required: ["host"],
    },
  },

  {
    name: "screen_session_write",
    description:
      "Send input to an interactive screen session. A trailing Enter is automatically appended. " +
      "After sending a command, wait 1-3 seconds, then use screen_session_read to see the result. " +
      "For TUI programs: send arrow keys, function keys, or 'q' to quit.",
    inputSchema: {
      type: "object" as const,
      properties: {
        session_id: {
          type: "string",
          description: "Session ID returned by screen_session_start.",
        },
        text: {
          type: "string",
          description: "The text to send (command or literal input).",
        },
      },
      required: ["session_id", "text"],
    },
  },

  {
    name: "screen_session_read",
    description:
      "Read the current terminal screen content (capture-pane). " +
      "Returns visible text rows × cols. Use after screen_session_write to see command output. " +
      "Default: plain text. format='ansi' preserves colors. " +
      "includeHistory=true reads scrollback (e.g., after a long build). " +
      "coordinates=true prepends a column ruler and line numbers for precise position reference.",
    inputSchema: {
      type: "object" as const,
      properties: {
        session_id: {
          type: "string",
          description: "Session ID returned by screen_session_start.",
        },
        format: {
          type: "string",
          enum: ["text", "ansi"],
          description:
            "Output format. 'text' strips ANSI escapes (default). " +
            "'ansi' preserves escape sequences.",
        },
        includeHistory: {
          type: "boolean",
          description:
            "Include scrollback history in the capture. Default: false.",
        },
        historyLines: {
          type: "number",
          description:
            "Number of history lines to include when includeHistory is true.",
        },
        coordinates: {
          type: "boolean",
          description:
            "Prepend column ruler and line numbers to enable precise " +
            "position referencing (e.g. 'line 5, column 30'). Default: false.",
        },
      },
      required: ["session_id"],
    },
  },

  {
    name: "screen_session_resize",
    description:
      "Resize the terminal dimensions of a screen session. Updates both " +
      "the tmux window size and the SSH PTY dimensions.",
    inputSchema: {
      type: "object" as const,
      properties: {
        session_id: {
          type: "string",
          description: "Session ID returned by screen_session_start.",
        },
        cols: {
          type: "number",
          description: "New column count.",
        },
        rows: {
          type: "number",
          description: "New row count.",
        },
      },
      required: ["session_id", "cols", "rows"],
    },
  },

  {
    name: "screen_session_interrupt",
    description:
      "Send Ctrl-C to the foreground process. Use to stop a running command " +
      "(e.g., cancel a long build, exit htop without 'q').",
    inputSchema: {
      type: "object" as const,
      properties: {
        session_id: {
          type: "string",
          description: "Session ID returned by screen_session_start.",
        },
      },
      required: ["session_id"],
    },
  },

  {
    name: "screen_session_close",
    description:
      "Close a screen session. Kills the tmux session, closes both SSH channels, " +
      "and releases the connection. Always close when done — tmux sessions hold resources.",
    inputSchema: {
      type: "object" as const,
      properties: {
        session_id: {
          type: "string",
          description: "Session ID to close.",
        },
      },
      required: ["session_id"],
    },
  },

  // ═══ SFTP transfer ═════════════════════════════════════════════════════

  {
    name: "sftp_upload",
    description:
      "Upload a LOCAL file or directory to a remote host. " +
      "Auto-detects file vs directory — single files use fastPut, directories use recursive uploadDir. " +
      "ONLY for cross-network transfer. For remote-side file operations " +
      "(ls, cat, mv, rm, chmod, mkdir), use exec with standard commands. " +
      "Creates a dedicated SFTP connection per transfer (stateless).",
    inputSchema: {
      type: "object" as const,
      properties: {
        host: {
          type: "string",
          description: "Logical host name configured in host_add.",
        },
        local_path: {
          type: "string",
          description: "Absolute path to the local file to upload.",
        },
        remote_path: {
          type: "string",
          description: "Absolute path on the remote host to write to.",
        },
      },
      required: ["host", "local_path", "remote_path"],
    },
  },

  {
    name: "sftp_download",
    description:
      "Download a REMOTE file or directory to the local machine. " +
      "Auto-detects file vs directory via stat — single files use fastGet, directories use recursive downloadDir. " +
      "ONLY for cross-network transfer. For reading remote file content " +
      "into context, use exec with cat/head/tail instead — much faster.",
    inputSchema: {
      type: "object" as const,
      properties: {
        host: {
          type: "string",
          description: "Logical host name configured in host_add.",
        },
        remote_path: {
          type: "string",
          description: "Absolute path on the remote host to read from.",
        },
        local_path: {
          type: "string",
          description: "Absolute local path to write the downloaded file to.",
        },
      },
      required: ["host", "remote_path", "local_path"],
    },
  },
];

// ─── Server creation ─────────────────────────────────────────────────────────

/**
 * Create and start the MCP server over stdio.
 *
 * This is the application entry point. It:
 * 1. Creates an MCP Server instance with tool capability.
 * 2. Registers the `tools/list` handler returning all 14 tool definitions.
 * 3. Registers the `tools/call` handler dispatching via routeToolCall().
 * 4. Connects the server to StdioServerTransport (stdin/stdout).
 */
export async function startServer(): Promise<void> {
  const server = new Server(
    { name: "mcp-remote-ssh", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );

  // ── tools/list handler ──────────────────────────────────────────────────

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return { tools: TOOLS };
  });

  // ── tools/call handler ──────────────────────────────────────────────────

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    const result = await routeToolCall(name, (args ?? {}) as Record<string, unknown>);

    // Check and strip the internal flag before serialisation.
    // _isMcpError is a transport-layer concern and should not be
    // exposed to the LLM agent via the text content.
    const raw = result as unknown as Record<string, unknown>;
    const isError = raw._isMcpError === true;
    delete raw._isMcpError;

    const text = toXml(result);

    return {
      content: [{ type: "text" as const, text }],
      isError: isError || undefined,
    };
  });

  // ── stdio transport ─────────────────────────────────────────────────────

  const transport = new StdioServerTransport();
  await server.connect(transport);

  // Log to stderr so it doesn't interfere with the MCP stdio protocol.
  console.error("mcp-remote-ssh MCP server started on stdio");
}
