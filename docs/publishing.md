# Release, OIDC Publishing, and SLSA Level 3 Verification

ZeroProxy distributes its ECMAScript Module (ESM) SDK and prebuilt WebAssembly runtime as `@gosuda/zeroproxy` on npm and as signed release archives on GitHub Releases. Every release artifact carries a **SLSA v1.0 Build Level 3** provenance attestation signed inside an isolated reusable workflow ([`.github/workflows/slsa-wasm-builder.yml`](../.github/workflows/slsa-wasm-builder.yml)).

## 1. Package Naming Note (`@gosuda/zeroproxy` vs `zeroproxy`)

The unscoped name `zeroproxy` collides with the existing `zero-proxy` package on the npm registry under npm's punctuation-folded moniker similarity rules (`zero-proxy` normalizes to `zeroproxy`, triggering `403 Package name too similar to existing packages`). Scoping the package as `@gosuda/zeroproxy` (`--access public`) avoids moniker conflicts and matches the Go module namespace (`github.com/gosuda/zeroproxy`).

## 2. One-Time npm OIDC Trusted Publisher Setup

npm requires a package entry to exist on `npmjs.com` before linking a GitHub Actions OIDC Trusted Publisher.

> [!IMPORTANT]
> Do not store a permanent `NPM_TOKEN` secret in GitHub repository settings. After the one-time initial bootstrap publish, configure OIDC Trusted Publishing on `npmjs.com` and revoke any local session token.

1. Create the `@gosuda` organization on `npmjs.com` if it does not exist yet.
2. Run a one-time bootstrap publish from a maintainer workstation (or a downloaded `release-bundle` artifact from a `workflow_dispatch` dry-run). Pass `--provenance=false` because `publishConfig.provenance` is enabled for CI OIDC releases and local workstations do not have an OIDC identity:
   ```sh
   npm run build:pkg
   npm login
   npm publish --access public --provenance=false
   ```
3. Open `https://www.npmjs.com/package/@gosuda/zeroproxy/access` and configure **Trusted Publisher** (GitHub Actions) with these exact values:

| Field | Value |
| :--- | :--- |
| **Organization or user** | `gosuda` |
| **Repository** | `zeroproxy` |
| **Workflow filename** | `release.yml` |
| **Environment name** | `npm-publish` |

4. In GitHub repository settings (`Settings` > `Environments`), create the `npm-publish` environment (optionally enabling required reviewers or tag deployment branch rules matching `v*`).

## 3. Cutting a Signed SLSA Level 3 Release

Tagging a version triggers [`.github/workflows/release.yml`](../.github/workflows/release.yml), which delegates compilation and signing to the isolated reusable builder workflow, runs the Chromium E2E and ESM contract suites on a clean runner, publishes to npm via OIDC, and uploads GitHub Release archives.

1. Update `"version"` in [`package.json`](../package.json) and `[workspace.package]` in [`Cargo.toml`](../Cargo.toml), then commit to `main`.
2. Push an annotated version tag:
   ```sh
   git tag -a v0.1.0 -m "Release v0.1.0"
   git push origin v0.1.0
   ```

## 4. Consumer Verification Commands

Downstream consumers can verify both the npm registry provenance and the standalone WebAssembly release archives without third-party key servers.

| Artifact | Verification Command |
| :--- | :--- |
| **npm package (`@gosuda/zeroproxy`)** | `npm audit signatures` |
| **Prebuilt WASM + ESM archive** | `gh attestation verify zeroproxy-wasm-0.1.0.tar.gz --repo gosuda/zeroproxy --signer-workflow gosuda/zeroproxy/.github/workflows/slsa-wasm-builder.yml` |
| **Prebuilt `dist/web` archive** | `gh attestation verify zeroproxy-web-0.1.0.tar.gz --repo gosuda/zeroproxy --signer-workflow gosuda/zeroproxy/.github/workflows/slsa-wasm-builder.yml` |
| **Individual `.wasm` binary** | `gh attestation verify zp-bundle.wasm --repo gosuda/zeroproxy --signer-workflow gosuda/zeroproxy/.github/workflows/slsa-wasm-builder.yml` |
| **Local contributor pull (Rust-free)** | `npm run wasm:pull -- --tag v0.1.0` |
