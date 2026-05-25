/**
 * connection.ts — ConnectionManager (ssh2.Client pool)
 *
 * Manages ssh2.Client lifecycle and channel allocation for ExecManager
 * and ScreenManager. This is INFRASTRUCTURE — no public-facing API.
 *
 * Key responsibilities:
 * - Lazy client creation with per-host pooling and reference counting
 * - SSH channel creation (shell without PTY, shell with PTY)
 * - Connection error classification (CONNECT_FAILED / AUTH_FAILED)
 * - Automatic client cleanup when refCount drops to zero
 */

import { Client, ClientChannel } from "ssh2";
import * as fs from "node:fs";
import { resolveHost } from "../shared/config.js";
import {
  CONNECT_FAILED,
  AUTH_FAILED,
  CONNECTION_CLOSED,
} from "../shared/errors.js";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface ChannelOptions {
  /** Preset host name (from config). */
  host: string;
  /** Terminal rows for PTY channels. Default 40. */
  rows?: number;
  /** Terminal columns for PTY channels. Default 120. */
  cols?: number;
  /** TERM environment variable. Default "xterm-256color". */
  term?: string;
}

/** Result of a channel creation call — caller owns the channel lifecycle. */
export interface ChannelResult {
  client: Client;
  channel: ClientChannel;
}

/**
 * An error thrown by ConnectionManager methods.
 * Carries a status code so callers can classify the failure without
 * string-matching on the message.
 */
export class ConnectionError extends Error {
  public readonly status: string;

  constructor(status: string, message: string) {
    super(message);
    this.name = "ConnectionError";
    this.status = status;
  }
}

// ─── Internal state shape ────────────────────────────────────────────────────

type DisconnectHandler = (host: string) => void;

interface ClientEntry {
  client: Client;
  refCount: number;
  connected: boolean;
  onDisconnect: Set<DisconnectHandler>;
}

// ─── Constants ───────────────────────────────────────────────────────────────

/** Default SSH ready timeout (handshake + auth), in milliseconds. */
const DEFAULT_READY_TIMEOUT = 10_000;

/** Keepalive interval in milliseconds. */
const KEEPALIVE_INTERVAL = 10_000;

/** Maximum unanswered keepalive packets before disconnection. */
const KEEPALIVE_COUNT_MAX = 3;

/** Default terminal dimensions for PTY channels. */
const DEFAULT_ROWS = 40;
const DEFAULT_COLS = 120;
const DEFAULT_TERM = "xterm-256color";

// ─── ConnectionManager ───────────────────────────────────────────────────────

export class ConnectionManager {
  /** Pool of active SSH clients, keyed by host name. */
  private clients: Map<string, ClientEntry> = new Map();

  /**
   * Get (or create) an ssh2 Client for the named host.
   *
   * If a connected client already exists in the pool, its refCount is
   * incremented and it is returned immediately. Otherwise a new Client
   * is created, connected, and added to the pool with refCount = 1.
   *
   * @param host - The preset host name configured via config.json.
   * @returns A connected, authenticated ssh2 Client.
   * @throws {ConnectionError} With status CONNECT_FAILED or AUTH_FAILED.
   */
  getClient(host: string): Promise<Client> {
    const existing = this.clients.get(host);

    // If a connected client already exists, reuse it.
    if (existing && existing.connected) {
      existing.refCount++;
      return Promise.resolve(existing.client);
    }

    // If client exists but disconnected, clean it up before reconnecting
    if (existing && !existing.connected) {
      this.clients.delete(host);
    }

    // Resolve connection parameters from the config.
    const resolved = resolveHost(host);

    // Read private key content if key-based auth is configured.
    let privateKey: string | undefined;
    if (resolved.privateKey) {
      try {
        privateKey = fs.readFileSync(resolved.privateKey, "utf-8");
      } catch (err) {
        throw new ConnectionError(
          CONNECT_FAILED,
          `Failed to read private key at "${resolved.privateKey}": ${(err as Error).message}`,
        );
      }
    }

    const client = new Client();

    return new Promise<Client>((resolve, reject) => {
      let settled = false;
      let entry: ClientEntry | undefined;

      const cleanup = (c: Client = client) => {
        c.removeAllListeners("ready");
        c.removeAllListeners("error");
      };

      client.on("ready", () => {
        if (settled) return;
        settled = true;
        cleanup();

        entry = {
          client,
          refCount: 1,
          connected: true,
          onDisconnect: new Set(),
        };

        client.on("close", () => {
          if (!entry) return;
          entry.connected = false;
          for (const handler of entry.onDisconnect) {
            try { handler(host); } catch { /* swallow handler errors */ }
          }
          entry.onDisconnect.clear();
          this.clients.delete(host);
        });

        // Add to pool.
        this.clients.set(host, entry!);
        resolve(client);
      });

      client.on("error", (err) => {
        if (settled) return;
        settled = true;
        cleanup();

        // Classify the error based on the ssh2 error level.
        // 'client-socket' = TCP/DNS errors (connection failed).
        // 'client-ssh'   = SSH protocol errors (typically auth failure).
        const ssh2Level = (err as { level?: string }).level;
        const status =
          ssh2Level === "client-socket" ? CONNECT_FAILED : AUTH_FAILED;

        reject(new ConnectionError(status, err.message));
      });

      // Connect — try modern algorithms first, fall back to legacy for old devices.
      const tryConnect = (algorithms?: Record<string, unknown>) => {
        client.connect({
          host: resolved.host,
          port: resolved.port,
          username: resolved.username,
          privateKey,
          password: resolved.password,
          readyTimeout: DEFAULT_READY_TIMEOUT,
          keepaliveInterval: KEEPALIVE_INTERVAL,
          keepaliveCountMax: KEEPALIVE_COUNT_MAX,
          hostVerifier: () => true,
          ...(algorithms ? { algorithms: algorithms as any } : {}),
        });
      };

      const onError = (err: Error & { level?: string; code?: string }) => {
        if (settled) return;
        settled = true;
        cleanup();

        const msg = err.message.toLowerCase();

        // Algorithm mismatch — retry with legacy-compatible algorithms
        if (
          msg.includes("no matching key exchange") ||
          msg.includes("no matching host key") ||
          msg.includes("no matching cipher") ||
          msg.includes("no matching mac") ||
          msg.includes("no suitable") ||
          msg.includes("algorithm") ||
          msg.includes("handshake failed")
        ) {
          const fallback = new Client();

          fallback.on("ready", () => {
            if (settled) return;
            settled = true;
            cleanup(fallback);

            if (!entry) {
              entry = {
                client: fallback,
                refCount: 1,
                connected: true,
                onDisconnect: new Set(),
              };
            } else {
              entry.client = fallback;
              entry.connected = true;
            }

            fallback.on("close", () => {
              if (entry) {
                entry.connected = false;
                for (const handler of entry.onDisconnect) {
                  try { handler(host); } catch { /* swallow */ }
                }
                entry.onDisconnect.clear();
              }
              this.clients.delete(host);
            });

            this.clients.set(host, entry!);
            resolve(fallback);
          });

          fallback.on("error", (fallbackErr) => {
            if (settled) return;
            settled = true;
            cleanup(fallback);
            reject(new ConnectionError(
              CONNECT_FAILED,
              `SSH algorithm negotiation failed. Tried modern + legacy algorithms. ` +
              `Last error: ${(fallbackErr as Error).message}`
            ));
          });
          // Legacy algorithms for old devices (routers, switches, old Linux, BMC/IPMI)
          fallback.connect({
            host: resolved.host,
            port: resolved.port,
            username: resolved.username,
            privateKey,
            password: resolved.password,
            readyTimeout: DEFAULT_READY_TIMEOUT,
            keepaliveInterval: KEEPALIVE_INTERVAL,
            keepaliveCountMax: KEEPALIVE_COUNT_MAX,
            hostVerifier: () => true,
            algorithms: {
              kex: [
                "diffie-hellman-group-exchange-sha256",
                "diffie-hellman-group14-sha256",
                "diffie-hellman-group14-sha1",
                "diffie-hellman-group1-sha1",
                "diffie-hellman-group-exchange-sha1",
                "ecdh-sha2-nistp256",
                "ecdh-sha2-nistp384",
                "ecdh-sha2-nistp521",
              ],
              serverHostKey: [
                "ssh-ed25519",
                "ecdsa-sha2-nistp256",
                "rsa-sha2-512",
                "rsa-sha2-256",
                "ssh-rsa",
                "ssh-dss",
              ],
              cipher: [
                "aes128-ctr",
                "aes192-ctr",
                "aes256-ctr",
                "aes128-gcm@openssh.com",
                "aes256-gcm@openssh.com",
                "aes128-cbc",
                "aes192-cbc",
                "aes256-cbc",
                "3des-cbc",
              ],
              hmac: [
                "hmac-sha2-256",
                "hmac-sha2-512",
                "hmac-sha1",
                "hmac-md5",
              ],
            } as any,
          });
          return;
        }

        const level = err.level;
        const status = level === "client-socket" ? CONNECT_FAILED : AUTH_FAILED;
        reject(new ConnectionError(status, err.message));
      };

      client.on("error", onError);
      tryConnect();
    });
  }

  /**
   * Create an SSH shell channel WITHOUT a pseudo-terminal (PTY).
   *
   * Use this for programmatic command execution where raw stdout/stderr
   * separation is desired. The caller owns the returned channel and is
   * responsible for reading, writing, and closing it.
   *
   * @param host - The preset host name.
   * @returns A connected shell channel (stderr is available separately).
   * @throws {ConnectionError} On connection or channel-open failure.
   */
  async createShellChannel(host: string): Promise<ChannelResult> {
    const client = await this.getClient(host);

    return new Promise<ChannelResult>((resolve, reject) => {
      client.shell(false, (err, channel) => {
        if (err) {
          reject(
            new ConnectionError(CONNECT_FAILED, `Shell channel failed: ${err.message}`),
          );
          return;
        }
        resolve({ client, channel });
      });
    });
  }

  /**
   * Create an SSH shell channel WITH a pseudo-terminal (PTY).
   *
   * Use this for interactive tmux sessions where terminal dimensions
   * and a TERM value are required. The caller owns the returned channel
   * and is responsible for reading, writing, and closing it.
   *
   * When a PTY is allocated, stdout and stderr are merged into the
   * single readable stream.
   *
   * @param host - The preset host name.
   * @param opts - Optional PTY dimensions and terminal type.
   * @returns A connected PTY shell channel.
   * @throws {ConnectionError} On connection or channel-open failure.
   */
  async createPtyChannel(
    host: string,
    opts: { rows?: number; cols?: number; term?: string } = {},
  ): Promise<ChannelResult> {
    const client = await this.getClient(host);

    const rows = opts.rows ?? DEFAULT_ROWS;
    const cols = opts.cols ?? DEFAULT_COLS;
    const term = opts.term ?? DEFAULT_TERM;

    return new Promise<ChannelResult>((resolve, reject) => {
      client.shell({ rows, cols, term }, (err, channel) => {
        if (err) {
          reject(
            new ConnectionError(CONNECT_FAILED, `PTY channel failed: ${err.message}`),
          );
          return;
        }
        resolve({ client, channel });
      });
    });
  }

  /**
   * Release a client reference for the given host.
   *
   * Decrements the internal refCount. When the refCount reaches zero,
   * the underlying ssh2 Client is terminated via `end()` and removed
   * from the pool.
   *
   * @param host - The preset host name.
   */
  releaseClient(host: string): void {
    const entry = this.clients.get(host);
    if (!entry) return;

    entry.refCount--;

    if (entry.refCount <= 0) {
      this.clients.delete(host);
      entry.client.end();
    }
  }

  /**
   * Check whether the SSH connection for a host is currently alive.
   *
   * @param host - The preset host name.
   * @returns `true` if the client exists and is connected.
   */
  isConnected(host: string): boolean {
    const entry = this.clients.get(host);
    return entry !== undefined && entry.connected;
  }

  /**
   * Register a handler to be called when the SSH connection drops.
   *
   * The handler receives the host name. If the connection is already
   * dead when this is called, the handler fires immediately.
   *
   * @param host - The preset host name to watch.
   * @param handler - Callback invoked on disconnect.
   */
  onDisconnect(host: string, handler: DisconnectHandler): void {
    const entry = this.clients.get(host);
    if (!entry) {
      // No entry = already gone. Fire immediately.
      handler(host);
      return;
    }
    entry.onDisconnect.add(handler);
  }
}
