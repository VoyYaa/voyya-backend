import {
  SETTLEMENT_CSV_COLUMNS,
  SETTLEMENT_TIME_ZONE,
  type SettlementReportResponse,
} from '@voyyaa/shared';

const BOM = '﻿';
const SEPARATOR = ';';
const LINE_BREAK = '\r\n';
const FORMULA_PREFIX = /^[=+\-@\t\r]/;
const NEEDS_QUOTES = /[;"\r\n]/;
const FALLBACK_SLUG = 'empresa';

function textCell(value: string): string {
  const safe = FORMULA_PREFIX.test(value) ? `'${value}` : value;
  return NEEDS_QUOTES.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

function line(cells: readonly string[]): string {
  return cells.join(SEPARATOR);
}

function bogotaTimestamp(instant: Date): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: SETTLEMENT_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(instant);
  const part = (type: string): string => parts.find((p) => p.type === type)?.value ?? '';
  return `${part('year')}-${part('month')}-${part('day')} ${part('hour')}:${part('minute')}`;
}

export function buildSettlementCsv(companyName: string, report: SettlementReportResponse): string {
  const rows = report.rows.map((row) =>
    line(
      SETTLEMENT_CSV_COLUMNS.map(({ key }) => {
        const value = row[key];
        if (value === null) return '';
        return typeof value === 'number' ? String(value) : textCell(value);
      }),
    ),
  );
  const totals = line(
    SETTLEMENT_CSV_COLUMNS.map(({ key }) => {
      if (key === 'driver_name') return 'Totales';
      const total = (report.totals as Record<string, unknown>)[key];
      return typeof total === 'number' ? String(total) : '';
    }),
  );
  const lines = [
    line(['Empresa', textCell(companyName)]),
    line(['Desde', report.from]),
    line(['Hasta', report.to]),
    line(['Zona horaria', report.time_zone]),
    line(['Generado', `${bogotaTimestamp(new Date(report.generated_at))} (hora Bogotá)`]),
    '',
    line(SETTLEMENT_CSV_COLUMNS.map((c) => c.label)),
    ...rows,
    totals,
  ];
  return BOM + lines.join(LINE_BREAK) + LINE_BREAK;
}

function slugify(name: string): string {
  const slug = name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || FALLBACK_SLUG;
}

export function settlementCsvFilename(companyName: string, from: string, to: string): string {
  return `conciliacion_${slugify(companyName)}_${from}_${to}.csv`;
}
