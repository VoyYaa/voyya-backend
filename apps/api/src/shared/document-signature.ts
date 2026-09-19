import type { DocumentContentType } from '@voyyaa/shared';

const SIGNATURES: Record<DocumentContentType, readonly number[]> = {
  'application/pdf': [0x25, 0x50, 0x44, 0x46],
  'image/jpeg': [0xff, 0xd8, 0xff],
  'image/png': [0x89, 0x50, 0x4e, 0x47],
};

export function detectDocumentContentType(buffer: Buffer): DocumentContentType | null {
  for (const [contentType, signature] of Object.entries(SIGNATURES) as Array<
    [DocumentContentType, readonly number[]]
  >) {
    if (matchesSignature(buffer, signature)) return contentType;
  }
  return null;
}

function matchesSignature(buffer: Buffer, signature: readonly number[]): boolean {
  if (buffer.length < signature.length) return false;
  return signature.every((byte, index) => buffer[index] === byte);
}
