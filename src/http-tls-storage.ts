import { randomBytes } from "node:crypto";
import { open, rename, unlink, chmod, lstat } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { failAfterCleanup, orderedTeardown } from "./lifecycle.js";

function ignoreMissing(error: unknown): undefined {
  if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") throw error;
  return undefined;
}

async function unlinkOwnedLock(path: string, identity: { dev: number; ino: number }): Promise<void> {
  const current = await lstat(path).catch(ignoreMissing);
  if (current && current.dev === identity.dev && current.ino === identity.ino) {
    await unlink(path).catch(ignoreMissing);
  }
}

export async function writePrivateFile(path: string, data: string): Promise<void> {
  const temp = `${path}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
  let handle: FileHandle | undefined;
  try {
    handle = await open(temp, "wx", 0o600);
    await handle.writeFile(data, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temp, path);
    await chmod(path, 0o600);
  } catch (error) {
    if (handle) await handle.close().catch(() => undefined);
    await unlink(temp).catch(() => undefined);
    throw error;
  }
}

export class AcmeStorageLock {
  private handle: FileHandle | undefined;
  private identity: { dev: number; ino: number } | undefined;
  private directory: string | undefined;

  get acquired(): boolean {
    return this.handle !== undefined;
  }

  async acquire(directory: string): Promise<void> {
    const path = `${directory}/issue.lock`;
    try {
      const handle = await open(path, "wx", 0o600);
      try {
        await handle.writeFile(`${process.pid}\n`, "utf8");
        const stat = await handle.stat();
        this.handle = handle;
        this.identity = { dev: stat.dev, ino: stat.ino };
        this.directory = directory;
      } catch (error) {
        return failAfterCleanup(error, () => orderedTeardown([
          async () => unlinkOwnedLock(path, await handle.stat()),
          () => handle.close(),
        ], "ACME lock cleanup failed"), "ACME lock initialization and cleanup failed");
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === "EEXIST") {
        throw new Error("ACME storage is locked by another process", { cause: error });
      }
      throw error;
    }
  }

  async release(directory = this.directory): Promise<void> {
    await orderedTeardown([
      async () => {
        const identity = this.identity;
        this.identity = undefined;
        this.directory = undefined;
        if (identity && directory) {
          const path = `${directory}/issue.lock`;
          await unlinkOwnedLock(path, identity);
        }
      },
      async () => {
        await this.handle?.close();
        this.handle = undefined;
      },
    ], "ACME storage lock cleanup failed");
  }
}
