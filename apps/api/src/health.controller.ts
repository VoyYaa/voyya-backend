import { Controller, Get, HttpStatus, Res } from '@nestjs/common';
import type { Response } from 'express';
import { Public } from './modules/auth/decorators/public.decorator';
import {
  DatabasePreflightService,
  type DatabasePreflightResult,
} from './infrastructure/prisma/database-preflight.service';
import { PrismaService } from './infrastructure/prisma/prisma.service';

interface DbHealthResponse {
  status: 'ok' | 'degraded';
  database_reachable: boolean;
  preflight: DatabasePreflightResult | null;
}

@Controller('health')
@Public()
export class HealthController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly preflight: DatabasePreflightService,
  ) {}

  @Get()
  check(): { status: 'ok'; service: 'voyya-api'; ts: string } {
    return { status: 'ok', service: 'voyya-api', ts: new Date().toISOString() };
  }

  @Get('db')
  async checkDb(@Res({ passthrough: true }) res: Response): Promise<DbHealthResponse> {
    let databaseReachable = true;
    try {
      await this.prisma.$queryRaw`SELECT 1`;
    } catch {
      databaseReachable = false;
    }

    const healthy = databaseReachable && this.preflight.isHealthy();
    res.status(healthy ? HttpStatus.OK : HttpStatus.SERVICE_UNAVAILABLE);
    return {
      status: healthy ? 'ok' : 'degraded',
      database_reachable: databaseReachable,
      preflight: this.preflight.getLastResult(),
    };
  }
}
