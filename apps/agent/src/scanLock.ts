import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";

interface LockRecord {
  kind?: string;
  version?: number;
  pid?: number;
  token?: string;
  at?: number;
  host?: string;
  port?: number;
  transport?: "pipe";
  pipeName?: string;
}

interface ProcessLockOptions {
  /** Respect the pid/at files written by agents predating socket locks. */
  honorLegacyOwner?: boolean;
}

const HOST = "127.0.0.1";
const KIND = "driveos-process-lock";
const INCOMPLETE_LEGACY_WRITE_GRACE_MS = 5_000;

function readRecord(lockPath: string): LockRecord | undefined {
  try {
    return JSON.parse(fs.readFileSync(lockPath, "utf8"));
  } catch {
    return undefined;
  }
}

function processMayBeAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // Permission failures are not evidence that the owner exited.
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

function closeServer(server: net.Server): Promise<void> {
  if (!server.listening) return Promise.resolve();
  return new Promise(resolve => server.close(() => resolve()));
}

/**
 * An OS-held mutex shared by agent processes using the same absolute lock path.
 *
 * Windows uses a named pipe, avoiding reserved/occupied ephemeral TCP ports.
 * Node/libuv creates its first listening pipe with FILE_FLAG_FIRST_PIPE_INSTANCE
 * (deps/uv/src/win/pipe.c: uv_pipe_bind2), so independent servers cannot own it
 * concurrently. The OS removes the pipe on owner exit; no stale-path unlink or
 * age/PID-based takeover is required. Other platforms keep the loopback mutex.
 * JSON remains diagnostic metadata and a guard for older agent versions.
 */
export class ProcessLock {
  readonly lockPath: string;
  lastFailure?: string;
  private held?: { server: net.Server; token: string };
  private acquiring = false;

  constructor(lockPath: string, private readonly options: ProcessLockOptions = {}) {
    this.lockPath = path.resolve(lockPath);
  }

  async acquire(): Promise<boolean> {
    if (this.held || this.acquiring) {
      this.lastFailure = "This agent is already using this lock.";
      return false;
    }
    this.acquiring = true;
    let server: net.Server | undefined;
    try {
      fs.mkdirSync(path.dirname(this.lockPath), { recursive: true });
      let canonicalPath = path.join(fs.realpathSync.native(path.dirname(this.lockPath)), path.basename(this.lockPath));
      if (process.platform === "win32") canonicalPath = canonicalPath.toLowerCase();
      const digest = crypto.createHash("sha256").update(canonicalPath).digest();
      const port = 49152 + digest.readUInt16BE(0) % 16384;
      const pipeName = `\\\\.\\pipe\\driveos-lock-${digest.toString("hex")}`;
      const usePipe = process.platform === "win32";
      server = net.createServer(socket => socket.destroy());
      const listening = await new Promise<boolean>((resolve, reject) => {
        server!.once("error", (error: NodeJS.ErrnoException) => {
          if (error.code === "EADDRINUSE" || error.code === "EACCES") {
            this.lastFailure = usePipe
              ? `DriveOS lock pipe ${pipeName} is unavailable. Another agent may be working; wait for it to finish before retrying.`
              : `DriveOS lock port ${HOST}:${port} is unavailable. Another agent may be working; if it is not, check for another local listener using this port.`;
            resolve(false);
          } else reject(error);
        });
        if (usePipe) server!.listen({ path: pipeName, exclusive: true }, () => resolve(true));
        else server!.listen({ host: HOST, port, exclusive: true }, () => resolve(true));
      });
      if (!listening) return false;

      const previous = readRecord(this.lockPath);
      const currentRecord = previous?.kind === KIND && (usePipe
        ? previous.version === 3 && previous.transport === "pipe" && previous.pipeName === pipeName
        : previous.version === 2 && previous.host === HOST && previous.port === port);
      // An already-running TCP-lock agent does not own our new pipe. Honor its
      // live PID even for job locks that do not use the older v1 scan guard.
      const olderTcpRecord = usePipe && previous?.kind === KIND && previous.version === 2 && previous.host === HOST;
      if (!currentRecord && (this.options.honorLegacyOwner !== false || olderTcpRecord)) {
        if (previous && Number.isSafeInteger(previous.pid) && previous.pid! > 0 && processMayBeAlive(previous.pid!)) {
          this.lastFailure = `An older agent process (${previous.pid}) still holds this lock. Wait for it to finish or stop that agent before retrying.`;
          await closeServer(server);
          return false;
        }
        // An old agent may be between creating and writing its lock file.
        if (!previous && fs.existsSync(this.lockPath) && Date.now() - fs.statSync(this.lockPath).mtimeMs < INCOMPLETE_LEGACY_WRITE_GRACE_MS) {
          this.lastFailure = "An older agent may be writing its lock. Retry in a few seconds.";
          await closeServer(server);
          return false;
        }
      }

      const token = crypto.randomUUID();
      const record: LockRecord = { kind: KIND, pid: process.pid, token, at: Date.now(),
        ...(usePipe ? { version: 3, transport: "pipe", pipeName } : { version: 2, host: HOST, port }) };
      fs.writeFileSync(this.lockPath, JSON.stringify(record), { encoding: "utf8", mode: 0o600 });
      this.held = { server, token };
      this.lastFailure = undefined;
      return true;
    } catch (error) {
      if (server) await closeServer(server);
      throw error;
    } finally {
      this.acquiring = false;
    }
  }

  async release(): Promise<void> {
    const held = this.held;
    if (!held) return;
    // Keep the OS lock until after removing our metadata. Never erase a record
    // replaced externally or by a different owner.
    try {
      if (readRecord(this.lockPath)?.token === held.token) fs.rmSync(this.lockPath, { force: true });
    } finally {
      await closeServer(held.server);
      this.held = undefined;
    }
  }
}

export function createProcessLock(lockPath: string, options?: ProcessLockOptions): ProcessLock {
  return new ProcessLock(lockPath, options);
}
