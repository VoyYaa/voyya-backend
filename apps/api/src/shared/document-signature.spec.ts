import { detectDocumentContentType } from './document-signature';

describe('detectDocumentContentType', () => {
  it('detects a PDF by its magic bytes', () => {
    const buffer = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34]);
    expect(detectDocumentContentType(buffer)).toBe('application/pdf');
  });

  it('detects a JPEG by its magic bytes', () => {
    const buffer = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);
    expect(detectDocumentContentType(buffer)).toBe('image/jpeg');
  });

  it('detects a PNG by its magic bytes', () => {
    const buffer = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    expect(detectDocumentContentType(buffer)).toBe('image/png');
  });

  it('returns null for content that does not match any allowed signature', () => {
    const buffer = Buffer.from('<html></html>');
    expect(detectDocumentContentType(buffer)).toBeNull();
  });

  it('returns null for a buffer shorter than the shortest signature', () => {
    expect(detectDocumentContentType(Buffer.from([0xff]))).toBeNull();
  });

  it('does not trust a Content-Type claimed by the client, only the bytes', () => {
    const htmlDisguisedAsPdf = Buffer.from('<script>alert(1)</script>');
    expect(detectDocumentContentType(htmlDisguisedAsPdf)).toBeNull();
  });
});
