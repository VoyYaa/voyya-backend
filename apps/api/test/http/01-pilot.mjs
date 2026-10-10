import {
  PICKUP,
  adminLogin,
  cachedSession,
  check,
  driverLogin,
  flushResults,
  grantLocationConsent,
  http,
  lifecycleBody,
  passengerLogin,
  psql,
  quote,
  requestTrip,
  tripStatus,
  waitForOffer,
  waitForTripStatus,
} from './lib.mjs';
import { ADMIN_EMAIL, PLATFORM_EMAIL, SEED_DRIVERS, STAFF_PASSWORD, saveState } from './state.mjs';

const platform = await cachedSession('platform', () => adminLogin(PLATFORM_EMAIL, STAFF_PASSWORD));
const admin = await cachedSession('adminA', () => adminLogin(ADMIN_EMAIL, STAFF_PASSWORD));
const yarumalId = Number(
  psql("SELECT municipality_id FROM tenancy.municipality WHERE dane_code='05887'"),
);
const cootrayalId = admin.user.tenant.company_id;
saveState({ yarumalId, cootrayalId });

const drivers = [];
for (const seeded of SEED_DRIVERS) {
  const session = await cachedSession(`driver-${seeded.nationalId}`, () =>
    driverLogin(seeded.nationalId, seeded.pin),
  );
  await grantLocationConsent(session.token);
  const shift = await http('PUT', '/driver/shift', {
    token: session.token,
    body: { on_shift: true, location: { lat: seeded.lat, lng: seeded.lng } },
  });
  check(
    'PILOT-00',
    `conductor ${seeded.nationalId} entra en turno`,
    shift.status === 200,
    shift.text,
  );
  drivers.push({ ...seeded, token: session.token, userId: session.user.user_id });
}
saveState({
  cootrayalDrivers: drivers.map((d) => ({ nationalId: d.nationalId, userId: d.userId })),
});

const passenger = await passengerLogin('3105550101');
await grantLocationConsent(passenger.token);

const options = await http('GET', `/trips/service-options?lat=${PICKUP.lat}&lng=${PICKUP.lng}`, {
  token: passenger.token,
});
const taxi = options.body?.services?.find((s) => s.service_type === 'taxi');
check(
  'HU-MS-01/02',
  'service-options con UNA empresa: municipio Yarumal, taxi, selection_required=false, sin empresas extra',
  options.status === 200 &&
    options.body.municipality?.name === 'Yarumal' &&
    taxi?.selection_required === false &&
    taxi.companies.length === 1,
  options.text,
);
check(
  'HU-MS-02',
  'la única empresa es Cootrayal y trae has_available_drivers=true',
  taxi?.companies[0]?.company_id === cootrayalId &&
    taxi.companies[0].has_available_drivers === true,
  JSON.stringify(taxi),
);

const q = await quote(passenger.token, yarumalId);
check(
  'HU-MS-03/RT-1',
  'cotización piloto: base 8000, commission=0, total 8000',
  q.status === 200 && q.body.fare.total === 8000 && q.body.fare.commission === 0,
  q.text,
);

const created = await requestTrip(passenger.token, yarumalId, q.body.quote_token);
check(
  'HU-MS-04',
  'pedido sin preferencia (piloto) crea el viaje en pending_assignment',
  created.status === 201 && created.body.status === 'pending_assignment',
  created.text,
);
const tripId = created.body.trip_request_id;

let winner = null;
let offer = null;
for (const d of drivers) {
  const found = await waitForOffer(d.token, tripId, 4000);
  if (found) {
    winner = d;
    offer = found;
    break;
  }
}
check(
  'HU-MS-17',
  'una oferta nearest-first llega a un conductor de Cootrayal',
  Boolean(offer),
  'sin oferta',
);
const accepted = await http('POST', `/assignments/${offer.assignment_id}/accept`, {
  token: winner.token,
  body: {},
});
check(
  'HU-MS-07',
  'accept devuelve result=accepted (contrato de hoy)',
  accepted.status === 200 && accepted.body.result === 'accepted',
  accepted.text,
);

const assigned = await tripStatus(passenger.token, tripId);
check(
  'HU-MS-06',
  'GET /trips/:id: assigned, requested_company=null y driver.company=Cootrayal',
  assigned.body.status === 'assigned' &&
    assigned.body.requested_company === null &&
    assigned.body.driver?.company?.company_id === cootrayalId,
  assigned.text,
);

const row = psql(
  `SELECT company_id, commission_pct::numeric(5,2), commission::int, fare::int FROM trips.trip_request WHERE trip_request_id=${tripId}`,
);
check(
  'HU-MS-15',
  'la toma fijó company_id=Cootrayal, comisión 8 % = 640 sobre 8000',
  row === `${cootrayalId}|8.00|640|8000`,
  row,
);

for (const step of ['en-route', 'arrived', 'start']) {
  const r = await http('POST', `/trips/${tripId}/${step}`, { token: winner.token, body: lifecycleBody(step, tripId) });
  check('RT-3', `conductor ${step} -> 200`, r.status === 200, r.text);
}
const done = await http('POST', `/trips/${tripId}/complete`, {
  token: winner.token,
  body: { cash_collected: true },
});
check(
  'RT-3',
  'complete con cash_collected=true',
  done.status === 200 && done.body.status === 'completed',
  done.text,
);
const finalStatus = await waitForTripStatus(passenger.token, tripId, 'completed', 3000);
check(
  'RT-3',
  'el pasajero ve completed',
  finalStatus.body.status === 'completed',
  finalStatus.text,
);

const today = new Date(Date.now() - 5 * 3600e3).toISOString().slice(0, 10);
const report = await http('GET', `/admin/reports/settlement?from=${today}&to=${today}`, {
  token: admin.token,
});
check(
  'HU-MS-16/RT-3',
  'conciliación Cootrayal del piloto: 1 viaje, efectivo 8000, comisión 640',
  report.status === 200 &&
    report.body.totals.trip_count === 1 &&
    report.body.totals.cash_collected === 8000 &&
    report.body.totals.commission === 640,
  JSON.stringify(report.body?.totals),
);

const opsList = await http('GET', '/ops/trip-requests?status=all', { token: admin.token });
check(
  'HU-MS-08/RT-3',
  'consola de Cootrayal ve el viaje del piloto',
  opsList.status === 200 && opsList.body.rows.some((r) => r.trip_request_id === tripId),
  opsList.text,
);

saveState({ pilotTripId: tripId, pilotDriverUserId: winner.userId });
process.exitCode = flushResults() ? 1 : 0;
