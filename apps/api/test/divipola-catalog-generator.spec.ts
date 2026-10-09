import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  buildCatalogMigration,
  CatalogSourceError,
  catalogChecksum,
  countByType,
  escapeSqlLiteral,
  expectedCsvSha256,
  parseCsv,
  parseDivipolaRows,
  recordedCatalogChecksum,
  renderMigrationSql,
  renderSourceTuples,
  toPresentationName,
} from '../scripts/divipola/build-catalog-migration';

const DATA_DIR = resolve(__dirname, '..', 'prisma', 'data', 'divipola');
const CSV_PATH = join(DATA_DIR, 'divipola-2024-12-30.csv');
const SOURCE_PATH = join(DATA_DIR, 'SOURCE.md');
const MIGRATION_PATH = resolve(
  __dirname,
  '..',
  'prisma',
  'migrations',
  '20261009100000_municipality_dane_catalog',
  'migration.sql',
);

const HEADER = '"cod_dpto","dpto","cod_mpio","nom_mpio","tipo_municipio","longitud","latitud"';

function csvOf(...rows: string[]): string {
  return [HEADER, ...rows].join('\n') + '\n';
}

const YARUMAL = '"05","ANTIOQUIA","05887","YARUMAL","Municipio","-75,418828","6,963832"';
const SANTA_ROSA = '"05","ANTIOQUIA","05686","SANTA ROSA DE OSOS","Municipio","-75,460723","6,643366"';

describe('toPresentationName (ADR-031 section 4.2)', () => {
  it.each([
    ['YARUMAL', 'Yarumal'],
    ['SANTA ROSA DE OSOS', 'Santa Rosa de Osos'],
    ['BOGOTÁ, D.C.', 'Bogotá, D.C.'],
    ['EL CARMEN DE VIBORAL', 'El Carmen de Viboral'],
    ['LA UNIÓN', 'La Unión'],
    ['SAN JUAN DEL CESAR', 'San Juan del Cesar'],
    ['PUERTO NARIÑO', 'Puerto Nariño'],
    ['VILLA DE SAN DIEGO DE UBATÉ', 'Villa de San Diego de Ubaté'],
    ['ARCHIPIÉLAGO DE SAN ANDRÉS, PROVIDENCIA Y SANTA CATALINA', 'Archipiélago de San Andrés, Providencia y Santa Catalina'],
    ['VALLE DEL CAUCA', 'Valle del Cauca'],
    ['LOS PATIOS', 'Los Patios'],
    ['SAN VICENTE DE CHUCURÍ', 'San Vicente de Chucurí'],
    ['  SAN  LUIS  ', 'San Luis'],
    ['ALTO-BAUDÓ', 'Alto-Baudó'],
    ['MARÍA LA BAJA', 'María la Baja'],
  ])('%s -> %s', (source, expected) => {
    expect(toPresentationName(source)).toBe(expected);
  });
});

describe('parseCsv', () => {
  it('handles quoted commas, doubled quotes and CRLF', () => {
    expect(parseCsv('"a,b","c""d"\r\n"e","f"\r\n')).toEqual([
      ['a,b', 'c"d'],
      ['e', 'f'],
    ]);
  });
});

describe('escapeSqlLiteral (MD-17)', () => {
  it('doubles single quotes so the literal inserts the exact value', () => {
    expect(escapeSqlLiteral("O'Higgins", 'row')).toBe("'O''Higgins'");
  });

  it.each(['a\u0000b', 'a\nb', 'a\u001fb', 'a\u007fb'])('rejects the control character in %j', (value) => {
    expect(() => escapeSqlLiteral(value, 'row 7')).toThrow(/Control character in row 7/);
  });

  it('treats a dollar-quote sequence as plain text inside a quoted literal', () => {
    expect(escapeSqlLiteral("$$'; DROP TABLE x; --", 'row')).toBe("'$$''; DROP TABLE x; --'");
  });
});

describe('parseDivipolaRows', () => {
  it('parses decimal commas into points and maps the type', () => {
    const rows = parseDivipolaRows(csvOf(YARUMAL, SANTA_ROSA), 2);

    expect(rows).toEqual([
      {
        daneCode: '05686',
        name: 'Santa Rosa de Osos',
        department: 'Antioquia',
        daneType: 'municipality',
        referenceLat: '6.643366',
        referenceLng: '-75.460723',
      },
      {
        daneCode: '05887',
        name: 'Yarumal',
        department: 'Antioquia',
        daneType: 'municipality',
        referenceLat: '6.963832',
        referenceLng: '-75.418828',
      },
    ]);
  });

  it('fails without a full source: the Socrata default of 1000 rows is not accepted', () => {
    expect(() => parseDivipolaRows(csvOf(YARUMAL))).toThrow(/must have 1122 rows, has 1/);
  });

  it('fails on a changed header', () => {
    expect(() => parseDivipolaRows('"a","b"\n"1","2"\n', 1)).toThrow(/Unexpected CSV header/);
  });

  it('fails on a duplicated code', () => {
    expect(() => parseDivipolaRows(csvOf(YARUMAL, YARUMAL), 2)).toThrow(/Duplicated DANE code 05887/);
  });

  it('fails when cod_dpto does not match the code', () => {
    const bad = '"08","ATLÁNTICO","05887","YARUMAL","Municipio","-75,418828","6,963832"';
    expect(() => parseDivipolaRows(csvOf(bad), 1)).toThrow(/cod_dpto 08 does not match 05887/);
  });

  it('fails on an unknown type', () => {
    const bad = '"05","ANTIOQUIA","05887","YARUMAL","Corregimiento","-75,418828","6,963832"';
    expect(() => parseDivipolaRows(csvOf(bad), 1)).toThrow(/Unknown tipo_municipio "Corregimiento"/);
  });

  it('fails on a malformed coordinate', () => {
    const bad = '"05","ANTIOQUIA","05887","YARUMAL","Municipio","-75.418828","6,963832"';
    expect(() => parseDivipolaRows(csvOf(bad), 1)).toThrow(/Invalid coordinate/);
  });

  it('fails naming the row when a field has a control character', () => {
    const bad = '"05","ANTIOQUIA","05887","YARU\u0001MAL","Municipio","-75,418828","6,963832"';
    expect(() => parseDivipolaRows(csvOf(YARUMAL.replace('05887', '05001'), bad), 2)).toThrow(
      /Control character in row 3 \(05887\)/,
    );
  });
});

describe('the SQL generated for a name with a quote (MD-17)', () => {
  const row = '"05","ANTIOQUIA","05001","O\'HIGGINS","Municipio","-75,5","6,2"';

  it('writes the exact name as an escaped literal', () => {
    const rows = parseDivipolaRows(csvOf(row), 1);

    expect(rows[0]?.name).toBe("O'Higgins");
    expect(renderSourceTuples(rows)).toContain("'O''Higgins'");
  });

  const pgUrl = process.env.PG_TEST_URL;
  const dbIt = pgUrl ? it : it.skip;

  dbIt('PostgreSQL reads the literal back as the exact name', async () => {
    const { PrismaClient } = await import('@prisma/client');
    const prisma = new PrismaClient({ datasources: { db: { url: pgUrl } } });
    try {
      const rows = parseDivipolaRows(csvOf(row), 1);
      const result = await prisma.$queryRawUnsafe<Array<{ name: string }>>(
        `SELECT name FROM (VALUES\n${renderSourceTuples(rows)}\n) AS v(dane_code, name, department, dane_type, reference_lat, reference_lng)`,
      );

      expect(result).toEqual([{ name: "O'Higgins" }]);
    } finally {
      await prisma.$disconnect();
    }
  });
});

describe('the versioned DIVIPOLA source (ADR-031 sections 3 and 4)', () => {
  const rows = parseDivipolaRows(readFileSync(CSV_PATH, 'utf8'));

  it('has 1122 rows: 1103 municipalities, 1 island and 18 non municipalized areas', () => {
    expect(rows).toHaveLength(1122);
    expect(countByType(rows)).toEqual({ municipality: 1103, island: 1, non_municipalized_area: 18 });
  });

  it('keeps Yarumal as 05887 and Santa Rosa de Osos as 05686', () => {
    expect(rows.find((r) => r.daneCode === '05887')).toMatchObject({ name: 'Yarumal', department: 'Antioquia' });
    expect(rows.find((r) => r.daneCode === '05686')).toMatchObject({
      name: 'Santa Rosa de Osos',
      department: 'Antioquia',
    });
  });

  it('offers 1104 selectable rows (municipality or island) and excludes the 18 areas', () => {
    expect(rows.filter((r) => r.daneType !== 'non_municipalized_area')).toHaveLength(1104);
  });

  it('SOURCE.md records the sha256 of the CSV and the catalog checksum', () => {
    const source = readFileSync(SOURCE_PATH, 'utf8');

    expect(expectedCsvSha256(source)).toBe(createHash('sha256').update(readFileSync(CSV_PATH)).digest('hex'));
    expect(recordedCatalogChecksum(source)).toBe(catalogChecksum(rows));
  });

  it('the committed migration is exactly what the generator emits (deterministic, nothing written by hand)', () => {
    const result = buildCatalogMigration({ csvPath: CSV_PATH, sourcePath: SOURCE_PATH });

    expect(result.sql).toBe(readFileSync(MIGRATION_PATH, 'utf8'));
    expect(renderMigrationSql(rows)).toBe(result.sql);
  });

  it('the generator refuses a CSV whose sha256 is not the one in SOURCE.md', () => {
    const dir = mkdtempSync(join(tmpdir(), 'divipola-'));
    const tampered = join(dir, 'divipola.csv');
    writeFileSync(tampered, readFileSync(CSV_PATH, 'utf8').replace('YARUMAL', 'YARUMAL '));

    expect(() => buildCatalogMigration({ csvPath: tampered, sourcePath: SOURCE_PATH })).toThrow(CatalogSourceError);
  });

  it('every guard of the migration runs before the first DDL statement (ADR-031 section 4.4)', () => {
    const sql = readFileSync(MIGRATION_PATH, 'utf8');

    expect(sql.indexOf('RAISE EXCEPTION')).toBeGreaterThan(-1);
    expect(sql.indexOf('referenced municipalities without a DANE match')).toBeLessThan(sql.indexOf('ALTER TABLE'));
    expect(sql.indexOf('DROP TABLE divipola_source')).toBeGreaterThan(sql.indexOf('INSERT INTO tenancy.municipality'));
  });
});
