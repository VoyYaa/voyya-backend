import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  API_LOG,
  check,
  flushResults,
  http,
  logMark,
  pdfForm,
  psql,
  waitForLog,
} from './lib.mjs';
import { ADMIN_EMAIL, PLATFORM_EMAIL, SEED_DRIVERS, STAFF_PASSWORD } from './state.mjs';

const require = createRequire(fileURLToPath(new URL('../../package.json', import.meta.url)));
const bcrypt = require('bcryptjs');

const PHONES = {
  driver: '3009900011',
  admin: '3000000000',
  platform_admin: '3000000001',
  operator: '3009900022',
  company: '3009900033',
  newPassenger: '3009900055',
  existingPassenger: '3001112233',
  unknown: '3009900099',
};
const OPERATOR_EMAIL = 'operador.s01@voyya-verify.test';
const OPERATOR_PASSWORD = 'OperatorS01-Pass-1234';
const INVALID_BODY = { code: 'OTP_INVALID', message: 'Código incorrecto' };

let hop = 0;
function asClient() {
  hop += 1;
  return { 'x-forwarded-for': `10.77.${Math.floor(hop / 250)}.${(hop % 250) + 1}` };
}

async function signIn(path, body) {
  const response = await http('POST', path, { body, headers: asClient() });
  if (response.status !== 200) throw new Error(`sign in ${path} ${response.status} ${response.text}`);
  return {
    token: response.body.tokens.access_token,
    refresh: response.body.tokens.refresh_token,
    user: response.body.user,
  };
}

const adminLogin = (email, password) => signIn('/auth/admin/login', { email, password });
const driverLogin = (nationalId, pin) => signIn('/auth/driver/login', { national_id: nationalId, pin });

async function requestOtp(phone) {
  const mark = Math.max(logMark() - 1, 0);
  const response = await http('POST', '/auth/otp/request', { body: { phone }, headers: asClient() });
  if (response.status !== 200) throw new Error(`otp request ${response.status} ${response.text}`);
  const pattern = new RegExp(String.raw`to=\*+${phone.slice(-4)} message=Tu código VoyYa es (\d{6})`);
  const match = await waitForLog(pattern, mark, 4000);
  return { code: match[1], mark };
}

function verifyOtp(phone, code) {
  return http('POST', '/auth/otp/verify', { body: { phone, code }, headers: asClient() });
}

function otherCode(code) {
  return String((Number(code) + 1) % 10 ** code.length).padStart(code.length, '0');
}

function brief(response) {
  return [
    `status=${response.status}`,
    `code=${response.body?.code ?? '-'}`,
    `role=${response.body?.user?.role ?? '-'}`,
    `refresh_token_in_body=${Boolean(response.body?.tokens?.refresh_token)}`,
  ].join(' ');
}

const VOLATILE_HEADERS = new Set(['date', 'etag', 'retry-after']);
function fingerprint(response) {
  const names = [...response.headers.keys()]
    .filter((name) => !VOLATILE_HEADERS.has(name) && !name.startsWith('x-ratelimit'))
    .sort();
  return JSON.stringify({
    status: response.status,
    body: response.text,
    contentType: response.headers.get('content-type'),
    contentLength: response.headers.get('content-length'),
    headerNames: names,
  });
}

function userIdByPhone(phone) {
  return Number(psql(`SELECT user_id FROM auth."user" WHERE phone='${phone}'`));
}

function refreshTokenCount(userId) {
  return Number(psql(`SELECT count(*) FROM auth.refresh_token WHERE user_id=${userId}`));
}

function userSnapshot(userId) {
  return psql(
    `SELECT failed_attempts, coalesce(blocked_until::text,''), account_status FROM auth."user" WHERE user_id=${userId}`,
  );
}

function otpRow(phone) {
  return psql(
    `SELECT consumed, attempts FROM auth.otp_code WHERE phone='${phone}' ORDER BY id DESC LIMIT 1`,
  );
}

function logSince(mark) {
  return readFileSync(API_LOG, 'utf8').split('\n').slice(mark);
}

const platform = await adminLogin(PLATFORM_EMAIL, STAFF_PASSWORD);
const admin = await adminLogin(ADMIN_EMAIL, STAFF_PASSWORD);
const companyId = admin.user.tenant.company_id;

async function createDriverByApi() {
  const documents = [];
  for (const type of ['license', 'soat', 'vehicle_inspection', 'operation_card']) {
    const upload = await http('POST', '/admin/drivers/documents', {
      token: admin.token,
      form: pdfForm(`${type}-s01`),
    });
    if (upload.status !== 201) throw new Error(`driver doc upload ${upload.status} ${upload.text}`);
    documents.push({ type, storage_key: upload.body.storage_key, expires_at: '2027-12-31' });
  }
  const created = await http('POST', '/admin/drivers', {
    token: admin.token,
    body: {
      first_name: 'Sofia',
      last_name: 'Verificacion',
      national_id: '73900011',
      phone: PHONES.driver,
      vehicle: { plate: 'SOF011', model: 'Kia Picanto', year: 2022 },
      documents,
    },
  });
  if (created.status !== 201) throw new Error(`create driver ${created.status} ${created.text}`);
}

await createDriverByApi();
const operatorHash = await bcrypt.hash(OPERATOR_PASSWORD, 10);
psql(
  `INSERT INTO auth."user" (first_name,last_name,email,phone,password_hash,role,company_id) VALUES ('Operador','S01','${OPERATOR_EMAIL}','${PHONES.operator}','${operatorHash}','operator',${companyId})`,
);
psql(
  `INSERT INTO auth."user" (first_name,last_name,phone,role,company_id) VALUES ('Empresa','S01','${PHONES.company}','company',${companyId})`,
);

const reference = {};

const unknown = await requestOtp(PHONES.unknown);
const unknownWrong = await verifyOtp(PHONES.unknown, otherCode(unknown.code));
reference.unknown = fingerprint(unknownWrong);
check(
  'HU-S01-03',
  'código incorrecto en un celular sin cuenta: 401 OTP_INVALID "Código incorrecto"',
  unknownWrong.status === 401 &&
    unknownWrong.body?.code === INVALID_BODY.code &&
    unknownWrong.body?.message === INVALID_BODY.message,
  brief(unknownWrong),
);

const existing = await requestOtp(PHONES.existingPassenger);
const existingWrong = await verifyOtp(PHONES.existingPassenger, otherCode(existing.code));
reference.passenger = fingerprint(existingWrong);
check(
  'HU-S01-03',
  'código incorrecto de un pasajero: misma respuesta que un celular sin cuenta, byte a byte',
  reference.passenger === reference.unknown,
  brief(existingWrong),
);
const existingLogin = await verifyOtp(PHONES.existingPassenger, existing.code);
check(
  'HU-S01-01',
  'pasajero existente entra con OTP: 200, rol passenger, refresh token en el cuerpo',
  existingLogin.status === 200 &&
    existingLogin.body.user.role === 'passenger' &&
    Boolean(existingLogin.body.tokens?.refresh_token),
  brief(existingLogin),
);
const existingActive = await http('GET', '/trips/active', { token: existingLogin.body.tokens.access_token });
check(
  'HU-S01-01',
  'pasajero existente: GET /trips/active responde 200 con su token',
  existingActive.status === 200,
  `status=${existingActive.status}`,
);

const staff = [
  { role: 'driver', phone: PHONES.driver },
  { role: 'admin', phone: PHONES.admin },
  { role: 'operator', phone: PHONES.operator },
  { role: 'platform_admin', phone: PHONES.platform_admin },
  { role: 'company', phone: PHONES.company },
];

for (const member of staff) {
  const userId = userIdByPhone(member.phone);
  const tokensBefore = refreshTokenCount(userId);
  const snapshotBefore = userSnapshot(userId);
  const { code, mark } = await requestOtp(member.phone);

  const wrong = await verifyOtp(member.phone, otherCode(code));
  check(
    'HU-S01-03',
    `${member.role}: código incorrecto en su celular, misma respuesta que un celular sin cuenta`,
    fingerprint(wrong) === reference.unknown,
    brief(wrong),
  );

  const right = await verifyOtp(member.phone, code);
  check(
    'HU-S01-02',
    `${member.role}: código correcto -> 401 OTP_INVALID "Código incorrecto"`,
    right.status === 401 &&
      right.body?.code === INVALID_BODY.code &&
      right.body?.message === INVALID_BODY.message,
    brief(right),
  );
  check(
    'HU-S01-02',
    `${member.role}: la respuesta no trae tokens ni user`,
    right.body !== null && !('tokens' in right.body) && !('user' in right.body),
    brief(right),
  );
  check(
    'HU-S01-03',
    `${member.role}: estado, cuerpo y cabeceras idénticos a los de un código incorrecto (byte a byte)`,
    fingerprint(right) === reference.unknown,
    brief(right),
  );
  check(
    'HU-S01-02',
    `${member.role}: ninguna fila nueva en auth.refresh_token`,
    refreshTokenCount(userId) === tokensBefore,
    `antes=${tokensBefore} despues=${refreshTokenCount(userId)}`,
  );
  check(
    'HU-S01-02',
    `${member.role}: OTP consumida y con los dos intentos reservados (consumed=t, attempts=2: el código incorrecto previo y el correcto)`,
    otpRow(member.phone) === 't|2',
    otpRow(member.phone),
  );
  const again = await verifyOtp(member.phone, code);
  check(
    'HU-S01-02',
    `${member.role}: verificar de nuevo el mismo código -> 410 OTP_EXPIRED`,
    again.status === 410 && again.body?.code === 'OTP_EXPIRED',
    brief(again),
  );
  check(
    'HU-S01-02',
    `${member.role}: failed_attempts, blocked_until y account_status sin cambios`,
    userSnapshot(userId) === snapshotBefore,
    `antes=${snapshotBefore} despues=${userSnapshot(userId)}`,
  );

  const lines = logSince(mark);
  const rejection = lines.find(
    (line) => line.includes(`user_id=${userId}`) && line.includes(`role=${member.role}`),
  );
  check(
    'RN-S01-07',
    `${member.role}: log de rechazo con user_id y rol`,
    Boolean(rejection),
    'sin línea de log con user_id y rol',
  );
  const smsLine = (line) => line.includes('[sms:console');
  const leaks = lines.filter((line) => !smsLine(line) && line.includes(member.phone));
  check(
    'RN-S01-07',
    `${member.role}: ningún log (salvo el SMS de consola, solo desarrollo) contiene el teléfono`,
    leaks.length === 0,
    `${leaks.length} líneas`,
  );
  check(
    'RN-S01-07',
    `${member.role}: el log de rechazo no contiene el código`,
    !rejection || !rejection.includes(code),
    'el código aparece en el log de rechazo',
  );
}

const fresh = await requestOtp(PHONES.newPassenger);
const created = await verifyOtp(PHONES.newPassenger, fresh.code);
check(
  'HU-S01-01',
  'pasajero nuevo (auto-registro): 200, passenger, tenant null, profile_complete false',
  created.status === 200 &&
    created.body.user.role === 'passenger' &&
    created.body.user.tenant === null &&
    created.body.user.profile_complete === false &&
    Boolean(created.body.tokens?.refresh_token),
  brief(created),
);
const freshId = userIdByPhone(PHONES.newPassenger);
check(
  'HU-S01-01',
  'pasajero nuevo: fila en auth.user (passenger), fila en users.passenger y un refresh token vigente',
  psql(`SELECT role FROM auth."user" WHERE user_id=${freshId}`) === 'passenger' &&
    psql(`SELECT count(*) FROM users.passenger WHERE passenger_id=${freshId}`) === '1' &&
    refreshTokenCount(freshId) === 1,
  `refresh=${refreshTokenCount(freshId)}`,
);
const replay = await verifyOtp(PHONES.newPassenger, fresh.code);
check(
  'HU-S01-01',
  'pasajero: un solo uso, el mismo código da 410 OTP_EXPIRED',
  replay.status === 410 && replay.body?.code === 'OTP_EXPIRED',
  brief(replay),
);
const refreshed = await http('POST', '/auth/refresh', {
  body: { refresh_token: created.body.tokens.refresh_token },
});
check(
  'HU-S01-01',
  'pasajero: refresh rota el token',
  refreshed.status === 200 && refreshed.body.refresh_token !== created.body.tokens.refresh_token,
  `status=${refreshed.status}`,
);
const loggedOut = await http('POST', '/auth/logout', {
  body: { refresh_token: refreshed.body.refresh_token },
});
const afterLogout = await http('POST', '/auth/refresh', {
  body: { refresh_token: refreshed.body.refresh_token },
});
check(
  'HU-S01-01',
  'pasajero: logout revoca el refresh token',
  loggedOut.status === 200 && afterLogout.status === 401,
  `logout=${loggedOut.status} refresh=${afterLogout.status}`,
);

const seeded = SEED_DRIVERS[0];
const seededDriver = await driverLogin(seeded.nationalId, seeded.pin);
check(
  'HU-S01-07',
  'conductor con cédula y PIN: 200 con company_id y tenant',
  seededDriver.user.role === 'driver' && seededDriver.user.tenant.company_id === companyId,
  JSON.stringify(seededDriver.user.tenant),
);
const badPin = await http('POST', '/auth/driver/login', {
  body: { national_id: seeded.nationalId, pin: '0000' },
  headers: asClient(),
});
check(
  'HU-S01-07',
  'conductor con PIN incorrecto: 401 INVALID_CREDENTIALS',
  badPin.status === 401 && badPin.body?.code === 'INVALID_CREDENTIALS',
  brief(badPin),
);
psql(`UPDATE fleet.driver SET failed_attempts=0, blocked_until=NULL WHERE national_id='${seeded.nationalId}'`);

const driverId = userIdByPhone(PHONES.driver);
psql(
  `UPDATE fleet.driver SET pin='${await bcrypt.hash('135790', 10)}' WHERE driver_id=${driverId}`,
);
const temporary = await driverLogin('73900011', '135790');
check(
  'HU-S01-07',
  'conductor creado por la API entra con PIN temporal: pin_change_required=true',
  temporary.user.pin_change_required === true && temporary.user.tenant.company_id === companyId,
  JSON.stringify(temporary.user),
);
const change = await http('POST', '/auth/driver/pin', {
  token: temporary.token,
  body: { current_pin: '135790', new_pin: '482913' },
});
check(
  'HU-S01-07',
  'cambio de PIN del conductor: 200 con sesión nueva',
  change.status === 200 && Boolean(change.body?.tokens?.refresh_token),
  brief(change),
);
const relogin = await driverLogin('73900011', '482913');
check(
  'HU-S01-07',
  'conductor entra con el PIN nuevo y su sesión no exige cambio',
  relogin.user.pin_change_required === false,
  JSON.stringify(relogin.user),
);

const operator = await adminLogin(OPERATOR_EMAIL, OPERATOR_PASSWORD);
const staffSessions = [
  { role: 'admin', session: admin },
  { role: 'operator', session: operator },
  { role: 'platform_admin', session: platform },
];
for (const { role, session } of staffSessions) {
  check(
    'HU-S01-07',
    `${role} con correo y contraseña: 200`,
    session.user.role === role &&
      (role === 'platform_admin' ? session.user.tenant === null : session.user.tenant.company_id === companyId),
    JSON.stringify(session.user.tenant),
  );
}

async function refreshByRole(role, login) {
  const session = await signIn(login.path, login.body);
  const refreshed = await http('POST', '/auth/refresh', {
    body: { refresh_token: session.refresh },
  });
  check(
    'HU-S01-07',
    `refresh de ${role}: 200 con el mismo rol${role === 'platform_admin' ? ' y sin empresa' : ' y con su empresa'}`,
    refreshed.status === 200 &&
      refreshed.body.user.role === role &&
      (role === 'platform_admin'
        ? refreshed.body.user.tenant === null
        : refreshed.body.user.tenant.company_id === companyId),
    `status=${refreshed.status} role=${refreshed.body?.user?.role}`,
  );
}

await refreshByRole('driver', {
  path: '/auth/driver/login',
  body: { national_id: seeded.nationalId, pin: seeded.pin },
});
await refreshByRole('admin', {
  path: '/auth/admin/login',
  body: { email: ADMIN_EMAIL, password: STAFF_PASSWORD },
});
await refreshByRole('operator', {
  path: '/auth/admin/login',
  body: { email: OPERATOR_EMAIL, password: OPERATOR_PASSWORD },
});
await refreshByRole('platform_admin', {
  path: '/auth/admin/login',
  body: { email: PLATFORM_EMAIL, password: STAFF_PASSWORD },
});

const failed = flushResults();
process.exit(failed === 0 ? 0 : 1);
