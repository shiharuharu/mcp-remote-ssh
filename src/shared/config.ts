/**
 * config.ts — XDG path resolution + Config types
 *
 * Provides configuration types (HostConnection, ResolvedHostConfig, ViaToolConfig)
 * and functions for resolving the config directory, loading/saving config.json,
 * and resolving named host entries with defaults applied.
 *
 * No external dependencies beyond Node.js built-ins (fs, path, os).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

// ─── Types ───────────────────────────────────────────────────────────────────

/**
 * Raw per-host connection configuration as stored in config.json.
 * privateKey and password are mutually exclusive authentication methods;
 * password is write-only — it is never returned on list operations.
 */
export interface HostConnection {
  /** IP address or hostname of the remote server. */
  host: string;
  /** SSH port. Defaults to 22 via config.defaults.port. */
  port?: number;
  /** SSH username for authentication. */
  username: string;
  /** Path to SSH private key file. `~` is expanded at resolution time. */
  privateKey?: string;
  /**
   * Password for password-based SSH authentication.
   * Write-only: always nulled when returned via list operations.
   */
  password?: string;
}

/**
 * Fully-resolved host configuration after applying defaults and expanding `~`.
 * This is what ConnectionManager consumes to establish an SSH connection.
 */
export interface ResolvedHostConfig {
  /** IP address or hostname (always defined). */
  host: string;
  /** SSH port (always resolved to a number; never undefined after resolution). */
  port: number;
  /** SSH username (always defined after resolution). */
  username: string;
  /** Absolute path to SSH private key file, or undefined if password auth. */
  privateKey?: string;
  /** Password for SSH auth, or undefined if key-based auth. */
  password?: string;
}

/**
 * Top-level configuration schema (version 1).
 * Stored as JSON in the XDG-resolved config directory.
 */
export interface ViaToolConfig {
  /** Schema version — currently always 1. */
  version: 1;
  /** Named host entries, keyed by logical host name. */
  hosts: Record<string, HostConnection>;
  /** Default values applied when a HostConnection omits a field. */
  defaults: {
    /** Default SSH port (typically 22). */
    port: number;
    /** Default SSH username. */
    username: string;
    /** Default path to SSH private key. `~` is expanded at resolution time. */
    privateKey: string;
  };
}

// ─── Constants ───────────────────────────────────────────────────────────────

/** Default config template written when no config.json exists. */
const DEFAULT_CONFIG: ViaToolConfig = {
  version: 1,
  hosts: {},
  defaults: {
    port: 22,
    username: "",
    privateKey: "~/.ssh/id_rsa",
  },
};

// ─── Cached config directory path (resolved once on first call) ──────────────

let _configDir: string | null = null;

// ─── Internal helpers ────────────────────────────────────────────────────────

/**
 * Expand a leading `~` (or `~user`) in a file path using `os.homedir()`.
 * Does nothing if the path does not start with `~`.
 */
function expandTilde(filePath: string): string {
  if (filePath.startsWith("~")) {
    // Handle ~user notation (e.g. ~otheruser/foo)
    if (filePath.startsWith("~/") || filePath === "~") {
      return path.join(os.homedir(), filePath.slice(1));
    }
    // For ~user/..., replace only the username portion
    const sepIndex = filePath.indexOf(path.sep);
    if (sepIndex === -1) {
      // Just ~user with no path separator
      const user = filePath.slice(1);
      return path.join(path.dirname(os.homedir()), user);
    }
    const user = filePath.slice(1, sepIndex);
    const rest = filePath.slice(sepIndex);
    return path.join(path.dirname(os.homedir()), user, rest);
  }
  return filePath;
}

/**
 * Probe candidate paths for the XDG config directory, in priority order.
 * Returns the absolute path of the first existing directory.
 */
function probeConfigDir(): string {
  const home = os.homedir();

  const candidates: string[] = [];

  // 1. $XDG_CONFIG_HOME/mcp-remote-ssh/
  if (process.env.XDG_CONFIG_HOME) {
    candidates.push(
      path.join(process.env.XDG_CONFIG_HOME, "mcp-remote-ssh"),
    );
  }

  // 2. $HOME/.mcp-remote-ssh/
  candidates.push(path.join(home, ".mcp-remote-ssh"));

  // 3. $HOME/.config/mcp-remote-ssh/
  candidates.push(path.join(home, ".config", "mcp-remote-ssh"));

  // 4. $APPDATA/mcp-remote-ssh/ (Windows)
  if (process.env.APPDATA && process.platform === "win32") {
    candidates.push(
      path.join(process.env.APPDATA, "mcp-remote-ssh"),
    );
  }

  // 5. $HOME/Library/Application Support/mcp-remote-ssh/ (macOS)
  if (process.platform === "darwin") {
    candidates.push(
      path.join(
        home,
        "Library",
        "Application Support",
        "mcp-remote-ssh",
      ),
    );
  }

  // Return the first existing directory
  for (const candidate of candidates) {
    try {
      if (fs.statSync(candidate).isDirectory()) {
        return candidate;
      }
    } catch {
      // Candidate does not exist; continue probing
    }
  }

  // None exist — fall back to creating ~/.mcp-remote-ssh/
  return candidates[0];
}

/**
 * Ensure the config directory exists, creating it (and parents) if needed.
 */
function ensureConfigDir(dir: string): void {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

/**
 * Write the default config template to config.json if the file does not exist.
 * Used to bootstrap a fresh installation.
 */
function writeDefaultConfig(configPath: string): void {
  const dir = path.dirname(configPath);
  ensureConfigDir(dir);
  fs.writeFileSync(
    configPath,
    JSON.stringify(DEFAULT_CONFIG, null, 2),
    "utf-8",
  );
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Resolve the XDG config directory for mcp-remote-ssh.
 *
 * Probe order (first existing directory wins):
 * 1. `$XDG_CONFIG_HOME/mcp-remote-ssh/`
 * 2. `$HOME/.mcp-remote-ssh/`
 * 3. `$HOME/.config/mcp-remote-ssh/`
 * 4. `$APPDATA/mcp-remote-ssh/` (Windows only)
 * 5. `$HOME/Library/Application Support/mcp-remote-ssh/` (macOS only)
 *
 * If none exist, `$HOME/.mcp-remote-ssh/` is created and a default
 * config template is written. The result is memoized for the process lifetime.
 *
 * @returns Absolute path to the config directory.
 */
export function resolveConfigDir(): string {
  if (_configDir !== null) {
    return _configDir;
  }

  const dir = probeConfigDir();
  const configPath = path.join(dir, "config.json");

  // If the directory didn't exist, create it and write default config
  if (!fs.existsSync(dir)) {
    writeDefaultConfig(configPath);
  } else if (!fs.existsSync(configPath)) {
    // Directory exists but no config.json yet
    writeDefaultConfig(configPath);
  }

  _configDir = dir;
  return dir;
}

/**
 * Load the full ViaToolConfig from config.json.
 *
 * If the config directory or file does not exist, a default config template
 * is created and returned.
 *
 * @returns The parsed ViaToolConfig object.
 * @throws {Error} If config.json exists but contains malformed JSON.
 */
export function loadConfig(): ViaToolConfig {
  const dir = resolveConfigDir();
  const configPath = path.join(dir, "config.json");

  let raw: string;
  try {
    raw = fs.readFileSync(configPath, "utf-8");
  } catch {
    // Should not happen — resolveConfigDir() creates the file — but be defensive
    writeDefaultConfig(configPath);
    raw = fs.readFileSync(configPath, "utf-8");
  }

  const parsed: unknown = JSON.parse(raw);
  // Minimal shape validation — version must be 1
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    (parsed as Record<string, unknown>).version !== 1
  ) {
    throw new Error(
      `Invalid config.json: expected object with version=1, got ${typeof parsed}`,
    );
  }

  return parsed as ViaToolConfig;
}

/**
 * Persist a ViaToolConfig object to config.json.
 *
 * Writes atomically by writing to the target file directly.
 * The config directory must already exist (guaranteed by resolveConfigDir).
 *
 * @param cfg - The configuration object to persist.
 */
export function saveConfig(cfg: ViaToolConfig): void {
  const dir = resolveConfigDir();
  const configPath = path.join(dir, "config.json");
  fs.writeFileSync(configPath, JSON.stringify(cfg, null, 2), "utf-8");
}

/**
 * Resolve a named host entry to a fully-specified ResolvedHostConfig.
 *
 * Applies config.defaults for any missing fields and expands `~` in
 * privateKey paths. Raises if the host name is not found.
 *
 * @param name - The logical host name registered in config.hosts.
 * @returns Fully resolved host connection parameters.
 * @throws {Error} If the host name is not found in the configuration.
 */
export function resolveHost(name: string): ResolvedHostConfig {
  const cfg = loadConfig();
  const entry = cfg.hosts[name];
  if (!entry) {
    throw new Error(
      `Host "${name}" not found in configuration. ` +
        `Available hosts: ${Object.keys(cfg.hosts).join(", ") || "(none)"}`,
    );
  }

  // Apply defaults layer
  const port = entry.port ?? cfg.defaults.port;
  const username = entry.username || cfg.defaults.username;
  const privateKeyRaw = entry.privateKey ?? cfg.defaults.privateKey;

  // Expand ~ in privateKey path
  const privateKey = privateKeyRaw ? expandTilde(privateKeyRaw) : undefined;

  return {
    host: entry.host,
    port,
    username,
    privateKey,
    password: entry.password,
  };
}
