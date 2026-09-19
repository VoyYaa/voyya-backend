import type { EnvService } from '../../config/env.service';
import { AffiliationLinkService } from './affiliation-link.service';
import { DocumentDownloadTokenService } from './document-download-token.service';

function fakeEnv(overrides: Record<string, unknown> = {}): EnvService {
  const values: Record<string, unknown> = {
    DOCUMENT_SIGNED_URL_TTL_SEC: 600,
    AFFILIATION_TOKEN_SECRET: 'test-secret-0123456789-abcdefghij-xyz',
    AFFILIATION_TOKEN_TTL_DAYS: 14,
    API_PUBLIC_URL: 'https://api.voyya.test',
    AFFILIATION_PORTAL_URL: 'https://admin.voyya.test',
    ...overrides,
  };
  return { get: (key: string) => values[key] } as unknown as EnvService;
}

const MINTED_BY = 900;

describe('DocumentDownloadTokenService', () => {
  it('signs a token and verifies it back to the same payload, including who minted it (C-18)', () => {
    const service = new DocumentDownloadTokenService(fakeEnv());

    const token = service.sign(42, 7, MINTED_BY);
    const result = service.verify(token);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.payload.companyDocumentId).toBe(42);
      expect(result.payload.companyId).toBe(7);
      expect(result.payload.mintedBy).toBe(MINTED_BY);
      expect(result.payload.purpose).toBe('document_download');
    }
  });

  it('builds a download URL rooted at API_PUBLIC_URL', () => {
    const service = new DocumentDownloadTokenService(fakeEnv());

    const url = service.buildUrl(42, 7, MINTED_BY);

    expect(url.startsWith('https://api.voyya.test/documents/')).toBe(true);
  });

  it('rejects a token with a tampered body', () => {
    const service = new DocumentDownloadTokenService(fakeEnv());
    const token = service.sign(42, 7, MINTED_BY);
    const [body, signature] = token.split('.') as [string, string];
    const tamperedPayload = {
      companyDocumentId: 999,
      companyId: 7,
      mintedBy: MINTED_BY,
      purpose: 'document_download',
      exp: 9999999999,
    };
    const tamperedBody = Buffer.from(JSON.stringify(tamperedPayload)).toString('base64url');

    const result = service.verify(`${tamperedBody}.${signature}`);

    expect(result).toEqual({ ok: false, reason: 'invalid' });
    expect(body).not.toBe(tamperedBody);
  });

  it('rejects a token whose mintedBy was tampered with, even keeping every other field intact', () => {
    const service = new DocumentDownloadTokenService(fakeEnv());
    const token = service.sign(42, 7, MINTED_BY);
    const [body, signature] = token.split('.') as [string, string];
    const original = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as Record<
      string,
      unknown
    >;
    const tamperedBody = Buffer.from(
      JSON.stringify({ ...original, mintedBy: 999999 }),
    ).toString('base64url');

    const result = service.verify(`${tamperedBody}.${signature}`);

    expect(result).toEqual({ ok: false, reason: 'invalid' });
  });

  it('rejects a malformed token', () => {
    const service = new DocumentDownloadTokenService(fakeEnv());

    expect(service.verify('not-a-real-token')).toEqual({ ok: false, reason: 'invalid' });
  });

  it('rejects a token signed with purpose=document_upload, even under the same secret', () => {
    const secret = 'shared-secret-0123456789-abcdefghij-xyz';
    const uploadLinkService = new AffiliationLinkService(fakeEnv({ AFFILIATION_TOKEN_SECRET: secret }));
    const downloadTokenService = new DocumentDownloadTokenService(fakeEnv({ AFFILIATION_TOKEN_SECRET: secret }));

    const uploadToken = uploadLinkService.sign(7);
    const result = downloadTokenService.verify(uploadToken);

    expect(result).toEqual({ ok: false, reason: 'invalid' });
  });

  it('mints a token that the upload verifier rejects, under the same secret', () => {
    const secret = 'shared-secret-0123456789-abcdefghij-xyz';
    const uploadLinkService = new AffiliationLinkService(fakeEnv({ AFFILIATION_TOKEN_SECRET: secret }));
    const downloadTokenService = new DocumentDownloadTokenService(fakeEnv({ AFFILIATION_TOKEN_SECRET: secret }));

    const downloadToken = downloadTokenService.sign(42, 7, MINTED_BY);
    const result = uploadLinkService.verify(downloadToken);

    expect(result).toEqual({ ok: false, reason: 'invalid' });
  });

  it('rejects an expired token', () => {
    const service = new DocumentDownloadTokenService(
      fakeEnv({ DOCUMENT_SIGNED_URL_TTL_SEC: -10 }),
    );

    const token = service.sign(42, 7, MINTED_BY);
    const result = service.verify(token);

    expect(result).toEqual({ ok: false, reason: 'expired' });
  });
});
