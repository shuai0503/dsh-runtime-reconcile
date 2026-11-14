/**
 * Repeatable self-test for the pure core. No Harness runtime needed.
 *   node test/selftest.mjs
 */
import assert from 'node:assert/strict';
import { collect, normalizeOptions, renderText, FOCI } from '../core.js';

const str = (v) => ({ get: () => v });
let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log('PASS ' + name);
  } catch (error) {
    console.log('FAIL ' + name + ' — ' + error.message);
    process.exitCode = 1;
  }
}
async function atest(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log('PASS ' + name);
  } catch (error) {
    console.log('FAIL ' + name + ' — ' + error.message);
    process.exitCode = 1;
  }
}

/** Build a faithful mock of the live profile state observed on this machine. */
function mockContext(overrides = {}) {
  const defs = overrides.defs ?? [
    { name: 'web_search', output: { render() {} } },
    { name: 'web_fetch', output: { render() {} } },
    { name: 'reconcile_runtime', output: { render() {} } },
  ];
  const bundles = overrides.bundles ?? [
    { name: '@deepseek-ai/dsh-base', enabled: true },
    { name: '@liustack/modsearch', enabled: false },
    { name: 'dsh-runtime-reconcile', enabled: true },
  ];
  const rows = overrides.rows ?? [
    { entryId: 'a', moduleName: 'x', enabled: true, fiberPhase: 'active' },
    { entryId: 'include:modsearch', moduleName: '@liustack/modsearch', enabled: false, fiberPhase: null },
  ];
  const services = {
    web: overrides.web ?? {
      config: { searchProvider: str('modsearch'), fetchProvider: str('http') },
      searchProviders: new Map([['deepseek-official', {}], ['web-search-free', {}]]),
      fetchProviders: new Map([['http', {}]]),
    },
    pluginManager: {
      async listBundles() { return bundles; },
      async listPlugins() { return rows; },
    },
    tools: { definitions() { return defs; }, register() { return () => {}; } },
    configEditor: {}, commands: {}, systemPrompt: {}, sessionProjections: {},
  };
  if (overrides.missingServices) for (const k of overrides.missingServices) delete services[k];
  return { get: (k) => services[k] };
}

const codes = (r) => r.findings.map((f) => f.code);

await atest('core: catches configured-but-unregistered search provider', async () => {
  const r = await collect(mockContext(), { focus: 'all' });
  assert.equal(r.ok, false);
  assert.ok(codes(r).includes('WEB_SEARCH_PROVIDER_MISSING'));
  assert.ok(!codes(r).includes('WEB_FETCH_PROVIDER_MISSING'));
});

await atest('core: correlates the error with the disabled bundle', async () => {
  const r = await collect(mockContext(), { focus: 'all' });
  const err = r.findings.find((f) => f.code === 'WEB_SEARCH_PROVIDER_MISSING');
  assert.equal(err.evidence.disabledBundle, '@liustack/modsearch');
  assert.match(err.remedy, /Enable bundle "@liustack\/modsearch"/);
  const b = r.findings.find((f) => f.code === 'BUNDLE_DISABLED' && f.evidence.bundle === '@liustack/modsearch');
  assert.equal(b.severity, 'warning');
  assert.equal(b.evidence.linkedToProviderError, true);
});

await atest('core: healthy profile reports ok with provider OK findings', async () => {
  const r = await collect(mockContext({
    web: {
      config: { searchProvider: str('deepseek-official'), fetchProvider: str('http') },
      searchProviders: new Map([['deepseek-official', {}]]),
      fetchProviders: new Map([['http', {}]]),
    },
    bundles: [{ name: 'dsh-runtime-reconcile', enabled: true }],
    rows: [{ entryId: 'a', moduleName: 'x', enabled: true, fiberPhase: 'active' }],
  }), { focus: 'all' });
  assert.equal(r.ok, true);
  assert.equal(r.complete, true);
  assert.ok(codes(r).includes('WEB_SEARCH_PROVIDER_OK'));
  assert.ok(codes(r).includes('BUNDLES_ALL_ENABLED'));
  assert.ok(codes(r).includes('ROWS_ALL_ACTIVE'));
  assert.ok(codes(r).includes('SERVICES_OK'));
});

await atest('core: registered-but-unavailable provider is an error', async () => {
  const r = await collect(mockContext({
    web: {
      config: { searchProvider: str('slow'), fetchProvider: str('http') },
      searchProviders: new Map([['slow', { available: () => false }]]),
      fetchProviders: new Map([['http', {}]]),
    },
  }), { focus: 'providers' });
  assert.ok(codes(r).includes('WEB_SEARCH_PROVIDER_UNAVAILABLE'));
  assert.equal(r.snapshot.providers.search.unavailable[0], 'slow');
});

await atest('core: multiple providers with no config is ambiguous with remedy', async () => {
  const r = await collect(mockContext({
    web: {
      config: { searchProvider: str(''), fetchProvider: str('') },
      searchProviders: new Map([['a', {}], ['b', {}]]),
      fetchProviders: new Map([['http', {}]]),
    },
  }), { focus: 'providers' });
  assert.ok(codes(r).includes('WEB_SEARCH_AMBIGUOUS'));
  const f = r.findings.find((x) => x.code === 'WEB_SEARCH_AMBIGUOUS');
  assert.match(f.remedy, /Set web.searchProvider/);
});

await atest('core: enabled-but-not-active Loader row is a warning', async () => {
  const r = await collect(mockContext({
    rows: [
      { entryId: 'a', moduleName: 'good', enabled: true, fiberPhase: 'active' },
      { entryId: 'b', moduleName: 'stuck', enabled: true, fiberPhase: null },
    ],
  }), { focus: 'rows' });
  assert.ok(codes(r).includes('ROWS_NOT_ACTIVE'));
  assert.deepEqual(r.snapshot.rows.notActive, ['stuck']);
});

await atest('core: missing services reported, not silently OK', async () => {
  const r = await collect(mockContext({ missingServices: ['commands', 'configEditor'] }), { focus: 'services' });
  assert.ok(codes(r).includes('SERVICES_MISSING'));
  assert.deepEqual(r.findings.find((f) => f.code === 'SERVICES_MISSING').evidence.missing, ['configEditor', 'commands']);
});

await atest('core: unavailable check sets complete=false and ok=false', async () => {
  // Only `tools` resolves; web / pluginManager are absent so their groups
  // cannot run and must be marked unavailable rather than silently OK.
  const ctx = { get: (k) => (k === 'tools' ? { definitions: () => [] } : undefined) };
  const r = await collect(ctx, { focus: 'all' });
  assert.equal(r.ok, false);
  assert.equal(r.complete, false);
  assert.ok(r.completeness.unavailable.includes('providers'));
  assert.ok(r.completeness.unavailable.includes('bundles'));
  assert.match(renderText(r), /report is incomplete/);
});

await atest('core: focus narrows checked groups', async () => {
  const r = await collect(mockContext(), { focus: 'providers' });
  assert.deepEqual(r.completeness.checked, ['providers']);
  assert.ok(!codes(r).includes('BUNDLE_DISABLED'));
});

await atest('core: tools without output renderer warned (real signal, not fake duplicates)', async () => {
  const r = await collect(mockContext({ defs: [{ name: 'bare' }, { name: 'ok', output: { render() {} } }] }), { focus: 'tools' });
  assert.ok(codes(r).includes('TOOLS_WITHOUT_OUTPUT'));
  assert.ok(codes(r).includes('TOOL_REGISTRY_OK'));
  assert.ok(!codes(r).includes('TOOL_NAME_SHADOWED'));
});

test('normalizeOptions: defaults', () => {
  assert.deepEqual(normalizeOptions(), { focus: 'all', maxTools: 40 });
});

test('normalizeOptions: clamps maxTools to 0..200', () => {
  assert.equal(normalizeOptions({ maxTools: 9999 }).maxTools, 200);
  assert.equal(normalizeOptions({ maxTools: -5 }).maxTools, 0);
  assert.equal(normalizeOptions({ maxTools: 12.9 }).maxTools, 12);
});

test('normalizeOptions: rejects invalid focus', () => {
  assert.throws(() => normalizeOptions({ focus: 'nonsense' }), /invalid focus/);
  assert.ok(FOCI.includes('all') && FOCI.includes('providers'));
});

test('renderText: includes remedy lines', () => {
  const text = renderText({
    ok: false, complete: true, focus: 'all', generatedAt: 'x',
    summary: { errors: 1, warnings: 0, info: 0 },
    completeness: { checked: [], unavailable: [] },
    findings: [{ severity: 'error', code: 'X', title: 't', detail: 'd', remedy: 'do this' }],
    snapshot: { providers: { search: null, fetch: null }, bundles: { enabled: 0, total: 0, disabled: [] }, rows: { active: 0, total: 0, disabled: [], notActive: [] }, tools: { count: 0 } },
    note: 'n',
  });
  assert.match(text, /remedy: do this/);
});

console.log(`\n${passed} checks passed`);
