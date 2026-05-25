/**
 * router.ts — Tool Router (prefix-based dispatch)
 *
 * Parses an MCP tool name and dispatches to the correct manager method.
 * Each tool name follows the pattern `<prefix>_<action>`:
 *
 *   host_*        → HostManager module-level functions
 *   exec_*        → ExecManager (session-based shell execution)
 *   screen_*      → ScreenManager (tmux-backed terminal sessions)
 *   sftp_*        → SftpManager (stateless file transfer)
 *
 * Errors thrown by managers are caught, classified via isMcpError(),
 * and wrapped into a ToolResult. MCP-level errors (connection/auth/channel
 * failures) propagate a flag so the transport can set `isError: true`.
 */

import * as HostManager from "../managers/host.js";
import type { HostConnection } from "../shared/config.js";
import { ConnectionManager } from "../managers/connection.js";
import { ExecManager } from "../managers/exec.js";
import { ScreenManager } from "../managers/screen.js";
import { SftpManager } from "../managers/sftp.js";
import { isMcpError } from "../shared/errors.js";
import { wrapResult, type ToolResult } from "./envelope.js";

// ─── Singleton managers ──────────────────────────────────────────────────────

/** Shared SSH connection pool. Used by both ExecManager and ScreenManager. */
const connectionManager = new ConnectionManager();

/** Manages persistent shell sessions (no PTY) for command execution. */
const execManager = new ExecManager(connectionManager);

/** Manages tmux-backed terminal sessions with PTY allocation. */
const screenManager = new ScreenManager(connectionManager);

/** Stateless SFTP transfer manager. */
const sftpManager = new SftpManager();

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Attempt to extract an error taxonomy status string from a thrown error.
 *
 * Checks:
 * 1. A `.status` property (set by ConnectionError and tmux errors).
 * 2. The error message if it matches one of the known taxonomy constants
 *    (SftpManager throws `new Error(statusString)` which carries the
 *    status as the message text).
 *
 * @returns The taxonomy status string, or `null` if unrecognised.
 */
function extractErrorStatus(err: unknown): string | null {
  if (!(err instanceof Error)) return null;

  // Manager errors that attach a .status property.
  const explicit = (err as unknown as Record<string, unknown>).status;
  if (typeof explicit === "string") return explicit;

  // SftpManager and some other paths throw with the taxonomy string as
  // the message. Check whether the message is a known error status.
  // We rely on isMcpError() as a litmus test — but isMcpError is
  // conservative (connection/channel only), so we need a broader check
  // for operation-level statuses. The pragmatic approach: if the message
  // consists entirely of a single lowercase_underscore token that
  // matches the error taxonomy naming convention, treat it as a status.
  const msg = err.message.trim();
  if (/^[a-z_]+$/.test(msg)) return msg;

  return null;
}

/**
 * Route a tool call to the appropriate manager method.
 *
 * Parses the tool name prefix, validates arguments, calls the manager,
 * times the operation, and wraps the result via wrapResult().
 *
 * @param name - MCP tool name (e.g. "exec", "host_list", "screen_session_read").
 * @param args - Arguments passed by the MCP client for this tool call.
 * @returns A ToolResult envelope ready for serialization.
 * @throws {ToolResult} Re-throws MCP-level errors as ToolResult with
 *   `_isMcpError: true` so the transport can set `isError: true`.
 */
export async function routeToolCall(
  name: string,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const t0 = Date.now();

  try {
    const result = await dispatch(name, args);
    const durationMs = Date.now() - t0;
    return wrapResult(result, durationMs);
  } catch (err) {
    const status = extractErrorStatus(err) ?? "internal_error";
    const durationMs = Date.now() - t0;
    const message = err instanceof Error ? err.message : String(err);

    const errorResult: ToolResult = {
      status,
      timedOut: false,
      cancelled: false,
      outputTruncated: false,
      durationMs,
      data: {
        cwd: "",
        stderr: message,
      },
    };

    // Attach an internal flag so the transport can set `isError: true`
    // when the error is connection-level or channel-level.
    if (status && isMcpError(status)) {
      (errorResult as unknown as Record<string, unknown>)._isMcpError = true;
    }

    return errorResult;
  }
}

// ─── Dispatch ────────────────────────────────────────────────────────────────

/**
 * Internal dispatch function. Maps tool name to the correct manager call.
 *
 * Each branch validates and casts the required arguments before calling
 * the manager. Unknown tool names throw an Error.
 */
async function dispatch(
  name: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  switch (name) {
    // ─── Host management ──────────────────────────────────────────────────

    case "host_list":
      return HostManager.list();

    case "host_add": {
      const hostName = asString(args, "name");
      const connection = asObject(args, "connection") as unknown as HostConnection;
      HostManager.add(hostName, connection);
      return undefined;
    }

    case "host_remove": {
      const hostName = asString(args, "name");
      HostManager.remove(hostName);
      return undefined;
    }

    // ─── Exec sessions ────────────────────────────────────────────────────

    case "exec_session_start": {
      const host = asString(args, "host");
      const session = await execManager.sessionStart(host);
      return session;
    }

    case "exec": {
      const sessionId = asString(args, "session_id");
      const command = asString(args, "command");
      const opts: {
        stdin?: string;
        timeout?: number;
        trace?: boolean;
      } = {};

      if (typeof args.stdin === "string") opts.stdin = args.stdin;
      if (typeof args.timeout === "number") opts.timeout = args.timeout;
      if (typeof args.trace === "boolean") opts.trace = args.trace;

      return await execManager.exec(sessionId, command, opts);
    }

    case "exec_session_close": {
      const sessionId = asString(args, "session_id");
      execManager.sessionClose(sessionId);
      return undefined;
    }

    // ─── Screen sessions ──────────────────────────────────────────────────

    case "screen_session_start": {
      const host = asString(args, "host");
      const opts: { cols?: number; rows?: number; term?: string } = {};
      if (typeof args.cols === "number") opts.cols = args.cols;
      if (typeof args.rows === "number") opts.rows = args.rows;
      if (typeof args.term === "string") opts.term = args.term;
      return await screenManager.sessionStart(host, opts);
    }

    case "screen_session_write": {
      const sessionId = asString(args, "session_id");
      const text = asString(args, "text");
      await screenManager.write(sessionId, text);
      return undefined;
    }

    case "screen_session_read": {
      const sessionId = asString(args, "session_id");
      const opts: {
        format?: "text" | "ansi";
        includeHistory?: boolean;
        historyLines?: number;
        coordinates?: boolean;
      } = {};

      if (args.format === "text" || args.format === "ansi") {
        opts.format = args.format;
      }
      if (typeof args.includeHistory === "boolean") {
        opts.includeHistory = args.includeHistory;
      }
      if (typeof args.historyLines === "number") {
        opts.historyLines = args.historyLines;
      }
      if (typeof args.coordinates === "boolean") {
        opts.coordinates = args.coordinates;
      }

      return await screenManager.read(sessionId, opts);
    }

    case "screen_session_resize": {
      const sessionId = asString(args, "session_id");
      const cols = asNumber(args, "cols");
      const rows = asNumber(args, "rows");
      await screenManager.resize(sessionId, cols, rows);
      return undefined;
    }

    case "screen_session_interrupt": {
      const sessionId = asString(args, "session_id");
      await screenManager.interrupt(sessionId);
      return undefined;
    }

    case "screen_session_close": {
      const sessionId = asString(args, "session_id");
      screenManager.sessionClose(sessionId);
      return undefined;
    }

    // ─── SFTP transfer ────────────────────────────────────────────────────

    case "sftp_upload": {
      const host = asString(args, "host");
      const localPath = asString(args, "local_path");
      const remotePath = asString(args, "remote_path");
      return await sftpManager.upload(host, localPath, remotePath);
    }

    case "sftp_download": {
      const host = asString(args, "host");
      const remotePath = asString(args, "remote_path");
      const localPath = asString(args, "local_path");
      return await sftpManager.download(host, remotePath, localPath);
    }

    default:
      throw new Error(`Unknown tool: "${name}"`);
  }
}

// ─── Argument helpers ────────────────────────────────────────────────────────

function asString(args: Record<string, unknown>, key: string): string {
  const val = args[key];
  if (typeof val !== "string" || val.length === 0) {
    throw new Error(
      `Missing or invalid argument "${key}": expected non-empty string.`,
    );
  }
  return val;
}

function asNumber(args: Record<string, unknown>, key: string): number {
  const val = args[key];
  if (typeof val !== "number") {
    throw new Error(
      `Missing or invalid argument "${key}": expected number.`,
    );
  }
  return val;
}

function asObject(
  args: Record<string, unknown>,
  key: string,
): Record<string, unknown> {
  const val = args[key];
  if (typeof val !== "object" || val === null || Array.isArray(val)) {
    throw new Error(
      `Missing or invalid argument "${key}": expected object.`,
    );
  }
  return val as Record<string, unknown>;
}
