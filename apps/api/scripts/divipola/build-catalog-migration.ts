import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

export const EXPECTED_ROW_COUNT = 1122;

export type DaneType = 'municipality' | 'island' | 'non_municipalized_area';

export interface CatalogRow {
  daneCode: string;
  name: string;
  department: string;
  daneType: DaneType;
  referenceLat: string;
  referenceLng: string;
}

const EXPECTED_HEADER = [
  'cod_dpto',
  'dpto',
  'cod_mpio',
  'nom_mpio',
  'tipo_municipio',
  'longitud',
  'latitud',
];

const DANE_TYPE_BY_SOURCE: Readonly<Record<string, DaneType>> = {
  Municipio: 'municipality',
  Isla: 'island',
  'Área no municipalizada': 'non_municipalized_area',
};

const CONNECTORS: ReadonlySet<string> = new Set(['de', 'del', 'la', 'las', 'los', 'el', 'y', 'e', 'en']);
const TRAILING_PUNCTUATION = /[,;:.]+$/;
const ABBREVIATION = /^D\.C\.[,;:]?$/;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;
const DECIMAL_COMMA_NUMBER = /^-?\d{1,3},\d{1,6}$/;
const DANE_CODE = /^\d{5}$/;
const LOCALE = 'es-CO';

export class CatalogSourceError extends Error {}

export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const char = text.charAt(i);
    if (quoted) {
      if (char === '"' && text.charAt(i + 1) === '"') {
        field += '"';
        i += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        field += char;
      }
    } else if (char === '"') {
      quoted = true;
    } else if (char === ',') {
      row.push(field);
      field = '';
    } else if (char === '\n' || char === '\r') {
      if (char === '\r' && text.charAt(i + 1) === '\n') i += 1;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else {
      field += char;
    }
  }
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

const WORD_START = /(^|[-'’])(\p{L})/gu;

function capitalizeWord(word: string): string {
  return word
    .toLocaleLowerCase(LOCALE)
    .replace(WORD_START, (_match, separator: string, letter: string) => separator + letter.toLocaleUpperCase(LOCALE));
}

function presentWord(word: string, isFirst: boolean): string {
  if (ABBREVIATION.test(word)) return word;
  const trailing = TRAILING_PUNCTUATION.exec(word)?.[0] ?? '';
  const core = word.slice(0, word.length - trailing.length);
  const lower = core.toLocaleLowerCase(LOCALE);
  if (!isFirst && CONNECTORS.has(lower)) return lower + trailing;
  return capitalizeWord(core) + trailing;
}

export function toPresentationName(source: string): string {
  return source
    .trim()
    .split(/\s+/)
    .map((word, index) => presentWord(word, index === 0))
    .join(' ');
}

export function escapeSqlLiteral(value: string, context: string): string {
  if (CONTROL_CHARACTERS.test(value)) {
    throw new CatalogSourceError(`Control character in ${context}`);
  }
  return `'${value.replace(/'/g, "''")}'`;
}

function toDecimalPoint(value: string, context: string): string {
  if (!DECIMAL_COMMA_NUMBER.test(value)) {
    throw new CatalogSourceError(`Invalid coordinate "${value}" in ${context}`);
  }
  return value.replace(',', '.');
}

function toCatalogRow(fields: string[], line: number): CatalogRow {
  const [dptoCode = '', dpto = '', code = '', name = '', type = '', lng = '', lat = ''] = fields;
  const context = `row ${line}`;
  if (fields.length !== EXPECTED_HEADER.length) {
    throw new CatalogSourceError(`Unexpected column count ${fields.length} in ${context}`);
  }
  for (const value of fields) {
    if (CONTROL_CHARACTERS.test(value)) {
      throw new CatalogSourceError(`Control character in ${context} (${code})`);
    }
  }
  if (!DANE_CODE.test(code)) {
    throw new CatalogSourceError(`Invalid DANE code "${code}" in ${context}`);
  }
  if (dptoCode !== code.slice(0, 2)) {
    throw new CatalogSourceError(`cod_dpto ${dptoCode} does not match ${code} in ${context}`);
  }
  const daneType = DANE_TYPE_BY_SOURCE[type];
  if (!daneType) {
    throw new CatalogSourceError(`Unknown tipo_municipio "${type}" in ${context} (${code})`);
  }
  return {
    daneCode: code,
    name: toPresentationName(name),
    department: toPresentationName(dpto),
    daneType,
    referenceLat: toDecimalPoint(lat, `${context} (${code})`),
    referenceLng: toDecimalPoint(lng, `${context} (${code})`),
  };
}

export function parseDivipolaRows(text: string, expectedCount: number = EXPECTED_ROW_COUNT): CatalogRow[] {
  const [header, ...body] = parseCsv(text).filter((row) => row.some((field) => field !== ''));
  if (!header || header.join(',') !== EXPECTED_HEADER.join(',')) {
    throw new CatalogSourceError(`Unexpected CSV header: ${header?.join(',') ?? '(empty)'}`);
  }
  if (body.length !== expectedCount) {
    throw new CatalogSourceError(`DIVIPOLA source must have ${expectedCount} rows, has ${body.length}`);
  }
  const rows = body.map((fields, index) => toCatalogRow(fields, index + 2));
  const seen = new Set<string>();
  for (const row of rows) {
    if (seen.has(row.daneCode)) {
      throw new CatalogSourceError(`Duplicated DANE code ${row.daneCode}`);
    }
    seen.add(row.daneCode);
  }
  return rows.sort(byDaneCode);
}

function byDaneCode(a: CatalogRow, b: CatalogRow): number {
  if (a.daneCode === b.daneCode) return 0;
  return a.daneCode < b.daneCode ? -1 : 1;
}

export function catalogChecksum(rows: readonly CatalogRow[]): string {
  const payload = [...rows]
    .sort(byDaneCode)
    .map((row) => `${row.daneCode}|${row.name}|${row.department}|${row.daneType}`)
    .join('\n');
  return createHash('md5').update(payload, 'utf8').digest('hex');
}

export function countByType(rows: readonly CatalogRow[]): Record<DaneType, number> {
  const counts: Record<DaneType, number> = { municipality: 0, island: 0, non_municipalized_area: 0 };
  for (const row of rows) counts[row.daneType] += 1;
  return counts;
}

export function renderSourceTuples(rows: readonly CatalogRow[]): string {
  return rows
    .map((row) => {
      const context = `DANE code ${row.daneCode}`;
      return (
        `  (${escapeSqlLiteral(row.daneCode, context)}, ${escapeSqlLiteral(row.name, context)}, ` +
        `${escapeSqlLiteral(row.department, context)}, ${escapeSqlLiteral(row.daneType, context)}, ` +
        `${row.referenceLat}, ${row.referenceLng})`
      );
    })
    .join(',\n');
}

export function renderMigrationSql(rows: readonly CatalogRow[]): string {
  const count = rows.length;
  return `CREATE TEMP TABLE divipola_source (
  dane_code     char(5) PRIMARY KEY,
  name          text NOT NULL,
  department    text NOT NULL,
  dane_type     text NOT NULL,
  reference_lat double precision NOT NULL,
  reference_lng double precision NOT NULL
);

INSERT INTO divipola_source VALUES
${renderSourceTuples(rows)};

DO $$
DECLARE
  ambiguous text;
  orphaned  text;
BEGIN
  IF (SELECT count(*) FROM divipola_source) <> ${count} THEN
    RAISE EXCEPTION 'ADR-031: DIVIPOLA source must have ${count} rows, has %', (SELECT count(*) FROM divipola_source);
  END IF;

  IF EXISTS (SELECT 1 FROM tenancy.municipality WHERE status <> 'active') THEN
    RAISE EXCEPTION 'ADR-031: unexpected municipality status values before the catalog load';
  END IF;

  IF EXISTS (SELECT 1 FROM tenancy.municipality WHERE jsonb_typeof(coverage_polygon) <> 'object') THEN
    RAISE EXCEPTION 'ADR-031: some coverage_polygon values are not GeoJSON objects';
  END IF;

  SELECT string_agg(m.municipality_id::text, ',') INTO ambiguous
    FROM tenancy.municipality m
   WHERE (SELECT count(*) FROM divipola_source s
           WHERE upper(s.name) = upper(m.name) AND upper(s.department) = upper(m.department)) > 1;
  IF ambiguous IS NOT NULL THEN
    RAISE EXCEPTION 'ADR-031: ambiguous DANE match for municipality ids %', ambiguous;
  END IF;

  SELECT string_agg(s.dane_code, ',') INTO ambiguous
    FROM divipola_source s
   WHERE (SELECT count(*) FROM tenancy.municipality m
           WHERE upper(s.name) = upper(m.name) AND upper(s.department) = upper(m.department)) > 1;
  IF ambiguous IS NOT NULL THEN
    RAISE EXCEPTION 'ADR-031: several existing municipalities match DANE codes %', ambiguous;
  END IF;

  SELECT string_agg(m.municipality_id::text, ',') INTO orphaned
    FROM tenancy.municipality m
   WHERE NOT EXISTS (SELECT 1 FROM divipola_source s
                      WHERE upper(s.name) = upper(m.name) AND upper(s.department) = upper(m.department))
     AND (   EXISTS (SELECT 1 FROM tenancy.company c    WHERE c.municipality_id = m.municipality_id)
          OR EXISTS (SELECT 1 FROM trips.trip_request t WHERE t.municipality_id = m.municipality_id));
  IF orphaned IS NOT NULL THEN
    RAISE EXCEPTION 'ADR-031: referenced municipalities without a DANE match: %; rename them to the DANE name first', orphaned;
  END IF;
END
$$;

ALTER TABLE tenancy.municipality
  ADD COLUMN dane_code     CHAR(5),
  ADD COLUMN dane_type     TEXT,
  ADD COLUMN reference_lat DOUBLE PRECISION,
  ADD COLUMN reference_lng DOUBLE PRECISION,
  ALTER COLUMN coverage_polygon DROP NOT NULL;

CREATE UNIQUE INDEX "municipality_dane_code_key" ON tenancy.municipality (dane_code);

ALTER TABLE tenancy.municipality
  ADD CONSTRAINT municipality_status_check
    CHECK (status IN ('catalog', 'active', 'retired')),
  ADD CONSTRAINT municipality_coverage_matches_status
    CHECK ((status = 'active') = (coverage_polygon IS NOT NULL)),
  ADD CONSTRAINT municipality_coverage_polygon_is_object
    CHECK (coverage_polygon IS NULL OR jsonb_typeof(coverage_polygon) = 'object'),
  ADD CONSTRAINT municipality_dane_code_format
    CHECK (dane_code IS NULL OR dane_code ~ '^[0-9]{5}$'),
  ADD CONSTRAINT municipality_dane_type_check
    CHECK (dane_type IS NULL OR dane_type IN ('municipality', 'island', 'non_municipalized_area'));

UPDATE tenancy.municipality m
   SET dane_code = s.dane_code, dane_type = s.dane_type,
       name = s.name, department = s.department,
       reference_lat = s.reference_lat, reference_lng = s.reference_lng
  FROM divipola_source s
 WHERE m.dane_code IS NULL
   AND upper(s.name) = upper(m.name) AND upper(s.department) = upper(m.department);

SELECT setval(
  pg_get_serial_sequence('tenancy.municipality', 'municipality_id'),
  GREATEST((SELECT coalesce(max(municipality_id), 0) FROM tenancy.municipality), 1),
  (SELECT count(*) > 0 FROM tenancy.municipality)
);

INSERT INTO tenancy.municipality
  (name, department, dane_code, dane_type, reference_lat, reference_lng, status, coverage_polygon)
SELECT s.name, s.department, s.dane_code, s.dane_type, s.reference_lat, s.reference_lng, 'catalog', NULL
  FROM divipola_source s
 ORDER BY s.dane_code
ON CONFLICT (dane_code) DO NOTHING;

DO $$
BEGIN
  IF (SELECT count(*) FROM tenancy.municipality WHERE dane_code IS NOT NULL) <> ${count} THEN
    RAISE EXCEPTION 'ADR-031: catalog load ended with % rows, expected ${count}',
      (SELECT count(*) FROM tenancy.municipality WHERE dane_code IS NOT NULL);
  END IF;
END
$$;

DROP TABLE divipola_source;
`;
}

const SHA256_LINE = /^- \*\*sha256 del CSV:\*\* `([0-9a-f]{64})`/m;
const CHECKSUM_LINE = /^- \*\*Checksum esperado del catálogo cargado:\*\* `([0-9a-f]{32})`/m;

export function expectedCsvSha256(sourceMarkdown: string): string {
  const match = SHA256_LINE.exec(sourceMarkdown);
  if (!match?.[1]) throw new CatalogSourceError('SOURCE.md does not record the CSV sha256');
  return match[1];
}

export function recordedCatalogChecksum(sourceMarkdown: string): string | null {
  return CHECKSUM_LINE.exec(sourceMarkdown)?.[1] ?? null;
}

export interface BuildInput {
  csvPath: string;
  sourcePath: string;
  expectedCount?: number;
}

export interface BuildResult {
  sql: string;
  checksum: string;
  counts: Record<DaneType, number>;
  rowCount: number;
}

export function buildCatalogMigration(input: BuildInput): BuildResult {
  const csv = readFileSync(input.csvPath);
  const actualSha = createHash('sha256').update(csv).digest('hex');
  const expectedSha = expectedCsvSha256(readFileSync(input.sourcePath, 'utf8'));
  if (actualSha !== expectedSha) {
    throw new CatalogSourceError(`CSV sha256 ${actualSha} does not match SOURCE.md (${expectedSha})`);
  }
  const rows = parseDivipolaRows(csv.toString('utf8'), input.expectedCount);
  return {
    sql: renderMigrationSql(rows),
    checksum: catalogChecksum(rows),
    counts: countByType(rows),
    rowCount: rows.length,
  };
}

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function main(): void {
  const out = argument('--out');
  if (!out) {
    throw new Error('Usage: build-catalog-migration.ts --out <migration.sql> [--csv <file>] [--source <SOURCE.md>]');
  }
  const csvPath = resolve(argument('--csv') ?? 'prisma/data/divipola/divipola-2024-12-30.csv');
  const sourcePath = resolve(argument('--source') ?? 'prisma/data/divipola/SOURCE.md');
  const result = buildCatalogMigration({ csvPath, sourcePath });
  const recorded = recordedCatalogChecksum(readFileSync(sourcePath, 'utf8'));
  if (recorded !== null && recorded !== result.checksum) {
    throw new CatalogSourceError(`Catalog checksum ${result.checksum} does not match SOURCE.md (${recorded})`);
  }
  writeFileSync(resolve(out), result.sql, { encoding: 'utf8' });
  process.stdout.write(
    `${JSON.stringify({ rows: result.rowCount, counts: result.counts, catalog_checksum: result.checksum, recorded_in_source: recorded !== null })}\n`,
  );
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
