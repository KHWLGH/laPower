/*! SPDX-FileCopyrightText: 2026 KHWLGH
 * SPDX-License-Identifier: GPL-3.0-only
 */
/** Generate the offline component and legal catalogs. This is a conservative license coverage set, not a release unit graph. */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { declaredLicense, generateLegalCatalog } from './license-materials.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUTPUT = resolve(ROOT, 'src/third-party-components.json');
export const TARGETS = [
  'x86_64-pc-windows-msvc',
  'x86_64-unknown-linux-gnu',
  'x86_64-apple-darwin',
  'aarch64-apple-darwin',
];
const MAIN = {
  tauri: 'componentDesktop',
  'tauri-plugin-dialog': 'componentDialogs',
  'tauri-plugin-fs': 'componentFiles',
  'tauri-plugin-store': 'componentSettings',
  'tauri-plugin-decorum': 'componentWindow',
  'tauri-plugin-opener': 'componentBrowser',
  reqwest: 'componentNetwork',
  semver: 'componentVersions',
  serde: 'componentSerialization',
  serde_json: 'componentSerialization',
  hidapi: 'componentHid',
  nusb: 'componentUsb',
  serialport: 'componentSerial',
  encoding_rs: 'componentEncoding',
  aes: 'componentCrypto',
  chrono: 'componentTime',
  'sys-locale': 'componentLocale',
  anyhow: 'componentErrors',
  thiserror: 'componentErrors',
};

/**
 * Cargo tree applies target and edge-kind selection together. Metadata dep_kinds alone can merge a
 * target-specific normal edge with an active dev edge and incorrectly include the package.
 * Cargo's feature-unified tree remains a conservative set, not the exact release compilation graph.
 */
export function runtimePackages(metadata, tree) {
  if (typeof tree !== 'string') throw new Error('Runtime selection requires target-filtered cargo tree output');
  const workspace = new Set(metadata.workspace_members);
  const application = metadata.packages.find((item) => item.name === 'lapower' && workspace.has(item.id));
  if (!application) throw new Error('Cannot find the laPower application in Cargo metadata');
  const nodes = new Map(metadata.resolve.nodes.map((item) => [item.id, item]));
  const selected = new Map();
  for (const line of tree.split(/\r?\n/)) {
    if (!line) continue;
    const match = line.match(/^([^\s]+) v([^\s]+)(?: \(([^)]+)\))?(?: \(\*\))?$/);
    if (!match) throw new Error(`Unrecognized cargo tree package: ${line}`);
    const [, name, version, qualifier] = match;
    let candidates = metadata.packages.filter((item) => item.name === name && item.version === version);
    if (candidates.length > 1 && qualifier && qualifier !== '*') {
      candidates = candidates.filter((item) =>
        item.source
          ? item.source.includes(qualifier) || qualifier.includes(item.source.replace(/^(?:git|registry)\+/, ''))
          : resolve(dirname(item.manifest_path)) === resolve(qualifier),
      );
    }
    if (candidates.length !== 1) throw new Error(`Ambiguous or missing Cargo source identity: ${line}`);
    const pkg = candidates[0];
    if (workspace.has(pkg.id) || pkg.targets.some((target) => target.kind.includes('proc-macro'))) continue;
    selected.set(pkg.id, { ...pkg, license: declaredLicense(pkg), runtimeFeatures: nodes.get(pkg.id)?.features ?? [] });
  }
  return [...selected.values()];
}

export function generateManifest(metadatas, uplotSource, storeSource, githubSource, trees) {
  const version = uplotSource.match(/uPlot \(v([\d.]+)\)/)?.[1];
  if (!version) throw new Error('The bundled uPlot header must declare its version');
  const storeVersion = storeSource.match(/@tauri-apps\/plugin-store v([\d.]+)/)?.[1];
  if (!storeVersion) throw new Error('The bundled plugin-store header must declare its version');
  const githubVersion = githubSource.match(/GitHub Octicons v([\d.]+)/)?.[1];
  if (!githubVersion) throw new Error('The bundled GitHub icon header must declare its version');
  const vendored = [
    { name: 'uPlot', version, license: 'MIT', purpose: 'componentChart' },
    { name: 'Fluent System Icons', version: null, license: 'MIT', purpose: 'componentIcons' },
    { name: 'GitHub Octicons', version: githubVersion, license: 'MIT', purpose: 'componentIcons' },
    {
      name: '@tauri-apps/plugin-store',
      version: storeVersion,
      license: 'Apache-2.0 OR MIT',
      purpose: 'componentSettings',
    },
  ];
  const unique = new Map();
  for (const [index, metadata] of metadatas.entries()) {
    for (const pkg of runtimePackages(metadata, trees[index])) {
      const key = `${pkg.name}@${pkg.version}`;
      const previous = unique.get(key);
      if (previous && (previous.license !== pkg.license || previous.source !== pkg.source)) {
        throw new Error(`Conflicting license or Cargo source cannot fit the public component schema: ${key}`);
      }
      unique.set(key, pkg);
    }
  }
  const compare = (a, b) =>
    a.name.toLowerCase() < b.name.toLowerCase()
      ? -1
      : a.name.toLowerCase() > b.name.toLowerCase()
        ? 1
        : a.version < b.version
          ? -1
          : a.version > b.version
            ? 1
            : 0;
  const runtime = [...unique.values()].sort(compare);
  const main = [...vendored];
  for (const [name, purpose] of Object.entries(MAIN)) {
    const packages = runtime.filter((item) => item.name === name);
    if (!packages.length) throw new Error(`Expected main runtime component is missing: ${name}`);
    main.push({
      name,
      version: packages.map((item) => item.version).join(' / '),
      license: [...new Set(packages.map((item) => item.license))].join(' / '),
      purpose,
    });
  }
  return {
    schemaVersion: 1,
    targets: TARGETS,
    main,
    components: [
      ...runtime.map(({ name, version, license }) => ({ name, version, license })),
      ...vendored.map(({ purpose: _purpose, ...item }) => item),
    ].sort(compare),
  };
}

export function main(args = process.argv.slice(2)) {
  if (args.some((arg) => arg !== '--check'))
    throw new Error('Usage: node scripts/third-party-components.mjs [--check]');
  const options = {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'inherit'],
  };
  const trees = [];
  const metadata = TARGETS.map((target) => {
    console.log(`Reading offline conservative runtime set: ${target}`);
    trees.push(
      execFileSync(
        'cargo',
        [
          'tree',
          '-p',
          'lapower',
          '--locked',
          '--offline',
          '--target',
          target,
          '--edges',
          'normal,no-proc-macro',
          '--prefix',
          'none',
          '--format',
          '{p}',
        ],
        options,
      ),
    );
    return JSON.parse(
      execFileSync(
        'cargo',
        ['metadata', '--locked', '--offline', '--format-version', '1', '--filter-platform', target],
        options,
      ),
    );
  });
  const manifest = generateManifest(
    metadata,
    readFileSync(resolve(ROOT, 'src/vendor/uPlot.iife.min.js'), 'utf8'),
    readFileSync(resolve(ROOT, 'src/vendor/plugin-store.js'), 'utf8'),
    readFileSync(resolve(ROOT, 'src/assets/github-mark.svg'), 'utf8'),
    trees,
  );
  const packages = new Map();
  for (const [index, item] of metadata.entries()) {
    for (const pkg of runtimePackages(item, trees[index])) {
      const previous = packages.get(pkg.id);
      packages.set(pkg.id, {
        ...pkg,
        runtimeFeatures: [...new Set([...(previous?.runtimeFeatures ?? []), ...pkg.runtimeFeatures])].sort(),
      });
    }
  }
  const materials = JSON.parse(readFileSync(resolve(ROOT, 'licenses/materials.json'), 'utf8'));
  const catalog = generateLegalCatalog(ROOT, manifest, [...packages.values()], materials);
  for (const entry of materials.packages.filter((item) => item.review)) {
    console.log(`REVIEW ${entry.name} ${entry.version}: ${entry.review.kind}: ${entry.review.reason}`);
  }
  // Complete collection and validation before touching either generated output.
  const output = `${JSON.stringify(manifest, null, 2)}\n`;
  const legalOutput = `${JSON.stringify(catalog, null, 2)}\n`;
  const legalPath = resolve(ROOT, 'src/legal-notices.json');
  if (args.includes('--check')) {
    if (JSON.stringify(JSON.parse(readFileSync(OUTPUT, 'utf8'))) !== JSON.stringify(manifest)) {
      throw new Error('Runtime component list is stale. Run npm run components:generate and commit the result.');
    }
    if (JSON.stringify(JSON.parse(readFileSync(legalPath, 'utf8'))) !== JSON.stringify(catalog)) {
      throw new Error('Legal notices are stale. Run npm run components:generate and commit both catalogs.');
    }
    console.log(
      `PASS: ${manifest.components.length} components and reviewed legal material match the conservative target set`,
    );
  } else {
    writeFileSync(OUTPUT, output);
    writeFileSync(legalPath, legalOutput);
    // JSON.stringify always breaks arrays, Biome keeps short ones on one line. Formatting the
    // file here means a regeneration cannot leave the repository failing npm run lint.
    try {
      execFileSync(
        process.execPath,
        [resolve(ROOT, 'node_modules/@biomejs/biome/bin/biome'), 'format', '--write', OUTPUT, legalPath],
        { stdio: 'ignore' },
      );
    } catch {
      // Without a local formatter the manifest is still valid; only its layout differs.
    }
    console.log(
      `Generated ${manifest.components.length} components and ${Object.keys(catalog.texts).length} legal texts`,
    );
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main();
