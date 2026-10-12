import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { prepareRelease, releaseRepository } from '../scripts/changelog.mjs';
import {
  cleanBundles,
  collectPackages,
  PACKAGES,
  packageNames,
  publishRelease,
  releaseNotes,
  verifyPackages,
} from '../scripts/release.mjs';

const VERSION = '1.2.3';
const NOTES = {
  en: `# ${VERSION} - 2026-10-04

## Added
- Add meter support; see [Usage](../../docs/en/USAGE.md#monitor-workspace).
`,
  'zh-CN': `# ${VERSION} - 2026-10-04

## 新增
- 新增仪表支持，参见 [使用说明](../../docs/USAGE.md#监控工作区)。
## 修复
- 修复导入记录，参见 [官网](https://example.com)。
`,
};
const INDEX = `# Changelog

<!-- releases:start -->

## [Unreleased]

待发布草稿

<!-- releases:end -->

## [0.1.0] - 2026-01-20
- 旧版本的改动
`;
const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'lapower-release-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = join(root, 'dist/packages');
  await mkdir(directory, { recursive: true });
  await writeFile(join(root, 'CHANGELOG.md'), INDEX);
  await mkdir(join(root, 'changelog', VERSION), { recursive: true });
  for (const [language, text] of Object.entries(NOTES)) {
    await writeFile(join(root, 'changelog', VERSION, `${language}.md`), text);
  }
  const names = Object.keys(PACKAGES).flatMap((id) => packageNames(VERSION, id));
  for (const name of names) await writeFile(join(directory, name), `installer contents: ${name}`);
  return { root, directory, names };
}

function githubMock({
  release = null,
  assets = [],
  failUploadAt = 0,
  corruptDigest = false,
  publishEarly = false,
} = {}) {
  const state = { release, assets, calls: [], uploads: 0 };
  const json = (body, status = 200) => new Response(JSON.stringify(body), { status });
  async function request(url, options) {
    const { pathname, searchParams } = new URL(url);
    const method = options.method;
    state.calls.push({ method, pathname });
    if (method === 'GET' && pathname.endsWith('/releases')) return json(state.release ? [state.release] : []);
    if (method === 'POST' && pathname.endsWith('/releases')) {
      state.release = {
        id: 7,
        upload_url: 'https://uploads.github.test/assets{?name,label}',
        ...JSON.parse(options.body),
      };
      return json(state.release, 201);
    }
    if (method === 'GET' && pathname.endsWith('/releases/7/assets')) return json(state.assets);
    if (method === 'GET' && pathname.endsWith('/releases/7')) {
      if (publishEarly) state.release.draft = false;
      return json(state.release);
    }
    if (method === 'DELETE' && pathname.includes('/releases/assets/')) {
      const id = Number(pathname.split('/').at(-1));
      state.assets = state.assets.filter((asset) => asset.id !== id);
      return new Response(null, { status: 204 });
    }
    if (method === 'POST' && pathname === '/assets') {
      state.uploads++;
      if (state.uploads === failUploadAt) return json({ message: 'upload failed' }, 502);
      const asset = {
        id: state.uploads + 100,
        name: searchParams.get('name'),
        size: options.body.byteLength,
        state: 'uploaded',
        digest: `sha256:${corruptDigest ? 'invalid' : createHash('sha256').update(options.body).digest('hex')}`,
      };
      state.assets.push(asset);
      return json(asset, 201);
    }
    if (method === 'PATCH' && pathname.endsWith('/releases/7')) {
      Object.assign(state.release, JSON.parse(options.body), {
        html_url: 'https://github.test/owner/repo/releases/v1.2.3',
      });
      return json(state.release);
    }
    throw new Error(`Unexpected API call: ${method} ${url}`);
  }
  return { state, request };
}

const draft = () => ({
  id: 7,
  tag_name: `v${VERSION}`,
  draft: true,
  prerelease: false,
  upload_url: 'https://uploads.github.test/assets{?name,label}',
});

async function publisher(t, mockOptions) {
  const { root, directory, names } = await fixture(t);
  await verifyPackages(directory, VERSION, { writeChecksums: true });
  const mock = githubMock(mockOptions);
  return {
    ...mock,
    directory,
    names,
    options: {
      directory,
      root,
      version: VERSION,
      tag: `v${VERSION}`,
      repository: 'owner/repo',
      commit: 'a'.repeat(40),
      token: 'test-token',
      apiUrl: 'https://api.github.test',
      request: mock.request,
    },
  };
}

test('complete installer set produces deterministic checksums; modified files cannot be published', async (t) => {
  const { directory, names } = await fixture(t);
  const assets = await verifyPackages(directory, VERSION, { writeChecksums: true });
  assert.equal(names.length, 7);
  assert.equal(assets.length, 8);
  const sums = await readFile(join(directory, 'SHA256SUMS'), 'utf8');
  assert.equal(sums.trimEnd().split('\n').length, 7);
  for (const asset of assets.filter(({ name }) => name !== 'SHA256SUMS')) {
    const content = await readFile(join(directory, asset.name));
    assert.ok(sums.includes(`${createHash('sha256').update(content).digest('hex')}  ${asset.name}\n`));
  }
  assert.deepEqual(await verifyPackages(directory, VERSION), assets);
  await writeFile(join(directory, names[0]), 'different installer');
  await assert.rejects(verifyPackages(directory, VERSION), /SHA256SUMS/);
});

test('missing architectures, stale versions, unexpected and empty files are rejected', async (t) => {
  for (const problem of ['missing', 'stale', 'extra', 'empty']) {
    await t.test(problem, async (sub) => {
      const { directory, names } = await fixture(sub);
      if (problem === 'missing')
        await rm(
          join(
            directory,
            names.find((name) => name.includes('macos-x64')),
          ),
        );
      if (problem === 'stale') {
        await rm(join(directory, names[0]));
        await writeFile(join(directory, names[0].replace(VERSION, '1.2.2')), 'old installer');
      }
      if (problem === 'extra') await writeFile(join(directory, 'unexpected.txt'), 'unexpected');
      if (problem === 'empty') await writeFile(join(directory, names[0]), '');
      await assert.rejects(verifyPackages(directory, VERSION, { writeChecksums: true }), /七个|非空/);
    });
  }
});

test('collect native installers from workspace target directories and normalize their names', async (t) => {
  const { root, directory, names } = await fixture(t);
  for (const name of names) await rm(join(directory, name));
  for (const [id, { target, bundles }] of Object.entries(PACKAGES)) {
    const expected = packageNames(VERSION, id);
    for (const [i, bundle] of bundles.entries()) {
      const dir = join(root, 'target', target, 'release/bundle', bundle);
      await mkdir(dir, { recursive: true });
      const ext = expected[i].slice(expected[i].lastIndexOf('.'));
      const filename = bundle === 'rpm' ? `laPower-${VERSION}-1.x86_64.rpm` : `laPower_${VERSION}_arch${ext}`;
      await writeFile(join(dir, filename), `native ${id}/${bundle}`);
    }
    assert.deepEqual(await collectPackages(id, VERSION, root), expected);
  }
  assert.deepEqual((await readdir(directory)).sort(), names.sort());
  await verifyPackages(directory, VERSION, { writeChecksums: true });
  const debDir = join(root, 'target', PACKAGES['linux-x64'].target, 'release/bundle/deb');
  await writeFile(join(debDir, `second_${VERSION}_amd64.deb`), 'duplicate');
  await assert.rejects(collectPackages('linux-x64', VERSION, root), /应有一个/);
  await rm(join(debDir, `second_${VERSION}_amd64.deb`));
  await assert.rejects(collectPackages('linux-x64', '1.2.4', root), /版本与清单/);
});

test('package names reject invalid versions and target paths', () => {
  for (const version of ['1.2.3\n', '01.2.3', 'v1.2.3', '1.2.3-beta', '../1.2.3']) {
    assert.throws(() => packageNames(version, 'linux-x64'), /无效/);
  }
  for (const id of ['../linux-x64', '__proto__', 'missing']) {
    assert.throws(() => packageNames(VERSION, id), /未知/);
  }
});

test('clean cached bundles without removing Rust dependencies or other targets', async (t) => {
  const { root } = await fixture(t);
  const target = PACKAGES['linux-x64'].target;
  const release = join(root, 'target', target, 'release');
  await mkdir(join(release, 'bundle/deb'), { recursive: true });
  await mkdir(join(release, 'deps'));
  await writeFile(join(release, 'bundle/deb/old.deb'), 'cached installer');
  await writeFile(join(release, 'deps/keep.rlib'), 'cached Rust dependency');
  const otherBundle = join(root, 'target', PACKAGES['windows-x64'].target, 'release/bundle/msi');
  await mkdir(otherBundle, { recursive: true });
  await writeFile(join(otherBundle, 'keep.msi'), 'another target');
  await cleanBundles('linux-x64', root);
  assert.deepEqual(await readdir(release), ['deps']);
  assert.equal(await readFile(join(release, 'deps/keep.rlib'), 'utf8'), 'cached Rust dependency');
  assert.equal(await readFile(join(otherBundle, 'keep.msi'), 'utf8'), 'another target');
  await assert.rejects(cleanBundles('../linux-x64', root), /未知/);
});

test('publish a draft only after all eight uploaded assets pass size and digest verification', async (t) => {
  const { options, state } = await publisher(t);
  const url = await publishRelease(options);
  assert.equal(url, 'https://github.test/owner/repo/releases/v1.2.3');
  assert.equal(state.release.draft, false);
  assert.equal(state.release.prerelease, false);
  assert.equal(state.release.body, releaseNotes(NOTES, VERSION, 'owner/repo'));
  assert.equal(state.release.generate_release_notes, undefined);
  assert.equal(state.assets.length, 8);
  assert.equal(state.calls.at(-2).method, 'GET');
  assert.ok(state.calls.at(-2).pathname.endsWith('/assets'));
  assert.equal(state.calls.at(-1).method, 'PATCH');
});

test('failed uploads and remote digest corruption keep the release draft', async (t) => {
  for (const mockOptions of [{ failUploadAt: 2 }, { corruptDigest: true }]) {
    await t.test(JSON.stringify(mockOptions), async (sub) => {
      const { options, state } = await publisher(sub, mockOptions);
      await assert.rejects(publishRelease(options), /失败/);
      assert.equal(state.release.draft, true);
      assert.equal(
        state.calls.some(({ method }) => method === 'PATCH'),
        false,
      );
    });
  }
});

test('rerun replaces only the owned draft assets and then publishes', async (t) => {
  const name = packageNames(VERSION, 'linux-x64')[0];
  const { options, state } = await publisher(t, { release: draft(), assets: [{ id: 42, name }] });
  await publishRelease(options);
  assert.equal(
    state.calls.some(({ method, pathname }) => method === 'POST' && pathname.endsWith('/releases')),
    false,
  );
  assert.ok(state.calls.some(({ method, pathname }) => method === 'DELETE' && pathname.endsWith('/42')));
  assert.equal(state.assets.length, 8);
  assert.equal(state.release.draft, false);
  assert.equal(state.release.body, releaseNotes(NOTES, VERSION, 'owner/repo'));
});

test('release notes expand English, collapse Chinese and pin relative links to the tag', () => {
  const body = releaseNotes(
    Object.fromEntries(Object.entries(NOTES).map(([key, text]) => [key, text.replaceAll('\n', '\r\n')])),
    VERSION,
    'owner/repo',
  );
  assert.ok(body.indexOf('## Added') < body.indexOf('<details>'));
  assert.ok(body.includes('<summary>简体中文</summary>'));
  assert.ok(body.includes('## 新增\n- 新增仪表支持'));
  assert.ok(body.includes('https://github.com/owner/repo/blob/v1.2.3/docs/USAGE.md#监控工作区'));
  assert.ok(body.includes('https://github.com/owner/repo/blob/v1.2.3/docs/en/USAGE.md#monitor-workspace'));
  assert.ok(body.includes('[官网](https://example.com)'));
  assert.ok(body.includes('## Download and installation'));
  assert.ok(body.includes('## 下载与安装'));
  assert.ok(!body.includes('旧版本的改动'));
});

test('missing or empty bilingual notes stop publication before any GitHub request', async (t) => {
  for (const language of ['en', 'zh-CN']) {
    for (const problem of ['missing', 'empty']) {
      await t.test(`${language}: ${problem}`, async (sub) => {
        const { options, state } = await publisher(sub);
        const path = join(options.root, 'changelog', VERSION, `${language}.md`);
        if (problem === 'missing') await rm(path);
        else await writeFile(path, `# ${VERSION}\n\n## Added\n`);
        await assert.rejects(publishRelease(options), /更新日志/);
        assert.equal(state.calls.length, 0);
      });
    }
  }
});

async function preparationFixture(t) {
  const { root } = await fixture(t);
  await mkdir(join(root, 'changelog/unreleased'));
  for (const [language, text] of Object.entries(NOTES))
    await writeFile(join(root, 'changelog/unreleased', `${language}.md`), text);
  for (const rel of [
    'package.json',
    'package-lock.json',
    'Cargo.toml',
    'Cargo.lock',
    'src-tauri/tauri.conf.json',
    ...['src-tauri', 'crates/usbpd-parser', 'crates/witrn-hid', 'crates/km003c'].map(
      (member) => `${member}/Cargo.toml`,
    ),
  ]) {
    await mkdir(dirname(join(root, rel)), { recursive: true });
    await writeFile(join(root, rel), await readFile(join(REPO_ROOT, rel)));
  }
  return root;
}

test('release preparation dry-run writes nothing; preparation archives notes and synchronizes versions', async (t) => {
  const root = await preparationFixture(t);
  const manifest = await readFile(join(root, 'package.json'), 'utf8');
  const options = { root, date: '2026-10-12', repository: 'owner/repo' };
  const preview = await prepareRelease('1.2.4', { ...options, dryRun: true });
  assert.ok(preview.body.includes('/blob/v1.2.4/'));
  assert.equal(await readFile(join(root, 'package.json'), 'utf8'), manifest);
  assert.equal(await readFile(join(root, 'CHANGELOG.md'), 'utf8'), INDEX);
  await assert.rejects(readFile(join(root, 'changelog/1.2.4/en.md')), /ENOENT/);
  await assert.rejects(readFile(join(root, 'dist/release-notes.md')), /ENOENT/);
  assert.equal(await readFile(join(root, 'changelog/unreleased/zh-CN.md'), 'utf8'), NOTES['zh-CN']);
  const result = await prepareRelease('1.2.4', options);
  assert.equal(result.body, preview.body);
  assert.equal(JSON.parse(await readFile(join(root, 'package.json'), 'utf8')).version, '1.2.4');
  assert.equal(JSON.parse(await readFile(join(root, 'package-lock.json'), 'utf8')).packages[''].version, '1.2.4');
  assert.equal(JSON.parse(await readFile(join(root, 'src-tauri/tauri.conf.json'), 'utf8')).version, '1.2.4');
  const index = await readFile(join(root, 'CHANGELOG.md'), 'utf8');
  assert.ok(index.includes('## [1.2.4] - 2026-10-12'));
  assert.equal(index.match(/^## \[Unreleased\]/gm)?.length, 1);
  assert.ok(!index.includes('待发布草稿'));
  assert.ok(index.endsWith('## [0.1.0] - 2026-01-20\n- 旧版本的改动\n'));
  assert.equal(await readFile(join(root, 'dist/release-notes.md'), 'utf8'), result.body);
  const en = await readFile(join(root, 'changelog/1.2.4/en.md'), 'utf8');
  const zh = await readFile(join(root, 'changelog/1.2.4/zh-CN.md'), 'utf8');
  assert.ok(en.startsWith('# 1.2.4 - 2026-10-12'));
  assert.equal(releaseNotes({ en, 'zh-CN': zh }, '1.2.4', 'owner/repo'), result.body);
  assert.equal(await readFile(join(root, 'changelog/unreleased/zh-CN.md'), 'utf8'), '# Unreleased\n');
});

test('failed preparation preserves drafts and does not overwrite a version directory', async (t) => {
  const root = await preparationFixture(t);
  const options = { root, date: '2026-10-12', repository: 'owner/repo' };
  await assert.rejects(prepareRelease(VERSION, options), /不覆盖/);
  assert.equal(await readFile(join(root, 'changelog', VERSION, 'en.md'), 'utf8'), NOTES.en);
  await assert.rejects(prepareRelease('../unsafe', options), /无效/);
  await assert.rejects(prepareRelease('1.2.4', { ...options, date: '2026-02-30' }), /发布日期/);
  await rm(join(root, 'changelog/unreleased/en.md'));
  await assert.rejects(prepareRelease('1.2.4', options), /更新日志缺失/);
  assert.equal(await readFile(join(root, 'changelog/unreleased/zh-CN.md'), 'utf8'), NOTES['zh-CN']);
  await writeFile(join(root, 'changelog/unreleased/en.md'), NOTES.en);
  await rm(join(root, 'Cargo.lock'));
  await assert.rejects(prepareRelease('1.2.4', options), /ENOENT/);
  assert.equal(await readFile(join(root, 'changelog/unreleased/en.md'), 'utf8'), NOTES.en);
  await assert.rejects(readFile(join(root, 'changelog/1.2.4/en.md')), /ENOENT/);
});

test('output write failure leaves both preparation drafts intact', async (t) => {
  const root = await preparationFixture(t);
  const manifest = await readFile(join(root, 'package.json'), 'utf8');
  await mkdir(join(root, 'dist/release-notes.md'));
  await assert.rejects(prepareRelease('1.2.4', { root, date: '2026-10-12', repository: 'owner/repo' }));
  for (const [language, text] of Object.entries(NOTES)) {
    assert.equal(await readFile(join(root, 'changelog/unreleased', `${language}.md`), 'utf8'), text);
  }
  assert.equal(await readFile(join(root, 'package.json'), 'utf8'), manifest);
  assert.equal(await readFile(join(root, 'CHANGELOG.md'), 'utf8'), INDEX);
});

test('repository identity prefers the environment and otherwise reads GitHub origin', async (t) => {
  const { root } = await fixture(t);
  assert.equal(releaseRepository(root, { GITHUB_REPOSITORY: 'fork/project' }), 'fork/project');
  execFileSync('git', ['init', root]);
  execFileSync('git', ['-C', root, 'remote', 'add', 'origin', 'git@github.com:owner/project.git']);
  assert.equal(releaseRepository(root, {}), 'owner/project');
});

test('a failed release listing never creates another draft', async (t) => {
  const { options, state } = await publisher(t);
  options.request = async (url, requestOptions) => {
    assert.equal(requestOptions.method, 'GET');
    assert.ok(new URL(url).pathname.endsWith('/releases'));
    return new Response(null, { status: 403 });
  };
  await assert.rejects(publishRelease(options), /403/);
  assert.equal(state.release, null);
});

test('draft lookup follows pagination before deciding to create a release', async (t) => {
  const { options, state, request } = await publisher(t, { release: draft() });
  const pages = [];
  options.request = async (url, requestOptions) => {
    const parsed = new URL(url);
    if (requestOptions.method === 'GET' && parsed.pathname.endsWith('/releases')) {
      const page = Number(parsed.searchParams.get('page'));
      pages.push(page);
      const items = page === 1 ? Array.from({ length: 100 }, (_, i) => ({ tag_name: `v0.0.${i}` })) : [draft()];
      return new Response(JSON.stringify(items), { status: 200 });
    }
    return request(url, requestOptions);
  };
  await publishRelease(options);
  assert.deepEqual(pages, [1, 2]);
  assert.equal(
    state.calls.some(({ method, pathname }) => method === 'POST' && pathname.endsWith('/releases')),
    false,
  );
});

test('already published releases and drafts with unrelated assets are never overwritten', async (t) => {
  for (const mockOptions of [
    { release: { ...draft(), draft: false } },
    { release: draft(), assets: [{ id: 42, name: 'manual-attachment.zip' }] },
    { release: draft(), publishEarly: true },
  ]) {
    await t.test(JSON.stringify(mockOptions), async (sub) => {
      const { options, state } = await publisher(sub, mockOptions);
      await assert.rejects(publishRelease(options), /不自动覆盖|人工检查/);
      assert.ok(state.calls.every(({ method }) => method === 'GET'));
    });
  }
});

test('wrong tag, missing credentials and modified checksums fail before any GitHub request', async (t) => {
  const { options, state, directory } = await publisher(t);
  await assert.rejects(publishRelease({ ...options, tag: 'v1.2.4' }), /Tag/);
  await assert.rejects(publishRelease({ ...options, token: '' }), /GITHUB_TOKEN/);
  await writeFile(join(directory, 'SHA256SUMS'), 'corrupted checksums');
  await assert.rejects(publishRelease(options), /SHA256SUMS/);
  assert.equal(state.calls.length, 0);
});
