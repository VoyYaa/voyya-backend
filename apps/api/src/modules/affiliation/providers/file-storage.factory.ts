import { accessSync, constants, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { EnvService } from '../../../config/env.service';
import type { FileStorageProvider } from '../ports/file-storage.port';
import { FilesystemStorageProvider } from './filesystem-storage.provider';

export function createFileStorageProvider(env: EnvService): FileStorageProvider {
  const configuredRoot = env.get('DOCUMENT_STORAGE_ROOT');

  if (env.get('NODE_ENV') === 'production') {
    if (!configuredRoot) {
      throw new Error(
        'STORAGE: missing DOCUMENT_STORAGE_ROOT and the local stub is forbidden in production. ' +
          'Mount the Railway volume and configure it to enable document uploads.',
      );
    }
    const parent = dirname(configuredRoot);
    if (!existsSync(parent)) {
      throw new Error(
        `STORAGE: the volume is not mounted at ${parent} (DOCUMENT_STORAGE_ROOT=${configuredRoot}). ` +
          'Check the Railway volume Mount path before starting the container.',
      );
    }
    try {
      if (!existsSync(configuredRoot)) {
        mkdirSync(configuredRoot);
      }
      accessSync(configuredRoot, constants.W_OK);
    } catch (error) {
      throw new Error(
        `STORAGE: DOCUMENT_STORAGE_ROOT (${configuredRoot}) is not writable: ${errorMessage(error)}`,
      );
    }
    return new FilesystemStorageProvider(configuredRoot);
  }

  return new FilesystemStorageProvider(configuredRoot ?? join(tmpdir(), 'voyya-documents'));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
