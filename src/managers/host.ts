/**
 * host.ts — HostManager (config.json CRUD)
 *
 * MCP-facing manager that provides read/write access to named SSH host entries
 * stored in the XDG-resolved config.json. Password is write-only: accepted on
 * add() but never included in list() results.
 */

import type { HostConnection } from "../shared/config.js";
import { loadConfig, saveConfig } from "../shared/config.js";

// ─── Types ───────────────────────────────────────────────────────────────────

/**
 * Public summary of a configured host entry.
 * The `password` field is intentionally absent — it is never returned on
 * list operations, regardless of whether a password exists in config.
 */
export interface HostSummary {
  /** Logical name for the host entry. */
  name: string;
  /** IP address or hostname of the remote server. */
  host: string;
  /** SSH port. */
  port: number;
  /** SSH username for authentication. */
  username: string;
  /** Path to SSH private key file, or undefined if not configured. */
  privateKey?: string;
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * List all configured host entries.
 *
 * Iterates the `hosts` map in config.json and returns a HostSummary for
 * each entry. The `password` field is unconditionally excluded — passwords
 * are write-only and must never leak via list operations.
 *
 * @returns Array of HostSummary objects. Empty array if no hosts configured.
 */
export function list(): HostSummary[] {
  const cfg = loadConfig();
  const result: HostSummary[] = [];

  for (const [name, conn] of Object.entries(cfg.hosts)) {
    result.push({
      name,
      host: conn.host,
      port: conn.port ?? cfg.defaults.port,
      username: conn.username || cfg.defaults.username,
      privateKey: conn.privateKey,
    });
  }

  return result;
}

/**
 * Add or update a named host entry.
 *
 * Writes (or overwrites) `hosts[name]` in config.json with the provided
 * connection details. The `password` field IS accepted and stored here —
 * write-only semantics mean it is nulled on list(), not rejected on input.
 *
 * @param name - Logical host name. Must be a non-empty string.
 * @param connection - Connection parameters for the host.
 * @throws {Error} If `name` is empty, `connection.host` is empty, or
 *   `connection.username` is empty.
 */
export function add(name: string, connection: HostConnection): void {
  // Validate required fields
  if (!name || name.trim().length === 0) {
    throw new Error("Host name must be a non-empty string.");
  }
  if (!connection.host || connection.host.trim().length === 0) {
    throw new Error("Host connection must include a non-empty 'host' field.");
  }
  if (!connection.username || connection.username.trim().length === 0) {
    throw new Error(
      "Host connection must include a non-empty 'username' field.",
    );
  }

  const cfg = loadConfig();
  cfg.hosts[name] = { ...connection };
  saveConfig(cfg);
}

/**
 * Remove a named host entry from the configuration.
 *
 * Deletes `hosts[name]` from config.json and persists the change.
 *
 * @param name - Logical host name to remove.
 * @throws {Error} If the host name is not found in the configuration.
 */
export function remove(name: string): void {
  const cfg = loadConfig();

  if (!(name in cfg.hosts)) {
    throw new Error(
      `Host "${name}" not found in configuration. ` +
        `Available hosts: ${Object.keys(cfg.hosts).join(", ") || "(none)"}`,
    );
  }

  delete cfg.hosts[name];
  saveConfig(cfg);
}
