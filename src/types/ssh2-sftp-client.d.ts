// Minimal type declarations for ssh2-sftp-client.
// ssh2-sftp-client v10 does not ship with bundled types and
// @types/ssh2-sftp-client does not exist on DefinitelyTyped.

declare module "ssh2-sftp-client" {
  import type { ConnectConfig } from "ssh2";

  class SftpClient {
    constructor(clientName?: string);

    /**
     * Establish SSH connection and open an SFTP channel.
     *
     * The config object is passed directly to the underlying ssh2
     * `Client.connect()`. Supports host, port, username, privateKey,
     * password, and other ssh2 ConnectConfig fields.
     */
    connect(config: ConnectConfig & Record<string, unknown>): Promise<unknown>;

    /**
     * Upload a local file to the remote host using ssh2's fastPut.
     * Uses parallel reads/writes for large files.
     */
    fastPut(localPath: string, remotePath: string, options?: Record<string, unknown>): Promise<string>;

    /**
     * Download a remote file to a local path using ssh2's fastGet.
     * Uses parallel reads/writes for large files.
     */
    fastGet(remotePath: string, localPath: string, options?: Record<string, unknown>): Promise<string>;

    /**
     * Close the SFTP channel and end the SSH connection.
     */
    end(): Promise<boolean>;
  }

  export { SftpClient };
  export default SftpClient;
}
