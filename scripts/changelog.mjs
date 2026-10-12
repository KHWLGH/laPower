/** Bilingual Markdown notes and the local, explicit release preparation step. */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, posix, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { VERSION_PATTERN, versionChanges } from './set-version.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const LANGUAGES = ['en', 'zh-CN'];
const START = '<!-- releases:start -->';
const END = '<!-- releases:end -->';
const DRAFT_ENTRY = `## [Unreleased]

[简体中文草稿](changelog/unreleased/zh-CN.md) · [English draft](changelog/unreleased/en.md)`;

function checkVersion(version) {
  if (!VERSION_PATTERN.test(version)) throw new Error(`无效的产品版本：${version}`);
}

function bodyOf(text, language) {
  const body = (text ?? '')
    .replaceAll('\r\n', '\n')
    .trim()
    .replace(/^# [^\n]*\n?/, '')
    .trim();
  if (
    !body
      .replace(/^#{1,6}[^\n]*$/gm, '')
      .replace(/<!--[\s\S]*?-->/g, '')
      .trim()
  ) {
    throw new Error(`更新日志正文为空：${language}.md`);
  }
  return body;
}

export async function readChangelog(version, root = ROOT) {
  if (version !== 'unreleased') checkVersion(version);
  const notes = {};
  for (const language of LANGUAGES) {
    const path = join(root, 'changelog', version, `${language}.md`);
    try {
      notes[language] = await readFile(path, 'utf8');
    } catch (error) {
      if (error.code === 'ENOENT') throw new Error(`更新日志缺失：${path}`);
      throw error;
    }
    bodyOf(notes[language], language);
  }
  return notes;
}

export function releaseRepository(root = ROOT, environment = process.env) {
  let repository = environment.GITHUB_REPOSITORY;
  if (!repository) {
    const origin = execFileSync('git', ['remote', 'get-url', 'origin'], { cwd: root, encoding: 'utf8' }).trim();
    repository = origin.match(
      /^(?:https?:\/\/github\.com\/|ssh:\/\/git@github\.com\/|git@github\.com:)([^/]+\/[^/]+?)(?:\.git)?\/?$/,
    )?.[1];
  }
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository ?? '')) {
    throw new Error('无法确定 GitHub 仓库，请设置 GITHUB_REPOSITORY=owner/repository');
  }
  return repository;
}

function taggedLinks(text, version, language, base) {
  const source = `changelog/${version}/${language}.md`;
  return text.replace(/\]\(([^\s)]+)([^)]*)\)/g, (link, target, suffix) => {
    if (/^(?:[a-z][a-z\d+.-]*:|\/)/i.test(target)) return link;
    const path = target.startsWith('#')
      ? `${source}${target}`
      : posix.normalize(posix.join(posix.dirname(source), target));
    return `](${base}${path}${suffix})`;
  });
}

/** Preview and publication share this renderer; no translation service is called. */
export function releaseNotes(notes, version, repository) {
  checkVersion(version);
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository ?? '')) throw new Error('无效的发布仓库');
  const base = `https://github.com/${repository}/blob/v${version}/`;
  const english = taggedLinks(bodyOf(notes.en, 'en'), version, 'en', base);
  const chinese = taggedLinks(bodyOf(notes['zh-CN'], 'zh-CN'), version, 'zh-CN', base);
  return `## What's changed

${english}

## Download and installation

- Windows x64: MSI or NSIS setup.exe; packages are not certificate-signed.
- macOS 12+: choose macos-x64 for Intel or macos-arm64 for Apple Silicon. Builds use ad-hoc signing, without Developer ID signing or notarization. On first launch, you may need to allow the app in System Settings → Privacy & Security. macOS 12 compatibility still requires real-machine verification.
- Linux x64: DEB, RPM or AppImage. Make the AppImage executable and configure device access using the [udev instructions](${base}docs/en/DEVELOPMENT.md#udev-rules-required). Installers do not change device permissions automatically.
- SHA256SUMS contains SHA-256 checksums for all seven installers.

Full notes: [English](${base}changelog/${version}/en.md) · [Version history](${base}CHANGELOG.md)

<details>
<summary>简体中文</summary>

## 更新内容

${chinese}

## 下载与安装

- Windows x64：MSI 或 NSIS setup.exe；当前未做证书签名。
- macOS 12+：Intel 选择 macos-x64，Apple Silicon 选择 macos-arm64。应用仅有 ad-hoc 签名，未做 Developer ID 签名或公证；首次打开可能需要在「系统设置 → 隐私与安全性」中允许运行。macOS 12 兼容性仍需实机验证。
- Linux x64：DEB、RPM 或 AppImage；AppImage 需赋予执行权限，访问仪表需按[开发指南中的 udev 规则](${base}docs/DEVELOPMENT.md#udev-规则必需)配置。安装包不会自动修改设备权限。
- SHA256SUMS：包含七个安装包的 SHA-256 校验和。

完整说明：[简体中文](${base}changelog/${version}/zh-CN.md) · [版本历史](${base}CHANGELOG.md)

</details>
`;
}

export async function writeReleaseNotes(version, { root = ROOT, repository = releaseRepository(root) } = {}) {
  const body = releaseNotes(await readChangelog(version, root), version, repository);
  const path = join(root, 'dist/release-notes.md');
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, body);
  return path;
}

export async function prepareRelease(version, { date, dryRun = false, root = ROOT, repository } = {}) {
  checkVersion(version);
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(date ?? '') ||
    Number.isNaN(Date.parse(`${date}T00:00:00Z`)) ||
    new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) !== date
  ) {
    throw new Error('发布日期必须为有效的 YYYY-MM-DD');
  }
  const destination = join(root, 'changelog', version);
  if (existsSync(destination)) throw new Error(`版本目录已存在，不覆盖：${destination}`);
  const notes = await readChangelog('unreleased', root);
  const archived = Object.fromEntries(
    LANGUAGES.map((language) => [language, `# ${version} - ${date}\n\n${bodyOf(notes[language], language)}\n`]),
  );
  const body = releaseNotes(archived, version, repository ?? releaseRepository(root));
  const changes = versionChanges(version, root);
  const indexPath = join(root, 'CHANGELOG.md');
  const index = await readFile(indexPath, 'utf8');
  const start = index.indexOf(START);
  const end = index.indexOf(END, start);
  if (start < 0 || end < 0) throw new Error('CHANGELOG.md 缺少版本入口区，请先迁移更新日志');
  const entries = index
    .slice(start + START.length, end)
    .replace(/^## \[Unreleased\][\s\S]*?(?=^## \[|(?![\s\S]))/m, '')
    .trim();
  const entry = `## [${version}] - ${date}\n\n[English](changelog/${version}/en.md) · [简体中文](changelog/${version}/zh-CN.md)`;
  const updatedIndex = `${index.slice(0, start)}${START}\n\n${DRAFT_ENTRY}\n\n${entry}\n\n${entries}\n\n${index.slice(end)}`;
  const files = [
    ...LANGUAGES.map((language) => join('changelog', version, `${language}.md`)),
    ...changes.keys(),
    'CHANGELOG.md',
    'dist/release-notes.md',
    ...LANGUAGES.map((language) => join('changelog/unreleased', `${language}.md`)),
  ];
  if (!dryRun) {
    // Validate everything first. Clear drafts only after all release files have been written.
    await mkdir(destination);
    for (const language of LANGUAGES) await writeFile(join(destination, `${language}.md`), archived[language]);
    await mkdir(join(root, 'dist'), { recursive: true });
    await writeFile(join(root, 'dist/release-notes.md'), body);
    for (const [rel, { after }] of changes) await writeFile(join(root, rel), after);
    await writeFile(indexPath, updatedIndex);
    try {
      for (const language of LANGUAGES)
        await writeFile(join(root, 'changelog/unreleased', `${language}.md`), '# Unreleased\n');
    } catch (error) {
      // If resetting one draft fails, restore what can be restored; archived notes remain intact.
      await Promise.allSettled(
        LANGUAGES.map((language) => writeFile(join(root, 'changelog/unreleased', `${language}.md`), notes[language])),
      );
      throw error;
    }
  }
  return { version, date, files, body };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const [version, ...args] = process.argv.slice(2);
    const dateIndex = args.indexOf('--date');
    if (
      !version ||
      dateIndex < 0 ||
      args.some((arg, index) => index !== dateIndex + 1 && !['--date', '--dry-run'].includes(arg))
    ) {
      throw new Error('用法：npm run release:prepare -- X.Y.Z --date YYYY-MM-DD [--dry-run]');
    }
    const result = await prepareRelease(version, { date: args[dateIndex + 1], dryRun: args.includes('--dry-run') });
    console.log(
      `${args.includes('--dry-run') ? '预览，不写文件' : '发布准备完成'}：${version} (${result.date})\n${result.files.join('\n')}`,
    );
    console.log(`\n${result.body}`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
