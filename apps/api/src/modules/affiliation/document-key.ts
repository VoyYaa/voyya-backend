import { randomUUID } from 'node:crypto';
import { ConflictException } from '@nestjs/common';
import type { DocumentContentType } from '@voyyaa/shared';

const EXTENSIONS: Record<DocumentContentType, string> = {
  'application/pdf': 'pdf',
  'image/jpeg': 'jpg',
  'image/png': 'png',
};

const STAGED_KEY_PATTERN = /^staging\/\d{4}\/\d{2}\/\d{2}\/[A-Za-z0-9_-]{1,120}\.(pdf|jpg|png)$/;

export function extensionFor(contentType: DocumentContentType): string {
  return EXTENSIONS[contentType];
}

export function stagingKey(contentType: DocumentContentType, now = new Date()): string {
  const yyyy = now.getUTCFullYear();
  const mm = String(now.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(now.getUTCDate()).padStart(2, '0');
  return `staging/${yyyy}/${mm}/${dd}/${randomUUID()}.${extensionFor(contentType)}`;
}

export function isStagedDocumentKey(key: string): boolean {
  return STAGED_KEY_PATTERN.test(key);
}

export function assertStagedDocumentKey(key: string, field?: string): void {
  if (isStagedDocumentKey(key)) return;
  throw new ConflictException({
    code: 'DOCUMENT_NOT_FOUND',
    message: 'Uno de los documentos cargados ya no está disponible, vuelve a cargarlo',
    ...(field === undefined ? {} : { field }),
  });
}

export function companyDocumentKey(
  companyId: number,
  documentType: string,
  contentType: string,
): string {
  const ext = contentType.split('/')[1] ?? 'bin';
  return `companies/${companyId}/${documentType}/${randomUUID()}.${ext}`;
}

export function driverDocumentKey(
  companyId: number,
  driverId: number,
  documentType: string,
  contentType: string,
): string {
  const ext = contentType.split('/')[1] ?? 'bin';
  return `drivers/${companyId}/${driverId}/${documentType}/${randomUUID()}.${ext}`;
}

export function basename(key: string): string {
  const idx = key.lastIndexOf('/');
  return idx === -1 ? key : key.slice(idx + 1);
}
