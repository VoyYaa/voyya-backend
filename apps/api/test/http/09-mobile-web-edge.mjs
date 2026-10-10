import { mkdirSync } from 'node:fs';
import { check, flushResults, http, lifecycleBody, psql, sleep, waitForOffer } from './lib.mjs';
import { loadState } from './state.mjs';
import {
  allOffShift,
  bodyText,
  chooseCompany,
  chromium,
  driverTokenOf,
  openConfirm,
  openPassengerPage,
  refreshDrivers,
  setYarumalCompanies,
  yarumalCompanyIds,
} from './mobile-lib.mjs';

const state = loadState();
const SHOTS = process.env.SHOTS_DIR ?? 'shots';
const PHONE = process.env.PASSENGER_PHONE_EDGE ?? '3105550411';
const B = state.companyB;
mkdirSync(SHOTS, { recursive: true });

const ids = yarumalCompanyIds(state);
const twoCompanies = ids.filter((id) => id === state.cootrayalId || id === B);
const browser = await chromium.launch({ channel: process.env.E2E_BROWSER_CHANNEL ?? 'chrome' });
let context;
try {
  setYarumalCompanies(state, twoCompanies);
  await allOffShift(state);
  const opened = await openPassengerPage(browser, PHONE);
  context = opened.context;
  const page = opened.page;
  const shot = (name) => page.screenshot({ path: `${SHOTS}/${name}.png` });
  const text = () => bodyText(page);

  await openConfirm(page);
  await chooseCompany(page, 'Taxis Norte');
  await page
    .getByText(/Solicitar viaje · \$/)
    .first()
    .click();
  await page.waitForURL(/\/searching/, { timeout: 15000 });
  await page.waitForFunction(
    () => document.body.innerText.includes('no tiene conductores disponibles ahora'),
    null,
    { timeout: 25000 },
  );
  await shot('edge-1-no-driver-company');
  let t = await text();
  check(
    'HU-MS-05',
    'dirigido a Taxis Norte sin conductores: "Taxis Norte no tiene conductores disponibles ahora" con "Buscar en cualquier empresa" y "Intentar de nuevo con Taxis Norte"',
    t.includes('Taxis Norte no tiene conductores disponibles ahora') &&
      t.includes('Buscar en cualquier empresa') &&
      t.includes('Intentar de nuevo con Taxis Norte'),
    t.slice(0, 500),
  );
  const directedTrip = Number(psql('SELECT max(trip_request_id) FROM trips.trip_request'));
  check(
    'HU-MS-05',
    'el viaje dirigido terminó en no_driver y no se amplió solo (sin ofertas a Cootrayal)',
    psql(`SELECT status FROM trips.trip_request WHERE trip_request_id=${directedTrip}`) ===
      'no_driver' &&
      psql(`SELECT count(*) FROM assignment.assignment WHERE trip_request_id=${directedTrip}`) ===
        '0',
    '',
  );

  await refreshDrivers(state);
  await page.getByRole('button', { name: 'Buscar en cualquier empresa' }).click();
  await page.waitForTimeout(3500);
  const anyTrip = Number(psql('SELECT max(trip_request_id) FROM trips.trip_request'));
  const anyRow = psql(
    `SELECT coalesce(requested_company_id::text,''), status FROM trips.trip_request WHERE trip_request_id=${anyTrip}`,
  );
  check(
    'HU-MS-05',
    '"Buscar en cualquier empresa" crea un viaje NUEVO con preferencia "Cualquiera" (el anterior sigue no_driver)',
    anyTrip > directedTrip &&
      anyRow.startsWith('|') &&
      psql(`SELECT status FROM trips.trip_request WHERE trip_request_id=${directedTrip}`) ===
        'no_driver',
    anyRow,
  );
  await shot('edge-2-any-search');

  const first = await (async () => {
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      for (const nationalId of ['82000001', '71000002', '71000001']) {
        const offer = await waitForOffer(driverTokenOf(state, nationalId), anyTrip, 600);
        if (offer) return { nationalId, offer };
      }
    }
    return null;
  })();
  check(
    'HU-MS-17',
    'la búsqueda "Cualquiera" nueva ofrece al conductor más cercano (Taxis Norte 82000001)',
    first?.nationalId === '82000001',
    JSON.stringify(first?.nationalId),
  );
  const accepted = await http('POST', `/assignments/${first.offer.assignment_id}/accept`, {
    token: driverTokenOf(state, first.nationalId),
    body: {},
  });
  await page.waitForURL(/\/driver-assigned/, { timeout: 20000 });
  await page.waitForTimeout(1500);
  t = await text();
  check(
    'HU-MS-06',
    'la app pasa a conductor asignado con "Empresa Taxis Norte"',
    accepted.body?.result === 'accepted' && t.includes('Taxis Norte'),
    t.slice(0, 300),
  );
  await shot('edge-3-assigned-b');

  const cancel = await http('POST', `/assignments/${first.offer.assignment_id}/cancel`, {
    token: driverTokenOf(state, first.nationalId),
    body: { reason: 'Llanta pinchada' },
  });
  check(
    'MD-18',
    'el conductor de Taxis Norte cancela en assigned: 200 searching_again',
    cancel.status === 200 && cancel.body.searching_again === true,
    cancel.text.slice(0, 200),
  );
  await page.waitForFunction(
    () =>
      /Buscando tu viaje|Seguimos buscando|Estamos buscando|Estamos contactando/.test(
        document.body.innerText,
      ),
    null,
    { timeout: 25000 },
  );
  await shot('edge-4-back-to-searching');
  t = await text();
  check(
    'HU-MS-06 (UXP §10.8)',
    'con la pantalla del conductor abierta, al cancelar el conductor la app vuelve a "buscando" y ya no muestra a Taxis Norte como conductor',
    /Buscando tu viaje|Seguimos buscando|Estamos buscando/.test(t) &&
      !t.includes('Empresa Taxis Norte'),
    t.slice(0, 400),
  );

  const second = await (async () => {
    const deadline = Date.now() + 12000;
    while (Date.now() < deadline) {
      for (const nationalId of ['71000002', '71000001', '71000003', '82000002']) {
        const offer = await waitForOffer(driverTokenOf(state, nationalId), anyTrip, 600);
        if (offer) return { nationalId, offer };
      }
    }
    return null;
  })();
  check(
    'HU-MS-06',
    'otro conductor recibe la oferta tras la cancelación (no el que canceló)',
    Boolean(second) && second.nationalId !== '82000001',
    JSON.stringify(second?.nationalId),
  );
  const accepted2 = await http('POST', `/assignments/${second.offer.assignment_id}/accept`, {
    token: driverTokenOf(state, second.nationalId),
    body: {},
  });
  await page.waitForURL(/\/driver-assigned/, { timeout: 20000 });
  await page.waitForTimeout(2000);
  t = await text();
  const expectedName = psql(
    `SELECT coalesce(public_name, legal_name) FROM tenancy.company WHERE company_id=(SELECT company_id FROM fleet.driver WHERE national_id='${second.nationalId}')`,
  );
  check(
    'HU-MS-06',
    `un conductor de otra empresa toma el viaje: la pantalla muestra a ${expectedName} y no conserva a Taxis Norte`,
    accepted2.body?.result === 'accepted' &&
      t.includes(expectedName) &&
      !t.includes('Empresa Taxis Norte'),
    t.slice(0, 400),
  );
  await shot('edge-5-reassigned');

  for (const step of ['en-route', 'arrived', 'start'])
    await http('POST', `/trips/${anyTrip}/${step}`, {
      token: driverTokenOf(state, second.nationalId),
      body: lifecycleBody(step, anyTrip),
    });
  await http('POST', `/trips/${anyTrip}/complete`, {
    token: driverTokenOf(state, second.nationalId),
    body: { cash_collected: true },
  });
  await sleep(500);
} catch (error) {
  check(
    'MOB-EDGE-EXC',
    'el recorrido no lanzó excepciones del script',
    false,
    String(error).slice(0, 380),
  );
} finally {
  setYarumalCompanies(state, ids);
  await refreshDrivers(state);
  if (context) await context.close();
  await browser.close();
}
process.exitCode = flushResults() ? 1 : 0;
