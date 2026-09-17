import type { NestExpressApplication } from '@nestjs/platform-express';
import { configureApp } from './main';
import type { EnvService } from './config/env.service';

function fakeEnv(corsOrigins: string): EnvService {
  return { get: () => corsOrigins } as unknown as EnvService;
}

function fakeApp() {
  const httpInstance = { disable: jest.fn() };
  const app = {
    set: jest.fn(),
    use: jest.fn(),
    getHttpAdapter: jest.fn().mockReturnValue({ getInstance: () => httpInstance }),
    enableCors: jest.fn(),
    useGlobalFilters: jest.fn(),
  };
  return { app: app as unknown as NestExpressApplication, httpInstance, raw: app };
}

describe('configureApp', () => {
  it('trusts exactly one hop from the Railway proxy (B-03 item 3): req.ip must come from X-Forwarded-For, not be spoofable beyond one hop', () => {
    const { app, raw } = fakeApp();
    configureApp(app, fakeEnv(''));
    expect(raw.set).toHaveBeenCalledWith('trust proxy', 1);
  });

  it('disables x-powered-by and installs helmet + the global exception filter', () => {
    const { app, raw, httpInstance } = fakeApp();
    configureApp(app, fakeEnv(''));
    expect(raw.use).toHaveBeenCalledTimes(1);
    expect(httpInstance.disable).toHaveBeenCalledWith('x-powered-by');
    expect(raw.useGlobalFilters).toHaveBeenCalledTimes(1);
  });

  it('no CORS_ORIGINS configured -> origin: false (blocks all cross-origin browsers)', () => {
    const { app, raw } = fakeApp();
    configureApp(app, fakeEnv(''));
    expect(raw.enableCors).toHaveBeenCalledWith({ origin: false, credentials: true });
  });

  it('CORS_ORIGINS with entries -> trims and forwards them as the allow-list', () => {
    const { app, raw } = fakeApp();
    configureApp(app, fakeEnv(' https://a.test , https://b.test '));
    expect(raw.enableCors).toHaveBeenCalledWith({
      origin: ['https://a.test', 'https://b.test'],
      credentials: true,
    });
  });
});
