/** Generate the offline runtime component list. Ordinary frontend builds only copy its output. */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

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

/** Follow only normal dependency edges from the application, including local protocol libraries. */
export function runtimePackages(metadata) {
  const packages = new Map(metadata.packages.map((item) => [item.id, item]));
  const nodes = new Map(metadata.resolve.nodes.map((item) => [item.id, item]));
  const workspace = new Set(metadata.workspace_members);
  const application = metadata.packages.find((item) => item.name === 'lapower' && workspace.has(item.id));
  if (!application) throw new Error('Cannot find the laPower application in Cargo metadata');
  const visited = new Set();
  const runtime = [];
  function visit(id) {
    if (visited.has(id)) return;
    visited.add(id);
    const pkg = packages.get(id);
    if (!pkg) throw new Error(`Missing Cargo metadata for ${id}`);
    if (pkg.targets.some((target) => target.kind.includes('proc-macro'))) return;
    if (!workspace.has(id)) {
      if (!pkg.license) throw new Error(`Missing declared license: ${pkg.name} ${pkg.version}`);
      runtime.push({ name: pkg.name, version: pkg.version, license: pkg.license });
    }
    for (const dependency of nodes.get(id)?.deps ?? []) {
      if (dependency.dep_kinds.some((kind) => kind.kind === null)) visit(dependency.pkg);
    }
  }
  visit(application.id);
  return runtime;
}

export function generateManifest(metadatas, uplotSource, storeSource, githubSource) {
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
  for (const metadata of metadatas) {
    for (const pkg of runtimePackages(metadata)) {
      const key = `${pkg.name}@${pkg.version}`;
      if (unique.has(key) && unique.get(key).license !== pkg.license) throw new Error(`Conflicting license: ${key}`);
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
    components: [...runtime, ...vendored.map(({ purpose: _purpose, ...item }) => item)].sort(compare),
  };
}

export function main(args = process.argv.slice(2)) {
  if (args.some((arg) => arg !== '--check'))
    throw new Error('Usage: node scripts/third-party-components.mjs [--check]');
  const metadata = TARGETS.map((target) => {
    console.log(`Reading runtime dependencies: ${target}`);
    return JSON.parse(
      execFileSync('cargo', ['metadata', '--locked', '--format-version', '1', '--filter-platform', target], {
        cwd: ROOT,
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024,
        stdio: ['ignore', 'pipe', 'inherit'],
      }),
    );
  });
  const manifest = generateManifest(
    metadata,
    readFileSync(resolve(ROOT, 'src/vendor/uPlot.iife.min.js'), 'utf8'),
    readFileSync(resolve(ROOT, 'src/vendor/plugin-store.js'), 'utf8'),
    readFileSync(resolve(ROOT, 'src/assets/github-mark.svg'), 'utf8'),
  );
  // Keep generated JSON in the same format as Biome, without requiring the formatter to generate it.
  const output = `${JSON.stringify(manifest, null, 2)}\n`;
  if (args.includes('--check')) {
    if (JSON.stringify(JSON.parse(readFileSync(OUTPUT, 'utf8'))) !== JSON.stringify(manifest)) {
      throw new Error('Runtime component list is stale. Run npm run components:generate and commit the result.');
    }
    console.log(`PASS: ${manifest.components.length} runtime components match all four release targets`);
  } else {
    writeFileSync(OUTPUT, output);
    console.log(`Generated ${manifest.components.length} runtime components`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main();
