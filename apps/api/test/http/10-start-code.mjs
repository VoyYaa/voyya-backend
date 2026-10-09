import {
  DROPOFF,
  PICKUP,
  check,
  driverLogin,
  flushResults,
  grantLocationConsent,
  http,
  offersFor,
  passengerLogin,
  psql,
  quote,
  requestTrip,
  sleep,
  tripStatus,
  waitForOffer,
} from './lib.mjs';
import { SEED_DRIVERS } from './state.mjs';

const DRIVER = SEED_DRIVERS[0];
const municipalityId = Number(psql("SELECT municipality_id FROM tenancy.municipality WHERE name = 'Yarumal'"));
const bodies = [];

const keep = (response) => {
  bodies.push(response.text);
  return response;
};

const dbRow = (tripId) => {
  const [status, attempts, blockedAt, code] = psql(
    `SELECT status, start_code_failed_attempts, coalesce(start_code_blocked_at::text,''), coalesce(start_code,'') FROM trips.trip_request WHERE trip_request_id=${tripId}`,
  ).split('|');
  return { status, attempts: Number(attempts), blockedAt, code };
};

async function requestAndAccept(passengerToken, driverToken) {
  const q = await quote(passengerToken, municipalityId);
  const created = await requestTrip(passengerToken, municipalityId, q.body.quote_token);
  if (created.status !== 201) throw new Error(`request ${created.status} ${created.text}`);
  const tripId = created.body.trip_request_id;
  const offer = await waitForOffer(driverToken, tripId, 15000);
  if (!offer) throw new Error('no offer reached the driver');
  const accepted = keep(
    await http('POST', `/assignments/${offer.assignment_id}/accept`, { token: driverToken, body: {} }),
  );
  return { tripId, accepted };
}

await http('POST', '/auth/driver/login', { body: { national_id: DRIVER.nationalId, pin: DRIVER.pin } });
const driver = await driverLogin(DRIVER.nationalId, DRIVER.pin);
const passengerOne = await passengerLogin('3105550701');
const passengerTwo = await passengerLogin('3105550702');
await grantLocationConsent(driver.token);
await grantLocationConsent(passengerOne.token);
await grantLocationConsent(passengerTwo.token);

for (const other of SEED_DRIVERS.slice(1)) {
  const session = await driverLogin(other.nationalId, other.pin);
  await http('PUT', '/driver/shift', { token: session.token, body: { on_shift: false } });
}
const shift = await http('PUT', '/driver/shift', {
  token: driver.token,
  body: { on_shift: true, location: { lat: DRIVER.lat, lng: DRIVER.lng } },
});
check('SMOKE-0', 'el conductor activa turno con el aviso v3 aceptado', shift.status === 200, shift.text);

const first = await requestAndAccept(passengerOne.token, driver.token);
check('SMOKE-1', 'assign: el conductor acepta y recibe 200 accepted', first.accepted.status === 200, first.accepted.text);

const status = await tripStatus(passengerOne.token, first.tripId);
const code = dbRow(first.tripId).code;
check(
  'SMOKE-2',
  'el pasajero ve el código de 4 dígitos, estado active, y la ventana de seguimiento con umbrales y sin posición',
  status.status === 200 &&
    status.body.start_code === code &&
    /^[0-9]{4}$/.test(code) &&
    status.body.start_code_state === 'active' &&
    status.body.driver_tracking?.stale_after_sec === 45 &&
    status.body.driver_tracking?.hide_after_sec === 300 &&
    status.body.driver_tracking?.position === null,
  status.text,
);
check(
  'SMOKE-2b',
  'GET /trips/:id responde con Cache-Control: no-store',
  status.headers.get('cache-control') === 'no-store',
  status.headers.get('cache-control'),
);

const home = keep(await http('GET', '/driver/me', { token: driver.token }));
const view = home.body?.active_trip;
check(
  'SMOKE-3',
  'el conductor NO recibe el código: start_code_required=true, 5 intentos, punto de recogida, sin destino y sin la cadena del código',
  home.status === 200 &&
    view?.start_code_required === true &&
    view?.start_attempts_remaining === 5 &&
    view?.pickup_location?.lat !== undefined &&
    view?.dropoff_location === null &&
    !home.text.includes(`"${code}"`) &&
    !home.text.includes('"start_code"'),
  home.text,
);

const reported = keep(
  await http('POST', '/driver/location', { token: driver.token, body: { lat: PICKUP.lat + 0.0005, lng: PICKUP.lng } }),
);
const tracked = await tripStatus(passengerOne.token, first.tripId);
check(
  'SMOKE-4',
  'el reporte del conductor devuelve location_sharing y el pasajero ve la posición con su edad',
  reported.status === 200 &&
    reported.body.location_sharing?.trip_request_id === first.tripId &&
    reported.body.location_sharing?.interval_sec === 15 &&
    Math.abs(tracked.body.driver_tracking?.position?.lat - (PICKUP.lat + 0.0005)) < 1e-6 &&
    tracked.body.driver_tracking.position.age_sec < 10,
  `${reported.text} ${tracked.text}`,
);

keep(await http('POST', `/trips/${first.tripId}/en-route`, { token: driver.token, body: {} }));

const missing = keep(await http('POST', `/trips/${first.tripId}/start`, { token: driver.token, body: {} }));
check(
  'SMOKE-5',
  'start sin código: 422 START_CODE_REQUIRED y no gasta intento',
  missing.status === 422 && missing.body?.code === 'START_CODE_REQUIRED' && dbRow(first.tripId).attempts === 0,
  missing.text,
);

const wrong = code === '0000' ? '0001' : '0000';
const wrongOne = keep(await http('POST', `/trips/${first.tripId}/start`, { token: driver.token, body: { start_code: wrong } }));
check(
  'SMOKE-6',
  'start con código incorrecto: 422 START_CODE_INVALID con attempts_remaining=4 y el intento sobrevive (se relee la fila)',
  wrongOne.status === 422 &&
    wrongOne.body?.code === 'START_CODE_INVALID' &&
    wrongOne.body?.attempts_remaining === 4 &&
    dbRow(first.tripId).attempts === 1,
  wrongOne.text,
);

let lastWrong = wrongOne;
for (let i = 0; i < 4; i += 1) {
  lastWrong = keep(await http('POST', `/trips/${first.tripId}/start`, { token: driver.token, body: { start_code: wrong } }));
}
const blockedRow = dbRow(first.tripId);
check(
  'SMOKE-7',
  'el quinto fallo bloquea: 409 START_CODE_BLOCKED con blocked_at, 5 intentos y el código borrado',
  lastWrong.status === 409 &&
    lastWrong.body?.code === 'START_CODE_BLOCKED' &&
    typeof lastWrong.body?.blocked_at === 'string' &&
    blockedRow.attempts === 5 &&
    blockedRow.blockedAt !== '' &&
    blockedRow.code === '',
  lastWrong.text,
);

const correctButBlocked = keep(
  await http('POST', `/trips/${first.tripId}/start`, { token: driver.token, body: { start_code: code } }),
);
check(
  'SMOKE-8',
  'con el viaje bloqueado ni el código correcto inicia: 409 START_CODE_BLOCKED y el viaje sigue en driver_en_route',
  correctButBlocked.status === 409 &&
    correctButBlocked.body?.code === 'START_CODE_BLOCKED' &&
    dbRow(first.tripId).status === 'driver_en_route',
  correctButBlocked.text,
);

const blockedStatus = await tripStatus(passengerOne.token, first.tripId);
check(
  'SMOKE-9',
  'el pasajero ve el estado blocked sin código',
  blockedStatus.body?.start_code_state === 'blocked' && blockedStatus.body?.start_code === null,
  blockedStatus.text,
);

const cancelled = await http('POST', `/trips/${first.tripId}/cancel`, { token: passengerOne.token, body: {} });
check(
  'SMOKE-10',
  'con el inicio bloqueado el pasajero cancela sin costo',
  cancelled.status === 200 && cancelled.body?.penalty_recorded === false && cancelled.body?.free_of_charge === true,
  cancelled.text,
);

await sleep(500);
const second = await requestAndAccept(passengerTwo.token, driver.token);
const secondCode = dbRow(second.tripId).code;
keep(await http('POST', `/trips/${second.tripId}/en-route`, { token: driver.token, body: {} }));
const started = keep(
  await http('POST', `/trips/${second.tripId}/start`, { token: driver.token, body: { start_code: secondCode } }),
);
check(
  'SMOKE-11',
  'en otro viaje, el código correcto inicia: 200 in_progress',
  started.status === 200 && started.body?.status === 'in_progress' && started.body?.idempotent === false,
  started.text,
);

const afterStart = await tripStatus(passengerTwo.token, second.tripId);
check(
  'SMOKE-12',
  'tras iniciar, el pasajero ya no recibe código ni seguimiento',
  afterStart.body?.status === 'in_progress' &&
    afterStart.body?.start_code === null &&
    afterStart.body?.start_code_state === 'not_applicable' &&
    afterStart.body?.driver_tracking === null,
  afterStart.text,
);

const homeStarted = keep(await http('GET', '/driver/me', { token: driver.token }));
check(
  'SMOKE-13',
  'en curso el conductor recibe el destino y deja de compartir',
  homeStarted.body?.active_trip?.dropoff_location?.lat !== undefined &&
    homeStarted.body?.active_trip?.location_sharing === null &&
    homeStarted.body?.active_trip?.start_code_required === false,
  homeStarted.text,
);

keep(await http('POST', `/trips/${second.tripId}/complete`, { token: driver.token, body: { cash_collected: true } }));
const offersAfter = keep(await offersFor(driver.token));
const everything = bodies.join('\n');
check(
  'SMOKE-14',
  'ninguna respuesta del conductor contiene el código de ninguno de los dos viajes ni la clave start_code',
  !everything.includes(`"${code}"`) && !everything.includes(`"${secondCode}"`) && !everything.includes('"start_code"'),
  offersAfter.status,
);

process.exit(flushResults() === 0 ? 0 : 1);
