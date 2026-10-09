import { readFileSync } from 'node:fs';
import { Prisma, PrismaClient } from '@prisma/client';

export const COVERAGE_MIN_AREA_KM2 = 1;
export const COVERAGE_MAX_AREA_KM2 = 600;
const WGS84 = 4326;
const DANE_CODE = /^\d{5}$/;
const REQUIRED_PROVENANCE = ['source', 'validated_by', 'validated_at'] as const;

export class CoverageError extends Error {}

export interface CoverageGeometry {
  type: 'Polygon' | 'MultiPolygon';
  coordinates: unknown;
}

export interface ParsedCoverage {
  geometry: CoverageGeometry;
  provenance: Record<(typeof REQUIRED_PROVENANCE)[number], string>;
}

export interface ActivateCoverageInput {
  daneCode: string;
  geojsonText: string;
  apply: boolean;
}

export interface DeactivateCoverageInput {
  daneCode: string;
  apply: boolean;
}

export interface CoverageReport {
  mode: 'activate' | 'deactivate';
  applied: boolean;
  daneCode: string;
  municipalityId: number;
  name: string;
  statusBefore: string;
  statusAfter: string;
  areaKm2: number | null;
  overlapsWith: string[];
  activeCompanies: number;
}

interface MunicipalityRow {
  municipalityId: number;
  name: string;
  status: string;
  referenceLat: number | null;
  referenceLng: number | null;
}

interface GeometryCheck {
  valid: boolean;
  reason: string | null;
  srid: number;
  coversReference: boolean | null;
  areaKm2: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function parseCoverageGeoJson(text: string): ParsedCoverage {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new CoverageError('The GeoJSON file is not valid JSON');
  }
  if (!isRecord(parsed) || parsed.type !== 'Feature') {
    throw new CoverageError(
      'The GeoJSON must be a Feature with properties source, validated_by and validated_at: a polygon without provenance is not activated',
    );
  }
  const properties = isRecord(parsed.properties) ? parsed.properties : {};
  const provenance = {} as ParsedCoverage['provenance'];
  for (const key of REQUIRED_PROVENANCE) {
    const value = properties[key];
    if (typeof value !== 'string' || value.trim() === '') {
      throw new CoverageError(`Missing provenance property "${key}" in the GeoJSON Feature`);
    }
    provenance[key] = value.trim();
  }
  const geometry = parsed.geometry;
  if (!isRecord(geometry) || (geometry.type !== 'Polygon' && geometry.type !== 'MultiPolygon')) {
    throw new CoverageError('The geometry must be a Polygon or a MultiPolygon');
  }
  return { geometry: geometry as unknown as CoverageGeometry, provenance };
}

async function findMunicipality(prisma: PrismaClient, daneCode: string): Promise<MunicipalityRow> {
  if (!DANE_CODE.test(daneCode)) throw new CoverageError(`Invalid --dane-code "${daneCode}"`);
  const row = await prisma.municipality.findUnique({
    where: { daneCode },
    select: { municipalityId: true, name: true, status: true, referenceLat: true, referenceLng: true },
  });
  if (!row) throw new CoverageError(`No municipality with DANE code ${daneCode}`);
  if (row.status === 'retired') throw new CoverageError(`Municipality ${daneCode} is retired`);
  return row;
}

async function activeCompaniesOf(prisma: PrismaClient, municipalityId: number): Promise<number> {
  return prisma.company.count({ where: { municipalityId, status: 'active' } });
}

async function checkGeometry(
  prisma: PrismaClient,
  geometry: CoverageGeometry,
  municipality: MunicipalityRow,
): Promise<GeometryCheck> {
  const json = JSON.stringify(geometry);
  const rows = await prisma.$queryRaw<
    Array<{ valid: boolean; reason: string | null; srid: number; covers: boolean | null; area: number }>
  >`
    SELECT ST_IsValid(g) AS valid,
           CASE WHEN ST_IsValid(g) THEN NULL ELSE ST_IsValidReason(g) END AS reason,
           ST_SRID(g) AS srid,
           CASE WHEN ${municipality.referenceLat}::float8 IS NULL OR ${municipality.referenceLng}::float8 IS NULL THEN NULL
                ELSE ST_Covers(g, ST_SetSRID(ST_MakePoint(${municipality.referenceLng}::float8, ${municipality.referenceLat}::float8), 4326)) END AS covers,
           (ST_Area(g::geography) / 1000000.0)::float8 AS area
      FROM (SELECT ST_GeomFromGeoJSON(${json}) AS g) x
  `;
  const row = rows[0];
  if (!row) throw new CoverageError('PostGIS did not return a geometry check');
  return {
    valid: row.valid,
    reason: row.reason,
    srid: Number(row.srid),
    coversReference: row.covers,
    areaKm2: Number(row.area),
  };
}

async function overlappingCoverages(
  prisma: PrismaClient,
  geometry: CoverageGeometry,
  municipalityId: number,
): Promise<string[]> {
  const json = JSON.stringify(geometry);
  const rows = await prisma.$queryRaw<Array<{ dane_code: string }>>`
    SELECT m.dane_code
      FROM tenancy.municipality m
     WHERE m.status = 'active'
       AND m.municipality_id <> ${municipalityId}
       AND m.dane_code IS NOT NULL
       AND ST_Intersects(m.coverage, ST_SetSRID(ST_GeomFromGeoJSON(${json}), 4326))
     ORDER BY m.dane_code
  `;
  return rows.map((row) => row.dane_code);
}

function assertAcceptable(check: GeometryCheck, daneCode: string): void {
  if (!check.valid) throw new CoverageError(`Invalid geometry: ${check.reason ?? 'unknown reason'}`);
  if (check.srid !== WGS84) throw new CoverageError(`The geometry must use SRID ${WGS84}, it uses ${check.srid}`);
  if (check.coversReference === false) {
    throw new CoverageError(`The polygon does not contain the DANE reference point of ${daneCode}`);
  }
  if (check.coversReference === null) {
    throw new CoverageError(`Municipality ${daneCode} has no DANE reference point to validate the polygon against`);
  }
  if (check.areaKm2 < COVERAGE_MIN_AREA_KM2 || check.areaKm2 > COVERAGE_MAX_AREA_KM2) {
    throw new CoverageError(
      `Area ${check.areaKm2.toFixed(2)} km2 is outside ${COVERAGE_MIN_AREA_KM2}-${COVERAGE_MAX_AREA_KM2} km2`,
    );
  }
}

export async function activateCoverage(
  prisma: PrismaClient,
  input: ActivateCoverageInput,
): Promise<CoverageReport> {
  const municipality = await findMunicipality(prisma, input.daneCode);
  const { geometry } = parseCoverageGeoJson(input.geojsonText);
  const check = await checkGeometry(prisma, geometry, municipality);
  assertAcceptable(check, input.daneCode);
  const overlapsWith = await overlappingCoverages(prisma, geometry, municipality.municipalityId);

  if (input.apply) {
    await prisma.municipality.update({
      where: { municipalityId: municipality.municipalityId },
      data: { status: 'active', coveragePolygon: geometry as unknown as Prisma.InputJsonObject },
    });
  }

  return {
    mode: 'activate',
    applied: input.apply,
    daneCode: input.daneCode,
    municipalityId: municipality.municipalityId,
    name: municipality.name,
    statusBefore: municipality.status,
    statusAfter: input.apply ? 'active' : municipality.status,
    areaKm2: Number(check.areaKm2.toFixed(3)),
    overlapsWith,
    activeCompanies: await activeCompaniesOf(prisma, municipality.municipalityId),
  };
}

export async function deactivateCoverage(
  prisma: PrismaClient,
  input: DeactivateCoverageInput,
): Promise<CoverageReport> {
  const municipality = await findMunicipality(prisma, input.daneCode);
  if (input.apply && municipality.status === 'active') {
    await prisma.municipality.update({
      where: { municipalityId: municipality.municipalityId },
      data: { status: 'catalog', coveragePolygon: Prisma.DbNull },
    });
  }
  const applied = input.apply && municipality.status === 'active';
  return {
    mode: 'deactivate',
    applied,
    daneCode: input.daneCode,
    municipalityId: municipality.municipalityId,
    name: municipality.name,
    statusBefore: municipality.status,
    statusAfter: applied ? 'catalog' : municipality.status,
    areaKm2: null,
    overlapsWith: [],
    activeCompanies: await activeCompaniesOf(prisma, municipality.municipalityId),
  };
}

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function main(): Promise<void> {
  const daneCode = argument('--dane-code');
  const geojsonPath = argument('--geojson');
  const deactivate = process.argv.includes('--deactivate');
  const apply = process.argv.includes('--apply');
  if (!daneCode || (!deactivate && !geojsonPath)) {
    throw new CoverageError(
      'Usage: activate-coverage.ts --dane-code <code> --geojson <file> [--apply] | --dane-code <code> --deactivate [--apply]',
    );
  }
  const prisma = new PrismaClient();
  try {
    const report = deactivate
      ? await deactivateCoverage(prisma, { daneCode, apply })
      : await activateCoverage(prisma, {
          daneCode,
          geojsonText: readFileSync(geojsonPath as string, 'utf8'),
          apply,
        });
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    if (!apply) process.stdout.write('Simulation only: add --apply to write.\n');
  } finally {
    await prisma.$disconnect();
  }
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
