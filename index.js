/**
 * dsh-runtime-reconcile — Host-only, read-only, zero-dependency.
 *
 * Why zero dependencies: the profile uses a hoisted pnpm layout. Importing a
 * @deepseek-ai/* runtime package from a third-party bundle can hoist a second
 * copy to the profile root and shadow the host's copy (Symbol identity is
 * per-module-instance), which breaks every tool call in the profile. See
 * deepseek-harness discussion #1697. So this plugin never imports a runtime
 * package; it reads the live services through ctx.get() instead.
 *
 * The point of this plugin is that static source scanners cannot see these
 * failures. All five checks read the *live* runtime: the composed config, the
 * registered provider maps, the active Loader rows, the enabled bundle list
 * and the visible tool registry.
 */

const EMPTY_SCHEMA = Object.freeze({ type: 'object', properties: {}, additionalProperties: false });

/** Read a service defensively; a missing service is reported, never thrown. */
function service(ctx, key) {
  try {
    return ctx.get(key);
  } catch {
    return undefined;
  }
}

/** Pull the configured provider id out of a z.string().volatile() field. */
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

function idsOf(map) {
  const out = [];
  if (map && typeof map.keys === 'function') {
    for (const id of map.keys()) out.push(String(id));
  }
  return out.sort();
}

function makeFinding(severity, code, title, detail, evidence) {
  return { severity, code, title, detail, ...(evidence !== undefined ? { evidence } : {}) };
}

/**
 * Live report. `focus` narrows the output without changing what is inspected;
 * `maxTools` caps the occupancy listing so a 228-row profile stays readable.
 */
async function collect(ctx, { focus = 'all', maxTools = 40 } = {}) {
  const findings = [];
  const summary = { errors: 0, warnings: 0, info: 0 };
  const add = (f) => {
    if (!f) return;
    findings.push(f);
    if (f.severity === 'error') summary.errors += 1;
    else if (f.severity === 'warning') summary.warnings += 1;
    else summary.info += 1;
  };
  const want = (group) => focus === 'all' || focus === group;

  // --- 1. Configured web provider that is not registered (the live failure) ---
  // This is the check that catches "web_search: configured web provider
  // \"modsearch\" is not registered". resolveProvider() throws that exact error
  // only when a configured id is absent from the registered provider map.
  const webGroup = 'providers';
  const web = service(ctx, 'web');
  const providerSnapshot = { search: null, fetch: null };
  if (want(webGroup)) {
    if (!web) {
      add(makeFinding('warning', 'WEB_SEAM_MISSING', 'Web capability seam is not mounted',
        'ctx.web is unavailable, so no live provider check could run.'));
    } else {
      for (const [kind, configKey, mapKey, envKey] of [
        ['search', 'searchProvider', 'searchProviders', 'DSH_WEB_SEARCH_PROVIDER'],
        ['fetch', 'fetchProvider', 'fetchProviders', 'DSH_WEB_FETCH_PROVIDER'],
      ]) {
        const configured = configuredId(web.config?.[configKey]) ?? process.env[envKey];
        const registered = idsOf(web[mapKey]);
        providerSnapshot[kind] = { configured: configured ?? null, registered };
        if (configured && !registered.includes(configured)) {
          add(makeFinding('error', `WEB_${kind.toUpperCase()}_PROVIDER_MISSING`,
            `Configured ${kind} provider "${configured}" is not registered`,
            `ctx.web.${configKey} points at "${configured}", but the live ${kind} provider registry contains [${registered.join(', ') || 'none'}]. Every ${kind} call will fail until the provider is enabled or the config points at a registered one.`,
            {
              configuredFrom: process.env[envKey] ? envKey : `web.${configKey}`,
              configured,
              registered,
              available: registered,
            }));
        } else if (!configured) {
          const usable = registered.length;
          if (usable === 0) {
            add(makeFinding('error', `WEB_${kind.toUpperCase()}_NO_PROVIDER`,
              `No ${kind} provider configured and none registered`,
              `No ${mapKey} entries exist; ${kind} calls cannot resolve a provider.`));
          } else if (usable > 1) {
            add(makeFinding('warning', `WEB_${kind.toUpperCase()}_AMBIGUOUS`,
              `${registered.length} ${kind} providers registered with no selection`,
              'Without an explicit config, resolveProvider() rejects with WEB_PROVIDER_AMBIGUOUS.',
              { registered }));
          }
        }
      }
    }
  }

  // --- 2. Disabled installed bundles (declared but not live) ---
  const bundlesGroup = 'bundles';
  const pm = service(ctx, 'pluginManager');
  const bundleSnapshot = { total: 0, enabled: 0, disabled: [] };
  if (want(bundlesGroup)) {
    if (!pm || typeof pm.listBundles !== 'function') {
      add(makeFinding('warning', 'PLUGIN_MANAGER_MISSING', 'Plugin manager is not available',
        'Cannot enumerate installed bundles.'));
    } else {
      try {
        const bundles = await pm.listBundles();
        if (Array.isArray(bundles)) {
          bundleSnapshot.total = bundles.length;
          for (const b of bundles) {
            if (b?.enabled === true) bundleSnapshot.enabled += 1;
            else if (b?.enabled === false) bundleSnapshot.disabled.push(String(b.name ?? b.id ?? '?'));
          }
          for (const name of bundleSnapshot.disabled) {
            add(makeFinding('info', 'BUNDLE_DISABLED', `Bundle "${name}" is installed but disabled`,
              'Its rows are inserted into the composition but never mounted. Any config that points at a capability it provides (see provider checks) will fail at runtime.',
              { bundle: name }));
          }
        }
      } catch (error) {
        add(makeFinding('warning', 'BUNDLE_LIST_FAILED', 'Could not enumerate installed bundles',
          String(error?.message ?? error)));
      }
    }
  }

  // --- 3. Live Loader rows: enabled / inactive / missing config targets ---
  const rowsGroup = 'rows';
  const rowsSnapshot = { total: 0, active: 0, inactive: [] };
  if (want(rowsGroup)) {
    if (!pm || typeof pm.listPlugins !== 'function') {
      add(makeFinding('warning', 'PLUGIN_LIST_MISSING', 'Plugin row inventory is not available',
        'Cannot enumerate live Loader rows.'));
    } else {
      try {
        const rows = await pm.listPlugins();
        if (Array.isArray(rows)) {
          rowsSnapshot.total = rows.length;
          for (const row of rows) {
            if (row?.enabled === true && row?.fiberPhase === 'active') rowsSnapshot.active += 1;
            else if (row?.enabled === false) {
              rowsSnapshot.inactive.push(String(row.moduleName ?? row.entryId ?? '?'));
            }
          }
          // Report the count, not every row: a disabled row is a normal opt-in,
          // not a fault. The value is cross-referencing it with findings above.
          if (rowsSnapshot.inactive.length > 0) {
            add(makeFinding('info', 'ROWS_DISABLED',
              `${rowsSnapshot.inactive.length} of ${rowsSnapshot.total} Loader rows are disabled`,
              'Disabled rows are expected for opt-in features. They matter only when a configured provider, command or service points at one of them.',
              { count: rowsSnapshot.inactive.length, examples: rowsSnapshot.inactive.slice(0, 12) }));
          }
        }
      } catch (error) {
        add(makeFinding('warning', 'PLUGIN_LIST_FAILED', 'Could not enumerate Loader rows',
          String(error?.message ?? error)));
      }
    }
  }

  // --- 4. Tool occupancy: what the model can actually call right now ---
  const toolsGroup = 'tools';
  const tools = service(ctx, 'tools');
  const toolSnapshot = { count: 0, duplicates: [], names: [] };
  if (want(toolsGroup)) {
    if (!tools || typeof tools.definitions !== 'function') {
      add(makeFinding('warning', 'TOOL_REGISTRY_MISSING', 'Tool registry is not available',
        'Cannot inspect live tool occupancy.'));
    } else {
      try {
        const defs = tools.definitions();
        const names = defs.map((d) => String(d?.name ?? '?')).filter(Boolean);
        toolSnapshot.count = names.length;
        toolSnapshot.names = names.slice(0, Math.max(0, Math.min(200, maxTools))).sort();
        const seen = new Map();
        for (const name of names) seen.set(name, (seen.get(name) ?? 0) + 1);
        for (const [name, count] of seen) if (count > 1) toolSnapshot.duplicates.push({ name, count });
        if (toolSnapshot.duplicates.length > 0) {
          add(makeFinding('warning', 'TOOL_NAME_SHADOWED',
            `${toolSnapshot.duplicates.length} tool name(s) have multiple live registrations`,
            'Nearer scopes intentionally shadow farther ones. These are not necessarily faults, but they are the exact occupancy that static scanners cannot see.',
            { duplicates: toolSnapshot.duplicates.slice(0, 30) }));
        } else {
          add(makeFinding('info', 'TOOL_REGISTRY_OK', `${names.length} tools are visible with no duplicate names`,
            'The live visible registry resolves cleanly in the global scope.'));
        }
      } catch (error) {
        add(makeFinding('warning', 'TOOL_SCAN_FAILED', 'Could not enumerate live tools',
          String(error?.message ?? error)));
      }
    }
  }

  // --- 5. Declared-vs-live services ---
  const servicesGroup = 'services';
  if (want(servicesGroup)) {
    const expected = ['tools', 'web', 'pluginManager', 'configEditor', 'commands', 'systemPrompt', 'sessionProjections'];
    const missing = expected.filter((key) => service(ctx, key) === undefined);
    if (missing.length > 0) {
      add(makeFinding('warning', 'SERVICES_MISSING', `${missing.length} expected services are not mounted`,
        'These are optional seams; their absence is only a fault if another enabled row injects them.',
        { missing }));
    } else {
      add(makeFinding('info', 'SERVICES_OK', `${expected.length} core services are live`,
        'tools / web / pluginManager / configEditor / commands / systemPrompt / sessionProjections all resolve through ctx.get().'));
    }
  }

  return {
    ok: summary.errors === 0,
    focus,
    generatedAt: new Date().toISOString(),
    summary,
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

function renderText(report) {
  const lines = [];
  lines.push(`Runtime reconcile — ${report.ok ? 'OK' : `${report.summary.errors} error(s)`}, ${report.summary.warnings} warning(s), ${report.summary.info} info`);
  lines.push(`focus=${report.focus}  generatedAt=${report.generatedAt}`);
  lines.push('');
  const s = report.snapshot;
  if (s.providers.search) {
    lines.push(`web.search: configured=${s.providers.search.configured ?? '(none)'} registered=[${s.providers.search.registered.join(', ') || 'none'}]`);
  }
  if (s.providers.fetch) {
    lines.push(`web.fetch:  configured=${s.providers.fetch.configured ?? '(none)'} registered=[${s.providers.fetch.registered.join(', ') || 'none'}]`);
  }
  lines.push(`bundles: ${s.bundles.enabled}/${s.bundles.total} enabled; disabled=[${s.bundles.disabled.join(', ') || 'none'}]`);
  lines.push(`loader rows: ${s.rows.active}/${s.rows.total} active; ${s.rows.inactive.length} disabled`);
  lines.push(`tools: ${s.tools.count} visible; ${s.tools.duplicates.length} shadowed names`);
  lines.push('');
  if (report.findings.length === 0) {
    lines.push('No findings.');
  } else {
    for (const f of report.findings) {
      lines.push(`[${f.severity.toUpperCase()}] ${f.code} — ${f.title}`);
      lines.push(`  ${f.detail}`);
      if (f.evidence !== undefined) lines.push(`  evidence: ${JSON.stringify(f.evidence)}`);
    }
  }
  lines.push('');
  lines.push(report.note);
  return lines.join('\n');
}

/** A ToolDefinition, built as a plain object (no defineTool import). */
function reconcileTool(ctx) {
  return {
    // Namespaced on purpose: generic names collide across the ecosystem
    // (553 tool-name collisions measured in discussion #4253).
    name: 'reconcile_runtime',
    description:
      'Read-only live inspection of the running DeepSeek Harness profile. Reconciles what is configured against what is actually registered: configured-but-missing web providers (the cause of "configured web provider is not registered"), installed-but-disabled bundles, disabled Loader rows, duplicate/shadowed tool names, and missing core services. Makes no network calls and changes nothing. Use this when a tool fails mysteriously, after installing/enabling plugins, or to check profile health.',
    parameters: {
      type: 'object',
      properties: {
        focus: {
          type: 'string',
          enum: ['all', 'providers', 'bundles', 'rows', 'tools', 'services'],
          description: 'Which check group to run. Default "all". Use "providers" for the fast web-provider diagnosis.',
        },
        maxTools: {
          type: 'number',
          description: 'Cap on tool names listed in the snapshot (default 40, max 200). Does not limit the checks.',
        },
      },
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean' },
          focus: { type: 'string' },
          generatedAt: { type: 'string' },
          summary: {
            type: 'object',
            additionalProperties: false,
            properties: {
              errors: { type: 'number' },
              warnings: { type: 'number' },
              info: { type: 'number' },
            },
          },
          findings: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: true,
              properties: {
                severity: { type: 'string' },
                code: { type: 'string' },
                title: { type: 'string' },
                detail: { type: 'string' },
              },
            },
          },
          snapshot: { type: 'object', additionalProperties: true },
          note: { type: 'string' },
        },
      },
      render(_args, value) {
        return [{ type: 'text', text: renderText(value) }];
      },
    },
    async execute(args = {}) {
      const focus = typeof args.focus === 'string' ? args.focus : 'all';
      const rawMax = Number(args.maxTools);
      const maxTools = Number.isFinite(rawMax) ? Math.max(0, Math.min(200, Math.floor(rawMax))) : 40;
      return collect(ctx, { focus, maxTools });
    },
  };
}

export function apply(ctx) {
  // Register only when the tool seam is present; the plugin itself still mounts
  // without it, so the missing-service check stays meaningful and boot is safe.
  ctx.inject(['tools'], (scoped) => {
    const tools = service(scoped, 'tools') ?? service(ctx, 'tools');
    if (!tools || typeof tools.register !== 'function') return;
    const dispose = tools.register(reconcileTool(ctx));
    scoped.effect(() => dispose);
  });
}
