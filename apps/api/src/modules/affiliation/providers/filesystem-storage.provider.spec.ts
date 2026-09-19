import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { FilesystemStorageProvider } from './filesystem-storage.provider';

function readAll(stream: NodeJS.ReadableStream): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    stream.on('data', (chunk: Buffer) => chunks.push(chunk));
    stream.on('end', () => resolve(Buffer.concat(chunks)));
    stream.on('error', reject);
  });
}

describe('FilesystemStorageProvider — against a real directory (ADR-021 §9.7.14)', () => {
  let root: string;
  let provider: FilesystemStorageProvider;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'voyya-fs-provider-test-'));
    provider = new FilesystemStorageProvider(root);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('runs the full put -> stat -> move -> read -> remove cycle with the same bytes throughout', async () => {
    const key = 'companies/1/chamber_of_commerce/original.pdf';
    const body = Buffer.from('%PDF-1.4 real bytes for the round trip test');

    const putResult = await provider.put({ key, body, contentType: 'application/pdf' });
    expect(putResult).toEqual({ storageKey: key, contentType: 'application/pdf', sizeBytes: body.length });
    expect(existsSync(join(root, key))).toBe(true);

    const statResult = await provider.stat(key);
    expect(statResult).toEqual({ storageKey: key, contentType: 'application/pdf', sizeBytes: body.length });

    const movedKey = 'companies/1/chamber_of_commerce/final.pdf';
    const moveResult = await provider.move(key, movedKey);
    expect(moveResult.storageKey).toBe(movedKey);
    expect(moveResult.contentType).toBe('application/pdf');
    expect(existsSync(join(root, key))).toBe(false);
    expect(existsSync(join(root, movedKey))).toBe(true);

    const stream = await provider.read(movedKey);
    expect(stream).not.toBeNull();
    const bytesRead = await readAll(stream as NodeJS.ReadableStream);
    expect(bytesRead.equals(body)).toBe(true);

    await provider.remove([movedKey]);
    expect(existsSync(join(root, movedKey))).toBe(false);

    const afterRemove = await provider.read(movedKey);
    expect(afterRemove).toBeNull();
    const statAfterRemove = await provider.stat(movedKey);
    expect(statAfterRemove).toBeNull();
  });

  it('read() returns null for a key that was never written', async () => {
    const result = await provider.read('companies/1/chamber_of_commerce/never-existed.pdf');
    expect(result).toBeNull();
  });

  it('listOlderThan finds a stale object and put/stat/move keep the .meta.json content-type sidecar honest', async () => {
    const key = 'staging/2026/01/01/stale.pdf';
    await provider.put({ key, body: Buffer.from('stale'), contentType: 'application/pdf' });

    const stale = await provider.listOlderThan('staging', new Date(Date.now() + 60_000));
    expect(stale).toContain(key);

    const notStale = await provider.listOlderThan('staging', new Date(Date.now() - 60_000));
    expect(notStale).not.toContain(key);
  });

  describe('path containment (C-02): read() must inherit pathFor and never escape the root', () => {
    let outsideFile: string;
    const outsideContent = 'top secret, outside the storage root';

    beforeEach(() => {
      outsideFile = join(dirname(root), `voyya-fs-provider-outside-${Date.now()}.txt`);
      writeFileSync(outsideFile, outsideContent);
    });

    afterEach(() => {
      rmSync(outsideFile, { force: true });
    });

    it('read() rejects a key that escapes the root via ../ and never touches the outside file', async () => {
      const escapingKey = `../${outsideFile.slice(dirname(root).length + 1)}`;

      await expect(provider.read(escapingKey)).rejects.toThrow(/escapes the storage root/);

      expect(readFileSync(outsideFile, 'utf8')).toBe(outsideContent);
    });

    it('read() rejects a deeply nested ../.. traversal key', async () => {
      await expect(provider.read('companies/1/../../../../etc/passwd')).rejects.toThrow(
        /escapes the storage root/,
      );
    });

    it('stat(), put(), move() and remove() all reject the same escaping key (contention is on pathFor, not per-method)', async () => {
      const escapingKey = `../${outsideFile.slice(dirname(root).length + 1)}`;
      const legitSourceKey = 'companies/1/x.pdf';
      await provider.put({ key: legitSourceKey, body: Buffer.from('x'), contentType: 'application/pdf' });

      await expect(provider.stat(escapingKey)).rejects.toThrow(/escapes the storage root/);
      await expect(
        provider.put({ key: escapingKey, body: Buffer.from('x'), contentType: 'application/pdf' }),
      ).rejects.toThrow(/escapes the storage root/);
      await expect(provider.move(legitSourceKey, escapingKey)).rejects.toThrow(
        /escapes the storage root/,
      );
      await expect(provider.remove([escapingKey])).rejects.toThrow(/escapes the storage root/);

      expect(readFileSync(outsideFile, 'utf8')).toBe(outsideContent);
      expect(existsSync(join(root, legitSourceKey))).toBe(true);
    });
  });
});
