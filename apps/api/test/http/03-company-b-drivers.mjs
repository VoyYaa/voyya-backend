import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import {
  psql,
  cachedSession,
  check,
  driverLogin,
  flushResults,
  grantLocationConsent,
  http,
  logMark,
  pdfForm,
  waitForLog,
} from './lib.mjs';
import { loadState, saveState } from './state.mjs';

const require = createRequire(fileURLToPath(new URL('../../package.json', import.meta.url)));
const bcrypt = require('bcryptjs');
const state = loadState();
const adminB = state.sessions.adminB.session;

const quotaBefore = await http('GET', '/admin/fleet-quota', { token: adminB.token });
check(
  'HU-MS-11',
  'cupo de flota de B: declarada 5, usada 0',
  quotaBefore.status === 200 && quotaBefore.body.declared === 5 && quotaBefore.body.used === 0,
  quotaBefore.text,
);

const profile = await http('GET', '/admin/company-profile', { token: adminB.token });
check(
  'HU-MS-13',
  'perfil de B: active, display_name "Taxis Norte", service_types incluye taxi',
  profile.status === 200 &&
    profile.body.status === 'active' &&
    profile.body.display_name === 'Taxis Norte' &&
    profile.body.service_types.includes('taxi'),
  profile.text,
);

const expires = '2027-12-31';
async function createDriver(nationalId, phone, plate, firstName) {
  const types = ['license', 'soat', 'vehicle_inspection', 'operation_card'];
  const documents = [];
  for (const type of types) {
    const upload = await http('POST', '/admin/drivers/documents', {
      token: adminB.token,
      form: pdfForm(`${type}-${nationalId}`),
    });
    if (upload.status !== 201) throw new Error(`driver doc upload ${upload.status} ${upload.text}`);
    documents.push({ type, storage_key: upload.body.storage_key, expires_at: expires });
  }
  const mark = logMark();
  const created = await http('POST', '/admin/drivers', {
    token: adminB.token,
    body: {
      first_name: firstName,
      last_name: 'Norte',
      national_id: nationalId,
      phone,
      vehicle: { plate, model: 'Kia Picanto', year: 2022 },
      documents,
    },
  });
  if (created.status !== 201) throw new Error(`create driver ${created.status} ${created.text}`);
  check(
    'HU-MS-11',
    `POST /admin/drivers 201 para ${nationalId} (el PIN temporal sale redactado en los logs; se fija por SQL para poder entrar)`,
    true,
  );
  const pin = '135790';
  psql(
    `UPDATE fleet.driver SET pin='${await bcrypt.hash(pin, 10)}' WHERE national_id='${nationalId}'`,
  );
  return { created: created.body, pin };
}

const drivers = [];
for (const spec of [
  {
    nationalId: '82000001',
    phone: '3215550001',
    plate: 'TNO001',
    firstName: 'Bruno',
    lat: 6.9651,
    lng: -75.4181,
  },
  {
    nationalId: '82000002',
    phone: '3215550002',
    plate: 'TNO002',
    firstName: 'Bianca',
    lat: 6.974,
    lng: -75.43,
  },
]) {
  const { created, pin } = await createDriver(
    spec.nationalId,
    spec.phone,
    spec.plate,
    spec.firstName,
  );
  check(
    'HU-MS-11',
    `B registra al conductor ${spec.nationalId} con PIN temporal`,
    created.status !== undefined && created.pin_delivery !== undefined,
    JSON.stringify(created).slice(0, 200),
  );
  const login = await driverLogin(spec.nationalId, pin);
  check(
    'HU-MS-07',
    `login del conductor de B ${spec.nationalId}: pin_change_required=true`,
    login.user.pin_change_required === true && login.user.tenant.company_id === state.companyB,
    JSON.stringify(login.user),
  );
  const newPin = spec.nationalId === '82000001' ? '482913' : '739104';
  const change = await http('POST', '/auth/driver/pin', {
    token: login.token,
    body: { current_pin: pin, new_pin: newPin },
  });
  check(
    'HU-MS-07',
    'cambio de PIN temporal',
    change.status === 200 || change.status === 204,
    change.text.slice(0, 200),
  );
  const relogin = await driverLogin(spec.nationalId, newPin);
  await grantLocationConsent(relogin.token);
  const shift = await http('PUT', '/driver/shift', {
    token: relogin.token,
    body: { on_shift: true, location: { lat: spec.lat, lng: spec.lng } },
  });
  check('HU-MS-07', `conductor de B ${spec.nationalId} en turno`, shift.status === 200, shift.text);
  drivers.push({
    nationalId: spec.nationalId,
    pin: newPin,
    userId: relogin.user.user_id,
    lat: spec.lat,
    lng: spec.lng,
  });
  const sessions = {
    ...(loadState().sessions ?? {}),
    [`driver-${spec.nationalId}`]: { at: Date.now(), session: relogin },
  };
  saveState({ sessions });
}
const quotaAfter = await http('GET', '/admin/fleet-quota', { token: adminB.token });
check(
  'HU-MS-11',
  'cupo de B tras registrar 2 conductores: usada 2',
  quotaAfter.body?.used === 2,
  quotaAfter.text,
);
saveState({ companyBDrivers: drivers });
process.exitCode = flushResults() ? 1 : 0;
