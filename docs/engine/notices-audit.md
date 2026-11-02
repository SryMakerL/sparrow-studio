# Web dependency notices

Verified local-fork update (2026-10-30): `node web/scripts/generate-notices.mjs` and `node web/scripts/generate-notices.mjs --check` both passed against the locked dependencies with `threads`. The inventory contains 43 production npm packages, 133 resolved Rust packages, and 132 distinct full license texts. An independent extraction check verified all 132 embedded SHA-256 hashes and every index reference, and found no absolute workstation source paths. The three public notice files total 3,492,406 bytes. These are current results; the historical counts below describe only the earlier audit.

## Historical artifacts (2026-09-05; not reverified for the local forks)

- `web/public/THIRD_PARTY_NOTICES.txt` contains 12 production npm packages, 111 resolved Rust packages, and 81 distinct full license texts. Texts are indexed by package and deduplicated by SHA-256, preserving original copyright and attribution text.
- `web/public/RUST-LIBRARY-stable.html` and `web/public/RUST-LIBRARY-nightly-2026-08-30.html` reproduce the installed toolchains' standard-library notices byte for byte. The main notice records their hashes and compiler commits. These cover stable 1.97.0 and nightly 1.100.0 from 2026-08-30 respectively.
- `web/scripts/license-sources/` stores the missing upstream license files with their exact URLs and hashes. The Rust package VCS metadata provides their revision pins. This makes regeneration independent of GitHub availability.
- Dataset attribution remains in `web/public/examples/NOTICE.txt`.

The Rust inventory deliberately includes a superset, including build and procedural macro dependencies. It does not claim that every entry contributes bytes to every Wasm output. Development npm tools are excluded. Rust standard-library dependencies are covered separately by the toolchain notices. The three public notice files total 2,157,557 bytes; they are static documentation, not initial application imports.

## Regeneration and verification

After installing the locked npm dependencies and the build's Rust toolchains:

```sh
node web/scripts/generate-notices.mjs
node web/scripts/generate-notices.mjs --check
```

The generator runs locked Cargo metadata in a temporary directory with inherited Rust flags cleared, so it does not pick up the original wrapper's ancestor Cargo configuration. It checks installed npm versions against the lockfile, requires license text for every inventoried package, and verifies the pinned fallback license hashes. `--check` fails if any generated public file differs from the installed dependency/toolchain evidence. `cargo metadata --locked` does not build, but may access registries or fetch dependencies if they are missing locally. The generator also validates each registered path dependency's name, version, and manifest directory; unregistered local dependencies fail rather than silently receiving an upstream source attribution. Local fork entries use repository-relative paths and upstream baseline references, not absolute workstation paths.

During the historical audit, both commands passed. An independent extraction check recomputed all 81 embedded text hashes and matched every index reference. Regeneration was byte-for-byte stable. No manifests, locks, application components, or build scripts were changed for this audit. Vite copies `public/` into builds; the next application build still needs to verify these files are present in `dist/` and reachable through the app's notices link.

## Exact upstream gaps and source availability

The published crate archives for `defmt-parser`, `geo`, `rstar`, and `jagua-rs` omit their workspace license files. Their complete texts were retrieved from the exact commits recorded in each archive's `.cargo_vcs_info.json`, not from a moving default branch. `splaytree` includes the full MIT text in its distributed README, which the generator extracts directly.

`wasm_sync` 0.1.2 declares `MIT OR Apache-2.0` in Cargo metadata but has no license file in its archive or its recorded upstream commit `cc027b3b27c2e24e3cd5c7a6cc63306eff724af5`. Its entry discloses this and includes the canonical Apache-2.0 text from apache.org. No package-specific copyright statement was invented. This is an upstream packaging gap, not evidence of a different license.

The pinned solver `sparrow` has a full MIT LICENSE even though its Cargo license field is absent. `jagua-rs` is MPL-2.0. The original `sparroWASM` wrapper's MPL license is a separate artifact and was not substituted for the solver's license.

During the historical audit, both the exact jagua-rs source tree and the published 0.8.1 crate download returned HTTP 200. Those checks do not establish source availability for the current local fork. The application repository and deployed About link were also inspected then; publication of the new fork has not been verified.

## Interior label dependency

The preparation label worker adds exact `polylabel` 2.1.0 and locked `tinyqueue` 3.0.0, both ISC. The upstream API and installed source were inspected before use. This provides the requested pole-of-inaccessibility labels without maintaining a second polygon search implementation. Both full license texts are included in the regenerated notices. `npm install` reported no known vulnerabilities.

## Current local forks and distribution source

- `vendor/sparrow` is a local fork of upstream revision `7f0e10f946f70a86138d3938548a13ee46464f39` (package version `0.2.0`). Its existing `LICENSE` contains the full MIT text and upstream copyright. Preserve that notice when distributing copies or substantial portions.
- `vendor/jagua-rs` is a modified local fork based on published `0.8.3`, whose upstream VCS baseline is `a15ddd4909c5bd4d619c1878342c7b71ab27ac4a`. Its `LICENSE` is the complete MPL-2.0 text from `web/scripts/license-sources/jagua-rs-0.8.3-LICENSE.txt`; it is not a claim that the fork is an unmodified registry crate.
- `PATH_DEPENDENCIES` in `web/scripts/generate-notices.mjs` explicitly maps these package names to repository-relative vendor paths, expected package versions, baseline references, and licenses. The baseline identifies provenance, not the complete modified source. Cargo manifest/lock changes are outside this notices update; regenerate only after the build actually resolves the intended local forks.

The modified source is kept in the repository's vendor directories rather than duplicated into `web/public/`. No release, source ZIP, or public upload was produced by this update. The generated public notices were refreshed and their byte-for-byte `--check` passed with both local forks resolved.

The maintained generator uses Node.js built-ins without additional npm dependencies; `generate-notices.py` is only a compatibility launcher for it. Python, `py`, and `uv` are unavailable on this machine, so the native Node entry point was used. Missing locked web dependencies were installed with `npm ci --ignore-scripts --no-audit --no-fund` before generation. The current standard-library notices were copied byte for byte from installed stable 1.99.1 (`58cf8f9c3`) and nightly 1.100.0 (`fd7ed57df`, toolchain `nightly-2026-08-30`); the public notice records their full compiler identities and hashes.

A byte check confirmed that `vendor/jagua-rs/LICENSE` and its fallback source file are identical. Their raw Windows checkout SHA-256 is `2684de17300e0a434686f1ec7f8af6045207a4b457a3fe04b2b9ce655e7c5d50`; normalizing CRLF to LF yields the unchanged pinned `sources.json` hash `1f256ecad192880510e84ad60474eab7589218784b9a50bc7ceee34c2b91f1d5`. The generator normalizes license text to LF before verifying fixed provenance hashes and deduplicating texts, allowing Git checkout line-ending conversion without accepting content changes. Rust standard-library HTML remains an exact binary copy, without normalization.

For a distribution containing MPL-covered executable code (including WASM), make the corresponding modified MPL-covered source available under MPL-2.0, preserve its notices, include the license, and tell recipients how to obtain that source by reasonable means in a timely manner (MPL sections 3.1, 3.2, and 3.4). Publish the matching release revision with `vendor/jagua-rs` and any other modified MPL-covered files, or supply a corresponding source archive. An unmodified upstream crate download is insufficient for the local fork. Verify that the actual distribution's source link reaches that exact modified source; a repository URL or About link alone does not prove that unpublished changes are available. Keep MIT attribution for Sparrow alongside these separate MPL obligations.


## DXF library migration

The browser now uses `dxf` 5.3.1 for import parsing, spline evaluation, and export verification. Direct module imports avoid pulling the package's unused rendering helpers into the geometry worker. `dxf-parser` and its `loglevel` dependency were removed. Notices inventory all locked production npm packages, including `dxf`'s transitive dependencies.

`vecks` 3.9.2 declares MIT but ships no license file; upstream tag `3.9.2` also contains none. Its npm `gitHead` does not resolve through the upstream GitHub API. The notice records this packaging gap and includes the canonical SPDX MIT template without inventing copyright attribution. The bundled `dxf` spline evaluator's original copyright statement is retained in its notice entry.

SVG importer migration: replaced npm svgpath with usvg 0.48.1 (default features disabled: no font loading, text conversion or SVGZ). Regenerated notices for the locked Rust dependency graph. Image resolvers are disabled; imported resources remain local.
