/*! SPDX-FileCopyrightText: 2026 KHWLGH
 * SPDX-License-Identifier: GPL-3.0-only
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  declaredLicense,
  generateLegalCatalog,
  licenseTextId,
  normalizeLicenseText,
  packageLicensePaths,
  validateLegalCatalog,
} from '../scripts/license-materials.mjs';
import { runtimePackages, TARGETS } from '../scripts/third-party-components.mjs';
import { dictionaries } from '../src/i18n.js';

test('runtime traversal excludes build, dev and proc-macro dependencies but follows workspace libraries', () => {
  const pkg = (name, kind = 'lib') => ({
    id: name,
    name,
    version: '1.0.0',
    license: 'MIT',
    targets: [{ kind: [kind] }],
  });
  const edge = (pkg, kind = null) => ({ pkg, dep_kinds: [{ kind }] });
  const metadata = {
    workspace_members: ['lapower', 'local-protocol'],
    packages: [
      pkg('lapower'),
      pkg('local-protocol'),
      pkg('direct'),
      pkg('indirect'),
      pkg('test-only'),
      pkg('build-only'),
      pkg('derive', 'proc-macro'),
      pkg('macro-helper'),
    ],
    resolve: {
      nodes: [
        {
          id: 'lapower',
          deps: [
            edge('local-protocol'),
            edge('direct'),
            {
              pkg: 'test-only',
              dep_kinds: [
                { kind: null, target: 'cfg(windows)' },
                { kind: 'dev', target: null },
              ],
            },
            edge('build-only', 'build'),
            edge('derive'),
          ],
        },
        { id: 'local-protocol', deps: [edge('indirect')] },
        { id: 'direct', deps: [edge('indirect')] },
        { id: 'derive', deps: [edge('macro-helper')] },
      ],
    },
  };
  assert.deepEqual(
    runtimePackages(metadata, 'lapower v1.0.0\nlocal-protocol v1.0.0\ndirect v1.0.0\nindirect v1.0.0\nderive v1.0.0\n')
      .map((item) => item.name)
      .sort(),
    ['direct', 'indirect'],
  );
});

test('bundled manifest covers every release target and contains real locked components and translations', () => {
  const manifest = JSON.parse(readFileSync(new URL('../src/third-party-components.json', import.meta.url), 'utf8'));
  const lock = readFileSync(new URL('../Cargo.lock', import.meta.url), 'utf8');
  const packages = new Set(
    lock.split('[[package]]').map((item) => {
      const name = item.match(/^name = "([^"]+)"/m)?.[1];
      const version = item.match(/^version = "([^"]+)"/m)?.[1];
      return `${name}@${version}`;
    }),
  );
  assert.deepEqual(manifest.targets, TARGETS);
  assert.ok(manifest.components.length > 100);
  assert.ok(manifest.main.some((item) => item.name === 'reqwest'));
  assert.ok(manifest.main.some((item) => item.name === 'tauri-plugin-opener'));
  const keys = manifest.components.map((item) => `${item.name}@${item.version}`);
  assert.equal(new Set(keys).size, keys.length);
  for (const item of manifest.components) {
    assert.ok(item.license.trim(), item.name);
    if (!['uPlot', 'Fluent System Icons', 'GitHub Octicons', '@tauri-apps/plugin-store'].includes(item.name))
      assert.ok(packages.has(`${item.name}@${item.version}`), item.name);
    assert.ok(
      ![
        'lapower',
        'witrn-hid',
        'km003c',
        'usbpd-parser',
        'criterion',
        'tauri-build',
        'tauri-codegen',
        'serde_derive',
      ].includes(item.name),
      item.name,
    );
  }
  for (const item of manifest.main) {
    for (const [language, dictionary] of Object.entries(dictionaries))
      assert.ok(dictionary[item.purpose], `${language}/${item.name}`);
  }
  const uplot = readFileSync(new URL('../src/vendor/uPlot.iife.min.js', import.meta.url), 'utf8');
  assert.ok(uplot.includes(`(v${manifest.components.find((item) => item.name === 'uPlot').version})`));
  assert.equal(manifest.components.find((item) => item.name === 'Fluent System Icons').version, null);
  const githubIcon = readFileSync(new URL('../src/assets/github-mark.svg', import.meta.url), 'utf8');
  assert.ok(
    githubIcon.includes(
      `GitHub Octicons v${manifest.components.find((item) => item.name === 'GitHub Octicons').version}`,
    ),
  );
});

const readJson = (path) => JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8'));

test('legal catalog binds every component and all three project documents to full normalized text', () => {
  const manifest = readJson('../src/third-party-components.json');
  const catalog = readJson('../src/legal-notices.json');
  validateLegalCatalog(catalog, manifest);
  for (const item of catalog.project.documents) {
    const original = readFileSync(new URL(`../${item.path}`, import.meta.url), 'utf8');
    assert.equal(catalog.texts[item.textId], normalizeLicenseText(original));
  }
  const block = catalog.components.find((item) => item.name === 'block');
  assert.ok(block.documents.some((item) => catalog.texts[item.textId].includes('upstream-missing-license-text')));
  const sdk = catalog.components.find((item) => item.name === 'webview2-com-sys');
  assert.ok(sdk.documents.some((item) => catalog.texts[item.textId].includes('Native SDK archive SHA-256:')));
  assert.ok(sdk.documents.some((item) => catalog.texts[item.textId].includes('Copyright (C) Microsoft Corporation')));
  assert.ok(!catalog.components.some((item) => item.documents.some((doc) => /tests\/|BINARY_LICENSE/.test(doc.path))));
  assert.ok(
    !catalog.components.find((item) => item.name === 'libdbus-sys').documents.some((item) => /vendor/.test(item.path)),
  );
});

test('license hashes preserve BOM, leading and trailing whitespace and final-newline state', () => {
  const original = '\uFEFF \r\nfull text \r\n\r\n';
  const normalized = '\uFEFF \nfull text \n\n';
  assert.equal(normalizeLicenseText(original), normalized);
  assert.equal(licenseTextId(original), createHash('sha256').update(normalized).digest('hex'));
  assert.notEqual(licenseTextId(original), licenseTextId(normalized.trim()));
  assert.notEqual(licenseTextId('text'), licenseTextId('text\n'));
});

test('catalog validator fails closed for corruption, missing text, duplicates and version drift', () => {
  const manifest = readJson('../src/third-party-components.json');
  const original = readJson('../src/legal-notices.json');
  const mutations = [
    (catalog) => {
      catalog.texts[catalog.project.documents[0].textId] += 'modified';
    },
    (catalog) => {
      delete catalog.texts[catalog.components[0].documents[0].textId];
    },
    (catalog) => {
      catalog.components.push(catalog.components[0]);
    },
    (catalog) => {
      catalog.components[0].version = '0.0.0-drift';
    },
    (catalog) => {
      catalog.project.documents[1].id = 'copyright';
    },
    (catalog) => {
      catalog.texts[licenseTextId('unused')] = 'unused';
    },
  ];
  for (const mutate of mutations) {
    const catalog = structuredClone(original);
    mutate(catalog);
    assert.throws(() => validateLegalCatalog(catalog, manifest), /Invalid legal catalog/);
  }
});

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'lapower-licenses-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const name of ['COPYRIGHT', 'LICENSE', 'LICENSE.LGPL-3.0']) writeFileSync(join(root, name), `${name}\n`);
  const packageRoot = join(root, 'package');
  mkdirSync(packageRoot);
  const pkg = {
    name: 'fixture',
    version: '1.0.0',
    source: 'registry+fixture',
    license: null,
    license_file: 'TERMS.txt',
    manifest_path: join(packageRoot, 'Cargo.toml'),
  };
  const generate = (materials = { schemaVersion: 1, packages: [], frontend: [] }) =>
    generateLegalCatalog(
      root,
      {
        components: [{ name: pkg.name, version: pkg.version, license: declaredLicense(pkg) }],
      },
      [pkg],
      materials,
    );
  return { root, packageRoot, pkg, generate };
}

test('license_file-only metadata is supported with exact text; invalid UTF-8 and escaped paths fail', (t) => {
  const { root, packageRoot, pkg, generate } = fixture(t);
  writeFileSync(join(packageRoot, 'TERMS.txt'), '\uFEFF  real custom terms\r\n\r\n');
  const catalog = generate();
  const doc = catalog.components[0].documents[0];
  assert.equal(catalog.components[0].license, 'LicenseRef-Cargo-license-file');
  assert.equal(catalog.texts[doc.textId], '\uFEFF  real custom terms\n\n');
  writeFileSync(join(packageRoot, 'TERMS.txt'), Buffer.from([0xc3, 0x28]));
  assert.throws(generate, /encoded data|encoding/i);
  pkg.license_file = '../LICENSE';
  assert.throws(generate, /escapes/);
  const external = join(root, 'external');
  mkdirSync(external);
  writeFileSync(join(external, 'TERMS.txt'), 'outside');
  symlinkSync(external, join(packageRoot, 'linked'), 'junction');
  pkg.license_file = 'linked/TERMS.txt';
  assert.throws(generate, /escapes/);
});

test('truncated and cross-document license fragments cannot satisfy release material coverage', (t) => {
  const { packageRoot, pkg, generate } = fixture(t);
  pkg.license = 'MIT';
  const text = readFileSync(new URL('../licenses/authorities/MIT.txt', import.meta.url), 'utf8');
  const boundary = text.indexOf('THE SOFTWARE IS PROVIDED');
  writeFileSync(join(packageRoot, 'TERMS.txt'), text.slice(0, boundary));
  assert.throws(generate, /Missing full MIT/);
  writeFileSync(join(packageRoot, 'LICENSE-fragment'), text.slice(boundary));
  assert.throws(generate, /Missing full MIT/);
  writeFileSync(join(packageRoot, 'TERMS.txt'), text);
  generate();
  pkg.license = 'Apache-2.0';
  writeFileSync(
    join(packageRoot, 'TERMS.txt'),
    'Apache License Version 2.0 https://www.apache.org/licenses/LICENSE-2.0',
  );
  assert.throws(generate, /Missing full Apache/);
  pkg.license = 'Apache-2.0 WITH LLVM-exception';
  const apache = readFileSync(new URL('../licenses/authorities/Apache-2.0.txt', import.meta.url), 'utf8');
  writeFileSync(join(packageRoot, 'TERMS.txt'), `${apache}\nLLVM Exceptions to the Apache 2.0 License\n`);
  assert.throws(generate, /Missing full LLVM-exception/);
  pkg.license = 'BSD-3-Clause';
  const bsd2 = readFileSync(new URL('../licenses/authorities/BSD-2-Clause.txt', import.meta.url), 'utf8');
  writeFileSync(join(packageRoot, 'TERMS.txt'), bsd2);
  assert.throws(generate, /Missing full BSD-3-Clause/);
  pkg.license = 'BSD-2-Clause';
  generate();
});

test('native SDK evidence and supplemental texts are checked against pinned raw and normalized hashes', (t) => {
  const { root, packageRoot, pkg, generate } = fixture(t);
  writeFileSync(join(packageRoot, 'TERMS.txt'), 'custom terms');
  const path = 'supplement.txt';
  writeFileSync(join(root, path), 'notice\r\n');
  const bytes = Buffer.from([0, 1, 255, 13, 10]);
  writeFileSync(join(packageRoot, 'loader.lib'), bytes);
  const materials = {
    schemaVersion: 1,
    frontend: [],
    packages: [
      {
        name: pkg.name,
        version: pkg.version,
        source: pkg.source,
        documents: [
          {
            path,
            origin: 'https://example.invalid/fixed',
            revision: 'fixed',
            upstreamPath: 'NOTICE',
            sha256: licenseTextId('notice\n'),
          },
        ],
        nativeEvidence: {
          sdkVersion: '1.0',
          origin: 'https://example.invalid/sdk/1.0',
          archiveSha256: 'a'.repeat(64),
          files: [{ path: 'loader.lib', sha256: createHash('sha256').update(bytes).digest('hex') }],
        },
      },
    ],
  };
  generate(materials);
  writeFileSync(join(packageRoot, 'loader.lib'), Buffer.from([0, 1, 255, 10]));
  assert.throws(() => generate(materials), /Native SDK binary hash mismatch/);
  writeFileSync(join(packageRoot, 'loader.lib'), bytes);
  writeFileSync(join(root, path), 'changed');
  assert.throws(() => generate(materials), /Supplemental license hash mismatch/);
  assert.deepEqual(packageLicensePaths(pkg), ['TERMS.txt']);
});

test('license headings and old Unicode agreements do not masquerade as full release terms', (t) => {
  const { packageRoot, pkg, generate } = fixture(t);
  for (const [license, header] of [
    ['ISC', 'Permission to use, copy, modify, and/or distribute'],
    ['0BSD', 'Permission to use, copy, modify, and/or distribute'],
    ['Unicode-3.0', 'UNICODE LICENSE V3'],
    ['Unicode-3.0', 'UNICODE, INC. LICENSE AGREEMENT'],
    ['MPL-2.0', 'Mozilla Public License Version 2.0 1. Definitions'],
    ['Unlicense', 'This is free and unencumbered software released into the public domain'],
    ['CC0-1.0', 'CC0 1.0 Universal Creative Commons Statement of Purpose'],
    ['Zlib', 'The origin of this software must not be misrepresented'],
    ['GPL-3.0-only', 'GNU GENERAL PUBLIC LICENSE Version 3'],
  ]) {
    pkg.license = license;
    writeFileSync(join(packageRoot, 'TERMS.txt'), header);
    assert.throws(generate, /Missing full/, license);
  }
});
