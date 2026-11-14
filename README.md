# dsh-runtime-reconcile

> A read-only agent tool that reconciles **what your DeepSeek Harness profile declares** against **what is actually registered in the live runtime**.

[![npm version](https://img.shields.io/npm/v/dsh-runtime-reconcile.svg)](https://www.npmjs.com/package/dsh-runtime-reconcile)
[![npm downloads](https://img.shields.io/npm/dm/dsh-runtime-reconcile.svg)](https://www.npmjs.com/package/dsh-runtime-reconcile)
[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)
[![dsh-plugin](https://img.shields.io/badge/dsh-plugin-2ea44f.svg)](https://github.com/topics/dsh-plugin)

English · [中文](README.zh.md)

**30-second start:** `dsh plugin --profile web add dsh-runtime-reconcile` → start a new session → ask your agent `reconcile_runtime`. It will tell you *why* a tool is failing and what to enable.

Static source scanners see a valid config. This tool sees the running process. It answers questions those scanners cannot:

- Why does `web_search` say *`configured web provider "modsearch" is not registered`* when the config looks fine?
- Which installed bundle is disabled but still referenced by an active config row?
- Which tool names are shadowed in the live registry right now?
- Which core services did this profile fail to mount?

It is **read-only**: no file writes, no network calls, no config changes, no runtime imports.

---

## The problem, concretely

DeepSeek Harness is "everything is a plugin". A profile composes dozens of bundles over ordered patch layers. A plugin row can be inserted, disabled, or overridden by a higher layer; a provider can be named in config while the bundle that registers it sits disabled. The composed config remains syntactically valid, so nothing complains at boot — the failure only appears when a tool call reaches provider selection:

```
configured web provider "modsearch" is not registered
```

`ctx.web` holds `config.searchProvider = 'modsearch'`, but its live `searchProviders` map contains only the providers whose bundles actually mounted. Source-level checks (`dsh-trust-check`, `dsh-plugin-preflight`, `dsh-conflict-doctor`, `dsh-doctor`, `dsh-plugin-ops`) inspect packages, manifests and patch files **before** or **outside** the running composition. They cannot see this drift, because the drift only exists after the Loader has applied every layer.

`dsh-runtime-reconcile` runs *inside* that composed process and reads the live services through `ctx.get()`.

### How it differs from adjacent tools

| Tool | Inspects | Sees live provider maps / Loader rows? |
|---|---|---|
| `dsh-trust-check`, `dsh-plugin-preflight` | package source / manifest | no (pre-install, static) |
| `dsh-conflict-doctor`, `dsh-plugin-conflict-guard` | declared capabilities | no (static / at install) |
| `dsh-doctor`, `dsh-plugin-ops` | profile files, boot logs | no (pre-boot / post-mortem) |
| `dsh-harbor` | declared vs detected ledger | partly (static reconciliation) |
| `dsh-vitals`, `dsh-system-vitals` | CPU / RAM / GPU | no (hardware, not the plugin graph) |
| **dsh-runtime-reconcile** | **live `ctx.web`, `ctx.tools`, `ctx.pluginManager`** | **yes** |

Ecosystem scale of the underlying problem is documented in [deepseek-harness discussion #4253](https://github.com/deepseek-ai/deepseek-harness/discussions/4253): across 9,873 real plugins, 553 tool-name collisions, 452 entry-id collisions and 89 orphan patches fail silently. This tool does not fix those — the fixes that matter belong upstream — but it makes the *current* profile's state observable to both the user and the agent.

---

## What it checks

| Group | Live source | Detects |
|---|---|---|
| `providers` | `ctx.web.config`, `searchProviders` / `fetchProviders` maps, `DSH_WEB_SEARCH_PROVIDER` / `DSH_WEB_FETCH_PROVIDER` | configured-but-unregistered, registered-but-unavailable, no provider, ambiguous providers |
| `bundles` | `pluginManager.listBundles()` | installed-but-disabled bundles, **correlated as the likely root cause** of a provider error |
| `rows` | `pluginManager.listPlugins()` | **enabled-but-not-active** Loader rows, disabled rows, active / total counts |
| `tools` | `tools.definitions()` | visible tool count, tools without an `output` renderer, listing cap |
| `services` | `ctx.get()` on core seams | missing optional services |

Findings carry `severity`, `code`, `title`, `detail`, structured `evidence` and an actionable **`remedy`**. They are **observations, not a security verdict**.

A check group that cannot run (missing service, throwing enumeration) is recorded in `completeness.unavailable` and forces `ok: false` / `complete: false` — an unreadable registry is never reported as a clean bill of health. An invalid `focus` is rejected rather than silently yielding an empty OK report.

---

## Install

One command, no build step, zero dependencies, no network access at runtime:

```bash
dsh plugin --profile web add dsh-runtime-reconcile
```

GitHub source (pin a commit or tag):

```bash
dsh plugin --profile web add github:shuai0503/dsh-runtime-reconcile#v0.2.1
```

From npm (no build step, no dependencies):

```bash
dsh plugin --profile web add dsh-runtime-reconcile
```

Local development:

```bash
dsh plugin --profile web add file:/absolute/path/to/dsh-runtime-reconcile
```

Or via the Harness plugin manager / Web GUI: install the bundle directory. GitHub-sourced installs may require allowing a build — **this package has no build scripts and no dependencies**, so there is nothing to allow.

Then **start a new session** so the newly registered tool enters the model's tool set.

---

## Usage

Ask your agent, or call directly:

```
reconcile_runtime {}
reconcile_runtime { "focus": "providers" }
reconcile_runtime { "focus": "all", "maxTools": 200 }
```

`focus` narrows the output without skipping any safety-relevant inspection; `maxTools` caps the listed tool names (default 40, max 200), not the checks themselves.

### Example output

```
Runtime reconcile — 1 error(s), 1 warning(s), 4 info
focus=all  complete=true  generatedAt=2026-11-14T09:35:06.996Z

web.search: configured=modsearch registered=[deepseek-official, web-search-free]
web.fetch : configured=fs-quality-fetch registered=[fs-quality-fetch, http]
bundles: 3/4 enabled; disabled=[@liustack/modsearch]
loader rows: 200/202 active; 2 disabled; 0 enabled-but-not-active
tools: 5 visible

[ERROR] WEB_SEARCH_PROVIDER_MISSING — Configured search provider "modsearch" is not registered
  ctx.web.searchProvider points at "modsearch", but the live searchProviders
  registry contains [deepseek-official, web-search-free]. Every search call fails
  at provider selection. The bundle "@liustack/modsearch" is installed but
  disabled — that is the likely cause.
  evidence: {"configuredFrom":"web.searchProvider","configured":"modsearch",
             "registered":["deepseek-official","web-search-free"],
             "disabledBundle":"@liustack/modsearch"}
  remedy: Enable bundle "@liustack/modsearch" (or set web.searchProvider to one
          of: deepseek-official, web-search-free).
[WARNING] BUNDLE_DISABLED — Bundle "@liustack/modsearch" is installed but disabled
  This disabled bundle is the likely cause of a provider error above.
  evidence: {"bundle":"@liustack/modsearch","linkedToProviderError":true}
[INFO] WEB_FETCH_PROVIDER_OK — fetch provider "fs-quality-fetch" is configured and live
[INFO] ROWS_DISABLED — 2 of 202 Loader rows are disabled
[INFO] TOOL_REGISTRY_OK — 5 tools are visible in the global scope
[INFO] SERVICES_OK — 7 core services are live

Read-only live inspection. No files, no network, no config changes.
```

The error/bundle pair is the whole diagnosis, and the `remedy` line is the next action. This tool deliberately does **not** edit your `cordis.patch.yml`.

---

## Design constraints (why it looks unusual)

- **Zero runtime imports.** This package imports no `@deepseek-ai/*` module. Profiles use a hoisted pnpm layout: importing a runtime package from a third-party bundle can hoist a second copy to the profile root and shadow the host's copy. `Symbol` identity is per-module-instance, so the host then reads `undefined` and every tool call fails — see [discussion #1697](https://github.com/deepseek-ai/deepseek-harness/discussions/1697). Everything is reached through `ctx.get()` / `ctx.inject()` instead.
- **No row-level `inject`.** A declared injection that is unavailable would keep the row from activating entirely — the plugin would be silent exactly when it is most useful. The plugin always mounts, and registers its single tool only when the `tools` seam is present.
- **Namespaced row id.** `dsh-runtime-reconcile` avoids the generic ids (`storage`, `web`, …) that collide across hundreds of community bundles.
- **Host-only, no Client half.** The report renders in the conversation, so there is no slot registration, no theme dependency and no Web rebuild.
- **Plain `ToolDefinition` object.** No `defineTool()` import; the tool is registered with `ctx.tools.register()` using a plain JSON schema.

---

## Compatibility

| | |
|---|---|
| DeepSeek Harness | `>=0.2.1-rc.2 <0.4.0-0` (declared via `engines.dsh`) |
| Verified on | 0.2.2-rc.1 / 0.2.2-rc.2 (Web profile, Windows) |
| Node | no direct Node API used in shipped code |
| Profiles | web / desktop / any profile mounting the `tools` seam |
| Dependencies | **none** |
| Build scripts | **none** |
| Network calls | **none** |
| Writes | **none** |

If the `tools` seam is absent the plugin still mounts and the `services` check reports it; the tool simply is not registered.

---

## Development

```
npm test          # 14 pure-core checks, no Harness runtime needed
```

`core.js` holds all inspection logic and depends on nothing — `collect()` takes a context-like object, so `test/selftest.mjs` drives it with a faithful mock of the live services. `index.js` only wires the tool. This split keeps the diagnosis testable without booting a profile.

---

## Privacy and trust

The tool reads service objects already present in the Harness process. It does not read your files, inspect personal browser profiles, read credentials, contact any host, or transmit anything. Its entire output is a JSON report rendered into the current conversation. The one environment value it consults is `DSH_WEB_SEARCH_PROVIDER` / `DSH_WEB_FETCH_PROVIDER` (a provider id, not a secret) because the web seam itself honours those overrides.

---

## Limitations

- It **diagnoses, does not repair**. Fixing a misconfigured provider means editing the profile patch or enabling the bundle, which is a user decision.
- Checks are best-effort and defensive: a changed internal service shape degrades into a warning rather than a crash. If a future DSH renames `searchProviders`, the provider check reports the seam as unavailable instead of guessing.
- Duplicate visible tool names are **not** detected, by design: `tools.definitions()` is the already-resolved visible set (a Map keyed by name), so duplicates cannot appear. Scoped shadowing is resolved by the registry itself. Declaring otherwise would be a check that can never fire.
- The disabled-bundle correlation is heuristic string matching (package name ↔ provider id). It is a strong hint, not proof of ownership.
- Findings describe state at call time. Re-run after enabling/disabling bundles or changing config.

---

## Repository

Source: [github.com/shuai0503/dsh-runtime-reconcile](https://github.com/shuai0503/dsh-runtime-reconcile). Issues and pull requests are welcome.

The `v0.2.1` tag makes the GitHub install command above resolve. The package is also published to npm, so `dsh plugin --profile web add dsh-runtime-reconcile` works without a build step. See [CHANGELOG.md](CHANGELOG.md) for the 0.1.0 → 0.2.1 changes.

---

## License

MIT — see [LICENSE](LICENSE).

This is an independent community plugin, not affiliated with, endorsed by, or published by DeepSeek.
