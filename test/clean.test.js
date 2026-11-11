/*!
 * SPDX-FileCopyrightText: 2026 KHWLGH
 * SPDX-License-Identifier: GPL-3.0-only
 * For original project contributions; see COPYRIGHT.
 */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, sep } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { cleanTargets } from '../scripts/clean.mjs';

const execFileAsync = promisify(execFile);
const TEMP = ['out', 'output', 'bench/results', '.playwright-cli', 'src/.playwright-cli', 'src-tauri/gen/schemas'];
const CARGO = ['target', 'src-tauri/target'];
const INCREMENTAL = CARGO.flatMap((root) =>
  ['', 'aarch64-apple-darwin/', 'wasm32-wasip1/', 'custom target/'].flatMap((target) =>
    ['debug', 'release'].map((profile) => `${root}/${target}${profile}/incremental`),
  ),
);
const KEPT = [
  'src/app.js',
  'package-lock.json',
  'Cargo.lock',
  'docs/screenshots/en/light-record.png',
  'bench/baselines/core.json',
  'measurement.csv',
  'recording.partial.csv',
  '.env',
];
const quiet = () => {};

async function put(root, path, contents = path) {
  const file = join(root, path);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, contents);
}

async function exists(root, path) {
  return stat(join(root, path)).then(
    () => true,
    (error) => {
      if (error.code === 'ENOENT') return false;
      throw error;
    },
  );
}

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'lapower clean '));
  t.after(() => rm(root, { recursive: true, force: true }));
  await execFileAsync('git', ['init', '--quiet', root]);
  await Promise.all([
    ...TEMP.map((path) => put(root, `${path}/generated.bin`)),
    ...INCREMENTAL.map((path) => put(root, `${path}/cache.bin`)),
    ...CARGO.map((path) => put(root, `${path}/debug/deps/compiled.bin`)),
    put(root, 'dist/installer.exe'),
    put(root, 'node_modules/tool/index.js'),
    ...KEPT.map((path) => put(root, path)),
  ]);
  return root;
}

for (const level of ['clean', 'incremental', 'build', 'all']) {
  test(`${level} removes its selected outputs and preserves data outside the whitelist`, async (t) => {
    const root = await fixture(t);
    await cleanTargets(level, { root, log: quiet });
    for (const path of TEMP) assert.equal(await exists(root, path), false, path);
    for (const path of INCREMENTAL) assert.equal(await exists(root, path), level === 'clean', path);
    for (const path of CARGO)
      assert.equal(await exists(root, `${path}/debug/deps/compiled.bin`), !['build', 'all'].includes(level), path);
    assert.equal(await exists(root, 'dist/installer.exe'), !['build', 'all'].includes(level));
    assert.equal(await exists(root, 'node_modules/tool/index.js'), level !== 'all');
    for (const path of KEPT) assert.equal(await readFile(join(root, path), 'utf8'), path);
    const repeat = await cleanTargets(level, { root, log: quiet });
    assert.deepEqual(repeat.removed, []);
  });

  test(`${level} dry-run never invokes removal`, async (t) => {
    const root = await fixture(t);
    const preview = await cleanTargets(level, {
      root,
      dryRun: true,
      log: quiet,
      remove: () => assert.fail('dry-run must not delete'),
    });
    assert.deepEqual(preview.removed, []);
    for (const path of [...TEMP, ...INCREMENTAL, 'dist', 'node_modules'])
      assert.equal(await exists(root, path), true, path);
    // No target is scheduled twice through an ancestor and its descendant.
    for (const parent of preview.targets)
      assert.ok(!preview.targets.some((child) => child !== parent && child.startsWith(`${parent}${sep}`)));
  });
}

test('preflight rejects tracked files, including deleted worktree files, before deleting any output', async (t) => {
  const root = await fixture(t);
  await put(root, 'src-tauri/gen/schemas/keep.json');
  await execFileAsync('git', ['add', '--', 'src-tauri/gen/schemas/keep.json'], { cwd: root });
  for (const deleted of [false, true]) {
    if (deleted) await rm(join(root, 'src-tauri/gen/schemas/keep.json'));
    await assert.rejects(cleanTargets('all', { root, log: quiet }), /Git 跟踪文件/);
    for (const path of TEMP) assert.equal(await exists(root, path), true, path);
  }
});

test('preflight rejects a regular file at a directory target before deleting earlier targets', async (t) => {
  const root = await fixture(t);
  await rm(join(root, 'src-tauri/gen/schemas'), { recursive: true });
  await put(root, 'src-tauri/gen/schemas', 'user file');
  await assert.rejects(cleanTargets('clean', { root, log: quiet }), /不是目录/);
  assert.equal(await exists(root, 'out/generated.bin'), true);
  assert.equal(await readFile(join(root, 'src-tauri/gen/schemas'), 'utf8'), 'user file');
});

test('protects tracked files with a differently cased directory name', async (t) => {
  const root = await fixture(t);
  await put(root, 'OUT/keep.txt');
  await execFileAsync('git', ['add', '--', 'OUT/keep.txt'], { cwd: root });
  await assert.rejects(cleanTargets('all', { root, log: quiet }), /Git 跟踪文件/);
  assert.equal(await exists(root, 'out/generated.bin'), true);
  assert.equal(await readFile(join(root, 'OUT/keep.txt'), 'utf8'), 'OUT/keep.txt');
});

test('protects a tracked ancestor replaced with generated directories in the worktree', async (t) => {
  const root = await fixture(t);
  await rm(join(root, 'target'), { recursive: true });
  await put(root, 'target', 'tracked file');
  await execFileAsync('git', ['add', '--', 'target'], { cwd: root });
  await rm(join(root, 'target'));
  await put(root, 'target/debug/incremental/cache.bin');
  await assert.rejects(cleanTargets('incremental', { root, log: quiet }), /Git 跟踪文件/);
  assert.equal(await exists(root, 'out/generated.bin'), true);
  assert.equal(await exists(root, 'target/debug/incremental/cache.bin'), true);
});

async function externalDirectory(t) {
  const outside = await mkdtemp(join(tmpdir(), 'lapower external '));
  t.after(() => rm(outside, { recursive: true, force: true }));
  await put(outside, 'keep.txt', 'outside data');
  return outside;
}

async function link(target, path) {
  await symlink(target, path, process.platform === 'win32' ? 'junction' : 'dir');
}

for (const path of ['output', 'src-tauri/gen', 'target', 'target/aarch64-apple-darwin']) {
  test(`rejects linked target or ancestor ${path} without touching external data`, async (t) => {
    const root = await fixture(t);
    const outside = await externalDirectory(t);
    await rm(join(root, path), { recursive: true });
    await link(outside, join(root, path));
    const level = path.startsWith('target') ? 'incremental' : 'clean';
    await assert.rejects(cleanTargets(level, { root, log: quiet }), /包含链接/);
    assert.equal(await readFile(join(outside, 'keep.txt'), 'utf8'), 'outside data');
    assert.equal(await exists(root, 'out/generated.bin'), true);
  });
}

test('removes an internal directory link itself and preserves its external target', async (t) => {
  const root = await fixture(t);
  const outside = await externalDirectory(t);
  await link(outside, join(root, 'out/external-link'));
  await cleanTargets('clean', { root, log: quiet });
  assert.equal(await exists(root, 'out'), false);
  assert.equal(await readFile(join(outside, 'keep.txt'), 'utf8'), 'outside data');
});

test('requires an actual checkout root and refuses arbitrary cleanup levels', async (t) => {
  const root = await fixture(t);
  await assert.rejects(cleanTargets('all', { root: join(root, 'src'), log: quiet }), /Git 仓库根目录/);
  await assert.rejects(cleanTargets('../src', { root, log: quiet }), /未知清理级别/);
  await link(root, join(root, 'linked-checkout'));
  await assert.rejects(cleanTargets('all', { root: join(root, 'linked-checkout'), log: quiet }), /仓库根目录无效/);
  assert.equal(await exists(root, 'out/generated.bin'), true);
});

test('waits for at most four parallel removals and reports failures without hiding other results', async (t) => {
  const root = await fixture(t);
  let active = 0;
  let peak = 0;
  let completed = 0;
  const messages = [];
  await assert.rejects(
    cleanTargets('all', {
      root,
      log: (message) => messages.push(message),
      remove: async (path, options) => {
        active++;
        peak = Math.max(peak, active);
        try {
          await new Promise((accept) => setTimeout(accept, 5));
          if (path === join(root, 'output')) throw Object.assign(new Error('file is busy'), { code: 'EBUSY' });
          await rm(path, options);
          completed++;
        } finally {
          active--;
        }
      },
    }),
    AggregateError,
  );
  assert.equal(active, 0, 'all removals must finish before returning');
  assert.ok(peak > 1 && peak <= 4, `observed concurrency: ${peak}`);
  assert.equal(completed, 9);
  assert.equal(await exists(root, 'output/generated.bin'), true);
  assert.equal(await exists(root, 'node_modules'), false);
  assert.ok(messages.some((message) => message.includes('[失败] output')));
  assert.ok(messages.some((message) => message.includes('失败 1 个')));
});

test('CLI rejects extra arguments before changing files', async () => {
  const script = fileURLToPath(new URL('../scripts/clean.mjs', import.meta.url));
  await assert.rejects(execFileAsync(process.execPath, [script, 'clean', '--dry-run', '--anything']), { code: 1 });
});

test('CLI locates its checkout independently of cwd and returns nonzero for unsafe targets', async (t) => {
  const root = await fixture(t);
  const script = join(root, 'scripts/clean.mjs');
  await mkdir(dirname(script), { recursive: true });
  await copyFile(new URL('../scripts/clean.mjs', import.meta.url), script);
  const result = await execFileAsync(process.execPath, [script, 'all', '--dry-run'], { cwd: tmpdir() });
  assert.match(result.stdout, /预览级别：all/);
  assert.equal(await exists(root, 'out/generated.bin'), true);
  await execFileAsync('git', ['add', '--', 'out/generated.bin'], { cwd: root });
  await assert.rejects(execFileAsync(process.execPath, [script, 'all'], { cwd: tmpdir() }), (error) => {
    assert.equal(error.code, 1);
    assert.match(error.stderr, /Git 跟踪文件/);
    return true;
  });
  assert.equal(await exists(root, 'out/generated.bin'), true);
});

test('CLI returns nonzero for a removal failure after finishing the remaining targets', async (t) => {
  const root = await fixture(t);
  const script = join(root, 'scripts/clean.mjs');
  await mkdir(dirname(script), { recursive: true });
  await copyFile(new URL('../scripts/clean.mjs', import.meta.url), script);
  const preload = join(root, 'fail-removal.cjs');
  await writeFile(
    preload,
    `const fs = require('node:fs/promises');
const path = require('node:path');
const remove = fs.rm;
fs.rm = async (target, options) => {
  if (path.basename(target) === 'output') throw Object.assign(new Error('file is busy'), { code: 'EBUSY' });
  return remove(target, options);
};
require('node:module').syncBuiltinESMExports();
`,
  );
  await assert.rejects(execFileAsync(process.execPath, ['--require', preload, script, 'all']), (error) => {
    assert.equal(error.code, 1);
    assert.match(error.stdout, /\[失败\] output/);
    assert.match(error.stdout, /失败 1 个/);
    return true;
  });
  assert.equal(await exists(root, 'output/generated.bin'), true);
  assert.equal(await exists(root, 'node_modules'), false);
  for (const path of KEPT) assert.equal(await readFile(join(root, path), 'utf8'), path);
});

test('protects tracked files in host and cross-compilation incremental caches', async (t) => {
  const root = await fixture(t);
  for (const path of [
    'target/debug/incremental/cache.bin',
    'src-tauri/target/aarch64-apple-darwin/release/incremental/cache.bin',
  ]) {
    await execFileAsync('git', ['add', '--', path], { cwd: root });
    await assert.rejects(cleanTargets('incremental', { root, log: quiet }), /Git 跟踪文件/);
    assert.equal(await exists(root, 'out/generated.bin'), true);
    await execFileAsync('git', ['rm', '--cached', '--', path], { cwd: root });
  }
});
