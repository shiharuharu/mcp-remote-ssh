/**
 * exec.ts — ExecManager (shell + sentinel protocol)
 *
 * Manages long-lived shell sessions (no PTY) for command execution on
 * remote hosts. Each session is a persistent shell process where commands
 * share cwd, environment, and alias state.
 *
 * Uses a unique sentinel string to mark command boundaries in the output
 * stream, capturing exit code and post-command working directory.
 *
 * Key implementation details:
 * - Channel I/O is stream-based: write via channel.write(), read via
 *   channel.on('data'). No promise wrappers over channel operations.
 * - Each session is single-command — guarded by a `busy` flag.
 * - Timeout: Ctrl-C (0x03), wait 2s, then signal('KILL'), close channel.
 * - stdin: written before the command wrapper, terminated with 0x04 (EOF).
 */

import * as crypto from "node:crypto";
import { ClientChannel } from "ssh2";
import { ConnectionManager } from "./connection.js";
import {
  EXITED,
  TIMEOUT_TERMINATED,
  CONNECTION_LOST_DURING_RUN,
} from "../shared/errors.js";

// ─── Types ───────────────────────────────────────────────────────────────────

/**
 * A long-lived shell session on a remote host.
 *
 * Commands executed within a session share the same working directory,
 * environment variables, and shell aliases. Only one command may run
 * at a time within a session (guarded by the `busy` flag).
 */
export interface ExecSession {
  /** Unique identifier for this session (UUID). */
  sessionId: string;
  /** Host name configured in config.json. */
  host: string;
  /** ssh2 channel — a non-PTY shell process on the remote host. */
  channel: ClientChannel;
  /** Detected shell binary path (e.g., /bin/bash, /bin/zsh, /bin/sh). */
  shellPath: string;
  /** Current working directory on the remote host (absolute path). */
  cwd: string;
  /** Whether a command is currently executing in this session. */
  busy: boolean;
  /** Whether the SSH connection has been lost. */
  dead: boolean;
  /** Reason for the dead state (human-readable). */
  deadReason?: string;
}

/**
 * Result envelope returned from every exec() call.
 *
 * Carries exit metadata, timing, and captured output. The status field
 * uses the error taxonomy from shared/errors.ts for non-zero / timeout
 * outcomes, and "success" for exit code 0.
 */
export interface ExecResult {
  /** Outcome status — "success", "exited", "timeout_terminated", "busy", etc. */
  status: string;
  /** Process exit code. Only set when the command completed. */
  exitCode?: number;
  /** Signal name if the command was terminated by a signal. */
  signal?: string;
  /** True if the command was terminated due to timeout. */
  timedOut: boolean;
  /** True if the command was cancelled by the caller. */
  cancelled: boolean;
  /** True if output was truncated (timeout, size limit, etc.). */
  outputTruncated: boolean;
  /** Wall-clock duration of the command in milliseconds. */
  durationMs: number;
  /** Session ID this result belongs to. */
  sessionId: string;
  /** Captured command output and post-execution state. */
  data: {
    /** Merged stdout + stderr from the command. */
    stdout: string;
    /** Always empty — stderr is merged into stdout via 2>&1 in the wrapper. */
    stderr: string;
    /** Absolute current working directory after command completion. */
    cwd: string;
  };
}

// ─── Constants ───────────────────────────────────────────────────────────────

/**
 * Unique sentinel used to mark command boundaries in the output stream.
 * Chosen to avoid collisions with any reasonable command output.
 */
const SENTINEL = "__VIA_TOOL_SENTINEL_END__";

/** Regex matching the sentinel line: __VIA_TOOL_SENTINEL_END__:<exitCode>:<cwd> */
const SENTINEL_RE = new RegExp(`^${SENTINEL}:(-?\\d+):(.*)$`, "m");

/**
 * Distinct sentinel used during session initialization to read the initial
 * working directory. Kept separate from the exec sentinel to avoid
 * ambiguity during init.
 */
const CWD_SENTINEL = "__VIA_CWD_MARKER__";

/** Regex matching the cwd sentinel line: __VIA_CWD_MARKER__:<cwd> */
const CWD_SENTINEL_RE = new RegExp(`^${CWD_SENTINEL}:(.*)$`, "m");

/** Timeout for shell detection and cwd retrieval (milliseconds). */
const PROBE_TIMEOUT = 5000;

/** Delay between Ctrl-C and KILL signal during timeout handling (ms). */
const KILL_DELAY = 2000;

/**
 * Shell init commands injected at session start.
 * - pipefail: the shell's exit code is the last non-zero exit code in a pipeline
 */
const INIT_CMDS = "set -o pipefail\n";

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Build the command wrapper that surrounds a user command with sentinel
 * capture logic.
 *
 * The wrapper:
 *   1. Executes the command in a block, merging stderr into stdout
 *   2. Captures the exit code ($?) and post-command cwd ($(pwd))
 *   3. Echoes a sentinel line that the reader can parse
 *
 * @param command - The raw command string to execute.
 * @returns Full command string including sentinel capture.
 */
function buildWrapper(command: string): string {
  return (
    `{ ${command}; } 2>&1; ` +
    `__VIA_S__=$?; ` +
    `__VIA_D__=$(pwd); ` +
    `echo ${SENTINEL}:$__VIA_S__:$__VIA_D__\n`
  );
}

/**
 * Create an empty ExecResult with safe defaults.
 */
function emptyResult(sessionId: string, cwd: string, overrides: Partial<ExecResult> = {}): ExecResult {
  return {
    status: "success",
    exitCode: undefined,
    signal: undefined,
    timedOut: false,
    cancelled: false,
    outputTruncated: false,
    durationMs: 0,
    sessionId,
    data: { stdout: "", stderr: "", cwd },
    ...overrides,
  };
}

// ─── ExecManager ─────────────────────────────────────────────────────────────

export class ExecManager {
  /** Active sessions, keyed by session UUID. */
  private sessions: Map<string, ExecSession> = new Map();

  /** Reference to the shared connection pool. */
  private connectionManager: ConnectionManager;

  /**
   * @param connectionManager - The shared ConnectionManager instance providing
   *   SSH channel creation and client lifecycle.
   */
  constructor(connectionManager: ConnectionManager) {
    this.connectionManager = connectionManager;
  }

  // ─── Public API ──────────────────────────────────────────────────────────

  /**
   * Start a new long-lived shell session on the given host.
   *
   * Detects the available shell, opens a persistent shell channel, injects
   * init commands (pipefail, trace), and reads the initial working directory.
   *
   * @param host - The preset host name configured in config.json.
   * @returns A new ExecSession with a unique sessionId.
   * @throws {ConnectionError} If SSH connection or channel creation fails.
   */
  async sessionStart(host: string): Promise<ExecSession> {
    // 1. Detect shell via a temporary channel
    const shellPath = await this.detectShell(host);

    // 2. Open persistent shell channel
    const { channel } = await this.connectionManager.createShellChannel(host);

    // 3. Inject shell init commands (pipefail, trace, PS4)
    channel.write(INIT_CMDS);

    // 4. Retrieve initial working directory
    const cwd = await this.readCwd(channel);

    // 5. Create and store session
    const sessionId = crypto.randomUUID();
    const session: ExecSession = {
      sessionId,
      host,
      channel,
      shellPath,
      cwd,
      busy: false,
      dead: false,
    };

    // Register disconnect handler — SSH drop kills the shell session irrecoverably.
    this.connectionManager.onDisconnect(host, () => {
      session.dead = true;
      session.deadReason =
        `SSH connection to "${host}" lost. ` +
        `The bash session and its state (cwd, env, aliases) cannot be recovered. ` +
        `Reinitialize with exec_session_start.`;
    });

    this.sessions.set(sessionId, session);
    return session;
  }

  /**
   * Execute a command in an existing shell session.
   *
   * The command runs in the session's shell, inheriting its cwd, env, and
   * aliases. Only one command may run per session at a time — if the session
   * is busy, a result with status "busy" is returned immediately.
   *
   * @param sessionId - UUID of the target session (from sessionStart).
   * @param command  - The command string to execute.
   * @param opts     - Optional execution parameters.
   * @param opts.stdin   - Content to write to the command's stdin.
   * @param opts.timeout - Maximum execution time in milliseconds. On expiry
   *                       the command receives Ctrl-C, then SIGKILL after 2s.
   * @param opts.trace   - Whether to prepend an XML-like &lt;cmd&gt; tag to the
   *                       captured stdout for semantic isolation. Defaults to
   *                       true. Formatted locally — never sent to the shell.
   * @returns ExecResult with captured output, exit code, and updated cwd.
   */
  exec(
    sessionId: string,
    command: string,
    opts?: { stdin?: string; timeout?: number; trace?: boolean },
  ): Promise<ExecResult> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Session "${sessionId}" not found`);
    }

    // Guard: session is dead (SSH connection lost)
    if (session.dead) {
      throw new Error(session.deadReason ?? `SSH connection lost for session "${sessionId}"`);
    }

    // Guard: single-command concurrency
    if (session.busy) {
      return Promise.resolve(
        emptyResult(sessionId, session.cwd, { status: "busy" }),
      );
    }

    session.busy = true;
    const startTime = Date.now();
    const trace = opts?.trace ?? true;

    return new Promise<ExecResult>((resolve) => {
      const { channel } = session;

      let output = "";
      let resolved = false;
      let timeoutHandle: NodeJS.Timeout | undefined;
      let killHandle: NodeJS.Timeout | undefined;

      /**
       * Finalise the exec call — clean up listeners and timers, unset busy,
       * and resolve the promise with the given result.
       */
      const finish = (result: ExecResult) => {
        if (resolved) return;
        resolved = true;

        if (timeoutHandle) clearTimeout(timeoutHandle);
        if (killHandle) clearTimeout(killHandle);

        channel.removeAllListeners("data");
        channel.removeAllListeners("close");

        session.busy = false;
        resolve(result);
      };

      // ── Data handler ───────────────────────────────────────────────────

      const onData = (data: Buffer) => {
        output += data.toString("utf-8");

        const match = SENTINEL_RE.exec(output);
        if (!match) return;

        const exitCode = parseInt(match[1]!, 10);
        const cwd = match[2]!;

        // Find where the sentinel line starts in the buffer
        const sentinelStart = output.lastIndexOf(match[0]);

        // stdout is everything before the sentinel line
        const raw = output.slice(0, sentinelStart).trimEnd();
        const stdout = trace ? `<cmd>${command}</cmd>\n${raw}` : raw;

        // Update session state
        session.cwd = cwd;

        const status = exitCode === 0 ? "success" : EXITED;

        finish({
          status,
          exitCode,
          signal: undefined,
          timedOut: false,
          cancelled: false,
          outputTruncated: false,
          durationMs: Date.now() - startTime,
          sessionId,
          data: { stdout, stderr: "", cwd },
        });
      };

      channel.on("data", onData);

      // ── Channel close handler ──────────────────────────────────────────

      channel.on("close", () => {
        session.dead = true;
        session.deadReason =
          `SSH connection to "${session.host}" lost during command execution. ` +
          `The bash session and its state cannot be recovered. ` +
          `Reinitialize with exec_session_start.`;
        const raw = output;
        const stdout = trace ? `<cmd>${command}</cmd>\n${raw}` : raw;
        finish(
          emptyResult(sessionId, session.cwd, {
            status: CONNECTION_LOST_DURING_RUN,
            durationMs: Date.now() - startTime,
            data: {
              stdout,
              stderr: "",
              cwd: session.cwd,
            },
          }),
        );
      });

      // ── Write stdin (if provided) ──────────────────────────────────────

      if (opts?.stdin !== undefined && opts.stdin.length > 0) {
        channel.write(opts.stdin);
        // EOF marker — tells the shell no more stdin is coming
        channel.write("\x04");
      }

      // ── Write command ──────────────────────────────────────────────────
      channel.write(buildWrapper(command));

      // ── Timeout ────────────────────────────────────────────────────────

      if (opts?.timeout && opts.timeout > 0) {
        timeoutHandle = setTimeout(() => {
          // Step 1: Send Ctrl-C to interrupt the running command
          channel.write("\x03");

          // Step 2: Wait 2s, then force-kill the channel
          killHandle = setTimeout(() => {
            try {
              channel.signal("KILL");
            } catch {
              // Channel may already be closed — ignore
            }
            channel.close();

            finish(
              emptyResult(sessionId, session.cwd, {
                status: TIMEOUT_TERMINATED,
                timedOut: true,
                outputTruncated: true,
                durationMs: Date.now() - startTime,
                data: {
                  stdout: output,
                  stderr: "",
                  cwd: session.cwd,
                },
              }),
            );
          }, KILL_DELAY);
        }, opts.timeout);
      }
    });
  }

  /**
   * Close a session and release its resources.
   *
   * Closes the SSH channel, releases the client reference in the
   * connection pool, and removes the session from the internal map.
   * Safe to call on a non-existent session (no-op).
   *
   * @param sessionId - UUID of the session to close.
   */
  sessionClose(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    try {
      session.channel.close();
    } catch {
      // Channel may already be closed — ignore
    }

    this.connectionManager.releaseClient(session.host);
    this.sessions.delete(sessionId);
  }

  // ─── Private helpers ─────────────────────────────────────────────────────

  /**
   * Detect the available shell on the remote host.
   *
   * Opens a temporary shell channel, runs `which bash || which zsh || echo /bin/sh`,
   * reads the first line of output, then closes the channel and releases the client.
   *
   * @param host - The preset host name.
   * @returns Absolute path to the detected shell binary.
   */
  private detectShell(host: string): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      this.connectionManager
        .createShellChannel(host)
        .then(({ channel, client }) => {
          let buf = "";
          let settled = false;

          const finish = (shell: string) => {
            if (settled) return;
            settled = true;

            try {
              channel.close();
            } catch {
              // Ignore close errors
            }
            this.connectionManager.releaseClient(host);

            resolve(shell);
          };

          const fallback = setTimeout(() => finish("/bin/sh"), PROBE_TIMEOUT);

          channel.on("data", (data: Buffer) => {
            buf += data.toString("utf-8");

            // Extract the first non-empty line as the shell path
            const lines = buf.split("\n");
            for (const line of lines) {
              const trimmed = line.trim();
              if (trimmed.length > 0 && trimmed.startsWith("/")) {
                clearTimeout(fallback);
                finish(trimmed);
                return;
              }
            }
          });

          channel.on("close", () => {
            clearTimeout(fallback);
            finish("/bin/sh");
          });

          channel.stderr.on("data", () => {
            // Suppress stderr from failed `which` attempts
          });

          channel.write(
            "which bash 2>/dev/null || which zsh 2>/dev/null || echo /bin/sh\n",
          );
        })
        .catch(reject);
    });
  }

  /**
   * Read the current working directory from a shell channel.
   *
   * Writes `echo __VIA_CWD_MARKER__:$(pwd)` and waits for the sentinel
   * line to appear in the output stream.
   *
   * @param channel - An active non-PTY shell channel.
   * @returns Absolute path to the current working directory.
   */
  private readCwd(channel: ClientChannel): Promise<string> {
    return new Promise<string>((resolve) => {
      let buf = "";
      let settled = false;

      const fallback = setTimeout(() => {
        if (settled) return;
        settled = true;
        channel.removeAllListeners("data");
        resolve("/");
      }, PROBE_TIMEOUT);

      const onData = (data: Buffer) => {
        buf += data.toString("utf-8");

        const match = CWD_SENTINEL_RE.exec(buf);
        if (!match) return;

        if (settled) return;
        settled = true;

        clearTimeout(fallback);
        channel.removeAllListeners("data");

        const cwd = match[1] || "/";
        resolve(cwd);
      };

      channel.on("data", onData);
      channel.write(`echo ${CWD_SENTINEL}:$(pwd)\n`);
    });
  }
}
