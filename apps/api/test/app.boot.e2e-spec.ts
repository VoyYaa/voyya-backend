import { Test } from '@nestjs/testing';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/infrastructure/prisma/prisma.service';

describe('AppModule (boot / wiring)', () => {
  beforeAll(() => {
    process.env.JWT_SECRET = 'test-jwt-secret-0123456789-abcdefghij';
    process.env.QUOTE_TOKEN_SECRET = 'test-quote-secret-0123456789-abcdefghij';
    process.env.DATABASE_URL = 'postgresql://u:p@localhost:5432/db?schema=public';
  });

  it('compiles the root module with all providers resolved', async () => {
    const prismaStub = {
      onModuleInit: async () => undefined,
      onModuleDestroy: async () => undefined,
      $connect: async () => undefined,
      $disconnect: async () => undefined,
    };

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PrismaService)
      .useValue(prismaStub)
      .compile();

    const app = moduleRef.createNestApplication();
    await app.init();
    expect(app).toBeDefined();
    await app.close();
  });
});
