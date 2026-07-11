import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';

/** Clave del advisory lock (arbitraria y estable) para serializar el barrido. */
const LOCK_KEY = 91_001;

/**
 * Barrido del estado efímero de auth (OTP/refresh vencidos o consumidos/revocados)
 * — ADR-005 (d). Sin Redis: PostgreSQL + @nestjs/schedule. Se protege con un
 * ADVISORY LOCK de transacción (`pg_try_advisory_xact_lock`): con N instancias solo
 * una barre por ciclo; se libera solo al COMMIT (seguro bajo PgBouncer transaction-mode).
 * En el MVP la instancia es única, pero el lock lo deja listo para escalar.
 */
@Injectable()
export class AuthCleanupService {
  private readonly logger = new Logger(AuthCleanupService.name);

  constructor(private readonly prisma: PrismaService) {}

  @Cron(CronExpression.EVERY_HOUR)
  async limpiar(): Promise<void> {
    try {
      await this.prisma.$transaction(async (tx) => {
        const filas = await tx.$queryRaw<Array<{ locked: boolean }>>`
          SELECT pg_try_advisory_xact_lock(${LOCK_KEY}) AS locked
        `;
        if (filas[0]?.locked !== true) return; // otra instancia está barriendo

        const otp = await tx.$executeRaw`
          DELETE FROM auth.codigo_otp WHERE expira_en < now() OR consumido = true
        `;
        const refresh = await tx.$executeRaw`
          DELETE FROM auth.refresh_token WHERE expira_en < now() OR revocado = true
        `;
        this.logger.log(`Limpieza auth: otp=${otp} refresh=${refresh}`);
      });
    } catch (e) {
      this.logger.error(`Fallo en limpieza de auth: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}
