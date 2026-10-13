# OpenFork — OpenCode V2 migration

This branch tracks OpenCode V2 `dev` and ports the fork's built-in Google Antigravity integration from V1. The production `main` branch remains V1 until V2 is validated and approved.

## What was migrated

- Built-in Google AI Pro / Antigravity OAuth using the V2 `IntegrationOAuthMethodRegistration` and `Credential.OAuth` APIs.
- OAuth refresh, Cloud Code Assist project discovery, and account metadata.
- Native V2 Gemini HTTP request rewriting to the Antigravity `v1internal` endpoint, including SSE/JSON response-envelope unwrapping.
- Gemini model filtering, free-cost presentation for the authenticated connection, and stable per-session identity.
- `openfork` npm CLI command alias, alongside the upstream `opencode` aliases.
- Fork-specific GitHub CI and a guarded daily V2 upstream sync that typechecks and tests before pushing.

## Login and usage

Once running the V2 CLI, use `openfork auth login` (or `opencode auth login`) and select **Google** then **Google AI Pro / Antigravity (browser)**. Complete the browser OAuth flow. V2 stores credentials in its new credential store; **re-authenticate** after upgrading, rather than assuming a V1 auth file will migrate automatically.

The Antigravity connection supports Gemini native generate-content requests; Google Interactions and non-Gemini media paths remain disabled for this OAuth method. Google API-key connections are not modified.

## Validation and release gate

Run:

```sh
bun install --frozen-lockfile
bun --cwd packages/core typecheck
bun --cwd packages/cli typecheck
cd packages/core && bun test test/plugin/google-antigravity.test.ts
```

The OpenFork V2 CI workflow executes these checks for changes and upstream syncs. Tests mock requests and cannot prove Google's remote OAuth entitlement or a live streaming completion. Before replacing the V1 default branch, verify one real browser login, one streaming Gemini completion, and a native CLI release build. Do not merge the large V2 branch into the V1 default branch blindly: its directory layout and dependency graph are intentionally different.

## Upstream workflow policy

The fork keeps only `.github/workflows/fork-ci.yml` and `.github/workflows/sync-upstream.yml`. Upstream-only publish/deploy workflows are intentionally removed. Automatic sync fails without pushing if non-workflow merge conflicts, type errors, or the Antigravity tests fail.
