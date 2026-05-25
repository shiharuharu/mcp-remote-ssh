/**
 * errors.ts — Error taxonomy constants
 *
 * Exports string constants for all error statuses defined in the
 * architecture's three-level error model:
 *
 *   Level 1 — Connection errors (MCP tool unavailable — isError)
 *   Level 2 — Channel errors    (MCP tool unavailable — isError)
 *   Level 3 — Operation errors  (returned in result envelope, not isError)
 *
 * Also exports `isMcpError(status)` to classify any status string.
 * No external dependencies.
 */

// ─── Level 1: Connection-level errors ────────────────────────────────────────

/** Failed to establish TCP connection to the remote host. */
export const CONNECT_FAILED = "connect_failed" as const;

/** TCP connection established but SSH authentication was rejected. */
export const AUTH_FAILED = "auth_failed" as const;

/** An established SSH connection was unexpectedly closed by the remote side. */
export const CONNECTION_CLOSED = "connection_closed" as const;

// ─── Level 2: Channel-level errors ───────────────────────────────────────────

/** Failed to open a new SSH channel on an existing connection. */
export const CHANNEL_OPEN_FAILED = "channel_open_failed" as const;

/** Failed to request a PTY on an SSH channel (screen sessions). */
export const PTY_REQUEST_FAILED = "pty_request_failed" as const;

/** Failed to request a shell/exec on an SSH channel. */
export const EXEC_REQUEST_FAILED = "exec_request_failed" as const;

/**
 * tmux is not installed on the remote host and auto-install is disabled
 * or was declined by the Agent.
 */
export const TMUX_REQUIRED = "tmux_required" as const;

/** tmux auto-install was attempted but failed on the remote host. */
export const TMUX_INSTALL_FAILED = "tmux_install_failed" as const;

// ─── Level 3: Operation-level errors ─────────────────────────────────────────

/** Command completed with a non-zero exit code. */
export const EXITED = "exited" as const;

/** Command was terminated by a signal (e.g. SIGKILL, SIGTERM). */
export const SIGNALED = "signaled" as const;

/** Command exceeded its timeout and was forcefully terminated. */
export const TIMEOUT_TERMINATED = "timeout_terminated" as const;

/** Operation was cancelled by the caller before completion. */
export const CANCELLED = "cancelled" as const;

/** The SSH connection was lost while a command was running. */
export const CONNECTION_LOST_DURING_RUN = "connection_lost_during_run" as const;

/** The SSH channel was closed without delivering a proper exit status. */
export const CLOSED_WITHOUT_STATUS = "closed_without_status" as const;

/** Command output exceeded the configured size limit and was truncated. */
export const OUTPUT_LIMIT_EXCEEDED = "output_limit_exceeded" as const;

/** The target file or path was not found on the remote host. */
export const NOT_FOUND = "not_found" as const;

/** Permission denied when accessing a file, directory, or command. */
export const PERMISSION_DENIED = "permission_denied" as const;

/** Attempted to create a file or directory that already exists. */
export const ALREADY_EXISTS = "already_exists" as const;

/** A path component in a file operation is not a directory. */
export const NOT_DIRECTORY = "not_directory" as const;

/** Attempted a file operation on a path that is a directory. */
export const IS_DIRECTORY = "is_directory" as const;

/** File transfer failed due to quota exceeded or disk full on the remote. */
export const QUOTA_OR_DISK_FULL = "quota_or_disk_full" as const;

/** A file transfer completed only partially (bytes sent != total size). */
export const PARTIAL_TRANSFER = "partial_transfer" as const;

/** The requested operation is not supported in the current context. */
export const UNSUPPORTED_OPERATION = "unsupported_operation" as const;

/** An unknown failure occurred on the remote host that could not be classified. */
export const UNKNOWN_REMOTE_FAILURE = "unknown_remote_failure" as const;

// ─── Error classification helper ─────────────────────────────────────────────

/**
 * All connection-level error status strings.
 * These indicate the SSH tool itself is unavailable.
 */
const CONNECTION_LEVEL_ERRORS: ReadonlySet<string> = new Set([
  CONNECT_FAILED,
  AUTH_FAILED,
  CONNECTION_CLOSED,
]);

/**
 * All channel-level error status strings.
 * These indicate the SSH tool itself is unavailable.
 */
const CHANNEL_LEVEL_ERRORS: ReadonlySet<string> = new Set([
  CHANNEL_OPEN_FAILED,
  PTY_REQUEST_FAILED,
  EXEC_REQUEST_FAILED,
  TMUX_REQUIRED,
  TMUX_INSTALL_FAILED,
]);

/**
 * Determine whether a status string represents an MCP-level error
 * (i.e. the tool itself is unavailable).
 *
 * Connection-level and channel-level errors are MCP errors — they mean
 * the tool cannot fulfill its contract. Operation-level errors are NOT
 * MCP errors — a command exiting with code != 0 is a normal outcome
 * that the Agent should inspect, not a tool failure.
 *
 * @param status - The status string to classify.
 * @returns `true` if the status indicates a tool-level error (connection/auth/channel).
 */
export function isMcpError(status: string): boolean {
  return (
    CONNECTION_LEVEL_ERRORS.has(status) || CHANNEL_LEVEL_ERRORS.has(status)
  );
}
