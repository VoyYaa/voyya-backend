import {
  check,
  flushResults,
  http,
  offersFor,
  psql,
  quote,
  requestTrip,
  sleep,
  tripStatus,
  waitForOffer,
} from './lib.mjs';
import { SEED_DRIVERS, loadState } from './state.mjs';

const state = loadState();
const y = state.yarumalId;
const passenger = state.sessions['passenger-1'].session;
const ROUNDS = Number(process.env.ROUNDS ?? 12);
const all = [...SEED_DRIVERS, ...state.companyBDrivers];
const tokenOf = (nationalId) => state.sessions[`driver-${nationalId}`].session.token;

async function refresh() {
  for (const d of all) {
    await http('PUT', '/driver/shift', {
      token: tokenOf(d.nationalId),
      body: { on_shift: true, location: { lat: d.lat, lng: d.lng } },
    });
  }
}

async function firstOffer(tripId) {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    for (const d of all) {
      const r = await offersFor(tokenOf(d.nationalId));
      const offer = (r.body ?? []).find((o) => o.trip_request_id === tripId);
      if (offer) return { nationalId: d.nationalId, offer };
    }
    await sleep(200);
  }
  return null;
}

async function newTrip() {
  const q = await quote(passenger.token, y);
  const created = await requestTrip(passenger.token, y, q.body.quote_token);
  return created.body.trip_request_id;
}

function snapshot(tripId) {
  const [status, company] = psql(
    `SELECT status, coalesce(company_id::text,'') FROM trips.trip_request WHERE trip_request_id=${tripId}`,
  ).split('|');
  const accepted = Number(
    psql(
      `SELECT count(*) FROM assignment.assignment WHERE trip_request_id=${tripId} AND status='accepted'`,
    ),
  );
  const live = Number(
    psql(
      `SELECT count(*) FROM assignment.assignment WHERE trip_request_id=${tripId} AND status IN ('created','notified') AND expires_at > now() at time zone 'utc'`,
    ),
  );
  return { status, company, accepted, live };
}

async function cancelActive() {
  const active = await http('GET', '/trips/active', { token: passenger.token });
  if (active.body?.active_trip)
    await http('POST', `/trips/${active.body.active_trip.trip_request_id}/cancel`, {
      token: passenger.token,
      body: {},
    });
}

await refresh();
await cancelActive();

const statuses = [];
const violations = [];
let acceptedWins = 0;
let cancelWins = 0;
for (let round = 0; round < ROUNDS; round += 1) {
  const tripId = await newTrip();
  const first = await firstOffer(tripId);
  if (!first) {
    violations.push(`round ${round}: sin oferta`);
    await cancelActive();
    continue;
  }
  const [accept, cancel] = await Promise.all([
    http('POST', `/assignments/${first.offer.assignment_id}/accept`, {
      token: tokenOf(first.nationalId),
      body: {},
    }),
    http('POST', `/trips/${tripId}/cancel`, { token: passenger.token, body: {} }),
  ]);
  statuses.push(`${accept.status}/${accept.body?.result ?? '-'}+${cancel.status}`);
  await sleep(400);
  const snap = snapshot(tripId);
  const driverStatus = psql(
    `SELECT status FROM fleet.driver WHERE national_id='${first.nationalId}'`,
  );
  if (accept.status >= 500 || cancel.status >= 500)
    violations.push(`round ${round}: 5xx ${accept.status}/${cancel.status}`);
  if (snap.status === 'cancelled_by_passenger') {
    cancelWins += 1;
    if (snap.accepted !== 0 || snap.live !== 0)
      violations.push(`round ${round}: cancelado con asignación viva ${JSON.stringify(snap)}`);
    if (driverStatus !== 'available')
      violations.push(`round ${round}: cancelado y el conductor quedó ${driverStatus}`);
  } else if (snap.status === 'assigned') {
    acceptedWins += 1;
    violations.push(
      `round ${round}: la cancelación respondió ${cancel.status} pero el viaje quedó assigned ${JSON.stringify(snap)}`,
    );
  } else {
    violations.push(`round ${round}: estado inesperado ${JSON.stringify(snap)}`);
  }
  await cancelActive();
  await sleep(200);
}
check(
  'MD-05',
  `cancelación del pasajero vs toma, ${ROUNDS} carreras por HTTP real: ninguna 5xx, estado final coherente (viaje cancelado, asignación cerrada, conductor libre)`,
  violations.length === 0,
  violations.join(' | '),
);
console.log(`respuestas accept+cancel: ${statuses.join(', ')}`);
console.log(
  `ganó la cancelación: ${cancelWins}; ganó la toma y el viaje terminó cancelado: ${acceptedWins}`,
);

const settled = [];
for (let round = 0; round < Math.max(4, Math.floor(ROUNDS / 3)); round += 1) {
  const tripId = await newTrip();
  const first = await firstOffer(tripId);
  if (!first) continue;
  const accepted = await http('POST', `/assignments/${first.offer.assignment_id}/accept`, {
    token: tokenOf(first.nationalId),
    body: {},
  });
  if (accepted.body?.result !== 'accepted') continue;
  const [driverCancel, passengerCancel] = await Promise.all([
    http('POST', `/assignments/${first.offer.assignment_id}/cancel`, {
      token: tokenOf(first.nationalId),
      body: { reason: 'Prueba de carrera' },
    }),
    http('POST', `/trips/${tripId}/cancel`, { token: passenger.token, body: {} }),
  ]);
  settled.push(`${driverCancel.status}+${passengerCancel.status}`);
  await sleep(500);
  const snap = snapshot(tripId);
  if (driverCancel.status >= 500 || passengerCancel.status >= 500)
    violations.push(`driver/passenger cancel 5xx ${driverCancel.status}/${passengerCancel.status}`);
  if (snap.accepted > 1) violations.push(`más de una asignación aceptada ${JSON.stringify(snap)}`);
  await cancelActive();
  await sleep(300);
  await refresh();
}
check(
  'MD-18/MD-05',
  `cancelación del conductor (assigned) vs cancelación del pasajero: ninguna 5xx y a lo sumo una asignación aceptada (${settled.join(', ')})`,
  violations.length === 0,
  violations.join(' | '),
);
process.exitCode = flushResults() ? 1 : 0;
