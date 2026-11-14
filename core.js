/**
 * dsh-runtime-reconcile — pure inspection core.
 *
 * No runtime imports, no Node APIs beyond process.env, no I/O. `collect()` takes
 * a context-like object and returns a plain JSON report, so it can be unit
 * tested with a mock (see test/selftest.mjs) and reused outside a Host plugin.
 *
 * Design note: importing a @deepseek-ai/* runtime package from a third-party
 * bundle can hoist a second copy and shadow the host's copy (Symbol identity is
 * per-module-instance), breaking every tool call — see deepseek-harness
 * discussion #1697. Everything here is reached through ctx.get().
 */

export const GROUPS = Object.freeze([
  'providers', 'bundles', 'rows', 'tools', 'services',
]);

export const FOCI = Object.freeze(['all', ...GROUPS]);

/** Core seams we expect in a healthy web profile. */
const EXPECTED_SERVICES = Object.freeze([
  'tools', 'web', 'pluginManager', 'configEditor', 'commands',
  'systemPrompt', 'sessionProjections',
]);

/** Read a service defensively; a missing service is reported, never thrown. */
function service(ctx, key) {
  try {
    return ctx?.get?.(key);
  } catch {
    return undefined;
  }
}

/** Pull a configured id out of a z.string().volatile() field or a plain value. */
function configuredId(value) {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'string') return value || undefined;
  if (typeof value === 'object' && typeof value.get === 'function') {
    try {
      return configuredId(value.get());
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/** Provider registry ids plus each provider's live availability/readiness. */
function inspectProviderMap(map) {
  const entries = [];
  if (!map || typeof map.keys !== 'function') return { entries, available: false, ids: [] };
  for (const [id, provider] of map.entries()) {
    const name = String(id);
    let present = true;
    let unavailable = false;
    try {
      // The web seam calls provider.available() before selecting it.
      if (provider && typeof provider.available === 'function' && !provider.available()) unavailable = true;
    } catch {
      // A throwing available() is itself a fault at selection time.
      unavailable = true;
    }
    entries.push({ id: name, present, unavailable });
  }
  entries.sort((a, b) => a.id.localeCompare(b.id));
  return {
    entries,
    available: entries.length > 0,
    ids: entries.map((e) => e.id),
  };
}

function makeFinding(severity, code, title, detail, evidence, remedy) {
  return {
    severity, code, title, detail,
    ...(evidence !== undefined ? { evidence } : {}),
    ...(remedy !== undefined ? { remedy } : {}),
  };
}

/** Does the named provider belong to a disabled bundle? Pure string matching. */
function bundleForProvider(providerId, disabledBundles) {
  if (!providerId) return undefined;
  const needle = providerId.toLowerCase();
  // Longest match first: "@liustack/modsearch" should beat a short "mod" hit.
  const sorted = [...disabledBundles].sort((a, b) => b.length - a.length);
  return sorted.find((name) => {
    const n = name.toLowerCase();
    return n === needle || n.endsWith('/' + needle) || needle === n.split('/').pop() || n.includes(needle);
  });
}

/**
 * Live report.
 *
 * `focus`: 'all' | one of GROUPS. Invalid values are rejected (see
 * normalizeOptions) rather than silently producing an empty "OK" report.
 * `maxTools`: cap on listed tool names, clamped 0..200.
 */
export async function collect(ctx, options = {}) {
  const { focus = 'all', maxTools = 40 } = options;
  const findings = [];
  const summary = { errors: 0, warnings: 0, info: 0 };
  const completeness = { checked: [], unavailable: [] };
  let incomplete = false;

  const add = (f) => {
    if (!f) return;
    findings.push(f);
    if (f.severity === 'error') summary.errors += 1;
    else if (f.severity === 'warning') summary.warnings += 1;
    else summary.info += 1;
  };
  const group = (name, present) => {
    const wanted = focus === 'all' || focus === name;
    if (!wanted) return false;
    completeness.checked.push(name);
    if (!present) {
      completeness.unavailable.push(name);
      incomplete = true;
    }
    return present;
  };

  // Pre-fetch bundles once: the provider check correlates against them below.
  // This keeps the diagnosis in one report without a second plugin-manager call.
  const pm = service(ctx, 'pluginManager');
  let bundlesRaw = null;
  let bundlesError;
  if (pm && typeof pm.listBundles === 'function') {
    try {
      const value = await pm.listBundles();
      if (Array.isArray(value)) bundlesRaw = value;
    } catch (error) {
      bundlesError = String(error?.message ?? error);
    }
  }
  const disabledBundles = [];
  const bundleSnapshot = { total: 0, enabled: 0, disabled: [], unavailable: false };
  if (bundlesRaw) {
    bundleSnapshot.total = bundlesRaw.length;
    for (const b of bundlesRaw) {
      const name = String(b?.name ?? b?.id ?? '?');
      if (b?.enabled === true) bundleSnapshot.enabled += 1;
      else if (b?.enabled === false) {
        bundleSnapshot.disabled.push(name);
        disabledBundles.push(name);
      }
    }
  } else {
    bundleSnapshot.unavailable = true;
  }

  // --- 1. Web providers: three-state selection, correlated with bundles ---
  const providerSnapshot = { search: null, fetch: null };
  const web = service(ctx, 'web');
  if (group('providers', !!web)) {
    for (const [kind, configKey, mapKey, envKey] of [
      ['search', 'searchProvider', 'searchProviders', 'DSH_WEB_SEARCH_PROVIDER'],
      ['fetch', 'fetchProvider', 'fetchProviders', 'DSH_WEB_FETCH_PROVIDER'],
    ]) {
      const envValue = process.env?.[envKey];
      const configured = configuredId(web.config?.[configKey]) ?? envValue;
      const inspected = inspectProviderMap(web[mapKey]);
      providerSnapshot[kind] = {
        configured: configured ?? null,
        configuredFrom: envValue ? envKey : (configured ? `web.${configKey}` : null),
        registered: inspected.ids,
        unavailable: inspected.entries.filter((e) => e.unavailable).map((e) => e.id),
      };
      if (!inspected.available) {
        add(makeFinding('error', `WEB_${kind.toUpperCase()}_NO_PROVIDER`,
          `No ${kind} provider is registered`,
          `The live ${mapKey} map is empty, so ${kind}() cannot resolve any provider.`,
          { map: mapKey },
          'Enable the bundle that provides a web search/fetch provider, or set web.' + configKey + ' to one that is mounted.'));
        continue;
      }
      if (configured && !inspected.ids.includes(configured)) {
        const culprit = bundleForProvider(configured, disabledBundles);
        const evidence = {
          configuredFrom: providerSnapshot[kind].configuredFrom,
          configured,
          registered: inspected.ids,
          ...(culprit ? { disabledBundle: culprit } : {}),
        };
        add(makeFinding('error', `WEB_${kind.toUpperCase()}_PROVIDER_MISSING`,
          `Configured ${kind} provider "${configured}" is not registered`,
          `ctx.web.${configKey} points at "${configured}", but the live ${mapKey} registry contains [${inspected.ids.join(', ')}]. Every ${kind} call fails at provider selection.`
          + (culprit ? ` The bundle "${culprit}" is installed but disabled — that is the likely cause.` : ''),
          evidence,
          culprit
            ? `Enable bundle "${culprit}" (or set web.${configKey} to one of: ${inspected.ids.join(', ')}).`
            : `Set web.${configKey} to one of the registered providers: ${inspected.ids.join(', ')}, or install the bundle that provides "${configured}".`));
        continue;
      }
      const chosen = configured
        ? inspected.entries.find((e) => e.id === configured)
        : undefined;
      if (chosen?.unavailable) {
        add(makeFinding('error', `WEB_${kind.toUpperCase()}_PROVIDER_UNAVAILABLE`,
          `Configured ${kind} provider "${configured}" is registered but unavailable`,
          'The web seam calls provider.available() before selecting it; this provider reports false (or threw), so resolveProvider() rejects with WEB_PROVIDER_CONFIGURED_UNAVAILABLE.',
          { configured, registered: inspected.ids },
          `Check the provider's credentials/readiness, or point web.${configKey} at another registered provider.`));
        continue;
      }
      if (!configured && inspected.ids.length > 1) {
        add(makeFinding('warning', `WEB_${kind.toUpperCase()}_AMBIGUOUS`,
          `${inspected.ids.length} ${kind} providers registered with no selection`,
          'Without an explicit config, resolveProvider() rejects with WEB_PROVIDER_AMBIGUOUS.',
          { registered: inspected.ids },
          `Set web.${configKey} to one of: ${inspected.ids.join(', ')}.`));
        continue;
      }
      if (configured && inspected.ids.includes(configured)) {
        add(makeFinding('info', `WEB_${kind.toUpperCase()}_PROVIDER_OK`,
          `${kind} provider "${configured}" is configured and live`,
          'The configured id resolves to a registered, available provider.',
          { configured, registered: inspected.ids }));
      }
    }
  }

  // --- 2. Disabled installed bundles ---
  if (group('bundles', bundlesRaw !== null)) {
    if (bundlesError) {
      add(makeFinding('warning', 'BUNDLE_LIST_FAILED', 'Could not enumerate installed bundles',
        bundlesError, undefined, 'Retry after the profile settles; a failing plugin manager may indicate a broken composition.'));
    } else {
      for (const name of bundleSnapshot.disabled) {
        const linked = findings.some((f) => f.code.startsWith('WEB_') && f.evidence?.disabledBundle === name);
        add(makeFinding(linked ? 'warning' : 'info',
          'BUNDLE_DISABLED', `Bundle "${name}" is installed but disabled`,
          linked
            ? 'This disabled bundle is the likely cause of a provider error above.'
            : 'Its rows are inserted into the composition but never mounted. It matters only when a config points at a capability it provides.',
          { bundle: name, linkedToProviderError: linked }));
      }
      if (bundleSnapshot.disabled.length === 0) {
        add(makeFinding('info', 'BUNDLES_ALL_ENABLED', `${bundleSnapshot.total} installed bundles are enabled`,
          'No installed bundle is disabled.'));
      }
    }
  }

  // --- 3. Loader rows: enabled-but-not-active is the real silent failure ---
  const rowsSnapshot = { total: 0, active: 0, disabled: [], notActive: [] };
  let rowsRaw = null;
  let rowsError;
  if (pm && typeof pm.listPlugins === 'function') {
    try {
      const value = await pm.listPlugins();
      if (Array.isArray(value)) rowsRaw = value;
    } catch (error) {
      rowsError = String(error?.message ?? error);
    }
  }
  if (group('rows', rowsRaw !== null)) {
    if (rowsError) {
      add(makeFinding('warning', 'PLUGIN_LIST_FAILED', 'Could not enumerate Loader rows', rowsError));
    } else {
      rowsSnapshot.total = rowsRaw.length;
      for (const row of rowsRaw) {
        const label = String(row?.moduleName ?? row?.entryId ?? '?');
        if (row?.enabled === false) rowsSnapshot.disabled.push(label);
        else if (row?.enabled === true && row?.fiberPhase !== 'active') rowsSnapshot.notActive.push(label);
        else if (row?.enabled === true) rowsSnapshot.active += 1;
      }
      if (rowsSnapshot.notActive.length > 0) {
        add(makeFinding('warning', 'ROWS_NOT_ACTIVE',
          `${rowsSnapshot.notActive.length} enabled Loader row(s) are not in the active phase`,
          'These rows are enabled but their fiber never reached "active" — the capability they were meant to provide is not live. This is the class of failure static scanners cannot see.',
          { rows: rowsSnapshot.notActive.slice(0, 20) },
          'Check the row\'s injection targets and load errors; a restart or fixing the missing dependency usually resolves it.'));
      }
      if (rowsSnapshot.disabled.length > 0) {
        add(makeFinding('info', 'ROWS_DISABLED',
          `${rowsSnapshot.disabled.length} of ${rowsSnapshot.total} Loader rows are disabled`,
          'Disabled rows are expected for opt-in features. They matter only when a configured provider, command or service points at one of them.',
          { count: rowsSnapshot.disabled.length, examples: rowsSnapshot.disabled.slice(0, 12) }));
      }
      if (rowsSnapshot.notActive.length === 0 && rowsSnapshot.disabled.length === 0) {
        add(makeFinding('info', 'ROWS_ALL_ACTIVE', `${rowsSnapshot.active}/${rowsSnapshot.total} Loader rows are active`,
          'Every enabled row reached the active fiber phase.'));
      }
    }
  }

  // --- 4. Tool registry health ---
  // NOTE: tools.definitions() returns the *resolved* visible set (a Map keyed by
  // name), so duplicate names cannot appear there — counting them was a no-op.
  // Instead report real signals: visibility, reserved-name safety, schema caps.
  const tools = service(ctx, 'tools');
  const toolSnapshot = { count: 0, names: [], truncated: false };
  let defs = null;
  let toolsError;
  if (tools && typeof tools.definitions === 'function') {
    try {
      const value = tools.definitions();
      if (Array.isArray(value)) defs = value;
    } catch (error) {
      toolsError = String(error?.message ?? error);
    }
  }
  if (group('tools', defs !== null)) {
    if (toolsError) {
      add(makeFinding('warning', 'TOOL_SCAN_FAILED', 'Could not enumerate live tools', toolsError));
    } else {
      const names = defs.map((d) => String(d?.name ?? '')).filter(Boolean).sort();
      const cap = Math.max(0, Math.min(200, maxTools));
      toolSnapshot.count = names.length;
      toolSnapshot.names = names.slice(0, cap);
      toolSnapshot.truncated = names.length > cap;
      const withOutput = defs.filter((d) => d?.output && typeof d.output.render === 'function').length;
      const withoutOutput = names.length - withOutput;
      if (withoutOutput > 0) {
        add(makeFinding('warning', 'TOOLS_WITHOUT_OUTPUT',
          `${withoutOutput} registered tool(s) declare no output renderer`,
          'ToolsService.register() requires output { schema, render }. Definitions without one may be scoped-only views or an incomplete registration.',
          { count: withoutOutput }));
      }
      add(makeFinding('info', 'TOOL_REGISTRY_OK',
        `${names.length} tools are visible in the global scope`,
        `The live resolved registry was read successfully${toolSnapshot.truncated ? ` (listing capped at ${cap})` : ''}. Scoped shadowing is resolved by the registry itself, so duplicate visible names are not possible.`,
        { count: names.length, withOutput, listed: toolSnapshot.names.length }));
    }
  }

  // --- 5. Declared-vs-live services ---
  if (group('services', true)) {
    const missing = EXPECTED_SERVICES.filter((key) => service(ctx, key) === undefined);
    if (missing.length > 0) {
      add(makeFinding('warning', 'SERVICES_MISSING', `${missing.length} expected services are not mounted`,
        'These are optional seams; their absence is only a fault if another enabled row injects them.',
        { missing }));
    } else {
      add(makeFinding('info', 'SERVICES_OK', `${EXPECTED_SERVICES.length} core services are live`,
        EXPECTED_SERVICES.join(' / ') + ' all resolve through ctx.get().'));
    }
  }

  // `ok` must not be true when checks could not run: an unreadable registry is
  // not a clean bill of health.
  const ok = summary.errors === 0 && !incomplete;
  return {
    ok,
    complete: !incomplete,
    focus,
    generatedAt: new Date().toISOString(),
    version: '0.2.0',
    summary,
    completeness,
    findings,
    snapshot: {
      providers: providerSnapshot,
      bundles: bundleSnapshot,
      rows: rowsSnapshot,
      tools: toolSnapshot,
    },
    note: 'Read-only live inspection. No files, no network, no config changes. Findings are observations, not a security verdict.',
  };
}

/** Validate and normalize tool arguments. Throws on an invalid focus. */
export function normalizeOptions(args = {}) {
  const focus = typeof args.focus === 'string' ? args.focus : 'all';
  if (!FOCI.includes(focus)) {
    throw new Error(`invalid focus "${focus}"; expected one of: ${FOCI.join(', ')}`);
  }
  const rawMax = Number(args.maxTools);
  const maxTools = Number.isFinite(rawMax) && args.maxTools !== undefined
    ? Math.max(0, Math.min(200, Math.floor(rawMax)))
    : 40;
  return { focus, maxTools };
}

export function renderText(report) {
  const lines = [];
  const status = report.ok ? 'OK' : `${report.summary.errors} error(s)`;
  lines.push(`Runtime reconcile — ${status}, ${report.summary.warnings} warning(s), ${report.summary.info} info`);
  lines.push(`focus=${report.focus}  complete=${report.complete}  generatedAt=${report.generatedAt}`);
  lines.push('');
  const s = report.snapshot;
  for (const kind of ['search', 'fetch']) {
    const p = s.providers[kind];
    if (!p) continue;
    const label = kind === 'search' ? 'web.search' : 'web.fetch ';
    lines.push(`${label}: configured=${p.configured ?? '(none)'} registered=[${p.registered.join(', ') || 'none'}]`
      + (p.unavailable?.length ? ` unavailable=[${p.unavailable.join(', ')}]` : ''));
  }
  lines.push(`bundles: ${s.bundles.enabled}/${s.bundles.total} enabled; disabled=[${s.bundles.disabled.join(', ') || 'none'}]`);
  lines.push(`loader rows: ${s.rows.active}/${s.rows.total} active; ${s.rows.disabled.length} disabled; ${s.rows.notActive.length} enabled-but-not-active`);
  lines.push(`tools: ${s.tools.count} visible${s.tools.truncated ? ' (listing capped)' : ''}`);
  if (report.completeness.unavailable.length > 0) {
    lines.push(`unavailable checks: ${report.completeness.unavailable.join(', ')} — report is incomplete, ok is false`);
  }
  lines.push('');
  if (report.findings.length === 0) {
    lines.push('No findings.');
  } else {
    for (const f of report.findings) {
      lines.push(`[${f.severity.toUpperCase()}] ${f.code} — ${f.title}`);
      lines.push(`  ${f.detail}`);
      if (f.evidence !== undefined) lines.push(`  evidence: ${JSON.stringify(f.evidence)}`);
      if (f.remedy) lines.push(`  remedy: ${f.remedy}`);
    }
  }
  lines.push('');
  lines.push(report.note);
  return lines.join('\n');
}
