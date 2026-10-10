import { Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { EnvService } from '../../config/env.service';
import { summarizeError } from '../observability/safe-error';
import { PrismaService } from './prisma.service';

export interface DatabasePreflightResult {
  isSuperuser: boolean;
  bypassesRls: boolean;
  hasPostgis: boolean;
  hasGeoColumns: boolean;
  hasSingleTakeIndex: boolean;
  hasForcedRls: boolean;
  hasSafeTripProbe: boolean;
  hasMunicipalityCatalog: boolean;
  hasServiceConfig: boolean;
  hasTripCompanyScope: boolean;
  hasTripStartCode: boolean;
}

const SERVICE_CONFIG_TABLES = [
  'trips.municipality_fare',
  'admin.municipality_operational_params',
  'tenancy.company_commission',
];
const TRIP_SCOPE_TABLES = [...SERVICE_CONFIG_TABLES, 'trips.trip_request'];
const TRIP_SCOPE_FUNCTIONS = [
  'trips.trip_request_company_preference()',
  'assignment.company_has_live_assignment(integer, boolean)',
];
const START_CODE_COLUMNS = [
  'start_code',
  'start_code_failed_attempts',
  'start_code_blocked_at',
  'start_code_exempt',
  'started_at',
  'pickup_distance_at_assignment_m',
];
const START_CODE_FUNCTIONS = [
  'trips.new_start_code()',
  'trips.trip_request_start_code_guard()',
];
const START_CODE_CONSTRAINT_COUNT = 5;
const LIVE_ASSIGNMENT_FUNCTION = 'assignment.company_has_live_assignment(integer, boolean)';

const quotedList = (values: readonly string[]): string => values.map((value) => `'${value}'`).join(', ');

const GUC_RESIDUAL_PROBE = `
  DO $$
  BEGIN
    PERFORM set_config('app.current_company', '', true);
    EXECUTE 'EXPLAIN SELECT count(*) FROM trips.trip_request WHERE trip_request_id = 0';
    PERFORM count(*) FROM trips.trip_request WHERE trip_request_id = 0;
    UPDATE trips.trip_request SET updated_at = updated_at WHERE trip_request_id = 0;
  END
  $$
`;

const START_CODE_PROBE = `
  DO $$
  BEGIN
    IF NOT (trips.new_start_code() ~ '^[0-9]{4}$') THEN
      RAISE EXCEPTION 'trips.new_start_code() did not return four digits';
    END IF;
  END
  $$
`;

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
             ('fleet','driver_document'),
             ('admin','settlement_remittance'), ('admin','settlement_export'),
             ('trips','trip_request'), ('trips','municipality_fare'),
             ('admin','municipality_operational_params'), ('tenancy','company_commission'))
    ) = 14 AS "hasForcedRls",
    EXISTS (
      SELECT 1 FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
      JOIN pg_roles r ON r.oid = p.proowner
      WHERE n.nspname = 'assignment' AND p.proname = 'trip_has_assignment'
        AND p.prosecdef
        AND (r.rolsuper OR r.rolbypassrls)
        AND COALESCE(p.proconfig, ARRAY[]::text[]) @> ARRAY['row_security=off']
    ) AS "hasSafeTripProbe",
    (
      EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'tenancy' AND table_name = 'municipality'
          AND column_name = 'dane_code'
      )
      AND EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'municipality_coverage_matches_status'
          AND conrelid = to_regclass('tenancy.municipality')
      )
    ) AS "hasMunicipalityCatalog",
    (
      (SELECT count(*) FROM pg_indexes
        WHERE indexname IN ('uq_municipality_fare_open', 'uq_municipality_operational_params_open',
                            'uq_company_commission_open')) = 3
      AND (SELECT count(*) FROM pg_constraint WHERE conname ~ '_no_motorcycle$') = 4
      AND COALESCE((
        SELECT count(*) = ${SERVICE_CONFIG_TABLES.length}
               AND bool_and(
                 NOT has_table_privilege(current_user, t.oid, 'DELETE')
                 AND NOT has_table_privilege(current_user, t.oid, 'UPDATE')
                 AND has_column_privilege(current_user, t.oid, 'valid_to', 'UPDATE'))
          FROM (SELECT to_regclass(name) AS oid FROM unnest(ARRAY[${quotedList(SERVICE_CONFIG_TABLES)}]) AS name) t
         WHERE t.oid IS NOT NULL
      ), false)
    ) AS "hasServiceConfig",
    (
      EXISTS (
        SELECT 1 FROM pg_policy
        WHERE polname = 'company_scope_trip_request' AND polrelid = to_regclass('trips.trip_request')
      )
      AND EXISTS (
        SELECT 1 FROM pg_trigger
        WHERE tgname = 'trip_request_company_preference'
          AND tgrelid = to_regclass('trips.trip_request') AND NOT tgisinternal
      )
      AND (
        SELECT count(*) FROM information_schema.columns
        WHERE table_schema = 'trips' AND table_name = 'trip_request'
          AND column_name IN ('company_id', 'addressed_company_id', 'requested_company_id')
      ) = 3
      AND COALESCE((
        SELECT count(*) = ${TRIP_SCOPE_FUNCTIONS.length}
               AND bool_and(NOT p.prosecdef
                            AND EXISTS (SELECT 1 FROM unnest(COALESCE(p.proconfig, ARRAY[]::text[])) AS setting
                                         WHERE setting LIKE 'search_path=%'))
          FROM (SELECT to_regprocedure(name) AS oid FROM unnest(ARRAY[${quotedList(TRIP_SCOPE_FUNCTIONS)}]) AS name) f
          JOIN pg_proc p ON p.oid = f.oid
      ), false)
      AND COALESCE(
        has_function_privilege(current_user, to_regprocedure('${LIVE_ASSIGNMENT_FUNCTION}'), 'EXECUTE')
        AND NOT has_function_privilege('public', to_regprocedure('${LIVE_ASSIGNMENT_FUNCTION}'), 'EXECUTE'),
        false)
      AND COALESCE((
        SELECT count(*) = ${TRIP_SCOPE_TABLES.length}
               AND bool_and(NOT pg_has_role(current_user, c.relowner, 'MEMBER'))
          FROM (SELECT to_regclass(name) AS oid FROM unnest(ARRAY[${quotedList(TRIP_SCOPE_TABLES)}]) AS name) t
          JOIN pg_class c ON c.oid = t.oid
      ), false)
    ) AS "hasTripCompanyScope",
    (
      (SELECT count(*) FROM information_schema.columns
        WHERE table_schema = 'trips' AND table_name = 'trip_request'
          AND column_name IN (${quotedList(START_CODE_COLUMNS)})) = ${START_CODE_COLUMNS.length}
      AND EXISTS (
        SELECT 1 FROM pg_trigger
        WHERE tgname = 'trip_request_start_code'
          AND tgrelid = to_regclass('trips.trip_request') AND NOT tgisinternal
          AND tgenabled = 'O'
          AND (tgtype & 1) <> 0 AND (tgtype & 2) <> 0 AND (tgtype & 4) <> 0 AND (tgtype & 16) <> 0
      )
      AND COALESCE((
        SELECT count(*) = ${START_CODE_FUNCTIONS.length}
               AND bool_and(NOT p.prosecdef
                            AND EXISTS (SELECT 1 FROM unnest(COALESCE(p.proconfig, ARRAY[]::text[])) AS setting
                                         WHERE setting LIKE 'search_path=%'))
          FROM (SELECT to_regprocedure(name) AS oid FROM unnest(ARRAY[${quotedList(START_CODE_FUNCTIONS)}]) AS name) f
          JOIN pg_proc p ON p.oid = f.oid
      ), false)
      AND COALESCE((
        SELECT count(*) = ${START_CODE_CONSTRAINT_COUNT} AND bool_and(convalidated)
          FROM pg_constraint
         WHERE conrelid = to_regclass('trips.trip_request') AND conname ~ '^trip_request_start_code_'
      ), false)
      AND NOT has_parameter_privilege(current_user, 'session_replication_role', 'SET')
    ) AS "hasTripStartCode"
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
      const row = rows[0];
      if (!row) return null;
      return {
        ...row,
        hasTripCompanyScope: row.hasTripCompanyScope && (await this.survivesResidualGuc()),
        hasTripStartCode: row.hasTripStartCode && (await this.generatesStartCode()),
      };
    } catch (error) {
      this.logger.warn(`Database preflight query failed: ${summarizeError(error)}`);
      return null;
    }
  }

  private async survivesResidualGuc(): Promise<boolean> {
    try {
      await this.prisma.$executeRawUnsafe(GUC_RESIDUAL_PROBE);
      return true;
    } catch (error) {
      this.logger.warn(`Residual GUC probe on trips.trip_request failed: ${summarizeError(error)}`);
      return false;
    }
  }

  private async generatesStartCode(): Promise<boolean> {
    try {
      await this.prisma.$executeRawUnsafe(START_CODE_PROBE);
      return true;
    } catch (error) {
      this.logger.warn(`Start code probe failed: ${summarizeError(error)}`);
      return false;
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
    if (!result.hasSafeTripProbe) failed.push('has_safe_trip_probe');
    if (!result.hasMunicipalityCatalog) failed.push('has_municipality_catalog');
    if (!result.hasServiceConfig) failed.push('has_service_config');
    if (!result.hasTripCompanyScope) failed.push('has_trip_company_scope');
    if (!result.hasTripStartCode) failed.push('has_trip_start_code');
    return failed;
  }
}

