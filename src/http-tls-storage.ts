import { randomBytes } from "node:crypto";
import { open, rename, unlink, chmod, lstat } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";

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
        await handle.close().catch(() => undefined);
        await unlink(path).catch(() => undefined);
        throw error;
      }
    } catch (error) {
      throw new Error("ACME storage is locked by another process", { cause: error });
    }
  }

  async release(directory = this.directory): Promise<void> {
    const identity = this.identity;
    if (identity && directory) {
      const path = `${directory}/issue.lock`;
      const current = await lstat(path).catch(() => undefined);
      if (current && current.dev === identity.dev && current.ino === identity.ino) {
        await unlink(path).catch(() => undefined);
      }
    }
    await this.handle?.close().catch(() => undefined);
    this.handle = undefined;
    this.identity = undefined;
    this.directory = undefined;
  }
}
