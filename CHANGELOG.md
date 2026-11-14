# Changelog

## 0.2.1

Discoverability and metadata only — no behavior changes, no new permissions, still zero I/O.

- Package metadata: `displayName`, `icon`, expanded `keywords` (npm search), `homepage`.
- README (EN/ZH): npm/version/download badges, a 30-second quick-start, and a one-command install up top.
- GitHub repository: shorter searchable `description`, npm `homepage`, and expanded `topics` for ecosystem discovery.
- Runtime-reported version in `core.js` synced to 0.2.1.

## 0.2.0

Diagnosis quality and engineering hardening. No new permissions, no new dependencies, still zero I/O.

- **Root-cause correlation**: a missing web provider is now linked to the installed-but-disabled bundle that likely provides it. That bundle's finding is promoted from `info` to `warning` and marked `linkedToProviderError`.
- **Actionable remedies**: error and warning findings carry a `remedy` string (e.g. `Enable bundle "@liustack/modsearch" (or set web.searchProvider to …)`), rendered in the text report.
- **Three-state provider selection**: besides "not registered", the check now detects a configured provider that is registered but `available()` returns false (`WEB_PROVIDER_CONFIGURED_UNAVAILABLE`), and reports which registered providers are unavailable.
- **Enabled-but-not-active rows**: `rows` now flags enabled Loader rows whose fiber never reached `active` — the class of silent failure static scanners cannot see — instead of only counting disabled rows.
- **Removed a no-op check**: `tools.definitions()` returns the already-resolved visible set (a Map keyed by name), so duplicate visible names are impossible. The old duplicate-name detection could never fire. Replaced with real signals: visible count, tools declaring no `output` renderer, and listing cap.
- **Honest `ok`**: a check group that could not run (missing service, throwing enumeration) now sets `complete: false` and forces `ok: false`. Previously an unreadable registry could still produce a clean bill of health.
- **Input validation**: an invalid `focus` is rejected instead of silently producing an empty "OK" report; `maxTools` is clamped 0–200.
- **Report metadata**: adds `complete`, `completeness.checked/unavailable`, `version`, and healthy-path findings (`*_PROVIDER_OK`, `BUNDLES_ALL_ENABLED`, `ROWS_ALL_ACTIVE`).
- **Structure**: pure inspection logic moved to `core.js` (exported as `./core`, unit-testable). `index.js` now only wires the tool. Added `test/selftest.mjs` (14 checks) and `npm test`.
- Corrected a latent syntax error in the 0.1.0 source path (`ROWS_ALL_ACTIVE` template literal) that the new module split surfaced; 0.1.0's shipped `index.js` was valid.

## 0.1.0

Initial release: read-only `reconcile_runtime` tool with five live check groups (providers / bundles / rows / tools / services).
