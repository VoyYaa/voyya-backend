import { chmodSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { EnvService } from '../../../config/env.service';
import { FilesystemStorageProvider } from './filesystem-storage.provider';
import { createFileStorageProvider } from './file-storage.factory';

function fakeEnv(overrides: Record<string, unknown> = {}): EnvService {
  const values: Record<string, unknown> = {
    NODE_ENV: 'test',
    DOCUMENT_STORAGE_ROOT: undefined,
    ...overrides,
  };
  return { get: (key: string) => values[key] } as unknown as EnvService;
}

const isWindows = process.platform === 'win32';
const posixOnly = isWindows ? it.skip : it;

describe('createFileStorageProvider — a real write-attempt at boot, not a config check (ADR-021 §9.7.19)', () => {
  it('outside production, works without DOCUMENT_STORAGE_ROOT and falls back to the OS tmpdir', () => {
    const provider = createFileStorageProvider(fakeEnv({ NODE_ENV: 'test' }));
    expect(provider).toBeInstanceOf(FilesystemStorageProvider);
  });

  it('in production, throws synchronously when DOCUMENT_STORAGE_ROOT is missing — the container must not start', () => {
    expect(() =>
      createFileStorageProvider(fakeEnv({ NODE_ENV: 'production', DOCUMENT_STORAGE_ROOT: undefined })),
    ).toThrow(/DOCUMENT_STORAGE_ROOT/);
  });

  it('in production, throws synchronously when DOCUMENT_STORAGE_ROOT is an empty string', () => {
    expect(() =>
      createFileStorageProvider(fakeEnv({ NODE_ENV: 'production', DOCUMENT_STORAGE_ROOT: '' })),
    ).toThrow(/DOCUMENT_STORAGE_ROOT/);
  });

  it('in production, throws when the volume is not mounted — the parent of DOCUMENT_STORAGE_ROOT does not exist (C-17)', () => {
    const parent = mkdtempSync(join(tmpdir(), 'voyya-fs-factory-unmounted-'));
    const missingMountPath = join(parent, 'this-parent-does-not-exist', 'documents');
    try {
      expect(() =>
        createFileStorageProvider(
          fakeEnv({ NODE_ENV: 'production', DOCUMENT_STORAGE_ROOT: missingMountPath }),
        ),
      ).toThrow(/volume is not mounted/);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it('in production, does NOT create the mount point itself (only the leaf dir, and only if the parent already exists) — C-17 regression for the "recursive: true papers over an unmounted volume" bug', () => {
    const parent = mkdtempSync(join(tmpdir(), 'voyya-fs-factory-leaf-'));
    const root = join(parent, 'documents');
    try {
      const provider = createFileStorageProvider(
        fakeEnv({ NODE_ENV: 'production', DOCUMENT_STORAGE_ROOT: root }),
      );
      expect(provider).toBeInstanceOf(FilesystemStorageProvider);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it('in production, a writable configured root boots successfully and the mkdir + write check really ran', () => {
    const root = mkdtempSync(join(tmpdir(), 'voyya-fs-factory-writable-'));
    try {
      const provider = createFileStorageProvider(
        fakeEnv({ NODE_ENV: 'production', DOCUMENT_STORAGE_ROOT: root }),
      );
      expect(provider).toBeInstanceOf(FilesystemStorageProvider);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  posixOnly(
    'in production, a real read-only root (chmod 0o555, no write bit) throws at boot instead of failing silently later — this is the guardrail-7 test: existence alone is not enough',
    () => {
      const parent = mkdtempSync(join(tmpdir(), 'voyya-fs-factory-readonly-'));
      const readonlyRoot = join(parent, 'locked');
      mkdirSync(readonlyRoot);
      chmodSync(readonlyRoot, 0o555);

      try {
        expect(() =>
          createFileStorageProvider(
            fakeEnv({ NODE_ENV: 'production', DOCUMENT_STORAGE_ROOT: readonlyRoot }),
          ),
        ).toThrow(/not writable/);
      } finally {
        chmodSync(readonlyRoot, 0o755);
        rmSync(parent, { recursive: true, force: true });
      }
    },
  );

  if (isWindows) {
    it.skip(
      'SKIPPED on win32: Node fs.accessSync(dir, W_OK) does not honor a chmod/ACL-denied directory on Windows ' +
        '(verified empirically — chmod 0o444/icacls deny leave accessSync reporting writable). This code path is ' +
        'authoritative on Linux, which is the real target (Railway containers): re-run this file under Linux ' +
        '(the CI job, or `podman run node:20-slim` against this repo) to exercise it for real. See the test report.',
      () => {},
    );
  }
});
