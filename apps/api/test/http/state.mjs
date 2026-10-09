import { existsSync, readFileSync, writeFileSync } from 'node:fs';

const FILE =
  process.env.STATE_FILE ??
  new URL('./state.json', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');

export function loadState() {
  return existsSync(FILE) ? JSON.parse(readFileSync(FILE, 'utf8')) : {};
}

export function saveState(patch) {
  const next = { ...loadState(), ...patch };
  writeFileSync(FILE, JSON.stringify(next, null, 2));
  return next;
}

export const PLATFORM_EMAIL = 'plataforma@voyya.co';
export const ADMIN_EMAIL = 'admin@voyya.co';
export const STAFF_PASSWORD = process.env.SEED_ADMIN_PASSWORD ?? 'DEV_ONLY_change_me_1234!';
export const SEED_DRIVERS = [
  { nationalId: '71000001', pin: '1234', lat: 6.9642, lng: -75.419 },
  { nationalId: '71000002', pin: '1234', lat: 6.9655, lng: -75.417 },
  { nationalId: '71000003', pin: '1234', lat: 6.9701, lng: -75.421 },
];
