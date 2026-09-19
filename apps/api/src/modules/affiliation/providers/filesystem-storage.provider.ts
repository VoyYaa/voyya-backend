import { createReadStream } from 'node:fs';
import { mkdir, readdir, readFile, rm, stat, statfs, writeFile } from 'node:fs/promises';
import { dirname, join, relative, isAbsolute, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import type { Readable } from 'node:stream';
import { Injectable } from '@nestjs/common';
import type { FileStorageProvider, StoredObject } from '../ports/file-storage.port';

@Injectable()
export class FilesystemStorageProvider implements FileStorageProvider {
  private readonly root: string;

  constructor(root = join(tmpdir(), 'voyya-documents')) {
    this.root = resolve(root);
  }

  async put(input: { key: string; body: Buffer; contentType: string }): Promise<StoredObject> {
    const path = this.pathFor(input.key);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, input.body);
    await writeFile(`${path}.meta.json`, JSON.stringify({ contentType: input.contentType }));
    return { storageKey: input.key, contentType: input.contentType, sizeBytes: input.body.length };
  }

  async stat(key: string): Promise<StoredObject | null> {
    const path = this.pathFor(key);
    try {
      const info = await stat(path);
      const contentType = await this.readContentType(path);
      return { storageKey: key, contentType, sizeBytes: info.size };
    } catch {
      return null;
    }
  }

  async move(fromKey: string, toKey: string): Promise<StoredObject> {
    const existing = await this.stat(fromKey);
    if (!existing) {
      throw new Error(`FilesystemStorageProvider: object not found for key=${fromKey}`);
    }
    const body = await readFile(this.pathFor(fromKey));
    const moved = await this.put({ key: toKey, body, contentType: existing.contentType });
    await this.remove([fromKey]);
    return moved;
  }

  async read(key: string): Promise<Readable | null> {
    const exists = await this.stat(key);
    if (!exists) return null;
    return createReadStream(this.pathFor(key));
  }

  async remove(keys: readonly string[]): Promise<void> {
    for (const key of keys) {
      await rm(this.pathFor(key), { force: true });
      await rm(`${this.pathFor(key)}.meta.json`, { force: true });
    }
  }

  async listOlderThan(prefix: string, olderThan: Date): Promise<readonly string[]> {
    const dir = this.pathFor(prefix);
    let entries: string[];
    try {
      entries = await this.walk(dir);
    } catch {
      return [];
    }
    const stale: string[] = [];
    for (const filePath of entries) {
      if (filePath.endsWith('.meta.json')) continue;
      const info = await stat(filePath);
      if (info.mtime < olderThan) {
        stale.push(this.keyFor(filePath));
      }
    }
    return stale;
  }

  async freeBytes(): Promise<number> {
    const info = await statfs(this.root);
    return info.bavail * info.bsize;
  }

  private async walk(dir: string): Promise<string[]> {
    const entries = await readdir(dir, { withFileTypes: true });
    const files: string[] = [];
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        files.push(...(await this.walk(full)));
      } else {
        files.push(full);
      }
    }
    return files;
  }

  private async readContentType(path: string): Promise<string> {
    try {
      const meta = JSON.parse(await readFile(`${path}.meta.json`, 'utf8')) as {
        contentType?: string;
      };
      return meta.contentType ?? 'application/octet-stream';
    } catch {
      return 'application/octet-stream';
    }
  }

  private pathFor(key: string): string {
    const resolved = join(this.root, key);
    const inside = relative(this.root, resolved);
    if (inside.startsWith(`..`) || isAbsolute(inside)) {
      throw new Error(`FilesystemStorageProvider: key escapes the storage root`);
    }
    return resolved;
  }

  private keyFor(path: string): string {
    return relative(this.root, path).replace(/\\/g, '/');
  }
}
