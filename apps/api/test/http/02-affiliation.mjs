import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { adminLogin, cachedSession, check, flushResults, http, pdfForm, psql } from './lib.mjs';
import { PLATFORM_EMAIL, STAFF_PASSWORD, loadState, saveState } from './state.mjs';

const require = createRequire(fileURLToPath(new URL('../../package.json', import.meta.url)));

const platform = await cachedSession('platform', () => adminLogin(PLATFORM_EMAIL, STAFF_PASSWORD));
const state = loadState();

const catalog = await http('GET', '/affiliation/municipalities');
const rows = catalog.body?.rows ?? [];
const byCode = new Map(rows.map((r) => [r.dane_code, r]));
check(
  'HU-CM-05/HU-CM-03',
  'GET /affiliation/municipalities responde 200 con fuente y atribución',
  catalog.status === 200 && catalog.body.source.attribution.length > 0,
  catalog.text.slice(0, 200),
);
const stored = Number(
  psql('SELECT count(*) FROM tenancy.municipality WHERE dane_code IS NOT NULL'),
);
check(
  'HU-CM-05',
  `catálogo guardado = 1.122 filas de la fuente y el selector ofrece ${rows.length} (esperado 1.104: 1.103 municipios + San Andrés)`,
  stored === 1122 && rows.length === 1104,
  `${stored} guardadas / ${rows.length} ofrecidas`,
);
check(
  'HU-CM-05',
  'las áreas no municipalizadas (El Encanto 91263, La Chorrera 91405, Pacoa 97511) no se ofrecen',
  !byCode.has('91263') && !byCode.has('91405') && !byCode.has('97511') && byCode.has('88001'),
  '',
);
const antioquia = rows.filter((r) => r.department_code === '05');
check(
  'HU-CM-03',
  `Antioquia tiene ${antioquia.length} (esperado ~125)`,
  antioquia.length >= 120 && antioquia.length <= 130,
  antioquia.length,
);
check(
  'HU-CM-03',
  'Bogotá D.C. (11001) está en el catálogo',
  byCode.get('11001')?.name?.toLowerCase().includes('bogot'),
  JSON.stringify(byCode.get('11001')),
);
check(
  'HU-CM-03',
  'los códigos DANE son únicos',
  byCode.size === rows.length,
  `${byCode.size}/${rows.length}`,
);

const SAMPLE = {
  '05001': 'medell',
  11001: 'bogot',
  76001: 'cali',
  '08001': 'barranquilla',
  13001: 'cartagena',
  68001: 'bucaramanga',
  17001: 'manizales',
  66001: 'pereira',
  73001: 'ibagu',
  54001: 'cúcuta',
  '05887': 'yarumal',
  '05045': 'apartad',
  '05154': 'caucasia',
  '05615': 'rionegro',
  '05360': 'itag',
  '05088': 'bello',
  '05266': 'envigado',
  52001: 'pasto',
  20001: 'valledupar',
  50001: 'villavicencio',
  41001: 'neiva',
  47001: 'santa marta',
  23001: 'monter',
  70001: 'sincelejo',
  15001: 'tunja',
  19001: 'popay',
  91001: 'leticia',
  88001: 'san andr',
  99001: 'puerto carre',
  81001: 'arauca',
};
const sampleFailures = Object.entries(SAMPLE).filter(([code, fragment]) => {
  const row = byCode.get(code);
  const normalized = row?.name?.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  return !normalized || !normalized.includes(fragment.normalize('NFD').replace(/[̀-ͯ]/g, ''));
});
check(
  'HU-CM-05',
  `muestreo de ${Object.keys(SAMPLE).length} códigos DIVIPOLA contra el nombre conocido`,
  sampleFailures.length === 0,
  JSON.stringify(sampleFailures),
);

const yarumal = byCode.get('05887');
check(
  'HU-MS-14',
  'Yarumal: has_active_companies=true y coverage_active=true (ya no bloquea)',
  yarumal?.has_active_companies === true && yarumal.coverage_active === true,
  JSON.stringify(yarumal),
);
const medellin = byCode.get('05001');
check(
  'HU-CM-04',
  'Medellín: sin cobertura y sin empresas',
  medellin?.coverage_active === false && medellin.has_active_companies === false,
  JSON.stringify(medellin),
);

async function upload(label) {
  const response = await http('POST', '/affiliation/documents', { form: pdfForm(label) });
  if (response.status !== 201)
    throw new Error(`upload ${label} ${response.status} ${response.text}`);
  return response.body.storage_key;
}

async function documents() {
  const types = [
    'chamber_of_commerce',
    'tax_registry',
    'transport_authorization',
    'liability_insurance',
  ];
  const out = [];
  for (const type of types) out.push({ type, storage_key: await upload(type) });
  return out;
}

const applicationB = await http('POST', '/affiliation/applications', {
  body: {
    legal_name: 'Taxis Norte S.A.S.',
    public_name: 'Taxis Norte',
    tax_id: '900123456-7',
    legal_form: 'corporation',
    municipality_id: yarumal.municipality_id,
    vehicle_count: 5,
    contact_first_name: 'Beatriz',
    contact_last_name: 'Norte',
    contact_email: 'beatriz@taxisnorte.test',
    contact_phone: '3205550001',
    service_types: ['taxi'],
    documents: await documents(),
  },
});
check(
  'HU-MS-13/HU-MS-11',
  'solicitud de Taxis Norte en Yarumal (servicio taxi, nombre público) se acepta',
  applicationB.status === 201 && applicationB.body.status === 'pending',
  applicationB.text,
);
const companyB = applicationB.body.company_id;

const applicationC = await http('POST', '/affiliation/applications', {
  body: {
    legal_name: 'Transportes Paisa Ltda.',
    tax_id: '900765432-1',
    legal_form: 'corporation',
    municipality_id: medellin.municipality_id,
    vehicle_count: 3,
    contact_first_name: 'Camilo',
    contact_last_name: 'Paisa',
    contact_email: 'camilo@paisa.test',
    contact_phone: '3205550002',
    documents: await documents(),
  },
});
check(
  'HU-CM-04',
  'solicitud en Medellín (sin cobertura) se acepta con servicio por defecto taxi',
  applicationC.status === 201,
  applicationC.text,
);
const companyC = applicationC.body.company_id;

const pending = await http('GET', '/platform/companies?status=pending', { token: platform.token });
const rowB = pending.body?.rows?.find((r) => r.company_id === companyB);
check(
  'HU-MS-11',
  'la plataforma ve B pendiente, con municipio ya cubierto y nombre público',
  pending.status === 200 &&
    rowB?.municipality_already_covered === true &&
    rowB.display_name === 'Taxis Norte' &&
    rowB.service_types.includes('taxi'),
  JSON.stringify(rowB),
);

const detailB = await http('GET', `/platform/companies/${companyB}`, { token: platform.token });
check(
  'HU-MS-11',
  'detalle de B lista las empresas activas del municipio (Cootrayal) y las tarifas vigentes',
  detailB.status === 200 &&
    detailB.body.municipality_active_companies.some((c) => c.legal_name === 'Cootrayal') &&
    detailB.body.municipality_fares.some((f) => f.fare?.base_fare === 8000),
  JSON.stringify(detailB.body?.municipality_active_companies),
);

const noCommission = await http('POST', `/platform/companies/${companyB}/approve`, {
  token: platform.token,
  body: {},
});
check(
  'HU-MS-11/HU-MS-15',
  'aprobar sin comisión da 400 (comisión obligatoria)',
  noCommission.status === 400,
  `${noCommission.status} ${noCommission.text.slice(0, 200)}`,
);

const approveB = await http('POST', `/platform/companies/${companyB}/approve`, {
  token: platform.token,
  body: { commission_pct: 10 },
});
check(
  'HU-MS-11',
  'aprobar B (segunda empresa en Yarumal) con comisión 10 -> 200 active, sin bloqueo por municipio cubierto',
  approveB.status === 200 &&
    approveB.body.status === 'active' &&
    approveB.body.decision === 'approved',
  approveB.text.slice(0, 400),
);
check(
  'HU-MS-11',
  'provisioning: no crea una segunda tarifa abierta (created=false) y crea comisión + admin',
  approveB.body?.provisioning?.municipality_fares?.every((f) => f.created === false) &&
    approveB.body.provisioning.company_commission_id > 0 &&
    approveB.body.provisioning.admin_email,
  JSON.stringify(approveB.body?.provisioning),
);
const openFares = psql(
  `SELECT count(*) FROM trips.municipality_fare WHERE municipality_id=${yarumal.municipality_id} AND service_type='taxi' AND valid_to IS NULL`,
);
check(
  'HU-MS-11',
  'una sola tarifa abierta de taxi en Yarumal tras aprobar a B',
  openFares === '1',
  openFares,
);

const approveCNoFare = await http('POST', `/platform/companies/${companyC}/approve`, {
  token: platform.token,
  body: { commission_pct: 8 },
});
check(
  'HU-CM-04',
  'aprobar C (municipio sin tarifa) sin initial_fare -> 409 MUNICIPALITY_FARE_REQUIRED',
  approveCNoFare.status === 409 && approveCNoFare.body?.code === 'MUNICIPALITY_FARE_REQUIRED',
  approveCNoFare.text.slice(0, 300),
);
const approveC = await http('POST', `/platform/companies/${companyC}/approve`, {
  token: platform.token,
  body: { commission_pct: 8, initial_fare: { base_fare: 7000 } },
});
check(
  'HU-CM-04',
  'aprobar C con initial_fare -> 200; cobertura del municipio sigue pendiente',
  approveC.status === 200 && approveC.body.municipality_coverage_active === false,
  approveC.text.slice(0, 300),
);

const bcrypt = require('bcryptjs');
const hash = await bcrypt.hash(STAFF_PASSWORD, 10);
const adminEmail = approveB.body.provisioning.admin_email;
psql(`UPDATE auth."user" SET password_hash='${hash}' WHERE email='${adminEmail}'`);
const adminB = await adminLogin(adminEmail, STAFF_PASSWORD);
check(
  'HU-MS-11',
  'el admin de B entra con su propio tenant (Taxis Norte, Yarumal)',
  adminB.user.tenant?.company_id === companyB && adminB.user.tenant.municipality_name === 'Yarumal',
  JSON.stringify(adminB.user.tenant),
);
const sessions = { ...(loadState().sessions ?? {}), adminB: { at: Date.now(), session: adminB } };
saveState({
  companyB,
  companyC,
  adminBEmail: adminEmail,
  sessions,
  medellinId: medellin.municipality_id,
});

process.exitCode = flushResults() ? 1 : 0;
