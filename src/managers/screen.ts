/**
 * screen.ts — ScreenManager (tmux + PTY)
 *
 * Manages tmux-based terminal sessions with PTY allocation for interactive
 * terminal screen reading. Each session creates a tmux session on the remote
 * host, sends keys via `send-keys`, reads the visible screen via `capture-pane`,
 * and supports resize, interrupt, and reconnection after SSH disconnection.
 *
 * Key implementation details:
 * - Channel I/O is stream-based: write via channel.write(), read by collecting
 *   channel.on('data') chunks. Promise wrappers with timeouts are used for
 *   reading command output.
 * - tmux session names use `mcp_<uuid>` format to avoid collisions.
 * - Auto-install tmux if not present on the remote host (apt/yum/apk/pacman).
 * - capture-pane uses start/end markers to delimit captured content in the
 *   merged PTY output stream.
 */

import * as crypto from "node:crypto";
import { ClientChannel } from "ssh2";
import { ConnectionManager } from "./connection.js";
import {
  TMUX_REQUIRED,
  TMUX_INSTALL_FAILED,
} from "../shared/errors.js";

// ─── Types ───────────────────────────────────────────────────────────────────

/**
 * A tmux-backed terminal session on a remote host.
 *
 * Each session wraps a PTY shell channel that hosts a tmux session.
 * Commands are sent via `tmux send-keys` and the screen is read via
 * `tmux capture-pane`.
 */
export interface ScreenSession {
  /** Unique identifier for this session (UUID). */
  sessionId: string;
  /** Host name configured in config.json. */
  host: string;
  /** tmux session name on the remote: `mcp_<uuid>`. */
  tmuxSession: string;
  /** ssh2 PTY channel — tmux is bound to this via `exec tmux`, dies with SSH. */
  channel: ClientChannel;
  /** ssh2 non-PTY shell channel for tmux management commands (no echo). */
  mgmtChannel: ClientChannel;
  /** Terminal columns. */
  cols: number;
  /** Terminal rows. */
  rows: number;
  /** TERM environment variable value. */
  term: string;
  /** Whether the PTY connection (and thus tmux) has been lost. */
  dead: boolean;
  /** Reason for the dead state (human-readable). */
  deadReason?: string;
}

/**
 * A screen snapshot captured from a tmux session via `capture-pane`.
 *
 * Contains the visible screen content (plain text by default, optionally
 * with ANSI escape sequences) along with terminal geometry and a monotonic
 * sequence counter so callers can detect state changes.
 */
export interface ScreenSnapshot {
  /** Number of rows in the snapshot. */
  rows: number;
  /** Number of columns in the snapshot. */
  cols: number;
  /** Plain-text screen content (ANSI escape sequences stripped by tmux). */
  text: string;
  /** ANSI-annotated screen content (only set when format="ansi"). */
  ansi?: string;
  /** Whether the capture came from the alternate screen buffer. */
  alternateScreen: boolean;
  /** Monotonic counter — increments on each read() call. */
  sequence: number;
}

// ─── Constants ───────────────────────────────────────────────────────────────

/** Default terminal dimensions. */
const DEFAULT_COLS = 120;
const DEFAULT_ROWS = 90;
const DEFAULT_TERM = "xterm-256color";

/** Prefix for tmux session names on the remote host. */
const TMUX_SESSION_PREFIX = "mcp_";

/** Markers used to delimit capture-pane output in the PTY stream. */
const SNAP_START = "__SNAP_START__";
const SNAP_END = "__SNAP_END__";

/** Markers for shell command output parsing during auto-install. */
const CMD_MARKER = "__CMD_DONE__";

/** Timeouts in milliseconds. */
const PROBE_TIMEOUT = 5000;
const INSTALL_TIMEOUT = 30000;
const READ_TIMEOUT = 10000;

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Read data from a channel until a marker string appears, or until a timeout.
 *
 * Returns the full accumulated buffer. The caller is responsible for
 * extracting the relevant content before/after/between markers.
 *
 * @param channel  - The ssh2 channel to read from.
 * @param marker   - String that signals completion.
 * @param timeout  - Maximum wait time in milliseconds.
 * @returns The accumulated output as a UTF-8 string.
 */
function readUntilMarker(
  channel: ClientChannel,
  marker: string,
  timeout: number,
): Promise<string> {
  return new Promise<string>((resolve) => {
    let buf = "";
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      channel.removeAllListeners("data");
      resolve(buf);
    }, timeout);

    const onData = (data: Buffer) => {
      buf += data.toString("utf-8");

      if (buf.includes(marker)) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        channel.removeAllListeners("data");
        resolve(buf);
      }
    };

    channel.on("data", onData);
  });
}

/**
 * Write a shell command to a channel, wait for a completion marker, then
 * return the accumulated output.
 *
 * Used during auto-install and verification steps where we run one command
 * at a time and need to know when it has completed.
 *
 * The command is appended with `; echo '<marker>'` so the marker appears
 * as a standalone line in the output when the command finishes.
 *
 * @param channel - The ssh2 channel to write to and read from.
 * @param command - The shell command to execute.
 * @param marker  - Unique string to watch for in output.
 * @param timeout - Maximum wait time in milliseconds.
 * @returns The full output buffer (including marker line).
 */
function execChannelCommand(
  channel: ClientChannel,
  command: string,
  marker: string,
  timeout: number,
): Promise<string> {
  const fullCmd = `${command}; echo '${marker}'\n`;
  channel.write(fullCmd);
  return readUntilMarker(channel, marker, timeout);
}

/**
 * Detect whether tmux is installed on the remote host by running
 * `which tmux` or `command -v tmux` through a temp shell channel.
 *
 * @param channel - An active non-PTY shell channel.
 * @returns `true` if tmux was found (output contained a path starting with `/`).
 */
async function detectTmux(channel: ClientChannel): Promise<boolean> {
  const output = await execChannelCommand(
    channel,
    "which tmux 2>/dev/null || command -v tmux 2>/dev/null",
    CMD_MARKER,
    PROBE_TIMEOUT,
  );

  // The output of `which tmux` should be a path like /usr/bin/tmux
  // If tmux is not found, which/command produces no stdout.
  return /\/tmux/m.test(output);
}

/**
 * Detect the remote package manager by probing common binaries.
 *
 * Returns one of "apt", "yum", "apk", "pacman", or "none".
 *
 * @param channel - An active non-PTY shell channel.
 * @returns The detected package manager identifier.
 */
async function detectPackageManager(channel: ClientChannel): Promise<string> {
  const output = await execChannelCommand(
    channel,
    "which apt-get && echo PKG:apt || " +
      "which yum && echo PKG:yum || " +
      "which apk && echo PKG:apk || " +
      "which pacman && echo PKG:pacman || " +
      "echo PKG:none",
    CMD_MARKER,
    PROBE_TIMEOUT,
  );

  const match = /PKG:(apt|yum|apk|pacman|none)/.exec(output);
  return match ? match[1]! : "none";
}

/**
 * Check whether passwordless sudo is available on the remote host.
 *
 * @param channel - An active non-PTY shell channel.
 * @returns `true` if `sudo -n true` succeeded (exit 0).
 */
async function detectSudo(channel: ClientChannel): Promise<boolean> {
  const output = await execChannelCommand(
    channel,
    "which sudo && sudo -n true 2>/dev/null && echo SUDO:ok || echo SUDO:no",
    CMD_MARKER,
    PROBE_TIMEOUT,
  );

  return /SUDO:ok/.test(output);
}

/**
 * Build the install command for a given package manager.
 *
 * @param pkg - The package manager identifier ("apt", "yum", "apk", "pacman").
 * @returns The full shell command to install tmux.
 */
function buildInstallCommand(pkg: string): string {
  switch (pkg) {
    case "apt":
      return "sudo apt-get update -qq && sudo apt-get install -y -qq tmux";
    case "yum":
      return "sudo yum install -y tmux";
    case "apk":
      return "sudo apk add tmux";
    case "pacman":
      return "sudo pacman -S --noconfirm tmux";
    default:
      return "";
  }
}

/**
 * Verify that tmux was successfully installed by running `which tmux`.
 *
 * @param channel - An active non-PTY shell channel.
 * @returns `true` if tmux is now available.
 */
async function verifyTmuxInstalled(channel: ClientChannel): Promise<boolean> {
  const output = await execChannelCommand(
    channel,
    "which tmux && echo TMUX_INSTALLED",
    CMD_MARKER,
    PROBE_TIMEOUT,
  );

  return /TMUX_INSTALLED/.test(output);
}

/**
 * Extract the content between start and end markers from a raw PTY output
 * buffer produced by a capture-pane command.
 *
 * The raw buffer contains the echoed command line, then the start marker
 * output, the capture-pane content, the end marker output, and a new prompt.
 *
 * We locate `__SNAP_START__` and `__SNAP_END__` as standalone lines in
 * the output and extract everything between them.
 *
 * @param raw     - The raw accumulated output from the PTY channel.
 * @returns The extracted screen content (plain text or ANSI).
 */
function extractCaptureContent(raw: string): string {
  // Look for the start marker output. The echo command outputs
  // __SNAP_START__ on its own line, preceded by a newline from the
  // command echo or previous output.
  const startIdx = raw.indexOf(`\n${SNAP_START}\n`);
  if (startIdx === -1) {
    // Fallback: try without the leading newline (edge case: at buffer start)
    const altStart = raw.indexOf(`${SNAP_START}\n`);
    if (altStart === -1) return "";
    const contentStart = altStart + SNAP_START.length + 1;
    const endIdx = raw.indexOf(`\n${SNAP_END}`, contentStart);
    if (endIdx === -1) {
      return raw.slice(contentStart).trimEnd();
    }
    return raw.slice(contentStart, endIdx);
  }

  const contentStart = startIdx + `\n${SNAP_START}\n`.length;
  const endIdx = raw.indexOf(`\n${SNAP_END}`, contentStart);
  if (endIdx === -1) {
    // End marker not found — return everything after start marker
    return raw.slice(contentStart).trimEnd();
  }

  return raw.slice(contentStart, endIdx);
}

// ─── ScreenManager ───────────────────────────────────────────────────────────

export class ScreenManager {
  /** Active screen sessions, keyed by session UUID. */
  private sessions: Map<string, ScreenSession> = new Map();

  /** Monotonic counter assigned to each read() call. */
  private sequenceCounter: number = 0;

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
   * Start a new tmux-backed terminal session on the given host.
   *
   * Checks for tmux on the remote host and auto-installs if missing.
   * Creates a PTY shell channel and launches a tmux session inside it.
   *
   * @param host - The preset host name configured in config.json.
   * @param opts - Optional terminal dimensions and type.
   * @param opts.cols - Terminal columns. Default 120.
   * @param opts.rows - Terminal rows. Default 40.
   * @param opts.term - TERM environment variable. Default "xterm-256color".
   * @returns A new ScreenSession with a unique sessionId.
   * @throws {ConnectionError} If SSH connection or channel creation fails.
   * @throws {Error} With status TMUX_REQUIRED if tmux is missing and cannot
   *   be auto-installed (no package manager detected).
   * @throws {Error} With status TMUX_INSTALL_FAILED if tmux auto-install
   *   was attempted but failed.
   */
  async sessionStart(
    host: string,
    opts: { cols?: number; rows?: number; term?: string } = {},
  ): Promise<ScreenSession> {
    const cols = opts.cols ?? DEFAULT_COLS;
    const rows = opts.rows ?? DEFAULT_ROWS;
    const term = opts.term ?? DEFAULT_TERM;

    // ── Step 1: Check tmux via temp shell channel (no PTY) ────────────────
    const { channel: tempChannel, client: _tempClient } =
      await this.connectionManager.createShellChannel(host);

    const hasTmux = await detectTmux(tempChannel);

    if (!hasTmux) {
      // ── Step 2: Auto-install tmux ─────────────────────────────────────
      const pkgManager = await detectPackageManager(tempChannel);

      if (pkgManager === "none") {
        // No package manager available — cannot auto-install
        try {
          tempChannel.close();
        } catch {
          // Best-effort cleanup
        }
        this.connectionManager.releaseClient(host);

        throw Object.assign(
          new Error(
            "tmux is not installed on the remote host and no supported " +
              "package manager (apt-get, yum, apk, pacman) was detected. " +
              "Please install tmux manually on the remote host.",
          ),
          { status: TMUX_REQUIRED },
        );
      }

      const hasSudo = await detectSudo(tempChannel);
      if (!hasSudo) {
        // Cannot install without passwordless sudo
        try {
          tempChannel.close();
        } catch {
          // Best-effort cleanup
        }
        this.connectionManager.releaseClient(host);

        throw Object.assign(
          new Error(
            "tmux is not installed on the remote host and passwordless " +
              "sudo is not available for automatic installation. " +
              "Please install tmux manually on the remote host.",
          ),
          { status: TMUX_REQUIRED },
        );
      }

      // Run the install command
      const installCmd = buildInstallCommand(pkgManager);
      await execChannelCommand(
        tempChannel,
        installCmd,
        CMD_MARKER,
        INSTALL_TIMEOUT,
      );

      // Verify installation
      const installed = await verifyTmuxInstalled(tempChannel);
      if (!installed) {
        try {
          tempChannel.close();
        } catch {
          // Best-effort cleanup
        }
        this.connectionManager.releaseClient(host);

        throw Object.assign(
          new Error(
            `tmux installation failed on the remote host using ${pkgManager}. ` +
              "Please check server logs or install tmux manually.",
          ),
          { status: TMUX_INSTALL_FAILED },
        );
      }
    }

    // Close the temp channel and release its client reference
    try {
      tempChannel.close();
    } catch {
      // Best-effort cleanup
    }
    this.connectionManager.releaseClient(host);

    // ── Step 3: Open channels ────────────────────────────────────────────
    // PTY channel for interactive use (send-keys, capture-pane)
    const { channel } = await this.connectionManager.createPtyChannel(host, {
      rows,
      cols,
      term,
    });

    // Non-PTY channel for tmux management commands (no terminal echo)
    const { channel: mgmtChannel } =
      await this.connectionManager.createShellChannel(host);

    // ── Step 4: Create tmux session bound to PTY (dies with SSH) ─────────
    const tmuxSession = `${TMUX_SESSION_PREFIX}${crypto.randomUUID()}`;

    // Drain PTY initial output (motd, shell prompt)
    await this.drainChannel(channel, 2000);

    // Replace the PTY shell process with tmux via `exec`.
    // PTY has terminal echo — we can't reliably read output back, so we
    // just fire the command and verify via the clean mgmtChannel.
    channel.write(`exec tmux new-session -s ${tmuxSession} -x ${cols} -y ${rows}\n`);

    // Verify tmux session was created via the non-PTY management channel
    let createOk = false;
    let createOutput = "";
    try {
      createOutput = await execChannelCommand(
        mgmtChannel,
        `tmux has-session -t ${tmuxSession} && echo TMUX_OK`,
        "TMUX_OK",
        PROBE_TIMEOUT,
      );
      createOk = /TMUX_OK/.test(createOutput);
    } catch {
      createOk = false;
    }

    if (!createOk) {
      try { mgmtChannel.close(); } catch { /* ignore */ }
      this.connectionManager.releaseClient(host);
      try { channel.close(); } catch { /* ignore */ }
      this.connectionManager.releaseClient(host);
      throw new Error(
        `Failed to create tmux session "${tmuxSession}" on host "${host}". ` +
          `Create output: ${createOutput?.trim() ?? "(no output)"}`,
      );
    }

    // ── Step 5: Store session and register PTY lifecycle handler ──────────
    const sessionId = crypto.randomUUID();
    const session: ScreenSession = {
      sessionId,
      host,
      tmuxSession,
      channel,
      mgmtChannel,
      cols,
      rows,
      term,
      dead: false,
    };

    // When the PTY closes, tmux is gone — mark session as dead
    channel.on("close", () => {
      session.dead = true;
      session.deadReason =
        `SSH connection to "${host}" lost. ` +
        `The tmux session "${tmuxSession}" is gone (bound to PTY lifecycle). ` +
        `Reinitialize with screen_session_start.`;
    });

    this.sessions.set(sessionId, session);
    return session;
  }

  /**
   * Send text input to a screen session via tmux send-keys.
   *
   * The text is written to the tmux session as if typed at the terminal.
   * A trailing Enter is automatically appended so the command is executed.
   * Single quotes in the text are safely escaped.
   *
   * @param sessionId - UUID of the target session (from sessionStart).
   * @param text      - The text to send (command or literal input).
   * @throws {Error} If the session is not found.
   */
  async write(sessionId: string, text: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Screen session "${sessionId}" not found`);
    }
    if (session.dead) {
      throw new Error(session.deadReason ?? `Screen session "${sessionId}" is dead`);
    }

    // Escape single quotes for shell: turn ' into '\''
    const escaped = text.replace(/'/g, "'\\''");

    // Send keys to the tmux session with a trailing Enter
    const command = `tmux send-keys -t ${session.tmuxSession} '${escaped}' Enter`;
    await execChannelCommand(session.mgmtChannel, command, SNAP_END, READ_TIMEOUT);
  }

  /**
   * Capture the current screen content from a tmux session.
   *
   * Uses `tmux capture-pane` to read the visible pane content.
   * By default returns plain text (ANSI escapes stripped). Use
   * `format: "ansi"` to preserve colors and attributes.
   *
   * @param sessionId - UUID of the target session (from sessionStart).
   * @param opts      - Optional read parameters.
   * @param opts.format         - Output format. "text" strips ANSI (default),
   *                              "ansi" preserves escape sequences.
   * @param opts.includeHistory - Include scrollback history in the capture.
   * @param opts.historyLines   - Number of history lines to include
   *                              (only relevant when includeHistory is true).
   * @returns A ScreenSnapshot with the captured content.
   * @throws {Error} If the session is not found.
   */
  async read(
    sessionId: string,
    opts: {
      format?: "text" | "ansi";
      includeHistory?: boolean;
      historyLines?: number;
      coordinates?: boolean;
    } = {},
  ): Promise<ScreenSnapshot> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Screen session "${sessionId}" not found`);
    }
    if (session.dead) {
      throw new Error(session.deadReason ?? `Screen session "${sessionId}" is dead`);
    }

    const format = opts.format ?? "text";
    const includeHistory = opts.includeHistory ?? false;
    const coordinates = opts.coordinates ?? false;

    // Build the capture-pane command
    const flags: string[] = ["-p"];

    // -e: include escape sequences for color/attributes
    if (format === "ansi") {
      flags.push("-e");
    }

    // History range
    if (includeHistory) {
      const lines = opts.historyLines ?? 200;
      flags.push(`-S -${lines}`);
      flags.push("-E -");
    }

    const flagStr = flags.join(" ");

    // Use the persistent non-PTY management channel — no echo, no extra connections
    const raw = await execChannelCommand(
      session.mgmtChannel,
      `echo '${SNAP_START}'; tmux capture-pane ${flagStr} -t ${session.tmuxSession}; echo '${SNAP_END}'`,
      SNAP_END,
      READ_TIMEOUT,
    );
    const content = extractCaptureContent(raw);

    // Increment the monotonic sequence counter
    const sequence = ++this.sequenceCounter;

    let text = format === "ansi" ? stripAnsi(content) : content;

    // Apply row/column coordinate annotations (local formatting)
    if (coordinates) {
      text = renderCoordinates(text, session.rows, session.cols);
    }

    const snapshot: ScreenSnapshot = {
      rows: session.rows,
      cols: session.cols,
      text,
      ansi: format === "ansi" ? content : undefined,
      alternateScreen: false,
      sequence,
    };

    return snapshot;
  }

  /**
   * Resize the terminal dimensions of a screen session.
   *
   * Updates both the tmux window size and the local session state.
   *
   * @param sessionId - UUID of the target session (from sessionStart).
   * @param cols      - New column count.
   * @param rows      - New row count.
   * @throws {Error} If the session is not found.
   */
  async resize(
    sessionId: string,
    cols: number,
    rows: number,
  ): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Screen session "${sessionId}" not found`);
    }
    if (session.dead) {
      throw new Error(session.deadReason ?? `Screen session "${sessionId}" is dead`);
    }

    // Resize the tmux window via non-PTY management channel (no echo)
    await execChannelCommand(
      session.mgmtChannel,
      `tmux resize-window -t ${session.tmuxSession} -x ${cols} -y ${rows}`,
      SNAP_END,
      READ_TIMEOUT,
    );

    // Also update the SSH PTY dimensions via setWindow
    try {
      session.channel.setWindow(rows, cols, 0, 0);
    } catch {
      // setWindow may not be supported or channel may be in wrong state
    }

    // Update local session state
    session.cols = cols;
    session.rows = rows;
  }

  /**
   * Send an interrupt signal (Ctrl-C / 0x03) to a screen session.
   *
   * This sends the interrupt directly through the PTY channel, which
   * will interrupt whatever foreground process is running in the tmux pane.
   *
   * @param sessionId - UUID of the target session (from sessionStart).
   * @throws {Error} If the session is not found.
   */
  async interrupt(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Screen session "${sessionId}" not found`);
    }
    if (session.dead) {
      throw new Error(session.deadReason ?? `Screen session "${sessionId}" is dead`);
    }

    // Write Ctrl-C (ASCII 0x03) directly to the PTY channel
    session.channel.write("\x03");
  }

  /**
   * Close a screen session and release all associated resources.
   *
   * Kills the tmux session on the remote host, closes the SSH channel,
   * releases the client reference in the connection pool, and removes
   * the session from the internal map.
   *
   * Safe to call on a non-existent session (no-op).
   *
   * @param sessionId - UUID of the session to close.
   */
  sessionClose(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    // Kill the tmux session via non-PTY management channel
    try {
      execChannelCommand(
        session.mgmtChannel,
        `tmux kill-session -t ${session.tmuxSession}`,
        SNAP_END,
        5000,
      );
    } catch {
      // Channel may already be closed — ignore
    }

    // Close both channels: PTY and management
    try { session.channel.close(); } catch { /* ignore */ }
    try { session.mgmtChannel.close(); } catch { /* ignore */ }

    // Release client refs for both channels
    this.connectionManager.releaseClient(session.host);
    this.connectionManager.releaseClient(session.host);

    // Remove from internal map
    this.sessions.delete(sessionId);
  }

  // ─── Private helpers ─────────────────────────────────────────────────────

  /**
   * Drain any buffered output from a channel.
   *
   * After opening a PTY channel, there may be initial output (motd,
   * shell prompt, etc.) that we want to consume before sending our
   * first command. This helper reads and discards any data that
   * arrives within a short wait period.
   *
   * @param channel - The channel to drain.
   * @param maxWait - Maximum time to wait for initial output (ms).
   */
  private drainChannel(channel: ClientChannel, maxWait: number): Promise<void> {
    return new Promise<void>((resolve) => {
      let drained = false;
      let timer: NodeJS.Timeout;

      const resetTimer = () => {
        clearTimeout(timer);
        timer = setTimeout(() => {
          if (drained) return;
          drained = true;
          channel.removeAllListeners("data");
          resolve();
        }, maxWait);
      };

      channel.on("data", () => {
        // Data is arriving — reset the quiet-period timer
        if (!drained) resetTimer();
      });

      // Start the initial timer
      resetTimer();
    });
  }

  /**
   * Write a shell command to the channel and read output until a marker
   * indicates completion.
   *
   * For PTY channels, command echo is interleaved with output. This method
   * appends a marker echo and waits until the marker appears in the stream.
   * The caller is responsible for extracting meaningful content from the
   * raw output buffer (which includes echoed commands, prompts, and markers).
   *
   * @param channel - The PTY channel to write to and read from.
   * @param command - The shell command to execute.
   * @returns The full raw output buffer including all echoed text and markers.
   */
  private runChannelCommand(
    channel: ClientChannel,
    command: string,
  ): Promise<string> {
    // Write command to PTY — terminal echo will cause the command text to
    // appear in the output before the actual result. We handle this by
    // reading until the marker, then stripping the echoed portion below.
    const fullCommand = `${command}; echo '${SNAP_END}'\n`;
    channel.write(fullCommand);
    return readUntilMarker(channel, SNAP_END, READ_TIMEOUT);
  }
}

/**
 * Render terminal text with row/column coordinate annotations.
 *
 * Prepends a column ruler line (marks every 5th column) and line numbers
 * to each row, enabling LLM agents to reference precise screen positions.
 *
 * @example
 *   renderCoordinates("ab\ncd", 2, 2)
 *   //     0....5
 *   // 00 | ab
 *   // 01 | cd
 */
function renderCoordinates(text: string, rows: number, cols: number): string {
  // Build column ruler: marks ones digit every 5 columns
  let ruler = "    ";
  for (let c = 0; c < cols && c < 10; c++) ruler += ".";
  for (let c = 10; c < cols; c++) {
    ruler += c % 5 === 0 ? String(c % 10) : ".";
  }

  const contentLines = text.split("\n");
  const out: string[] = [ruler];

  for (let r = 0; r < contentLines.length; r++) {
    const lineno = String(r + 1).padStart(2, "0");
    out.push(`${lineno} | ${contentLines[r]}`);
  }

  return out.join("\n");
}

// ─── ANSI stripping helper ───────────────────────────────────────────────────

/**
 * Strip ANSI escape sequences from a string.
 *
 * Handles CSI sequences (including SGR color codes), OSC sequences,
 * and other common escape codes. Used to produce plain text from
 * ANSI-formatted capture-pane output when format="text".
 *
 * @param str - The string potentially containing ANSI escapes.
 * @returns The string with all ANSI escape sequences removed.
 */
function stripAnsi(str: string): string {
  // Pattern covers:
  // - CSI sequences: ESC [ ... (0x1b followed by '[' and params)
  // - OSC sequences: ESC ] ... (up to BEL or ST)
  // - Other escape sequences: ESC followed by any char
  // eslint-disable-next-line no-control-regex
  const ansiRegex = /\x1b\[[0-9;]*[a-zA-Z]/g;
  // eslint-disable-next-line no-control-regex
  const oscRegex = /\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g;
  // eslint-disable-next-line no-control-regex
  const simpleRegex = /\x1b[^[\]]./g;

  return str
    .replace(oscRegex, "")
    .replace(ansiRegex, "")
    .replace(simpleRegex, "");
}
