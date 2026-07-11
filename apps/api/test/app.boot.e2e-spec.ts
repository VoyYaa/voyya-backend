// =============================================================================
// Smoke test de ARRANQUE: compila el grafo completo de DI (AppModule) y valida
// el entorno con Zod, SIN base de datos (PrismaService se sustituye por un stub).
// Verifica que el wiring de módulos/providers/eventos es correcto.
// =============================================================================

import { Test } from '@nestjs/testing';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/infrastructure/prisma/prisma.service';

describe('AppModule (arranque / wiring)', () => {
  beforeAll(() => {
    // Entorno mínimo válido (independiente de .env) para el ConfigModule.
    // Secretos ≥32 caracteres (A-03).
    process.env.JWT_SECRET = 'test-jwt-secret-0123456789-abcdefghij';
    process.env.QUOTE_TOKEN_SECRET = 'test-quote-secret-0123456789-abcdefghij';
    process.env.DATABASE_URL = 'postgresql://u:p@localhost:5432/db?schema=public';
  });

  it('compila el módulo raíz con todos los proveedores resueltos', async () => {
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
