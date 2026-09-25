import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { EnvService } from '../../config/env.service';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { PushTokenRepository } from './push-token.repository';

const LOCK_KEY = 91_003;

@Injectable()
export class PushTokenPurgeService {
  private readonly logger = new Logger(PushTokenPurgeService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly tokens: PushTokenRepository,
    private readonly env: EnvService,
  ) {}

  @Cron(CronExpression.EVERY_DAY_AT_3AM)
  async purge(): Promise<void> {
    const ttlDays = this.env.get('PUSH_TOKEN_TTL_DAYS');
    if (ttlDays === 0) return;

    try {
      if (!(await this.acquireLock())) return;

      const purged = await this.tokens.purgeStale(ttlDays);
      this.logger.log(`Push token purge: purged=${purged}`);
    } catch (e) {
      this.logger.error(`Push token purge failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  private async acquireLock(): Promise<boolean> {
    const rows = await this.prisma.$transaction(
      (tx) => tx.$queryRaw<Array<{ locked: boolean }>>`
        SELECT pg_try_advisory_xact_lock(${LOCK_KEY}) AS locked
      `,
    );
    return rows[0]?.locked === true;
  }
}
