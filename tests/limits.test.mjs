// Unit tests for the per-role daily limits used by the Cloud Functions (functions/access.js → checkLimit).
// No emulator needed: npm run limits
import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync } from 'node:fs';

const require = createRequire(import.meta.url);
const { checkLimit, DEFAULT_LIMITS } = require('../functions/access.js');

const L = {
  roles: { super: { routeOpt: 40, scanReads: 120 }, admin: { routeOpt: 2, scanReads: 10 }, user: { routeOpt: 1, scanReads: '' }, blocked: { routeOpt: 0, scanReads: 0 } },
  global: { routeOpt: 3, scanReads: 5 },
};
const cases = [
  ['user: first smart route of the day', () => checkLimit('routeOpt', 'user', { byUser: 0, total: 0 }, L).ok === true],
  ['user: second smart route refused (role cap 1)', () => checkLimit('routeOpt', 'user', { byUser: 1, total: 1 }, L).reason === 'role'],
  ['admin: second allowed, third refused (cap 2)', () => checkLimit('routeOpt', 'admin', { byUser: 1, total: 1 }, L).ok && checkLimit('routeOpt', 'admin', { byUser: 2, total: 2 }, L).reason === 'role'],
  ['global cap stops everyone (3 in total)', () => checkLimit('routeOpt', 'super', { byUser: 0, total: 3 }, L).reason === 'global'],
  ['empty role value = no role cap, only global', () => checkLimit('scanReads', 'user', { byUser: 999, total: 4 }, L).ok && checkLimit('scanReads', 'user', { byUser: 999, total: 5 }, L).reason === 'global'],
  ['0 = blocked', () => checkLimit('routeOpt', 'blocked', { byUser: 0, total: 0 }, L).reason === 'role'],
  ['future role without its own row falls back to user', () => checkLimit('routeOpt', 'manager', { byUser: 1, total: 0 }, L).reason === 'role'],
  ['defaults: every role 40 routes / 120 reads', () => ['super', 'admin', 'user'].every((r) => DEFAULT_LIMITS.roles[r].routeOpt === 40 && DEFAULT_LIMITS.roles[r].scanReads === 120)],
  ['defaults: 40th route allowed, 41st refused', () => checkLimit('routeOpt', 'user', { byUser: 39, total: 39 }).ok && !checkLimit('routeOpt', 'user', { byUser: 40, total: 40 }).ok],
  ['missing config → defaults', () => checkLimit('scanReads', 'user', { byUser: 119, total: 119 }, undefined).ok],
];
const results = cases.map(([name, fn]) => { let pass; try { pass = !!fn(); } catch { pass = false; } return { name, pass }; });
results.forEach((r) => console.log(`${r.pass ? '✓' : '✗'} ${r.name}`));
const failed = results.filter((r) => !r.pass).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
mkdirSync(new URL('./results/', import.meta.url), { recursive: true });
writeFileSync(new URL('./results/limits.json', import.meta.url), JSON.stringify({ at: new Date().toISOString(), results }, null, 2));
process.exit(failed ? 1 : 0);
