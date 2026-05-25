// sftp.ts — SftpManager (upload/download)
//
// SftpManager provides upload and download only. All other file operations
// (list, stat, read, write, mkdir, rm, rename, chmod) are done via
// ExecManager with standard commands — SFTP only handles cross-network-boundary
// file transfer.
//
// STATELESS: every operation creates its own SftpClient, connects, performs
// one transfer, and calls end(). Never reuse an SftpClient across operations.

import SftpClient from "ssh2-sftp-client";
import * as fs from "node:fs";
import { resolveHost } from "../shared/config.js";
import {
  NOT_FOUND,
  PERMISSION_DENIED,
  QUOTA_OR_DISK_FULL,
  PARTIAL_TRANSFER,
  UNSUPPORTED_OPERATION,
  UNKNOWN_REMOTE_FAILURE,
  CONNECTION_LOST_DURING_RUN,
} from "../shared/errors.js";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface SftpResult {
  status: string;
  durationMs: number;
  data: {
    localPath: string;
    remotePath: string;
    bytesTransferred: number;
  };
}

// ─── Internal helpers ────────────────────────────────────────────────────────

/**
 * Inspect an ssh2-sftp-client error and classify it into the project's
 * unified error taxonomy.
 *
 * We check both `err.code` (node-style codes like ENOENT, EACCES) and
 * `err.message` (human-readable text) because different failure scenarios
 * surface through different properties depending on where the error
 * originated (local Node.js layer, ssh2 layer, or remote SFTP server).
 */
function classifyError(err: unknown): string {
  if (!(err instanceof Error)) {
    return UNKNOWN_REMOTE_FAILURE;
  }

  const msg: string = err.message.toLowerCase();
  const code: string =
    typeof (err as unknown as Record<string, unknown>).code === "string"
      ? ((err as unknown as Record<string, unknown>).code as string).toLowerCase()
      : "";

  // ── File/directory not found ──────────────────────────────────────────
  if (
    code === "enoent" ||
    code === "err_bad_path" ||
    msg.includes("no such file") ||
    msg.includes("not found") ||
    msg.includes("does not exist") ||
    msg.includes("enoent")
  ) {
    return NOT_FOUND;
  }

  // ── Permission / access denied ────────────────────────────────────────
  if (
    code === "eacces" ||
    code === "eperm" ||
    msg.includes("permission denied") ||
    msg.includes("access denied") ||
    msg.includes("forbidden")
  ) {
    return PERMISSION_DENIED;
  }

  // ── Disk full / quota exceeded ────────────────────────────────────────
  if (
    code === "enospc" ||
    code === "edquot" ||
    msg.includes("disk full") ||
    msg.includes("quota exceeded") ||
    msg.includes("no space left")
  ) {
    return QUOTA_OR_DISK_FULL;
  }

  // ── Connection lost / keepalive timeout ───────────────────────────────
  if (
    msg.includes("connection lost") ||
    msg.includes("keepalive") ||
    msg.includes("timed out") ||
    msg.includes("econnreset") ||
    msg.includes("etimedout") ||
    msg.includes("enotconnected")
  ) {
    return CONNECTION_LOST_DURING_RUN;
  }

  // ── Transfer interrupted / partial completion ─────────────────────────
  if (
    msg.includes("partial") ||
    msg.includes("interrupted") ||
    msg.includes("incomplete") ||
    msg.includes("broken pipe")
  ) {
    return PARTIAL_TRANSFER;
  }

  // ── Operation not supported ───────────────────────────────────────────
  if (
    code === "eopnotsupp" ||
    msg.includes("not supported") ||
    msg.includes("unsupported")
  ) {
    return UNSUPPORTED_OPERATION;
  }

  // ── Fallback ──────────────────────────────────────────────────────────
  return UNKNOWN_REMOTE_FAILURE;
}

/**
 * Build a connect config object for SftpClient, omitting fields that only
 * apply when they are defined (privateKey and password are mutually
 * exclusive auth methods in practice, but both may appear in the resolved
 * config — we include whichever is present and let ssh2 negotiate).
 */
function buildConnectConfig(resolved: ReturnType<typeof resolveHost>) {
  const cfg: Record<string, unknown> = {
    host: resolved.host,
    port: resolved.port,
    username: resolved.username,
    readyTimeout: 10_000,         // 10s handshake timeout
    keepaliveInterval: 10_000,    // 10s keepalive probe
    keepaliveCountMax: 3,         // 3 missed → disconnect (30s detection)
  };
  if (resolved.privateKey) {
    cfg.privateKey = fs.readFileSync(resolved.privateKey, "utf-8");
  }
  if (resolved.password) {
    cfg.password = resolved.password;
  }
  return cfg;
}

// ─── SftpManager ─────────────────────────────────────────────────────────────

export class SftpManager {
  /**
   * Upload a local file or directory to a remote host via SFTP.
   *
   * Auto-detects whether localPath is a file or directory:
   * - File → fastPut (single transfer)
   * - Directory → uploadDir (recursive, creates remote if missing)
   *
   * @param host - Logical host name registered in config.hosts.
   * @param localPath - Absolute path to the local file or directory to upload.
   * @param remotePath - Absolute path on the remote host to write to.
   * @returns SftpResult with bytes transferred.
   * @throws Error with a taxonomy status string if the transfer fails.
   */
  async upload(
    host: string,
    localPath: string,
    remotePath: string,
  ): Promise<SftpResult> {
    const t0 = Date.now();
    const resolved = resolveHost(host);
    const client = new SftpClient();

    // Detect directory vs file before connecting
    const localStat = fs.statSync(localPath);
    const isDir = localStat.isDirectory();

    try {
      await client.connect(buildConnectConfig(resolved));

      if (isDir) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await (client as any).uploadDir(localPath, remotePath);
      } else {
        await client.fastPut(localPath, remotePath);
      }

      // Skip byte count for directories (recursive stat too slow)
      const bytesTransferred = isDir ? 0 : fs.statSync(localPath).size;

      return {
        status: "ok",
        durationMs: Date.now() - t0,
        data: {
          localPath,
          remotePath,
          bytesTransferred,
        },
      };
    } catch (err) {
      const status = classifyError(err);
      const detail = err instanceof Error ? err.message : String(err);
      const sftpErr = new Error(`${status}: ${detail}`);
      (sftpErr as unknown as Record<string, unknown>).code = status;
      throw sftpErr;
    } finally {
      try {
        await client.end();
      } catch {
        // Best-effort cleanup — connection teardown should not mask
        // the original error.
      }
    }
  }

  /**
   * Download a remote file or directory to a local path via SFTP.
   *
   * Connects first, stats the remote path to detect file vs directory:
   * - File → fastGet (single transfer)
   * - Directory → downloadDir (recursive, creates local if missing)
   *
   * @param host - Logical host name registered in config.hosts.
   * @param remotePath - Absolute path on the remote host to read from.
   * @param localPath - Absolute local path to write the downloaded content to.
   * @returns SftpResult with bytes transferred (local stat after download).
   * @throws Error with a taxonomy status string if the transfer fails.
   */
  async download(
    host: string,
    remotePath: string,
    localPath: string,
  ): Promise<SftpResult> {
    const t0 = Date.now();
    const resolved = resolveHost(host);
    const client = new SftpClient();

    try {
      await client.connect(buildConnectConfig(resolved));

      // Detect remote file vs directory
      const remoteStat = await (client as any).stat(remotePath);
      const isDir = remoteStat.isDirectory;

      if (isDir) {
        await (client as any).downloadDir(remotePath, localPath);
      } else {
        await client.fastGet(remotePath, localPath);
      }

      // Skip byte count for directories (recursive stat too slow)
      const bytesTransferred = isDir ? 0 : fs.statSync(localPath).size;

      return {
        status: "ok",
        durationMs: Date.now() - t0,
        data: {
          localPath,
          remotePath,
          bytesTransferred,
        },
      };
    } catch (err) {
      const status = classifyError(err);
      const detail = err instanceof Error ? err.message : String(err);
      const sftpErr = new Error(`${status}: ${detail}`);
      (sftpErr as unknown as Record<string, unknown>).code = status;
      throw sftpErr;
    } finally {
      try {
        await client.end();
      } catch {
        // Best-effort cleanup.
      }
    }
  }
}
