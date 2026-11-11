/*!
 * SPDX-FileCopyrightText: 2026 KHWLGH
 * SPDX-License-Identifier: GPL-3.0-only
 * For original project contributions; see COPYRIGHT.
 */
/** Remove only explicitly selected, untracked development outputs inside this checkout. */
import { execFile } from 'node:child_process';
import { lstat, readdir, realpath, rm } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const LEVELS = ['clean', 'incremental', 'build', 'all'];
const TEMP_TARGETS = [
  'out',
  'output',
  'bench/results',
  '.playwright-cli',
  'src/.playwright-cli',
  'src-tauri/gen/schemas',
];
const CARGO_ROOTS = ['target', 'src-tauri/target'];
const PROFILES = ['debug', 'release'];
const USAGE = '用法：node scripts/clean.mjs [clean|incremental|build|all] [--dry-run]';

function isInside(root, target) {
  const path = relative(root, target);
  return path !== '' && !isAbsolute(path) && path !== '..' && !path.startsWith(`..${sep}`);
}

/** Inspect every existing ancestor without following links, including Windows junctions. */
async function directoryExists(root, target) {
  if (!isInside(root, target)) throw new Error(`清理目标越界：${target}`);
  let current = root;
  for (const segment of relative(root, target).split(sep)) {
    current = join(current, segment);
    let info;
    try {
      info = await lstat(current);
    } catch (error) {
      if (error.code === 'ENOENT') return false;
      throw error;
    }
    if (info.isSymbolicLink()) throw new Error(`清理路径包含链接，已拒绝：${current}`);
    if (!info.isDirectory()) throw new Error(`清理路径不是目录，已拒绝：${current}`);
  }
  return true;
}

async function git(root, args) {
  const { stdout } = await execFileAsync('git', args, { cwd: root, windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
  return stdout;
}

async function validateRoot(root) {
  const info = await lstat(root);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`仓库根目录无效：${root}`);
  const gitRoot = (await git(root, ['rev-parse', '--show-toplevel'])).trim();
  if (relative(await realpath(root), await realpath(gitRoot)) !== '')
    throw new Error(`清理脚本必须位于 Git 仓库根目录下的 scripts/：${root}`);
}

async function incrementalTargets(root) {
  const targets = [];
  for (const cargoRoot of CARGO_ROOTS) {
    const absolute = resolve(root, cargoRoot);
    if (!(await directoryExists(root, absolute))) continue;
    for (const profile of PROFILES) targets.push(join(cargoRoot, profile, 'incremental'));
    // Cargo places cross-compilation profiles one directory below its target root. Ignore
    // cache internals; include link entries so the later preflight rejects unsafe target paths.
    for (const entry of await readdir(absolute, { withFileTypes: true })) {
      if (!(entry.isDirectory() || entry.isSymbolicLink()) || PROFILES.includes(entry.name)) continue;
      for (const profile of PROFILES) targets.push(join(cargoRoot, entry.name, profile, 'incremental'));
    }
  }
  return targets;
}

export async function cleanTargets(
  level = 'clean',
  { root = ROOT, dryRun = false, remove = rm, log = console.log } = {},
) {
  if (!LEVELS.includes(level)) throw new Error(`未知清理级别：${level}`);
  const started = performance.now();
  root = resolve(root);
  await validateRoot(root);
  const paths = [...TEMP_TARGETS];
  if (level === 'incremental') paths.push(...(await incrementalTargets(root)));
  if (level === 'build' || level === 'all') paths.push(...CARGO_ROOTS, 'dist');
  if (level === 'all') paths.push('node_modules');
  const targets = [...new Set(paths.map((path) => resolve(root, path)))];

  // Finish the complete preflight before deleting anything, even when a later target is unsafe.
  const exists = await Promise.all(targets.map((target) => directoryExists(root, target)));
  // Compare index paths instead of case-sensitive Git pathspecs: Windows may spell a
  // tracked directory differently from the whitelist. Also protect tracked ancestors
  // (for example a submodule) without walking the generated file trees.
  const labels = targets.map((target) => relative(root, target).split(sep).join('/').toLowerCase());
  const tracked = (await git(root, ['ls-files', '--cached', '-z'])).split('\0').filter((path) => {
    if (!path) return false;
    const lower = path.toLowerCase();
    return labels.some((label) => lower === label || lower.startsWith(`${label}/`) || label.startsWith(`${lower}/`));
  });
  if (tracked.length) throw new Error(`清理目标包含 Git 跟踪文件，已拒绝：${tracked.join(', ')}`);

  log(`${dryRun ? '预览' : '清理'}级别：${level}；目标 ${targets.length} 个`);
  if (dryRun) {
    for (const [index, target] of targets.entries())
      log(`  ${exists[index] ? '[将删除]' : '[不存在]'} ${relative(root, target)}`);
    log(`预览完成：未删除任何目录，耗时 ${((performance.now() - started) / 1000).toFixed(2)} 秒`);
    return { targets, removed: [], failures: [] };
  }

  const removed = [];
  const failures = [];
  let next = 0;
  async function worker() {
    while (next < targets.length) {
      const index = next++;
      const target = targets[index];
      const label = relative(root, target);
      if (!exists[index]) {
        log(`  [不存在] ${label}`);
        continue;
      }
      try {
        // Recheck ancestors immediately before removal. fs.rm removes internal symlinks
        // themselves, rather than traversing their targets.
        await directoryExists(root, target);
        await remove(target, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
        removed.push(target);
        log(`  [已删除] ${label}`);
      } catch (error) {
        failures.push({ target, error });
        log(`  [失败] ${label}: ${error.message}`);
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(4, targets.length) }, () => worker()));
  log(
    `清理${failures.length ? '结束' : '完成'}：删除 ${removed.length} 个目录，失败 ${failures.length} 个，耗时 ${((performance.now() - started) / 1000).toFixed(2)} 秒`,
  );
  if (failures.length)
    throw new AggregateError(
      failures.map(({ error }) => error),
      `有 ${failures.length} 个清理目标失败`,
    );
  return { targets, removed, failures };
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === '--help') {
    console.log(USAGE);
    return;
  }
  const level = args[0] && !args[0].startsWith('--') ? args.shift() : 'clean';
  if (!LEVELS.includes(level) || args.length > 1 || (args.length === 1 && args[0] !== '--dry-run'))
    throw new Error(USAGE);
  await cleanTargets(level, { dryRun: args.includes('--dry-run') });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
