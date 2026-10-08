import type { SettlementReportResponse } from '@voyyaa/shared';
import { buildSettlementCsv, settlementCsvFilename } from './settlement-csv.writer';

const ROW: SettlementReportResponse['rows'][number] = {
  driver_id: 1,
  driver_name: 'María Peña',
  national_id: '123',
  plate: 'ABC123',
  trip_count: 3,
  cash_collected: 30000,
  commission: 2400,
  driver_net: 27600,
  amount_to_remit: 2400,
  pending_cash_trip_count: 1,
  pending_cash_amount: 9000,
  remittance: null,
};

const REPORT: SettlementReportResponse = {
  from: '2026-10-05',
  to: '2026-10-11',
  time_zone: 'America/Bogota',
  week_start: '2026-10-05',
  in_progress: false,
  generated_at: '2026-10-12T15:30:00.000Z',
  rows: [
    {
      driver_id: 1,
      driver_name: 'María Peña',
      national_id: '123',
      plate: 'ABC123',
      trip_count: 3,
      cash_collected: 30000,
      commission: 2400,
      driver_net: 27600,
      amount_to_remit: 2400,
      pending_cash_trip_count: 1,
      pending_cash_amount: 9000,
      remittance: null,
    },
  ],
  totals: {
    trip_count: 3,
    cash_collected: 30000,
    commission: 2400,
    driver_net: 27600,
    amount_to_remit: 2400,
    pending_cash_trip_count: 1,
    pending_cash_amount: 9000,
    remitted_amount: null,
    remittance_balance: null,
  },
};

describe('buildSettlementCsv', () => {
  const lines = (csv: string): string[] => csv.replace(/^\uFEFF/, '').split('\r\n');

  it('starts with a UTF-8 BOM and does not write the sep= line', () => {
    const csv = buildSettlementCsv('Cootrayal', REPORT);
    expect(csv.charCodeAt(0)).toBe(0xfeff);
    expect(csv).not.toMatch(/sep=/);
  });

  it('writes the header block, titles, rows and totals separated by semicolons', () => {
    const out = lines(buildSettlementCsv('Cootrayal', REPORT));
    expect(out.slice(0, 5)).toEqual([
      'Empresa;Cootrayal',
      'Desde;2026-10-05',
      'Hasta;2026-10-11',
      'Zona horaria;America/Bogota',
      'Generado;2026-10-12 10:30 (hora Bogotá)',
    ]);
    expect(out[5]).toBe('');
    expect(out[6]).toBe(
      'Conductor;Cédula;Placa;Viajes;Efectivo cobrado;Comisión registrada;Neto del conductor;Total a remitir;Viajes con cobro pendiente;Monto con cobro pendiente',
    );
    expect(out[7]).toBe('María Peña;123;ABC123;3;30000;2400;27600;2400;1;9000');
    expect(out[8]).toBe('Totales;;;3;30000;2400;27600;2400;1;9000');
  });

  it.each(['=', '+', '-', '@'])('neutralizes text cells starting with %s', (prefix) => {
    const report = { ...REPORT, rows: [{ ...ROW, driver_name: `${prefix}CMD()` }] };
    expect(lines(buildSettlementCsv('X', report))[7]).toContain(`'${prefix}CMD();123;`);
  });

  it('quotes cells containing separators, quotes or line breaks', () => {
    const report = { ...REPORT, rows: [{ ...ROW, driver_name: 'A;"B"' }] };
    expect(lines(buildSettlementCsv('X', report))[7]).toMatch(/^"A;""B"""/);
  });

  it('writes an empty plate as an empty cell', () => {
    const report = { ...REPORT, rows: [{ ...ROW, plate: null }] };
    expect(lines(buildSettlementCsv('X', report))[7]).toBe('María Peña;123;;3;30000;2400;27600;2400;1;9000');
  });
});

describe('settlementCsvFilename', () => {
  it('slugifies the legal name without accents and collapses separators', () => {
    expect(settlementCsvFilename('Cooperativa  Ñandú & Co.', '2026-10-05', '2026-10-11')).toBe(
      'conciliacion_cooperativa-nandu-co_2026-10-05_2026-10-11.csv',
    );
  });

  it('falls back when the name has no usable characters', () => {
    expect(settlementCsvFilename('!!!', '2026-10-05', '2026-10-11')).toBe(
      'conciliacion_empresa_2026-10-05_2026-10-11.csv',
    );
  });
});
