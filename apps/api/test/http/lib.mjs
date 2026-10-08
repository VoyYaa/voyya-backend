import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { loadState, saveState } from './state.mjs';

export const BASE = process.env.API_URL ?? 'http://localhost:3000';
export const API_LOG = process.env.API_LOG;
export const DB_CONTAINER = process.env.DB_CONTAINER ?? 'voyya-verify-db';
export const DB_SUPERUSER = process.env.DB_SUPERUSER ?? 'postgres';
export const RESULTS_FILE = process.env.RESULTS_FILE;

export const results = [];

export function check(id, description, condition, evidence = '') {
  const pass = Boolean(condition);
  results.push({ id, description, pass, evidence: String(evidence).slice(0, 400) });
  console.log(
    `${pass ? 'PASS' : 'FAIL'} ${id} ${description}${pass ? '' : `  <= ${String(evidence).slice(0, 300)}`}`,
  );
  return pass;
}

export function flushResults() {
  if (RESULTS_FILE) writeFileSync(RESULTS_FILE, JSON.stringify(results, null, 2));
  const failed = results.filter((r) => !r.pass).length;
  console.log(`\n${results.length - failed}/${results.length} PASS, ${failed} FAIL`);
  return failed;
}

export async function http(method, path, { token, body, form, headers = {} } = {}) {
  const init = { method, headers: { ...headers } };
  if (token) init.headers.authorization = `Bearer ${token}`;
  if (form) {
    init.body = form;
  } else if (body !== undefined) {
    init.headers['content-type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  let response = await fetch(`${BASE}${path}`, init);
  for (let attempt = 0; response.status === 429 && attempt < 6; attempt += 1) {
    await sleep(15000);
    response = await fetch(`${BASE}${path}`, init);
  }
  const text = await response.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return { status: response.status, body: json, text, headers: response.headers };
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function psql(sql) {
  return execFileSync(
    'docker',
    [
      'exec',
      '-i',
      DB_CONTAINER,
      'psql',
      '-U',
      DB_SUPERUSER,
      '-d',
      'voyya',
      '-v',
      'ON_ERROR_STOP=1',
      '-tA',
      '-F',
      '|',
      '-c',
      sql,
    ],
    { encoding: 'utf8', env: { ...process.env, MSYS_NO_PATHCONV: '1' } },
  ).trim();
}

function logLines() {
  return readFileSync(API_LOG, 'utf8').split('\n');
}

export async function waitForLog(pattern, sinceLine, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const lines = logLines();
    for (let i = lines.length - 1; i >= sinceLine; i -= 1) {
      const match = lines[i].match(pattern);
      if (match) return match;
    }
    await sleep(150);
  }
  throw new Error(`log pattern not found: ${pattern}`);
}

export function logMark() {
  return logLines().length;
}

export async function passengerLogin(phone) {
  const mark = logMark();
  const requested = await http('POST', '/auth/otp/request', { body: { phone } });
  if (requested.status !== 200)
    throw new Error(`otp request ${requested.status} ${requested.text}`);
  const suffix = phone.slice(-4);
  const pattern = new RegExp(String.raw`to=\*+${suffix} message=Tu código VoyYa es (\d+)`);
  const match = await waitForLog(pattern, mark, 1500).catch(() => waitForLog(pattern, 0, 500));
  const verified = await http('POST', '/auth/otp/verify', { body: { phone, code: match[1] } });
  if (verified.status !== 200) throw new Error(`otp verify ${verified.status} ${verified.text}`);
  return { token: verified.body.tokens.access_token, user: verified.body.user, otp: match[1] };
}

export async function adminLogin(email, password) {
  const response = await http('POST', '/auth/admin/login', { body: { email, password } });
  if (response.status !== 200)
    throw new Error(`admin login ${email} ${response.status} ${response.text}`);
  return { token: response.body.tokens.access_token, user: response.body.user };
}

export async function driverLogin(nationalId, pin) {
  const response = await http('POST', '/auth/driver/login', {
    body: { national_id: nationalId, pin },
  });
  if (response.status !== 200)
    throw new Error(`driver login ${nationalId} ${response.status} ${response.text}`);
  return { token: response.body.tokens.access_token, user: response.body.user };
}

export function pdfForm(label = 'doc') {
  const form = new FormData();
  const bytes = Buffer.from(
    `%PDF-1.4\n% ${label} ${Date.now()}\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n`,
  );
  form.append('file', new Blob([bytes], { type: 'application/pdf' }), `${label}.pdf`);
  return form;
}

export const PICKUP = { lat: 6.965, lng: -75.418, address: 'Parque Principal, Yarumal' };
export const DROPOFF = {
  lat: 6.9701,
  lng: -75.4212,
  address: 'Hospital San Juan de Dios, Yarumal',
};

export async function grantLocationConsent(token) {
  const response = await http('POST', '/consents', {
    token,
    body: { purpose: 'location', notice_version: 'location-notice-v2' },
  });
  return response;
}

export async function quote(token, municipalityId) {
  return http('POST', '/trips/quote', {
    token,
    body: {
      origin: PICKUP,
      destination: DROPOFF,
      municipality_id: municipalityId,
      service_type: 'taxi',
    },
  });
}

export async function requestTrip(token, municipalityId, quoteToken, requestedCompanyId) {
  const body = {
    origin: PICKUP,
    destination: DROPOFF,
    municipality_id: municipalityId,
    service_type: 'taxi',
    payment_method: 'cash',
    quote_token: quoteToken,
  };
  if (requestedCompanyId !== undefined) body.requested_company_id = requestedCompanyId;
  return http('POST', '/trips', { token, body });
}

export async function offersFor(driverToken) {
  return http('GET', '/assignments/nearby', { token: driverToken });
}

export async function waitForOffer(driverToken, tripId, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const response = await offersFor(driverToken);
    const offer = (response.body ?? []).find((o) => o.trip_request_id === tripId);
    if (offer) return offer;
    await sleep(300);
  }
  return null;
}

export async function tripStatus(token, tripId) {
  return http('GET', `/trips/${tripId}`, { token });
}

export async function waitForTripStatus(token, tripId, wanted, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await tripStatus(token, tripId);
    if (last.body?.status === wanted) return last;
    await sleep(300);
  }
  return last;
}

export async function cachedSession(key, login) {
  const cached = loadState().sessions?.[key];
  if (cached && Date.now() - cached.at < 3 * 3600e3) return cached.session;
  const session = await login();
  const sessions = { ...(loadState().sessions ?? {}), [key]: { at: Date.now(), session } };
  saveState({ sessions });
  return session;
}
