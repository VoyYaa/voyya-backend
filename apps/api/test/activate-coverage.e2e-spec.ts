import type { PrismaClient } from '@prisma/client';
import {
  activateCoverage,
  CoverageError,
  deactivateCoverage,
  parseCoverageGeoJson,
} from '../scripts/activate-coverage';
import { purgeMunicipalitiesByNamePrefix } from './support/purge-test-fixtures';

const HOOK_TIMEOUT_MS = 60_000;
const url = process.env.PG_TEST_URL;
const suite = url ? describe : describe.skip;

const PREFIX = '_CovB1';
const DANE_PREFIX = '008';
const PROVENANCE = { source: 'MGN cabecera urbana (borrador)', validated_by: 'Cootrayal', validated_at: '2026-10-08' };

function square(centerLng: number, centerLat: number, halfSide: number): number[][][] {
  return [
    [
      [centerLng - halfSide, centerLat - halfSide],
      [centerLng + halfSide, centerLat - halfSide],
      [centerLng + halfSide, centerLat + halfSide],
      [centerLng - halfSide, centerLat + halfSide],
      [centerLng - halfSide, centerLat - halfSide],
    ],
  ];
}

function feature(coordinates: number[][][], properties: Record<string, unknown> = PROVENANCE): string {
  return JSON.stringify({ type: 'Feature', properties, geometry: { type: 'Polygon', coordinates } });
}

describe('parseCoverageGeoJson', () => {
  it('accepts a Feature with provenance and returns its geometry', () => {
    const parsed = parseCoverageGeoJson(feature(square(0.5, 0.5, 0.05)));

    expect(parsed.geometry.type).toBe('Polygon');
    expect(parsed.provenance.validated_by).toBe('Cootrayal');
  });

  it('rejects a bare geometry: a polygon without provenance is not activated', () => {
    const bare = JSON.stringify({ type: 'Polygon', coordinates: square(0.5, 0.5, 0.05) });

    expect(() => parseCoverageGeoJson(bare)).toThrow(/must be a Feature/);
  });

  it.each(['source', 'validated_by', 'validated_at'])('rejects a Feature without %s', (missing) => {
    const properties: Record<string, unknown> = { ...PROVENANCE };
    delete properties[missing];

    expect(() => parseCoverageGeoJson(feature(square(0.5, 0.5, 0.05), properties))).toThrow(
      new RegExp(`Missing provenance property "${missing}"`),
    );
  });

  it('rejects a Point and invalid JSON', () => {
    const point = JSON.stringify({ type: 'Feature', properties: PROVENANCE, geometry: { type: 'Point', coordinates: [0, 0] } });

    expect(() => parseCoverageGeoJson(point)).toThrow(/Polygon or a MultiPolygon/);
    expect(() => parseCoverageGeoJson('{')).toThrow(CoverageError);
  });
});

suite('activate-coverage against real Postgres (ADR-031 section 5.2)', () => {
  let prisma: PrismaClient;
  let counter = 0;

  async function catalogMunicipality(options: { status?: string; withReference?: boolean } = {}): Promise<string> {
    counter += 1;
    const daneCode = `${DANE_PREFIX}${String(counter).padStart(2, '0')}`;
    const used = await prisma.municipality.findUnique({ where: { daneCode } });
    if (used) await purgeMunicipalitiesByNamePrefix(prisma, PREFIX, { daneCodePrefix: DANE_PREFIX });
    await prisma.municipality.create({
      data: {
        name: `${PREFIX} ${daneCode}`,
        department: `${PREFIX} Dept`,
        daneCode,
        daneType: 'municipality',
        referenceLat: options.withReference === false ? null : 0.5,
        referenceLng: options.withReference === false ? null : 0.5,
        status: options.status ?? 'catalog',
      },
    });
    return daneCode;
  }

  beforeAll(async () => {
    const { PrismaClient: Client } = await import('@prisma/client');
    prisma = new Client({ datasources: { db: { url } } });
    await prisma.$connect();
    await purgeMunicipalitiesByNamePrefix(prisma, PREFIX, { daneCodePrefix: DANE_PREFIX });
  }, HOOK_TIMEOUT_MS);

  afterAll(async () => {
    if (prisma) {
      await purgeMunicipalitiesByNamePrefix(prisma, PREFIX, { daneCodePrefix: DANE_PREFIX });
      await prisma.$disconnect();
    }
  }, HOOK_TIMEOUT_MS);

  async function stateOf(daneCode: string): Promise<{ status: string; hasPolygon: boolean; hasCoverage: boolean }> {
    const rows = await prisma.$queryRaw<Array<{ status: string; polygon: boolean; coverage: boolean }>>`
      SELECT status, coverage_polygon IS NOT NULL AS polygon, coverage IS NOT NULL AS coverage
        FROM tenancy.municipality WHERE dane_code = ${daneCode}`;
    const row = rows[0];
    return { status: row?.status ?? '', hasPolygon: row?.polygon ?? false, hasCoverage: row?.coverage ?? false };
  }

  it('the simulation reports the plan and writes nothing', async () => {
    const code = await catalogMunicipality();

    const report = await activateCoverage(prisma, {
      daneCode: code,
      geojsonText: feature(square(0.5, 0.5, 0.05)),
      apply: false,
    });

    expect(report).toMatchObject({ mode: 'activate', applied: false, statusBefore: 'catalog', statusAfter: 'catalog' });
    expect(report.areaKm2).toBeGreaterThan(50);
    expect(await stateOf(code)).toEqual({ status: 'catalog', hasPolygon: false, hasCoverage: false });
  });

  it('--apply sets status and polygon in one UPDATE and ST_Covers answers true afterwards', async () => {
    const code = await catalogMunicipality();

    const report = await activateCoverage(prisma, {
      daneCode: code,
      geojsonText: feature(square(0.5, 0.5, 0.05)),
      apply: true,
    });

    expect(report).toMatchObject({ applied: true, statusAfter: 'active' });
    expect(await stateOf(code)).toEqual({ status: 'active', hasPolygon: true, hasCoverage: true });
    const covered = await prisma.$queryRaw<Array<{ covers: boolean }>>`
      SELECT ST_Covers(coverage, ST_SetSRID(ST_MakePoint(0.5, 0.5), 4326)) AS covers
        FROM tenancy.municipality WHERE dane_code = ${code}`;
    expect(covered[0]?.covers).toBe(true);
  });

  it('--deactivate --apply returns the municipality to catalog without a polygon (D-4)', async () => {
    const code = await catalogMunicipality();
    await activateCoverage(prisma, { daneCode: code, geojsonText: feature(square(0.5, 0.5, 0.05)), apply: true });

    const simulated = await deactivateCoverage(prisma, { daneCode: code, apply: false });
    expect(simulated).toMatchObject({ mode: 'deactivate', applied: false, statusAfter: 'active' });
    expect((await stateOf(code)).status).toBe('active');

    const applied = await deactivateCoverage(prisma, { daneCode: code, apply: true });

    expect(applied).toMatchObject({ applied: true, statusBefore: 'active', statusAfter: 'catalog' });
    expect(await stateOf(code)).toEqual({ status: 'catalog', hasPolygon: false, hasCoverage: false });
  });

  it('deactivating a municipality that is already catalog changes nothing', async () => {
    const code = await catalogMunicipality();

    const report = await deactivateCoverage(prisma, { daneCode: code, apply: true });

    expect(report).toMatchObject({ applied: false, statusBefore: 'catalog', statusAfter: 'catalog' });
  });

  it('rejects a polygon that does not contain the DANE reference point', async () => {
    const code = await catalogMunicipality();

    await expect(
      activateCoverage(prisma, { daneCode: code, geojsonText: feature(square(0.8, 0.8, 0.05)), apply: true }),
    ).rejects.toThrow(/does not contain the DANE reference point/);
    expect((await stateOf(code)).status).toBe('catalog');
  });

  it('rejects an invalid (self-intersecting) geometry', async () => {
    const code = await catalogMunicipality();
    const bowtie = [
      [
        [0.45, 0.45],
        [0.55, 0.55],
        [0.55, 0.45],
        [0.45, 0.55],
        [0.45, 0.45],
      ],
    ];

    await expect(
      activateCoverage(prisma, { daneCode: code, geojsonText: feature(bowtie), apply: true }),
    ).rejects.toThrow(/Invalid geometry/);
  });

  it.each([
    ['too large', 2],
    ['too small', 0.001],
  ])('rejects an area that is %s', async (_label, halfSide) => {
    const code = await catalogMunicipality();

    await expect(
      activateCoverage(prisma, { daneCode: code, geojsonText: feature(square(0.5, 0.5, halfSide)), apply: true }),
    ).rejects.toThrow(/outside 1-600 km2/);
  });

  it('rejects a municipality without the DANE reference point instead of activating blindly', async () => {
    const code = await catalogMunicipality({ withReference: false });

    await expect(
      activateCoverage(prisma, { daneCode: code, geojsonText: feature(square(0.5, 0.5, 0.05)), apply: true }),
    ).rejects.toThrow(/has no DANE reference point/);
  });

  it('reports the overlap with another active coverage as a warning and still activates', async () => {
    const first = await catalogMunicipality();
    await activateCoverage(prisma, { daneCode: first, geojsonText: feature(square(0.5, 0.5, 0.05)), apply: true });
    const second = await catalogMunicipality();

    const report = await activateCoverage(prisma, {
      daneCode: second,
      geojsonText: feature(square(0.52, 0.52, 0.05)),
      apply: true,
    });

    expect(report.overlapsWith).toContain(first);
    expect(report.statusAfter).toBe('active');
  });

  it('rejects an unknown code, a malformed code and a retired municipality', async () => {
    const retired = await catalogMunicipality({ status: 'retired' });

    await expect(deactivateCoverage(prisma, { daneCode: '00099', apply: false })).rejects.toThrow(/No municipality/);
    await expect(deactivateCoverage(prisma, { daneCode: '5887', apply: false })).rejects.toThrow(/Invalid --dane-code/);
    await expect(deactivateCoverage(prisma, { daneCode: retired, apply: true })).rejects.toThrow(/is retired/);
  });
});
