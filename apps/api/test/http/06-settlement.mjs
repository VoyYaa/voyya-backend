import { check, flushResults, http, psql } from './lib.mjs';
import { loadState } from './state.mjs';

const state = loadState();
const A = state.cootrayalId;
const B = state.companyB;
const today = new Date(Date.now() - 5 * 3600e3).toISOString().slice(0, 10);
const tomorrow = new Date(Date.now() - 5 * 3600e3 + 86400e3).toISOString().slice(0, 10);

function expected(companyId) {
  const [count, cash, commission] = psql(
    `SELECT count(*), coalesce(sum(fare),0)::int, coalesce(sum(commission),0)::int FROM trips.trip_request WHERE company_id=${companyId} AND status='completed' AND cash_collected_at IS NOT NULL`,
  )
    .split('|')
    .map(Number);
  return { count, cash, commission };
}

for (const [label, session, companyId] of [
  ['Cootrayal', state.sessions.adminA.session, A],
  ['Taxis Norte', state.sessions.adminB.session, B],
]) {
  const report = await http('GET', `/admin/reports/settlement?from=${today}&to=${tomorrow}`, {
    token: session.token,
  });
  const want = expected(companyId);
  check(
    'HU-MS-15',
    `${label}: conciliación = viajes completados con cobro de SU empresa (esperado por SQL ${JSON.stringify(want)})`,
    report.status === 200 &&
      report.body.totals.trip_count === want.count &&
      report.body.totals.cash_collected === want.cash &&
      report.body.totals.commission === want.commission,
    JSON.stringify(report.body?.totals),
  );
  const foreign = report.body.rows.filter((row) => {
    const owner = psql(`SELECT company_id FROM fleet.driver WHERE driver_id=${row.driver_id}`);
    return owner !== String(companyId);
  });
  check(
    'HU-MS-15',
    `${label}: el reporte solo lista conductores de su empresa`,
    foreign.length === 0,
    JSON.stringify(foreign.map((r) => r.driver_id)),
  );
  const totals = report.body.totals;
  check(
    'HU-MS-15',
    `${label}: neto del conductor = efectivo - comisión y total a remitir = comisión de la empresa, sin cobros pendientes`,
    totals.driver_net === want.cash - want.commission &&
      totals.amount_to_remit === want.commission &&
      totals.pending_cash_trip_count === 0,
    JSON.stringify(totals),
  );
}

const cancelledWithCompany = Number(
  psql(
    `SELECT count(*) FROM trips.trip_request WHERE status IN ('cancelled_by_passenger','cancelled_by_driver') AND company_id IS NOT NULL`,
  ),
);
check(
  'HU-MS-15',
  'hay viajes cancelados tras aceptar que conservan empresa y comisión en la fila, y aun así ningún total los cuenta (verificado arriba contra SQL de solo completados)',
  cancelledWithCompany >= 2,
  `cancelados con empresa: ${cancelledWithCompany}`,
);

const pending = await http('GET', '/driver/trips/cash-pending', {
  token: state.sessions['driver-82000001'].session.token,
});
check(
  'HU-MS-15',
  'GET /driver/trips/cash-pending responde 200',
  pending.status === 200 && Array.isArray(pending.body),
  pending.text.slice(0, 200),
);
process.exitCode = flushResults() ? 1 : 0;
