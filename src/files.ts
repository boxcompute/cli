import { link, lstat, mkdtemp, open, rm, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { BoxComputeClient, FILE_CHUNK_BYTES, validateFilePath } from "./client.js";

export async function uploadFile(client: BoxComputeClient, id: string, local: string, remote: string): Promise<number> {
  validateFilePath(remote);
  if (!(await stat(local)).isFile()) throw new Error("Upload source must be a regular file");
  const file = await open(local, "r");
  try {
    const stat = await file.stat();
    if (!stat.isFile()) throw new Error("Upload source must be a regular file");
    if (stat.size > FILE_CHUNK_BYTES) throw new Error("Uploads are limited to 8 MiB");
    // Read at most the limit plus one byte even if the file grows after stat.
    const buffer = Buffer.alloc(FILE_CHUNK_BYTES + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await file.read(buffer, length, buffer.length - length, null);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length > FILE_CHUNK_BYTES) throw new Error("Uploads are limited to 8 MiB");
    await client.upload(id, remote, buffer.subarray(0, length));
    return length;
  } finally {
    await file.close();
  }
}

export async function downloadFile(client: BoxComputeClient, id: string, remote: string, local: string): Promise<number> {
  validateFilePath(remote);
  const target = resolve(local);
  try {
    await lstat(target);
    throw new Error("Download destination already exists; choose a new path");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  // Keep partial data private and publish only a complete, consistent file.
  const temporary = await mkdtemp(join(dirname(target), ".bxc-download-"));
  const staged = join(temporary, "content");
  try {
    const file = await open(staged, "wx", 0o600);
    let offset = 0;
    let size: number | undefined;
    let cursor: string | undefined;
    const signal = AbortSignal.timeout(300_000);
    try {
      for (;;) {
        const chunk = await client.readFile(id, remote, offset, cursor, signal);
        if (size !== undefined && chunk.size !== size) throw new Error("File size changed during download; restart the download");
        size = chunk.size;
        await file.writeFile(chunk.bytes);
        offset = chunk.nextOffset;
        cursor = chunk.nextCursor;
        if (chunk.eof) break;
      }
    } finally {
      await file.close();
    }
    // link is atomic and refuses an existing destination, including symlinks.
    await link(staged, target);
    return offset;
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
