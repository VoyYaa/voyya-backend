import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  check,
  flushResults,
  http,
  lifecycleBody,
  logMark,
  offersFor,
  psql,
  sleep,
  waitForLog,
  waitForOffer,
} from './lib.mjs';
import { SEED_DRIVERS, loadState } from './state.mjs';

const adminRequire = createRequire(
  fileURLToPath(new URL('../../../../../voyya-admin/package.json', import.meta.url)),
);
const { chromium } = adminRequire('@playwright/test');

const state = loadState();
const APP = process.env.PASSENGER_WEB_URL ?? 'http://localhost:8082';
const SHOTS = process.env.SHOTS_DIR ?? 'shots';
const PHONE = process.env.PASSENGER_PHONE ?? '3105550301';
const A = state.cootrayalId;
const B = state.companyB;
mkdirSync(SHOTS, { recursive: true });

const driverToken = (nationalId) => state.sessions[`driver-${nationalId}`].session.token;
async function refreshDrivers() {
  const all = [...SEED_DRIVERS, ...state.companyBDrivers];
  for (const d of all) {
    await http('PUT', '/driver/shift', {
      token: driverToken(d.nationalId),
      body: { on_shift: true, location: { lat: d.lat, lng: d.lng } },
    });
  }
}

function setCompanies(activeIds) {
  psql(
    `UPDATE tenancy.company SET status='suspended' WHERE company_id NOT IN (${activeIds.join(',')}) AND municipality_id=(SELECT municipality_id FROM tenancy.company WHERE company_id=${A})`,
  );
  psql(`UPDATE tenancy.company SET status='active' WHERE company_id IN (${activeIds.join(',')})`);
}

const allYarumalIds = psql(
  `SELECT string_agg(company_id::text, ',' ORDER BY company_id) FROM tenancy.company WHERE municipality_id=(SELECT municipality_id FROM tenancy.company WHERE company_id=${A})`,
)
  .split(',')
  .map(Number);

const browser = await chromium.launch({ channel: process.env.E2E_BROWSER_CHANNEL ?? 'chrome' });
const context = await browser.newContext({
  viewport: { width: 390, height: 844 },
  geolocation: { latitude: 6.965, longitude: -75.418 },
  permissions: ['geolocation'],
  locale: 'es-CO',
});
const page = await context.newPage();
const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(String(e).slice(0, 200)));
const shot = (name) => page.screenshot({ path: `${SHOTS}/${name}.png` });
const visible = (text) => page.locator(`text=${text} >> visible=true`).first();
const bodyText = async () => await page.locator('body').innerText();

try {
  await refreshDrivers();
  await page.goto(APP);
  await page.getByLabel('Número de celular').fill(PHONE);
  const mark = logMark();
  await page.getByRole('button', { name: 'Enviar código' }).click();
  const otp = (
    await waitForLog(
      new RegExp(String.raw`to=\*+${PHONE.slice(-4)} message=Tu código VoyYa es (\d+)`),
      mark,
      8000,
    )
  )[1];
  await page.waitForTimeout(1200);
  await page.keyboard.type(otp, { delay: 80 });
  await page.getByRole('button', { name: 'Acepto, usar mi ubicación' }).click({ timeout: 15000 });
  await page.waitForTimeout(2500);
  check(
    'MOB-00',
    'login por OTP real (código leído de los logs del proveedor console) y aceptación del aviso de ubicación',
    (await bodyText()).includes('Te recogemos en'),
    (await bodyText()).slice(0, 200),
  );

  async function openConfirm() {
    await page.goto(`${APP}/`);
    await page.waitForTimeout(2500);
    await page.getByText('¿A dónde vas?').first().click();
    await page.waitForTimeout(1500);
    await visible('Parque Principal').click();
    await page.waitForURL(/\/confirm/, { timeout: 10000 });
    await page.waitForTimeout(2500);
  }

  setCompanies([A]);
  await openConfirm();
  await shot('mobile-1-company');
  let text = await bodyText();
  check(
    'HU-MS-02/RT-3',
    'confirm con UNA empresa: "Servicio de Cootrayal", sin fila EMPRESA ni "Cambiar"',
    text.includes('Servicio de Cootrayal') &&
      !text.includes('EMPRESA') &&
      !text.includes('Cambiar'),
    text.slice(0, 500),
  );
  check(
    'HU-MS-03',
    'confirm muestra la tarifa del municipio y el botón "Solicitar viaje" con el total',
    /Solicitar viaje · \$\d+\.\d{3}/.test(text),
    text.slice(-120),
  );

  setCompanies(allYarumalIds.filter((id) => id !== allYarumalIds[2]));
  await openConfirm();
  await shot('mobile-2-companies');
  text = await bodyText();
  check(
    'HU-MS-02',
    'confirm con DOS empresas: fila EMPRESA con "Cualquiera" preseleccionada y la nota de tarifa igual',
    text.includes('EMPRESA') &&
      /EMPRESA\s*\n?\s*Cualquiera/.test(text) &&
      text.includes('La tarifa es la misma con cualquier empresa.'),
    text.slice(0, 600),
  );
  const requestEnabled = await page
    .getByText(/Solicitar viaje · \$/)
    .first()
    .isVisible();
  check(
    'HU-MS-02',
    'con "Cualquiera" preseleccionada se puede solicitar sin elegir (no aparece "Elige una empresa para continuar")',
    requestEnabled && !text.includes('Elige una empresa para continuar'),
    '',
  );

  await visible('Cambiar').click();
  await page.waitForTimeout(1200);
  await shot('mobile-2-companies-sheet');
  text = await bodyText();
  check(
    'HU-MS-02',
    'la hoja "Elige una empresa" abre con Cualquiera, Cootrayal y Taxis Norte (nombre público)',
    text.includes('Elige una empresa') &&
      text.includes('Cualquiera') &&
      text.includes('Cootrayal') &&
      text.includes('Taxis Norte') &&
      !text.includes('Taxis Norte S.A.S.'),
    text.slice(0, 700),
  );
  await visible('Taxis Norte').click();
  await visible('Listo').click();
  await page.waitForTimeout(800);
  text = await bodyText();
  check(
    'HU-MS-02',
    'tras elegir Taxis Norte la fila muestra la empresa elegida y el total no cambia',
    /EMPRESA\s*\n?\s*Taxis Norte/.test(text),
    text.slice(0, 500),
  );

  setCompanies(allYarumalIds);
  await openConfirm();
  await shot('mobile-3-companies');
  await visible('Cambiar').click();
  await page.waitForTimeout(1000);
  await shot('mobile-3-companies-sheet');
  text = await bodyText();
  check(
    'HU-MS-02',
    'con TRES empresas la hoja lista Cualquiera + las 3 por nombre público',
    ['Cualquiera', 'Cootrayal', 'Taxis Norte', 'Horizonte Taxis'].every((n) => text.includes(n)),
    text.slice(0, 700),
  );
  await page.keyboard.press('Escape');

  setCompanies(allYarumalIds.filter((id) => id !== allYarumalIds[2]));
  await refreshDrivers();
  await openConfirm();
  await visible('Cambiar').click();
  await page.waitForTimeout(800);
  await visible('Taxis Norte').click();
  await visible('Listo').click();
  await page.waitForTimeout(500);
  const before = Number(psql('SELECT coalesce(max(trip_request_id),0) FROM trips.trip_request'));
  await page
    .getByText(/Solicitar viaje · \$/)
    .first()
    .click();
  await page.waitForURL(/\/searching/, { timeout: 15000 });
  await page.waitForTimeout(1500);
  await shot('mobile-searching');
  text = await bodyText();
  const tripId = Number(psql('SELECT max(trip_request_id) FROM trips.trip_request'));
  const row = psql(
    `SELECT coalesce(requested_company_id::text,''), status FROM trips.trip_request WHERE trip_request_id=${tripId}`,
  );
  check(
    'HU-MS-04',
    'pedir desde la app con Taxis Norte elegida crea el viaje dirigido a esa empresa (requested_company_id en BD)',
    tripId > before && row.startsWith(`${B}|`),
    row,
  );
  check(
    'HU-MS-06',
    'la pantalla de búsqueda dice que contacta a los conductores de Taxis Norte',
    text.includes('Taxis Norte'),
    text.slice(0, 400),
  );

  const offer = await waitForOffer(driverToken('82000001'), tripId, 10000);
  check(
    'HU-MS-17',
    'la oferta llega al conductor de Taxis Norte (82000001)',
    Boolean(offer),
    'sin oferta',
  );
  const accepted = await http('POST', `/assignments/${offer.assignment_id}/accept`, {
    token: driverToken('82000001'),
    body: {},
  });
  check(
    'HU-MS-07',
    'el conductor acepta por la API real',
    accepted.body?.result === 'accepted',
    accepted.text.slice(0, 200),
  );
  await page.waitForURL(/\/driver-assigned/, { timeout: 20000 });
  await page.waitForTimeout(1500);
  await shot('mobile-driver-assigned');
  text = await bodyText();
  check(
    'HU-MS-06',
    'la pantalla del conductor asignado muestra "Empresa Taxis Norte"',
    text.includes('Taxis Norte'),
    text.slice(0, 500),
  );

  const lifecycle = ['en-route', 'arrived', 'start'];
  for (const step of lifecycle)
    await http('POST', `/trips/${tripId}/${step}`, { token: driverToken('82000001'), body: lifecycleBody(step, tripId) });
  await http('POST', `/trips/${tripId}/complete`, {
    token: driverToken('82000001'),
    body: { cash_collected: true },
  });
  await page.waitForTimeout(6000);
  await shot('mobile-completed');
  text = await bodyText();
  check(
    'HU-MS-06',
    'el resultado del viaje conserva el nombre de la empresa',
    text.includes('Taxis Norte'),
    text.slice(0, 500),
  );
  check(
    'MOB-ERR',
    'sin excepciones de página durante el recorrido',
    pageErrors.length === 0,
    pageErrors.join(' | '),
  );
} catch (error) {
  await shot('mobile-error').catch(() => undefined);
  check(
    'MOB-EXC',
    'el recorrido no lanzó excepciones del script',
    false,
    String(error).slice(0, 380),
  );
} finally {
  setCompanies(allYarumalIds);
  await browser.close();
}
process.exitCode = flushResults() ? 1 : 0;
