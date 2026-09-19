import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import type { FileStorageProvider, StoredObject } from '../ports/file-storage.port';

export interface SupabaseStorageConfig {
  url: string;
  serviceRoleKey: string;
  bucket: string;
}

interface SupabaseListEntry {
  name: string;
  id: string | null;
  updated_at: string | null;
  metadata: { size?: number; mimetype?: string } | null;
}

@Injectable()
export class SupabaseStorageProvider implements FileStorageProvider {
  private readonly logger = new Logger(SupabaseStorageProvider.name);
  private readonly base: string;

  constructor(private readonly config: SupabaseStorageConfig) {
    this.base = `${config.url.replace(/\/+$/, '')}/storage/v1`;
  }

  async put(input: { key: string; body: Buffer; contentType: string }): Promise<StoredObject> {
    const res = await this.request(`/object/${this.config.bucket}/${input.key}`, {
      method: 'POST',
      headers: { 'Content-Type': input.contentType, 'x-upsert': 'true' },
      body: input.body,
    });
    if (!res.ok) throw this.unavailable('upload', res.status);
    return { storageKey: input.key, contentType: input.contentType, sizeBytes: input.body.length };
  }

  async stat(key: string): Promise<StoredObject | null> {
    const prefix = key.includes('/') ? key.slice(0, key.lastIndexOf('/')) : '';
    const name = key.includes('/') ? key.slice(key.lastIndexOf('/') + 1) : key;
    const res = await this.request(`/object/list/${this.config.bucket}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: Buffer.from(JSON.stringify({ prefix, search: name, limit: 100 })),
    });
    if (!res.ok) return null;
    const entries = (await res.json()) as SupabaseListEntry[];
    const found = entries.find((e) => e.name === name && e.id !== null);
    if (!found) return null;
    return {
      storageKey: key,
      contentType: found.metadata?.mimetype ?? 'application/octet-stream',
      sizeBytes: found.metadata?.size ?? 0,
    };
  }

  async move(fromKey: string, toKey: string): Promise<StoredObject> {
    const res = await this.request('/object/move', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: Buffer.from(
        JSON.stringify({ bucketId: this.config.bucket, sourceKey: fromKey, destinationKey: toKey }),
      ),
    });
    if (!res.ok) throw this.unavailable('move', res.status);
    const moved = await this.stat(toKey);
    if (!moved) throw this.unavailable('move', 404);
    return moved;
  }

  async signedUrl(key: string, ttlSeconds: number): Promise<string> {
    const res = await this.request(`/object/sign/${this.config.bucket}/${key}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: Buffer.from(JSON.stringify({ expiresIn: ttlSeconds })),
    });
    if (!res.ok) throw this.unavailable('sign', res.status);
    const body = (await res.json()) as { signedURL: string };
    return `${this.base}${body.signedURL}`;
  }

  async remove(keys: readonly string[]): Promise<void> {
    if (keys.length === 0) return;
    const res = await this.request(`/object/${this.config.bucket}`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: Buffer.from(JSON.stringify({ prefixes: keys })),
    });
    if (!res.ok) throw this.unavailable('remove', res.status);
  }

  async listOlderThan(prefix: string, olderThan: Date): Promise<readonly string[]> {
    const stale: string[] = [];
    await this.collectStale(prefix, olderThan, stale);
    return stale;
  }

  private async collectStale(prefix: string, olderThan: Date, acc: string[]): Promise<void> {
    const res = await this.request(`/object/list/${this.config.bucket}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: Buffer.from(JSON.stringify({ prefix, limit: 1000 })),
    });
    if (!res.ok) return;
    const entries = (await res.json()) as SupabaseListEntry[];
    for (const entry of entries) {
      const key = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.id === null) {
        await this.collectStale(key, olderThan, acc);
        continue;
      }
      if (entry.updated_at && new Date(entry.updated_at) < olderThan) {
        acc.push(key);
      }
    }
  }

  private async request(path: string, init: RequestInit): Promise<Response> {
    return fetch(`${this.base}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${this.config.serviceRoleKey}`,
        apikey: this.config.serviceRoleKey,
        ...init.headers,
      },
    });
  }

  private unavailable(op: string, status: number): ServiceUnavailableException {
    this.logger.error(`[storage:supabase] ${op} failed status=${status}`);
    return new ServiceUnavailableException({
      code: 'STORAGE_OPERATION_FAILED',
      message: 'No se pudo completar la operación de archivos',
    });
  }
}
