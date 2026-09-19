import type { Readable } from 'node:stream';

export const FILE_STORAGE = Symbol('FILE_STORAGE');

export interface StoredObject {
  storageKey: string;
  contentType: string;
  sizeBytes: number;
}

export interface FileStorageProvider {
  put(input: { key: string; body: Buffer; contentType: string }): Promise<StoredObject>;
  stat(key: string): Promise<StoredObject | null>;
  move(fromKey: string, toKey: string): Promise<StoredObject>;
  read(key: string): Promise<Readable | null>;
  remove(keys: readonly string[]): Promise<void>;
  listOlderThan(prefix: string, olderThan: Date): Promise<readonly string[]>;
  freeBytes(): Promise<number>;
}
