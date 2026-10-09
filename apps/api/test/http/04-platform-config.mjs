import { check, flushResults, http, psql } from './lib.mjs';
import { loadState, saveState } from './state.mjs';

const state = loadState();
const platform = state.sessions.platform.session;
const adminA = state.sessions.adminA.session;
const adminB = state.sessions.adminB.session;
const y = state.yarumalId;
const fareUrl = `/platform/municipalities/${y}/services/taxi/fare`;
const paramsUrl = `/platform/municipalities/${y}/services/taxi/operational-params`;

const configs = await http('GET', '/platform/service-configs', { token: platform.token });
const yarumalRow = configs.body?.rows?.find(
  (r) => r.municipality_id === y && r.service_type === 'taxi',
);
check(
  'HU-MS-10',
  'service-configs: Yarumal/taxi con 2 empresas activas, tarifa vigente y cobertura activa',
  configs.status === 200 &&
    yarumalRow?.active_company_count === 2 &&
    yarumalRow.fare?.base_fare === 8000 &&
    yarumalRow.coverage_active === true,
  JSON.stringify(yarumalRow)?.slice(0, 300),
);

const fare0 = (await http('GET', fareUrl, { token: platform.token })).body.current;
const fareBody = (version, base) => ({
  version,
  base_fare: base,
  night_surcharge_pct: 20,
  holiday_surcharge_pct: 15,
  is_official: true,
  official_reference: 'Resolución 0142 de 2026 (Alcaldía de Yarumal)',
});

const put1 = await http('PUT', fareUrl, {
  token: platform.token,
  body: fareBody(fare0.municipality_fare_id, 9000),
});
check(
  'HU-MS-10',
  'PUT de tarifa con la versión vigente: 200, crea una versión nueva oficial con referencia',
  put1.status === 200 &&
    put1.body.base_fare === 9000 &&
    put1.body.is_official === true &&
    put1.body.municipality_fare_id > fare0.municipality_fare_id,
  put1.text.slice(0, 300),
);

const stale = await http('PUT', fareUrl, {
  token: platform.token,
  body: fareBody(fare0.municipality_fare_id, 9500),
});
check(
  'HU-MS-10',
  'conflicto de dos pestañas: PUT con la versión vieja -> 409 SETTINGS_CONFLICT con current_version y current_author_name',
  stale.status === 409 &&
    stale.body?.code === 'SETTINGS_CONFLICT' &&
    stale.body.current_version === put1.body.municipality_fare_id &&
    Boolean(stale.body.current_author_name),
  stale.text.slice(0, 300),
);

const dual = await Promise.all([
  http('PUT', fareUrl, {
    token: platform.token,
    body: fareBody(put1.body.municipality_fare_id, 9000),
  }),
  http('PUT', fareUrl, {
    token: platform.token,
    body: fareBody(put1.body.municipality_fare_id, 9000),
  }),
]);
const dualStatuses = dual.map((r) => r.status).sort();
check(
  'HU-MS-10',
  'dos PUT simultáneos con la misma versión: un 200 y un 409 (nunca 500)',
  dualStatuses[0] === 200 && dualStatuses[1] === 409,
  dualStatuses.join(','),
);

const history = await http('GET', fareUrl, { token: platform.token });
const openFares = psql(
  `SELECT count(*) FROM trips.municipality_fare WHERE municipality_id=${y} AND service_type='taxi' AND valid_to IS NULL`,
);
check(
  'HU-MS-10',
  'historial con versiones y exactamente una tarifa abierta tras las escrituras concurrentes',
  history.body.versions.length >= 3 && openFares === '1',
  `${history.body.versions.length} versiones, ${openFares} abiertas`,
);
const currentFare = history.body.current;

const nonOfficialWithRef = await http('PUT', fareUrl, {
  token: platform.token,
  body: { ...fareBody(currentFare.municipality_fare_id, 9000), is_official: false },
});
check(
  'HU-MS-10',
  'referencia del acto sin tarifa oficial -> 422 con field official_reference',
  nonOfficialWithRef.status === 422 && nonOfficialWithRef.body?.field === 'official_reference',
  `${nonOfficialWithRef.status} ${nonOfficialWithRef.text.slice(0, 160)}`,
);
const outOfRange = await http('PUT', fareUrl, {
  token: platform.token,
  body: fareBody(currentFare.municipality_fare_id, 50),
});
check(
  'HU-MS-10',
  'tarifa fuera de rango -> 4xx estable',
  outOfRange.status >= 400 && outOfRange.status < 500,
  `${outOfRange.status} ${outOfRange.text.slice(0, 160)}`,
);

for (const service of ['comfort', 'delivery', 'motorcycle']) {
  const response = await http('PUT', `/platform/municipalities/${y}/services/${service}/fare`, {
    token: platform.token,
    body: fareBody(1, 9000),
  });
  check(
    'HU-MS-12',
    `PUT de tarifa para ${service} (inactivo/prohibido) -> 4xx estable`,
    response.status >= 400 && response.status < 500,
    `${response.status} ${response.text.slice(0, 160)}`,
  );
}

const params0 = (await http('GET', paramsUrl, { token: platform.token })).body.current;
const paramsPut = await http('PUT', paramsUrl, {
  token: platform.token,
  body: {
    version: params0.operational_params_id,
    search_radius_km: params0.search_radius_km,
    expansion_radius_km: params0.expansion_radius_km,
    acceptance_timeout_sec: params0.acceptance_timeout_sec,
    max_auto_retries: 4,
    tiebreak_window_hours: params0.tiebreak_window_hours,
    location_stale_min: params0.location_stale_min,
    avg_speed_kmh: params0.avg_speed_kmh,
    cancellation_window_min: params0.cancellation_window_min,
    no_show_grace_min: params0.no_show_grace_min,
  },
});
check(
  'HU-MS-10',
  'PUT de parámetros del municipio (reintentos 3 -> 4) crea versión nueva',
  paramsPut.status === 200 && paramsPut.body.max_auto_retries === 4,
  paramsPut.text.slice(0, 300),
);

for (const [label, session] of [
  ['Cootrayal', adminA],
  ['Taxis Norte', adminB],
]) {
  const settings = await http('GET', '/admin/settings', { token: session.token });
  check(
    'HU-MS-10',
    `${label}: GET /admin/settings es solo lectura y trae la tarifa 9000 oficial y reintentos 4`,
    settings.status === 200 &&
      settings.body.read_only === true &&
      settings.body.base_fare === 9000 &&
      settings.body.fare_is_official === true &&
      settings.body.max_auto_retries === 4,
    settings.text.slice(0, 400),
  );
  const write = await http('PUT', '/admin/settings', {
    token: session.token,
    body: {
      version: settings.body.version,
      base_fare: 12000,
      night_surcharge_pct: 20,
      holiday_surcharge_pct: 15,
      commission_pct: 1,
      search_radius_km: 2,
      expansion_radius_km: 6,
      acceptance_timeout_sec: 15,
    },
  });
  check(
    'HU-MS-10',
    `${label}: PUT /admin/settings -> 403 (la empresa no edita)`,
    write.status === 403,
    `${write.status} ${write.text.slice(0, 200)}`,
  );
  for (const [method, path] of [
    ['GET', '/platform/companies'],
    ['GET', '/platform/commissions'],
    ['GET', '/platform/service-configs'],
    ['PUT', fareUrl],
  ]) {
    const denied = await http(method, path, {
      token: session.token,
      body: method === 'PUT' ? fareBody(1, 9999) : undefined,
    });
    check(
      'HU-MS-09/10',
      `${label}: ${method} ${path.slice(0, 40)} -> 403`,
      denied.status === 403,
      denied.status,
    );
  }
}
const fareAfter = (await http('GET', fareUrl, { token: platform.token })).body.current;
check(
  'HU-MS-10',
  'la tarifa sigue en 9000 tras los intentos denegados de la empresa',
  fareAfter.base_fare === 9000,
  fareAfter.base_fare,
);

const commissionUrl = (id) => `/platform/companies/${id}/commission`;
const commissionB0 = (await http('GET', commissionUrl(state.companyB), { token: platform.token }))
  .body.current;
const commissionPut = await http('PUT', commissionUrl(state.companyB), {
  token: platform.token,
  body: { version: commissionB0.company_commission_id, commission_pct: 12 },
});
check(
  'HU-MS-15',
  'PUT de comisión de B 10 -> 12 con versión: 200',
  commissionPut.status === 200 && commissionPut.body.commission_pct === 12,
  commissionPut.text.slice(0, 250),
);
const commissionStale = await http('PUT', commissionUrl(state.companyB), {
  token: platform.token,
  body: { version: commissionB0.company_commission_id, commission_pct: 15 },
});
check(
  'HU-MS-15',
  'comisión con versión vieja -> 409 SETTINGS_CONFLICT',
  commissionStale.status === 409 && commissionStale.body?.code === 'SETTINGS_CONFLICT',
  commissionStale.text.slice(0, 250),
);
const commissionTooHigh = await http('PUT', commissionUrl(state.companyB), {
  token: platform.token,
  body: { version: commissionPut.body.company_commission_id, commission_pct: 50.01 },
});
check(
  'HU-MS-15',
  'comisión 50,01 % -> 4xx estable',
  commissionTooHigh.status >= 400 && commissionTooHigh.status < 500,
  `${commissionTooHigh.status} ${commissionTooHigh.text.slice(0, 160)}`,
);

saveState({ fareBase: 9000, commissionB: 12, commissionA: 8 });
process.exitCode = flushResults() ? 1 : 0;
