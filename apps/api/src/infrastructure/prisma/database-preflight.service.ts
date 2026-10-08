import { Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { EnvService } from '../../config/env.service';
import { PrismaService } from './prisma.service';

export interface DatabasePreflightResult {
  isSuperuser: boolean;
  bypassesRls: boolean;
  hasPostgis: boolean;
  hasGeoColumns: boolean;
  hasSingleTakeIndex: boolean;
  hasForcedRls: boolean;
}

const PREFLIGHT_QUERY = `
  SELECT
    current_setting('is_superuser') = 'on' AS "isSuperuser",
    COALESCE(
      (SELECT rolbypassrls FROM pg_roles WHERE rolname = current_user), false
    ) AS "bypassesRls",
    EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'postgis') AS "hasPostgis",
    EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'fleet' AND table_name = 'driver'
        AND column_name = 'current_location'
    ) AS "hasGeoColumns",
    EXISTS (
      SELECT 1 FROM pg_indexes
      WHERE indexname = 'uq_assignment_accepted_per_trip_request'
    ) AS "hasSingleTakeIndex",
    (
      SELECT count(*) FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE c.relforcerowsecurity
        AND (n.nspname, c.relname) IN
            (('fleet','driver'), ('fleet','vehicle'), ('assignment','assignment'),
             ('trips','fare_config'), ('admin','system_parameter'),
             ('tenancy','company_document'), ('tenancy','company_review'),
             ('fleet','driver_document'))
    ) = 8 AS "hasForcedRls"
`;

@Injectable()
export class DatabasePreflightService implements OnApplicationBootstrap {
  private readonly logger = new Logger(DatabasePreflightService.name);
  private lastResult: DatabasePreflightResult | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly env: EnvService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    const result = await this.runPreflightQuery();
    this.lastResult = result;

    const failed = result === null ? ['preflight_query_failed'] : this.failedInvariants(result);
    if (failed.length === 0) {
      this.logger.log('Database preflight OK: non-superuser role, RLS forced, PostGIS ready');
      return;
    }

    const message = `Database preflight failed: ${failed.join(', ')}`;
    if (this.env.get('NODE_ENV') === 'production') {
      this.logger.fatal(
        `${message}. Run db:release / apply 00_postgis_rls.sql before serving traffic.`,
      );
      throw new Error(message);
    }
    this.logger.warn(`${message} (non-production, not blocking startup)`);
  }

  private async runPreflightQuery(): Promise<DatabasePreflightResult | null> {
    try {
      const rows = await this.prisma.$queryRawUnsafe<DatabasePreflightResult[]>(PREFLIGHT_QUERY);
      return rows[0] ?? null;
    } catch (error) {
      this.logger.warn(`Database preflight query failed: ${errorMessage(error)}`);
      return null;
    }
  }

  getLastResult(): DatabasePreflightResult | null {
    return this.lastResult;
  }

  isHealthy(): boolean {
    return this.lastResult !== null && this.failedInvariants(this.lastResult).length === 0;
  }

  private failedInvariants(result: DatabasePreflightResult): string[] {
    const failed: string[] = [];
    if (result.isSuperuser) failed.push('is_superuser');
    if (result.bypassesRls) failed.push('bypasses_rls');
    if (!result.hasPostgis) failed.push('has_postgis');
    if (!result.hasGeoColumns) failed.push('has_geo_columns');
    if (!result.hasSingleTakeIndex) failed.push('has_single_take_index');
    if (!result.hasForcedRls) failed.push('has_forced_rls');
    return failed;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
