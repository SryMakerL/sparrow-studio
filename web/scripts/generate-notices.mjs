#!/usr/bin/env node
/** Regenerate static notices from locked packages and pinned license sources. */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const WEB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SOURCES = path.join(WEB, 'scripts/license-sources');
const PUBLIC = path.join(WEB, 'public');
const REPOSITORY = path.dirname(WEB);
const PATH_DEPENDENCIES = {
  sparrow: {
    path: 'vendor/sparrow', version: '0.2.0', license: 'MIT',
    baseline: 'https://github.com/JeroenGar/sparrow/tree/7f0e10f946f70a86138d3938548a13ee46464f39',
  },
  'jagua-rs': {
    path: 'vendor/jagua-rs', version: '0.8.3', license: 'MPL-2.0',
    baseline: 'https://crates.io/api/v1/crates/jagua-rs/0.8.3/download',
  },
};
const check = process.argv.includes('--check');
const sha256 = content => createHash('sha256').update(content).digest('hex');
const text = filename => readFileSync(filename, 'utf8').replace(/\r\n/g, '\n');
const json = filename => JSON.parse(text(filename));
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
function output(filename, content) {
  const target = path.join(PUBLIC, filename);
  const bytes = Buffer.isBuffer(content) ? content : Buffer.from(content);
  if (check) {
    if (!existsSync(target) || !readFileSync(target).equals(bytes)) {
      throw new Error(`Stale notices: run node web/scripts/generate-notices.mjs (${filename})`);
    }
  } else {
    writeFileSync(target, bytes);
  }
}
function run(command, ...args) {
  return execFileSync(command, args, {
    cwd: tmpdir(), env: { ...process.env, CARGO_ENCODED_RUSTFLAGS: '' },
    encoding: 'utf8', maxBuffer: 32 * 1024 * 1024,
  }).replace(/\r\n/g, '\n');
}
function licenseDocs(root) {
  return readdirSync(root, { withFileTypes: true })
    .filter(p => p.isFile() && /^(licen[cs]e|copying|copyright|notice)(?:$|[-.])/i.test(p.name))
    .map(p => p.name).sort(compare).map(name => [name, text(path.join(root, name))]);
}
const texts = new Map();
const entries = [];
function entry(label, license, source, documents, extra = '') {
  if (!documents.length) throw new Error(`No license text found for ${label}`);
  const refs = documents.map(([origin, content]) => {
    if (!content.trim()) throw new Error(`Empty license: ${origin}`);
    const digest = sha256(content);
    texts.set(digest, content);
    return `  ${origin}\n  Text SHA-256: ${digest}`;
  });
  entries.push(`${label}\nDeclared license: ${license}\nSource: ${source}\n`
    + (extra ? extra + '\n' : '') + refs.join('\n'));
}
const fallbacks = json(path.join(SOURCES, 'sources.json'));
function fallbackDocs(name, version) {
  return fallbacks.filter(f => f.package === name && f.version === version).map(f => {
    // Git may convert checked-out text to CRLF; provenance hashes use canonical LF.
    const content = text(path.join(SOURCES, f.file));
    if (sha256(content) !== f.sha256) throw new Error(`License source hash mismatch: ${f.file}`);
    return [f.url, content];
  });
}
const lock = json(path.join(WEB, 'package-lock.json'));
let npmCount = 0;
for (const [relative, pkg] of Object.entries(lock.packages).sort(([a], [b]) => compare(a, b))) {
  if (!relative || pkg.dev) continue;
  const root = path.join(WEB, relative);
  const installed = json(path.join(root, 'package.json'));
  if (installed.version !== pkg.version) throw new Error(`Run npm ci: ${relative}`);
  const docs = [...licenseDocs(root), ...fallbackDocs(installed.name, installed.version)];
  if (installed.name === 'splaytree' && !docs.length) {
    docs.push(['Readme.md, License section', text(path.join(root, 'Readme.md')).split('## License\n')[1]]);
  }
  const repository = typeof installed.repository === 'object' ? installed.repository.url : installed.repository || '';
  let extra = `Repository: ${repository}\nIntegrity: ${pkg.integrity}`;
  if (installed.name === 'vecks') {
    extra += '\nThis package declares MIT but includes no license file, and none was found '
      + 'in upstream tag 3.9.2. The canonical SPDX MIT template is reproduced; '
      + 'its placeholders are not a package-specific copyright notice.';
  }
  if (installed.name === 'dxf') {
    extra += '\nBundled spline evaluator: Copyright (c) 2015 Thibaut Séguy <thibaut.seguy@gmail.com> (src/util/bSpline.js).';
  }
  entry(`npm ${installed.name} ${installed.version}`, installed.license, pkg.resolved, docs, extra);
  npmCount++;
}
const metadata = JSON.parse(run('cargo', '+stable', 'metadata', '--manifest-path',
  path.join(WEB, 'wasm/Cargo.toml'), '--locked', '--format-version', '1',
  '--filter-platform', 'wasm32-unknown-unknown', '--features', 'threads'));
const resolved = new Set(metadata.resolve.nodes.map(node => node.id));
let rustCount = 0;
for (const pkg of metadata.packages.sort((a, b) => compare(a.name, b.name) || compare(a.version, b.version))) {
  if (!resolved.has(pkg.id) || pkg.name === 'sparrow-web') continue;
  const root = path.dirname(pkg.manifest_path);
  const docs = [...licenseDocs(root), ...fallbackDocs(pkg.name, pkg.version)];
  let source = pkg.source;
  let local;
  if (source === null) {
    local = PATH_DEPENDENCIES[pkg.name];
    if (!local) throw new Error(`Unregistered path dependency: ${pkg.name}`);
    if (realpathSync(root) !== realpathSync(path.join(REPOSITORY, local.path)) || pkg.version !== local.version) {
      throw new Error(`Path dependency registration mismatch: ${pkg.name}`);
    }
    source = `${local.path} (repository-relative local fork)`;
  } else if (source.startsWith('registry+')) {
    source = `https://crates.io/api/v1/crates/${pkg.name}/${pkg.version}/download`;
  }
  let extra = `Repository: ${pkg.repository || 'not declared'}\nAuthors: ${pkg.authors.join(', ') || 'not declared'}`;
  if (local) {
    extra += `\nUpstream baseline: ${local.baseline}\nLocally modified source; the upstream baseline is not the complete fork. `
      + 'Corresponding source is included at the repository-relative path above.';
  }
  const vcs = path.join(root, '.cargo_vcs_info.json');
  if (existsSync(vcs)) extra += '\nPackage VCS metadata: ' + JSON.stringify(json(vcs));
  if (pkg.name === 'wasm_sync') {
    extra += '\nThis package declares MIT OR Apache-2.0 but includes no license file. '
      + 'Its exact upstream commit also contains none. Apache-2.0 terms are reproduced '
      + 'from apache.org; no package copyright notice has been invented.';
  }
  let license = local ? local.license : pkg.license;
  if (pkg.name === 'sparrow' && !local) license = 'MIT (from the pinned repository LICENSE; Cargo omits this field)';
  entry(`Rust ${pkg.name} ${pkg.version}`, license, source, docs, extra);
  rustCount++;
}
const toolchains = [];
for (const toolchain of ['stable', 'nightly-2026-08-30']) {
  const root = run('rustc', '+' + toolchain, '--print', 'sysroot').trim();
  const version = run('rustc', '+' + toolchain, '-Vv').trim();
  const content = readFileSync(path.join(root, 'share/doc/rust/COPYRIGHT-library.html'));
  const filename = `RUST-LIBRARY-${toolchain}.html`;
  output(filename, content);
  toolchains.push(`${version}\nLibrary notices: ${filename}\nSHA-256: ${sha256(content)}`);
}
const header = `sparrow web prototype: third-party notices

Generated by scripts/generate-notices.mjs. Do not edit this file manually.
Includes all ${npmCount} production npm packages from package-lock.json and a
conservative superset of ${rustCount} packages resolved by Cargo.lock for the
wasm32 target with the threads feature, including build/proc-macro dependencies.
This is not a claim that every listed package contributes bytes to every bundle.
Full license texts below are deduplicated by SHA-256; each package references its
original file or exact source URL. Declared dual-license choices are preserved.

Rust standard-library notices are distributed alongside this file. See the
toolchain section below. Dataset provenance and license: examples/NOTICE.txt.

Studio's local forks are included in this repository:
vendor/sparrow: MIT; baseline revision 7f0e10f946f70a86138d3938548a13ee46464f39
vendor/jagua-rs: MPL-2.0; baseline published version 0.8.3
jagua-rs upstream baseline (not the modified fork):
https://github.com/JeroenGar/jagua-rs/tree/a15ddd4909c5bd4d619c1878342c7b71ab27ac4a/jagua-rs
https://crates.io/api/v1/crates/jagua-rs/0.8.3/download
The full MIT and MPL texts are included below and in the vendor directories.
The solver's MIT license is distinct from the original sparroWASM wrapper's MPL license.
When distributing executable builds containing modified MPL-covered code, make the
corresponding modified source available under MPL-2.0 and tell recipients how to
obtain it. An upstream archive alone does not contain these local modifications.
The application repository location is:
https://github.com/JeroenGar/sparrow-studio
Distributors must ensure the release's vendor source is actually available there
at the corresponding release revision, or provide an accompanying source archive.
This notice does not assert that local modifications have already been published.
Upstream dependencies are identified by the exact source references above/below.

PACKAGE INDEX
`;
let body = header + entries.join('\n\n') + '\n\nRUST TOOLCHAINS\n\n' + toolchains.join('\n\n');
body += '\n\nFULL LICENSE TEXTS\n';
for (const [digest, content] of [...texts].sort(([a], [b]) => compare(a, b))) {
  body += `\n===== SHA-256 ${digest} =====\n${content}\n`;
}
output('THIRD_PARTY_NOTICES.txt', body);
console.log(`${npmCount} npm packages, ${rustCount} Rust packages, ${texts.size} distinct license texts; Rust library notices ${check ? 'verified' : 'copied'}.`);
