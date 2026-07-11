import {
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { Prisma, PrismaClient } from '@prisma/client';

/**
 * PrismaService — cliente único de Prisma + helper multi-tenant (RLS).
 *
 * RLS (defensa en profundidad · doc 14 §3 · ADR-002): la GUC `app.current_empresa`
 * se fija con `set_config(..., true)` DENTRO de una transacción, NO como middleware
 * `$use` global. Motivo (ADR-002): con PgBouncer en modo *transaction* el estado de
 * sesión no persiste entre queries; el único punto seguro para fijarla es la propia
 * transacción. `runInTenant` es la realización correcta de "set_config por transacción".
 */
@Injectable()
export class PrismaService
  extends PrismaClient
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(PrismaService.name);

  async onModuleInit(): Promise<void> {
    await this.$connect();
    this.logger.log('Prisma conectado');
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }

  /**
   * Ejecuta `fn` en una transacción con el tenant fijado para RLS.
   * `set_config` recibe el valor como PARÁMETRO LIGADO (no interpolación) → sin
   * inyección SQL. El tercer argumento `true` = LOCAL a la transacción (se limpia
   * solo al COMMIT/ROLLBACK; seguro bajo PgBouncer transaction-mode).
   */
  async runInTenant<T>(
    idEmpresa: number,
    fn: (tx: Prisma.TransactionClient) => Promise<T>,
  ): Promise<T> {
    return this.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.current_empresa', ${String(idEmpresa)}, true)`;
      return fn(tx);
    });
  }
}
