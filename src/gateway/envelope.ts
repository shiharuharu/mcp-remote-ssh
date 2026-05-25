/**
 * envelope.ts — Result Envelope
 *
 * Defines the standard ToolResult wrapper used to normalize all manager
 * responses into a uniform structure consumed by the MCP transport layer.
 *
 * Each manager returns a different shape (ExecResult, SftpResult,
 * ScreenSnapshot, HostSummary[], etc.). wrapResult() detects the shape
 * and maps it into the canonical envelope.
 */

import type { ScreenSnapshot } from "../managers/screen.js";
import type { HostSummary } from "../managers/host.js";

// ─── Types ───────────────────────────────────────────────────────────────────

/**
 * Canonical result envelope returned by every tool invocation.
 *
 * All manager responses are normalized into this shape. Boolean flags
 * default to false. The `data` bag carries manager-specific payloads
 * (stdout, screen content, host entries, transfer stats, etc.).
 */
export interface ToolResult {
  /** Outcome status string from the error taxonomy (e.g. "success", "exited"). */
  status: string;
  /** Process exit code. Only set when a command completed. */
  exitCode?: number;
  /** Signal name if the command was terminated by a signal. */
  signal?: string;
  /** True if the command was terminated due to timeout. */
  timedOut: boolean;
  /** True if the command was cancelled by the caller. */
  cancelled: boolean;
  /** True if output was truncated (timeout, size limit, etc.). */
  outputTruncated: boolean;
  /** Wall-clock duration of the operation in milliseconds. */
  durationMs: number;
  /** Session ID, when the operation is session-scoped. */
  sessionId?: string;
  /** Manager-specific payload. */
  data: {
    /** Current working directory (exec sessions). */
    cwd: string;
    /** Merged stdout from a command execution. */
    stdout?: string;
    /** Stderr output from a command execution. */
    stderr?: string;
    /** Screen capture from a tmux session read. */
    screen?: ScreenSnapshot;
    /** List of configured hosts (host_list). */
    entries?: HostSummary[];
    /** Arbitrary stat/blob data (reserved for future use). */
    stat?: unknown;
    /** Raw text content (reserved for future use). */
    content?: string;
    /** Whether the content was truncated. */
    contentTruncated?: boolean;
    /** Number of bytes transferred (SFTP operations). */
    bytesTransferred?: number;
  };
}

// ─── wrapResult ──────────────────────────────────────────────────────────────

/**
 * Wrap a manager return value into the canonical ToolResult envelope.
 *
 * Detects the shape of the manager result and maps fields accordingly:
 * - `ExecResult` / `SftpResult` — already envelope-like; fields pass through.
 * - `ScreenSnapshot` — wrapped into `data.screen`.
 * - `HostSummary[]` — wrapped into `data.entries`.
 * - `ExecSession` / `ScreenSession` — sessionId and cwd extracted.
 * - `void` / `undefined` — minimal success envelope.
 *
 * @param managerResult - The raw return value from a manager method.
 * @param durationMs     - Wall-clock duration of the call (used when the
 *                         manager result does not include its own timing).
 * @returns A fully-populated ToolResult with safe defaults.
 */
export function wrapResult(
  managerResult: unknown,
  durationMs: number,
): ToolResult {
  const result: ToolResult = {
    status: "ok",
    timedOut: false,
    cancelled: false,
    outputTruncated: false,
    durationMs,
    data: { cwd: "" },
  };

  // Void / undefined — return the default success envelope.
  if (managerResult === undefined || managerResult === null) {
    return result;
  }

  const mr = managerResult as Record<string, unknown>;

  // ── Envelope-level fields (ExecResult / SftpResult shapes) ───────────────

  if (typeof mr.status === "string") {
    result.status = mr.status;
  }
  if (typeof mr.exitCode === "number") result.exitCode = mr.exitCode;
  if (typeof mr.signal === "string") result.signal = mr.signal;
  if (typeof mr.timedOut === "boolean") result.timedOut = mr.timedOut;
  if (typeof mr.cancelled === "boolean") result.cancelled = mr.cancelled;
  if (typeof mr.outputTruncated === "boolean") {
    result.outputTruncated = mr.outputTruncated;
  }
  // Prefer the manager's own duration measurement if available.
  if (typeof mr.durationMs === "number") result.durationMs = mr.durationMs;
  if (typeof mr.sessionId === "string") result.sessionId = mr.sessionId;

  // ── data bag (ExecResult.data, SftpResult.data) ──────────────────────────

  if (mr.data && typeof mr.data === "object") {
    const d = mr.data as Record<string, unknown>;
    if (typeof d.cwd === "string") result.data.cwd = d.cwd;
    if (typeof d.stdout === "string") result.data.stdout = d.stdout;
    if (typeof d.stderr === "string") result.data.stderr = d.stderr;
    if (typeof d.bytesTransferred === "number") {
      result.data.bytesTransferred = d.bytesTransferred;
    }
  }

  // ── ScreenSnapshot detection (has text + rows + sequence, no status) ────

  if (
    typeof mr.text === "string" &&
    typeof mr.rows === "number" &&
    typeof mr.sequence === "number"
  ) {
    result.data.screen = managerResult as ScreenSnapshot;
  }

  // ── HostSummary[] detection ──────────────────────────────────────────────

  if (Array.isArray(managerResult)) {
    result.data.entries = managerResult as HostSummary[];
  }

  // ── Session objects (ExecSession / ScreenSession from sessionStart) ─────

  // Session objects have sessionId + cwd but no `.data` envelope.
  // They also carry internal fields like `channel`, `host`, `tmuxSession` etc.
  if (typeof mr.sessionId === "string") {
    result.sessionId = mr.sessionId as string;
    // Extract cwd only if data.cwd was not already set from a .data block.
    if (!result.data.cwd && typeof mr.cwd === "string") {
      result.data.cwd = mr.cwd as string;
    }
    // Extract tmuxSession for ScreenSession returns
    if (typeof mr.tmuxSession === "string") {
      (result.data as Record<string, unknown>).tmuxSession = mr.tmuxSession as string;
    }
  }

  return result;
}

// ─── XML serialisation ───────────────────────────────────────────────────────

/**
 * Serialise a ToolResult to XML-like text for LLM consumption.
 *
 * Unlike JSON.stringify(), this preserves native newlines in stdout/stderr —
 * the LLM receives multi-line text as literal newlines, not \\n escape sequences.
 * XML tags provide semantic isolation without shell injection risk (all
 * formatting is done locally, never sent to the remote shell).
 *
 * @example
 *   <result status="success" exitCode="0" durationMs="113">
 *     <cwd>/root</cwd>
 *     <stdout>
 *   hostname
 *     </stdout>
 *   </result>
 */
export function toXml(r: ToolResult): string {
  const attrs = [
    `status="${r.status}"`,
  ];
  if (r.exitCode !== undefined) attrs.push(`exitCode="${r.exitCode}"`);
  if (r.sessionId)              attrs.push(`sessionId="${r.sessionId}"`);
  if (r.timedOut)               attrs.push(`timedOut="true"`);
  if (r.cancelled)              attrs.push(`cancelled="true"`);
  if (r.outputTruncated)        attrs.push(`outputTruncated="true"`);
  if (r.signal)                 attrs.push(`signal="${r.signal}"`);
  attrs.push(`durationMs="${r.durationMs}"`);

  const lines: string[] = [];
  lines.push(`<result ${attrs.join(" ")}>`);

  // data.cwd
  if (r.data.cwd) {
    lines.push(`  <cwd>${r.data.cwd}</cwd>`);
  }

  // data.stdout — preserve native newlines
  if (r.data.stdout !== undefined) {
    lines.push(`  <stdout>`);
    lines.push(r.data.stdout);
    lines.push(`  </stdout>`);
  }

  // data.stderr
  if (r.data.stderr) {
    lines.push(`  <stderr>${r.data.stderr}</stderr>`);
  }

  // data.bytesTransferred (SFTP) — skip for directories (0)
  if (r.data.bytesTransferred) {
    lines.push(`  <bytesTransferred>${r.data.bytesTransferred}</bytesTransferred>`);
  }

  // data.screen (tmux capture)
  if (r.data.screen) {
    const s = r.data.screen;
    lines.push(`  <screen rows="${s.rows}" cols="${s.cols ?? ""}" sequence="${s.sequence}">`);
    lines.push(s.text);
    lines.push(`  </screen>`);
  }

  // data.entries (host_list)
  if (r.data.entries) {
    lines.push(`  <entries>`);
    for (const e of r.data.entries) {
      lines.push(`    <entry name="${e.name}" host="${e.host}" port="${e.port}" username="${e.username}"/>`);
    }
    lines.push(`  </entries>`);
  }

  // data.content (reserved)
  if (r.data.content !== undefined) {
    lines.push(`  <content>${r.data.content}</content>`);
  }

  lines.push(`</result>`);
  return lines.join("\n");
}
