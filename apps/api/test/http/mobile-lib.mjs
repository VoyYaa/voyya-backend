import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { http, logMark, psql, waitForLog } from './lib.mjs';
import { SEED_DRIVERS } from './state.mjs';

const adminRequire = createRequire(
  fileURLToPath(new URL('../../../../../voyya-admin/package.json', import.meta.url)),
);
export const { chromium } = adminRequire('@playwright/test');

export const APP = process.env.PASSENGER_WEB_URL ?? 'http://localhost:8082';

export function driverTokenOf(state, nationalId) {
  return state.sessions[`driver-${nationalId}`].session.token;
}

export async function refreshDrivers(state) {
  for (const d of [...SEED_DRIVERS, ...state.companyBDrivers]) {
    await http('PUT', '/driver/shift', {
      token: driverTokenOf(state, d.nationalId),
      body: { on_shift: true, location: { lat: d.lat, lng: d.lng } },
    });
  }
}

export async function allOffShift(state) {
  for (const d of [...SEED_DRIVERS, ...state.companyBDrivers]) {
    await http('PUT', '/driver/shift', {
      token: driverTokenOf(state, d.nationalId),
      body: { on_shift: false },
    });
  }
}

export function setYarumalCompanies(state, activeIds) {
  const municipality = `(SELECT municipality_id FROM tenancy.company WHERE company_id=${state.cootrayalId})`;
  psql(
    `UPDATE tenancy.company SET status='suspended' WHERE company_id NOT IN (${activeIds.join(',')}) AND municipality_id=${municipality}`,
  );
  psql(`UPDATE tenancy.company SET status='active' WHERE company_id IN (${activeIds.join(',')})`);
}

export function yarumalCompanyIds(state) {
  return psql(
    `SELECT string_agg(company_id::text, ',' ORDER BY company_id) FROM tenancy.company WHERE municipality_id=(SELECT municipality_id FROM tenancy.company WHERE company_id=${state.cootrayalId})`,
  )
    .split(',')
    .map(Number);
}

export async function openPassengerPage(browser, phone) {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    geolocation: { latitude: 6.965, longitude: -75.418 },
    permissions: ['geolocation'],
    locale: 'es-CO',
  });
  const page = await context.newPage();
  await page.goto(APP);
  await page.getByLabel('Número de celular').fill(phone);
  const mark = logMark();
  await page.getByRole('button', { name: 'Enviar código' }).click();
  const pattern = new RegExp(String.raw`to=\*+${phone.slice(-4)} message=Tu código VoyYa es (\d+)`);
  const otp = (await waitForLog(pattern, mark, 8000))[1];
  await page.waitForTimeout(1200);
  await page.keyboard.type(otp, { delay: 80 });
  await page
    .getByRole('button', { name: 'Acepto, usar mi ubicación' })
    .click({ timeout: 8000 })
    .catch(() => undefined);
  await page.waitForTimeout(2500);
  return { context, page };
}

export async function openConfirm(page) {
  await page.goto(`${APP}/`);
  await page.waitForTimeout(2500);
  await page.getByText('¿A dónde vas?').first().click();
  await page.waitForTimeout(1500);
  await page.locator('text=Parque Principal >> visible=true').first().click();
  await page.waitForURL(/\/confirm/, { timeout: 10000 });
  await page.waitForTimeout(2500);
}

export async function chooseCompany(page, name) {
  await page.locator('text=Cambiar >> visible=true').first().click();
  await page.waitForTimeout(800);
  await page.locator(`text=${name} >> visible=true`).first().click();
  await page.locator('text=Listo >> visible=true').first().click();
  await page.waitForTimeout(500);
}

export const bodyText = (page) => page.locator('body').innerText();
