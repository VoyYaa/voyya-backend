import {
  DROPOFF,
  PICKUP,
  cachedSession,
  check,
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
  waitForTripStatus,
} from './lib.mjs';
import { SEED_DRIVERS, loadState, saveState } from './state.mjs';

const state = loadState();
const y = state.yarumalId;
const A = state.cootrayalId;
const B = state.companyB;
const sessions = state.sessions;
const platform = sessions.platform.session;
const adminA = sessions.adminA.session;
const adminB = sessions.adminB.session;
const driverToken = (nationalId) => sessions[`driver-${nationalId}`].session.token;
const ALL_DRIVERS = [
  ...SEED_DRIVERS.map((d) => ({ ...d, company: A })),
  ...state.companyBDrivers.map((d) => ({
    nationalId: d.nationalId,
    lat: d.lat,
    lng: d.lng,
    company: B,
  })),
];

async function placeAllOnShift() {
  for (const d of ALL_DRIVERS) {
    const r = await http('PUT', '/driver/shift', {
      token: driverToken(d.nationalId),
      body: { on_shift: true, location: { lat: d.lat, lng: d.lng } },
    });
    if (r.status !== 200) throw new Error(`shift ${d.nationalId} ${r.status} ${r.text}`);
  }
}

async function offAllShift() {
  for (const d of ALL_DRIVERS) {
    await http('PUT', '/driver/shift', {
      token: driverToken(d.nationalId),
      body: { on_shift: false },
    });
  }
}

async function anyOfferFor(tripId, nationalIds, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const nationalId of nationalIds) {
      const response = await offersFor(driverToken(nationalId));
      const offer = (response.body ?? []).find((o) => o.trip_request_id === tripId);
      if (offer) return { nationalId, offer };
    }
    await sleep(250);
  }
  return null;
}

async function lifecycle(tripId, token, { cash = true } = {}) {
  for (const step of ['en-route', 'arrived', 'start']) {
    const r = await http('POST', `/trips/${tripId}/${step}`, { token, body: {} });
    if (r.status !== 200) throw new Error(`${step} ${r.status} ${r.text}`);
  }
  return http('POST', `/trips/${tripId}/complete`, { token, body: { cash_collected: cash } });
}

async function accept(driver, offer) {
  return http('POST', `/assignments/${offer.assignment_id}/accept`, {
    token: driverToken(driver),
    body: {},
  });
}

async function tripRow(tripId) {
  const [company, requested, pct, commission, status] = psql(
    `SELECT coalesce(company_id::text,''), coalesce(requested_company_id::text,''), coalesce(commission_pct::numeric(5,2)::text,''), commission::int, status FROM trips.trip_request WHERE trip_request_id=${tripId}`,
  ).split('|');
  return { company, requested, pct, commission: Number(commission), status };
}

async function newQuote(token) {
  const r = await quote(token, y);
  if (r.status !== 200) throw new Error(`quote ${r.status} ${r.text}`);
  return r.body;
}

const p1 = await cachedSession('passenger-1', () => passengerLogin('3105550201'));
const p2 = await cachedSession('passenger-2', () => passengerLogin('3105550202'));
for (const p of [p1, p2]) await grantLocationConsent(p.token);
await placeAllOnShift();

const options = await http('GET', `/trips/service-options?lat=${PICKUP.lat}&lng=${PICKUP.lng}`, {
  token: p1.token,
});
const taxi = options.body?.services?.find((s) => s.service_type === 'taxi');
check(
  'HU-MS-01/02',
  'service-options con DOS empresas: selection_required=true y ambas listadas con conductores disponibles',
  options.status === 200 &&
    taxi?.selection_required === true &&
    taxi.companies.length === 2 &&
    taxi.companies.every((c) => c.has_available_drivers === true),
  JSON.stringify(taxi),
);
check(
  'HU-MS-02',
  'las opciones usan el nombre público (Taxis Norte), no la razón social',
  taxi?.companies.some((c) => c.company_id === B && c.display_name === 'Taxis Norte'),
  JSON.stringify(taxi?.companies),
);
const outside = await http('GET', '/trips/service-options?lat=4.6&lng=-74.1', { token: p1.token });
check(
  'HU-MS-01',
  'service-options fuera de cobertura (Bogotá): municipality=null y sin servicios',
  outside.status === 200 &&
    outside.body.municipality === null &&
    outside.body.services.length === 0,
  outside.text.slice(0, 200),
);

const qAny = await newQuote(p1.token);
const qA = await newQuote(p2.token);
const qB = await newQuote(p1.token);
check(
  'HU-MS-03/RT-1',
  'cotización idéntica para "Cualquiera", Cootrayal y Taxis Norte; commission=0 y total = tarifa del municipio (9000)',
  qAny.fare.total === qA.fare.total &&
    qA.fare.total === qB.fare.total &&
    qAny.fare.commission === 0 &&
    qAny.fare.total === 9000,
  JSON.stringify([qAny.fare, qA.fare, qB.fare]),
);
const dualA = await http('POST', '/trips/quote', {
  token: p1.token,
  body: { origin: PICKUP, destination: DROPOFF, municipality_id: y, service_type: 'comfort' },
});
check(
  'HU-MS-12',
  'cotizar comfort (inactivo) -> 4xx estable',
  dualA.status >= 400 && dualA.status < 500,
  `${dualA.status} ${dualA.text.slice(0, 160)}`,
);

const badCompany = await requestTrip(p1.token, y, qAny.quote_token, state.companyC);
check(
  'HU-MS-04',
  'pedir dirigido a una empresa que no es del municipio (C, Medellín) -> 409 COMPANY_NOT_AVAILABLE',
  badCompany.status === 409 && badCompany.body?.code === 'COMPANY_NOT_AVAILABLE',
  `${badCompany.status} ${badCompany.text.slice(0, 200)}`,
);

const t1 = await requestTrip(p1.token, y, qAny.quote_token);
check(
  'HU-MS-04',
  'pedido con "Cualquiera" (sin requested_company_id) -> 201 pending_assignment',
  t1.status === 201 && t1.body.status === 'pending_assignment',
  t1.text,
);
const trip1 = t1.body.trip_request_id;
const first = await anyOfferFor(
  trip1,
  ALL_DRIVERS.map((d) => d.nationalId),
);
check(
  'HU-MS-17',
  'con "Cualquiera" la primera oferta va al conductor MÁS CERCANO de cualquier empresa (B1 82000001, empresa B)',
  first?.nationalId === '82000001',
  JSON.stringify(first),
);
const othersWithOffer = [];
for (const d of ALL_DRIVERS.filter((d) => d.nationalId !== '82000001')) {
  const r = await offersFor(driverToken(d.nationalId));
  if ((r.body ?? []).some((o) => o.trip_request_id === trip1)) othersWithOffer.push(d.nationalId);
}
check(
  'HU-MS-17',
  'solo un conductor tiene la oferta viva (una oferta a la vez)',
  othersWithOffer.length === 0,
  othersWithOffer.join(','),
);
const pending = await tripStatus(p1.token, trip1);
check(
  'HU-MS-06',
  'mientras se busca: requested_company=null y driver=null (no se revela a quien se ofreció)',
  pending.body.requested_company === null &&
    pending.body.driver === null &&
    pending.body.status === 'pending_assignment',
  pending.text.slice(0, 300),
);

const opsA = await http('GET', '/ops/trip-requests?status=all', { token: adminA.token });
const opsB = await http('GET', '/ops/trip-requests?status=all', { token: adminB.token });
check(
  'HU-MS-08/09',
  '"Cualquiera" solo ofrecido: NI la cola de A NI la de B lo muestran (B tiene la oferta viva)',
  !opsA.body.rows.some((r) => r.trip_request_id === trip1) &&
    !opsB.body.rows.some((r) => r.trip_request_id === trip1),
  `A:${opsA.body.rows.length} B:${opsB.body.rows.length}`,
);
const detailA = await http('GET', `/ops/trip-requests/${trip1}`, { token: adminA.token });
const detailB = await http('GET', `/ops/trip-requests/${trip1}`, { token: adminB.token });
check(
  'HU-MS-09',
  'detalle por id del viaje ofrecido: 404 para A y 404 para B',
  detailA.status === 404 && detailB.status === 404,
  `${detailA.status}/${detailB.status}`,
);
const platformOps = await http('GET', '/ops/trip-requests?status=all', { token: platform.token });
const platformDetail = await http('GET', `/ops/trip-requests/${trip1}`, { token: platform.token });
check(
  'HU-MS-09/RT-2',
  'platform_admin no lee viajes ni datos del pasajero: /ops/trip-requests 403 y detalle 403',
  platformOps.status === 403 && platformDetail.status === 403,
  `${platformOps.status}/${platformDetail.status}`,
);

const acc1 = await accept('82000001', first.offer);
check(
  'HU-MS-17',
  'B1 acepta: result=accepted',
  acc1.status === 200 && acc1.body.result === 'accepted',
  acc1.text.slice(0, 300),
);
const row1 = await tripRow(trip1);
check(
  'HU-MS-15',
  'la toma fija company_id=B y la comisión de B (12 % de 9000 = 1080)',
  row1.company === String(B) &&
    row1.pct === '12.00' &&
    row1.commission === 1080 &&
    row1.requested === '',
  JSON.stringify(row1),
);
const status1 = await tripStatus(p1.token, trip1);
check(
  'HU-MS-06',
  'el pasajero ve driver.company = Taxis Norte (nombre público) y requested_company=null',
  status1.body.driver?.company?.company_id === B &&
    status1.body.driver.company.display_name === 'Taxis Norte' &&
    status1.body.requested_company === null,
  JSON.stringify(status1.body.driver?.company),
);
const opsA2 = await http('GET', '/ops/trip-requests?status=all', { token: adminA.token });
const opsB2 = await http('GET', '/ops/trip-requests?status=all', { token: adminB.token });
const detailA2 = await http('GET', `/ops/trip-requests/${trip1}`, { token: adminA.token });
const detailB2 = await http('GET', `/ops/trip-requests/${trip1}`, { token: adminB.token });
check(
  'HU-MS-08/09',
  'tras la toma de B: B lo ve (lista y detalle) y A no (lista ni 404 por id)',
  opsB2.body.rows.some((r) => r.trip_request_id === trip1) &&
    !opsA2.body.rows.some((r) => r.trip_request_id === trip1) &&
    detailB2.status === 200 &&
    detailA2.status === 404,
  `${detailB2.status}/${detailA2.status}`,
);
check(
  'HU-MS-09',
  'detalle de B: teléfono del pasajero enmascarado',
  detailB2.body?.passenger_phone_masked?.includes('*'),
  detailB2.body?.passenger_phone_masked,
);
const done1 = await lifecycle(trip1, driverToken('82000001'));
check(
  'HU-MS-15',
  'viaje 1 (Cualquiera -> B) completado con cobro en efectivo',
  done1.status === 200 && done1.body.status === 'completed',
  done1.text.slice(0, 200),
);

const qA1 = await newQuote(p2.token);
const t2 = await requestTrip(p2.token, y, qA1.quote_token, A);
check('HU-MS-04', 'pedido dirigido a Cootrayal -> 201', t2.status === 201, t2.text);
const trip2 = t2.body.trip_request_id;
const pend2 = await tripStatus(p2.token, trip2);
check(
  'HU-MS-06',
  'status del viaje dirigido: requested_company = Cootrayal',
  pend2.body.requested_company?.company_id === A &&
    pend2.body.requested_company.display_name === 'Cootrayal',
  JSON.stringify(pend2.body.requested_company),
);
const offer2 = await anyOfferFor(
  trip2,
  ALL_DRIVERS.map((d) => d.nationalId),
);
check(
  'HU-MS-17',
  'empresa elegida limita la búsqueda: B1 sigue siendo el más cercano pero la oferta va al más cercano de Cootrayal (71000002)',
  offer2?.nationalId === '71000002',
  JSON.stringify(offer2?.nationalId),
);
const opsA3 = await http('GET', '/ops/trip-requests?status=all', { token: adminA.token });
check(
  'HU-MS-08',
  'dirigido a A: A lo ve en su cola aunque solo esté ofrecido (RT-2 a)',
  opsA3.body.rows.some((r) => r.trip_request_id === trip2),
  '',
);
const opsB3 = await http('GET', '/ops/trip-requests?status=all', { token: adminB.token });
check(
  'HU-MS-08/09',
  'dirigido a A: B no lo ve',
  !opsB3.body.rows.some((r) => r.trip_request_id === trip2),
  '',
);
const rej = await http('POST', `/assignments/${offer2.offer.assignment_id}/reject`, {
  token: driverToken('71000002'),
  body: {},
});
check('HU-MS-17', 'rechazo -> 200', rej.status === 200, rej.text.slice(0, 200));
const offer2b = await anyOfferFor(
  trip2,
  ALL_DRIVERS.map((d) => d.nationalId),
);
check(
  'HU-MS-17',
  'tras el rechazo la oferta pasa a otro conductor de Cootrayal y nunca a B ni a quien rechazó',
  ['71000001', '71000003'].includes(offer2b?.nationalId),
  JSON.stringify(offer2b?.nationalId),
);
const acc2 = await accept(offer2b.nationalId, offer2b.offer);
const row2 = await tripRow(trip2);
check(
  'HU-MS-15',
  'la toma fija company_id=A y comisión de A (8 % = 720), requested_company_id=A conservado',
  acc2.body?.result === 'accepted' &&
    row2.company === String(A) &&
    row2.requested === String(A) &&
    row2.pct === '8.00' &&
    row2.commission === 720,
  JSON.stringify(row2),
);
const doneCoot = await lifecycle(trip2, driverToken(offer2b.nationalId));
check(
  'HU-MS-15',
  'viaje 2 (dirigido a A) completado',
  doneCoot.status === 200,
  doneCoot.text.slice(0, 200),
);

const qB2 = await newQuote(p1.token);
const t3 = await requestTrip(p1.token, y, qB2.quote_token, B);
const trip3 = t3.body.trip_request_id;
const offer3 = await anyOfferFor(
  trip3,
  ALL_DRIVERS.map((d) => d.nationalId),
);
check(
  'HU-MS-17',
  'dirigido a B: la oferta va al más cercano de B (82000001)',
  offer3?.nationalId === '82000001',
  JSON.stringify(offer3?.nationalId),
);
await http('POST', `/assignments/${offer3.offer.assignment_id}/reject`, {
  token: driverToken('82000001'),
  body: {},
});
const offer3b = await anyOfferFor(
  trip3,
  ALL_DRIVERS.map((d) => d.nationalId),
);
check(
  'HU-MS-17',
  'tras el rechazo de B1 la oferta va a B2 (82000002), no a conductores de Cootrayal',
  offer3b?.nationalId === '82000002',
  JSON.stringify(offer3b?.nationalId),
);
await http('POST', `/assignments/${offer3b.offer.assignment_id}/reject`, {
  token: driverToken('82000002'),
  body: {},
});
const end3 = await waitForTripStatus(p1.token, trip3, 'no_driver', 15000);
check(
  'HU-MS-05',
  'B agotada: el viaje dirigido termina en no_driver y NO se amplía a Cootrayal',
  end3.body.status === 'no_driver' && end3.body.ui === 'no_driver',
  end3.text.slice(0, 200),
);
const cootOffers3 = psql(
  `SELECT count(*) FROM assignment.assignment WHERE trip_request_id=${trip3} AND company_id=${A}`,
);
check(
  'HU-MS-05',
  'ninguna oferta del viaje dirigido a B se creó para Cootrayal',
  cootOffers3 === '0',
  cootOffers3,
);
const opsB4 = await http('GET', '/ops/trip-requests?status=no_driver', { token: adminB.token });
const opsA4 = await http('GET', '/ops/trip-requests?status=no_driver', { token: adminA.token });
check(
  'HU-MS-08',
  'no_driver dirigido a B: aparece en la cola de B y no en la de A',
  opsB4.body.rows.some((r) => r.trip_request_id === trip3) &&
    !opsA4.body.rows.some((r) => r.trip_request_id === trip3),
  '',
);

const qFree = await newQuote(p1.token);
const t4 = await requestTrip(p1.token, y, qFree.quote_token);
const trip4 = t4.body.trip_request_id;
const offer4 = await anyOfferFor(
  trip4,
  ALL_DRIVERS.map((d) => d.nationalId),
);
const acc4 = await accept(offer4.nationalId, offer4.offer);
check(
  'HU-MS-06',
  'viaje 4 (Cualquiera) aceptado por B1',
  offer4.nationalId === '82000001' && acc4.body?.result === 'accepted',
  JSON.stringify(offer4.nationalId),
);
const cancel4 = await http('POST', `/trips/${trip4}/cancel`, {
  token: p1.token,
  body: { reason: 'cambié de opinión' },
});
const row4 = await tripRow(trip4);
const driverB1 = await http('GET', '/driver/me', { token: driverToken('82000001') });
check(
  'MD-05/HU-MS-08',
  'cancelación del pasajero tras aceptar: 200 cancelled_by_passenger, conserva empresa B y el conductor queda libre',
  cancel4.status === 200 &&
    row4.status === 'cancelled_by_passenger' &&
    row4.company === String(B) &&
    driverB1.body?.shift?.status === 'available',
  `${cancel4.text.slice(0, 160)} ${JSON.stringify(row4)} ${driverB1.body?.shift?.status}`,
);
const opsB5 = await http('GET', '/ops/trip-requests?status=all', { token: adminB.token });
check(
  'HU-MS-08',
  'el cancelado tras aceptar sigue visible para B',
  opsB5.body.rows.some((r) => r.trip_request_id === trip4),
  '',
);

const qMd18 = await newQuote(p2.token);
const t5 = await requestTrip(p2.token, y, qMd18.quote_token);
const trip5 = t5.body.trip_request_id;
const offer5 = await anyOfferFor(
  trip5,
  ALL_DRIVERS.map((d) => d.nationalId),
);
const acc5 = await accept(offer5.nationalId, offer5.offer);
check(
  'MD-18',
  'viaje 5 (Cualquiera) aceptado por B1 en assigned',
  offer5.nationalId === '82000001' && acc5.body?.result === 'accepted',
  offer5.nationalId,
);
const cancelDriver = await http('POST', `/assignments/${offer5.offer.assignment_id}/cancel`, {
  token: driverToken('82000001'),
  body: { reason: 'Llanta pinchada' },
});
check(
  'MD-18',
  'B1 cancela en assigned: 200 con searching_again=true (nunca 500)',
  cancelDriver.status === 200 &&
    cancelDriver.body.searching_again === true &&
    cancelDriver.body.trip_request_status === 'pending_assignment',
  cancelDriver.text.slice(0, 250),
);
const row5a = await tripRow(trip5);
check(
  'MD-18/HU-MS-15',
  'el viaje queda sin empresa y sin comisión (company_id NULL, commission 0), B no registra comisión',
  row5a.company === '' &&
    row5a.commission === 0 &&
    row5a.pct === '' &&
    row5a.status === 'pending_assignment',
  JSON.stringify(row5a),
);
const b1Again = (await offersFor(driverToken('82000001'))).body?.some(
  (o) => o.trip_request_id === trip5,
);
check(
  'HU-MS-06',
  'el conductor que canceló no recibe de nuevo ese viaje',
  b1Again === false,
  String(b1Again),
);
const offer5b = await anyOfferFor(
  trip5,
  ALL_DRIVERS.map((d) => d.nationalId),
);
check(
  'HU-MS-06/HU-MS-17',
  'la búsqueda se reabre y otro conductor recibe la oferta (no B1)',
  Boolean(offer5b) && offer5b.nationalId !== '82000001',
  JSON.stringify(offer5b?.nationalId),
);
const acc5b = await accept(offer5b.nationalId, offer5b.offer);
const row5b = await tripRow(trip5);
const company5 = (await tripStatus(p2.token, trip5)).body.driver?.company?.company_id;
check(
  'HU-MS-06',
  'el nuevo conductor toma el viaje: el pasajero ve su empresa y la comisión es la de esa empresa',
  acc5b.body?.result === 'accepted' && row5b.company === String(company5) && row5b.commission > 0,
  JSON.stringify(row5b),
);
const doneMd18 = await lifecycle(trip5, driverToken(offer5b.nationalId));
check(
  'HU-MS-15',
  'viaje 5 completado por la empresa que lo retomó',
  doneMd18.status === 200,
  doneMd18.text.slice(0, 200),
);

const qEn = await newQuote(p1.token);
const t6 = await requestTrip(p1.token, y, qEn.quote_token);
const trip6 = t6.body.trip_request_id;
const offer6 = await anyOfferFor(
  trip6,
  ALL_DRIVERS.map((d) => d.nationalId),
);
await accept(offer6.nationalId, offer6.offer);
await http('POST', `/trips/${trip6}/en-route`, { token: driverToken(offer6.nationalId), body: {} });
const cancel6 = await http('POST', `/assignments/${offer6.offer.assignment_id}/cancel`, {
  token: driverToken(offer6.nationalId),
  body: { reason: 'Problema mecánico' },
});
const row6 = await tripRow(trip6);
check(
  'HU-MS-06',
  'el conductor cancela ya en camino: el viaje termina cancelled_by_driver, sin búsqueda automática y conserva la empresa',
  cancel6.status === 200 &&
    cancel6.body.searching_again === false &&
    row6.status === 'cancelled_by_driver' &&
    row6.company !== '',
  `${cancel6.text.slice(0, 200)} ${JSON.stringify(row6)}`,
);

await offAllShift();
const qNone = await newQuote(p1.token);
const t7 = await requestTrip(p1.token, y, qNone.quote_token);
const trip7 = t7.body.trip_request_id;
const end7 = await waitForTripStatus(p1.token, trip7, 'no_driver', 15000);
check(
  'HU-MS-05',
  '"Cualquiera" sin ningún conductor en turno: no_driver',
  end7.body?.status === 'no_driver',
  end7.text?.slice(0, 200),
);
const opsA7 = await http('GET', '/ops/trip-requests?status=all', { token: adminA.token });
const opsB7 = await http('GET', '/ops/trip-requests?status=all', { token: adminB.token });
const d7a = await http('GET', `/ops/trip-requests/${trip7}`, { token: adminA.token });
const d7b = await http('GET', `/ops/trip-requests/${trip7}`, { token: adminB.token });
check(
  'HU-MS-08/09',
  '"Cualquiera" sin conductor con 2 empresas: ninguna cola lo muestra y el detalle da 404 a las dos',
  !opsA7.body.rows.some((r) => r.trip_request_id === trip7) &&
    !opsB7.body.rows.some((r) => r.trip_request_id === trip7) &&
    d7a.status === 404 &&
    d7b.status === 404,
  `${d7a.status}/${d7b.status}`,
);

const qDirNone = await newQuote(p1.token);
const t8 = await requestTrip(p1.token, y, qDirNone.quote_token, B);
const end8 = await waitForTripStatus(p1.token, t8.body.trip_request_id, 'no_driver', 15000);
check(
  'HU-MS-05',
  'dirigido a B sin conductores en turno: no_driver inmediato, sin ampliar',
  end8.body?.status === 'no_driver' && end8.body.requested_company?.company_id === B,
  end8.text?.slice(0, 200),
);
const optionsNone = await http(
  'GET',
  `/trips/service-options?lat=${PICKUP.lat}&lng=${PICKUP.lng}`,
  { token: p1.token },
);
const taxiNone = optionsNone.body.services.find((s) => s.service_type === 'taxi');
check(
  'HU-MS-02',
  'sin conductores en turno: has_available_drivers=false en ambas empresas (el selector las marca)',
  taxiNone.companies.every((c) => c.has_available_drivers === false),
  JSON.stringify(taxiNone.companies),
);

await placeAllOnShift();
saveState({
  tripIds: { trip1, trip2, trip3, trip4, trip5, trip6, trip7, trip8: t8.body.trip_request_id },
  passengerPhones: ['3105550201', '3105550202'],
});
process.exitCode = flushResults() ? 1 : 0;
