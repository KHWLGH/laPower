import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
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
            edge('test-only', 'dev'),
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
    runtimePackages(metadata)
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
