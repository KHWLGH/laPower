/*! SPDX-FileCopyrightText: 2026 KHWLGH
 * SPDX-License-Identifier: GPL-3.0-only
 */
/** Offline license collection. Supplemental upstream texts are pinned in licenses/materials.json. */
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';

export const PROJECT_COPYRIGHT = 'Copyright (C) 2026 KHWLGH';
const PROJECT_DOCUMENTS = [
  { id: 'copyright', title: 'Copyright and licensing', path: 'COPYRIGHT' },
  { id: 'gpl-3.0', title: 'GNU General Public License v3.0', path: 'LICENSE' },
  { id: 'lgpl-3.0', title: 'GNU Lesser General Public License v3.0', path: 'LICENSE.LGPL-3.0' },
];
const MATERIAL_NAME = /^(?:licen[cs]e|copying|copyright|notice|unlicense)(?:[._-]|$)/i;
const EXCLUDED_DIRECTORIES = /^(?:tests?|examples?|benches|fuzz|docs?|\.git)$/i;
const SIGNATURES = {
  MIT: /permission is hereby granted[\s\S]*?free of charge[\s\S]*?(?:copyright notice[\s\S]*?permission notice|copyright and permission notices)[\s\S]*?THE SOFTWARE IS PROVIDED[\s\S]*?AS IS[\s\S]*?WARRANT[\s\S]*?IN NO EVENT[\s\S]*?LIAB[\s\S]*?(?:SOFTWARE|PROGRAM)/i,
  'MIT-0':
    /permission is hereby granted[\s\S]*?free of charge[\s\S]*?THE SOFTWARE IS PROVIDED[\s\S]*?AS IS[\s\S]*?WARRANT[\s\S]*?IN NO EVENT[\s\S]*?LIAB[\s\S]*?SOFTWARE/i,
  'Apache-2.0':
    /Apache License[\s\S]*?Version 2\.0[\s\S]*?1\.\s*Definitions[\s\S]*?2\.\s*Grant of Copyright License[\s\S]*?3\.\s*Grant of Patent License[\s\S]*?4\.\s*Redistribution[\s\S]*?5\.\s*Submission of Contributions[\s\S]*?6\.\s*Trademarks[\s\S]*?7\.\s*Disclaimer of Warranty[\s\S]*?8\.\s*Limitation of Liability[\s\S]*?9\.\s*Accepting Warranty[\s\S]*?(?:END OF TERMS AND CONDITIONS|of your accepting any such warranty or additional liability\.)/i,
  'LLVM-exception':
    /LLVM Exceptions to the Apache 2\.0 License[\s\S]*?Sections 4\(a\), 4\(b\) and 4\(d\)[\s\S]*?In addition[\s\S]*?GPLv2[\s\S]*?only in their entirety[\s\S]*?Combined\s+Software/i,
  'BSD-2-Clause':
    /redistribution and use in source and binary forms[\s\S]*?source code must retain[\s\S]*?binary form must reproduce[\s\S]*?THIS SOFTWARE IS PROVIDED[\s\S]*?WARRANT[\s\S]*?IN NO EVENT[\s\S]*?DAMAGE/i,
  'BSD-3-Clause':
    /redistribution and use in source and binary forms[\s\S]*?source code must retain[\s\S]*?binary form must reproduce[\s\S]*?(?:Neither[\s\S]*?may be used|may not be used) to endorse[\s\S]*?THIS SOFTWARE IS PROVIDED[\s\S]*?WARRANT[\s\S]*?IN NO EVENT[\s\S]*?DAMAGE/i,
  ISC: /permission to use, copy, modify, and(?:\/or)? distribute[\s\S]*?copyright notice[\s\S]*?permission notice[\s\S]*?THE SOFTWARE IS PROVIDED[\s\S]*?AS IS[\s\S]*?WARRANT[\s\S]*?IN NO EVENT[\s\S]*?LIAB[\s\S]*?PERFORMANCE OF THIS SOFTWARE/i,
  'Unicode-3.0':
    /UNICODE LICENSE V3[\s\S]*?Permission is hereby granted[\s\S]*?copyright and permission notice[\s\S]*?THE DATA FILES AND SOFTWARE ARE PROVIDED[\s\S]*?AS IS[\s\S]*?WARRANT[\s\S]*?IN NO EVENT[\s\S]*?LIAB[\s\S]*?prior written\s+authorization of the copyright holder/i,
  'MPL-2.0':
    /Mozilla Public License[\s\S]*?(?:Version|v\.)\s*2\.0[\s\S]*?1\.\s*Definitions[\s\S]*?10\.4\.[\s\S]*?Exhibit A[\s\S]*?Exhibit B[\s\S]*?defined by the Mozilla Public License, v\. 2\.0/i,
  Unlicense:
    /This is free and unencumbered software released into the public domain[\s\S]*?THE SOFTWARE IS PROVIDED[\s\S]*?WARRANT[\s\S]*?IN NO EVENT[\s\S]*?LIAB[\s\S]*?unlicense\.org/i,
  '0BSD':
    /Permission to use, copy, modify, and(?:\/or)? distribute[\s\S]*?THE SOFTWARE IS PROVIDED[\s\S]*?AS IS[\s\S]*?WARRANT[\s\S]*?IN NO EVENT[\s\S]*?LIAB[\s\S]*?PERFORMANCE OF THIS SOFTWARE/i,
  'CC0-1.0':
    /CC0 1\.0 Universal[\s\S]*?Statement of Purpose[\s\S]*?3\. Public License Fallback[\s\S]*?4\. Limitations and Disclaimers[\s\S]*?Creative Commons is not a party to this document/i,
  Zlib: /provided 'as-is'[\s\S]*?1\. The origin of this software must not be misrepresented[\s\S]*?2\. Altered source versions[\s\S]*?3\. This notice may not be removed or altered from any source distribution/i,
  'GPL-3.0-only':
    /GNU GENERAL PUBLIC LICENSE[\s\S]*?Version 3[\s\S]*?0\. Definitions[\s\S]*?16\. Limitation of Liability[\s\S]*?17\. Interpretation of Sections 15 and 16[\s\S]*?unless a warranty or assumption of liability accompanies a[\s\S]*?copy of the Program/i,
};

/** Preserve all content, including BOM, whitespace and final-newline state. */
export function normalizeLicenseText(text) {
  if (typeof text !== 'string') throw new Error('License text must be a string');
  return text.replace(/\r\n/g, '\n');
}

export function licenseTextId(text) {
  return createHash('sha256').update(normalizeLicenseText(text), 'utf8').digest('hex');
}

const componentKey = (item) => JSON.stringify([item.name, item.version]);
const readUtf8 = (path) => new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(readFileSync(path));
function requireValue(condition, message) {
  if (!condition) throw new Error(`Invalid legal catalog: ${message}`);
}

/** Pure synchronous validator: returns undefined on success; throws Error on invalid or mismatched data. */
export function validateLegalCatalog(catalog, manifest) {
  requireValue(catalog?.schemaVersion === 1, 'unsupported schemaVersion');
  requireValue(catalog.project?.copyright === PROJECT_COPYRIGHT, 'project copyright');
  requireValue(catalog.texts && typeof catalog.texts === 'object' && !Array.isArray(catalog.texts), 'texts object');
  for (const [id, text] of Object.entries(catalog.texts)) {
    requireValue(typeof text === 'string' && text.length > 0 && /\S/.test(text), `empty text ${id}`);
    requireValue(/^[a-f0-9]{64}$/.test(id) && licenseTextId(text) === id, `text hash ${id}`);
    requireValue(normalizeLicenseText(text) === text, `CRLF text ${id}`);
  }
  const referenced = new Set();
  function validateDocuments(documents, label) {
    requireValue(Array.isArray(documents) && documents.length > 0, `missing documents for ${label}`);
    const paths = new Set();
    for (const document of documents) {
      requireValue(typeof document.path === 'string' && document.path.length > 0, `document path for ${label}`);
      requireValue(!paths.has(document.path), `duplicate document path for ${label}`);
      paths.add(document.path);
      requireValue(Object.hasOwn(catalog.texts, document.textId), `missing text for ${label}/${document.path}`);
      requireValue(document.origin === undefined || typeof document.origin === 'string', `origin for ${label}`);
      referenced.add(document.textId);
    }
  }
  validateDocuments(catalog.project.documents, 'project');
  requireValue(catalog.project.documents.length === PROJECT_DOCUMENTS.length, 'project document count');
  for (const expected of PROJECT_DOCUMENTS) {
    const document = catalog.project.documents.find((item) => item.id === expected.id);
    requireValue(document?.path === expected.path, `project document ${expected.id}`);
    requireValue(typeof document.title === 'string' && document.title.length > 0, `project title ${expected.id}`);
  }
  requireValue(Array.isArray(catalog.components) && Array.isArray(manifest?.components), 'components array');
  const expected = new Map();
  for (const item of manifest.components) {
    const key = componentKey(item);
    requireValue(!expected.has(key), `duplicate manifest component ${key}`);
    expected.set(key, item);
  }
  const found = new Set();
  for (const item of catalog.components) {
    requireValue(typeof item.name === 'string' && item.name.length > 0, 'component name');
    requireValue(item.version === null || typeof item.version === 'string', `version for ${item.name}`);
    const key = componentKey(item);
    requireValue(!found.has(key), `duplicate component ${key}`);
    found.add(key);
    requireValue(expected.has(key) && expected.get(key).license === item.license, `manifest mismatch ${key}`);
    validateDocuments(item.documents, key);
  }
  requireValue(found.size === expected.size, 'missing component documents');
  requireValue(referenced.size === Object.keys(catalog.texts).length, 'unreferenced text');
}

function within(root, path) {
  if (isAbsolute(path)) throw new Error(`License path must be relative: ${path}`);
  const absolute = resolve(root, path);
  const fromRoot = relative(realpathSync(root), realpathSync(absolute));
  if (fromRoot === '..' || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) {
    throw new Error(`License path escapes its source: ${path}`);
  }
  return absolute;
}

/** Include actual notices under source/native trees, excluding test fixtures and unused dbus source. */
export function packageLicensePaths(pkg) {
  const root = dirname(pkg.manifest_path);
  const paths = new Set();
  if (pkg.license_file) {
    // Cargo metadata normally reports an absolute license_file; support both forms.
    const path = isAbsolute(pkg.license_file) ? relative(root, pkg.license_file) : pkg.license_file;
    within(root, path);
    paths.add(path.split(sep).join('/'));
  }
  function visit(directory, prefix = '') {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = `${prefix}${entry.name}`;
      if (entry.isDirectory()) {
        if (EXCLUDED_DIRECTORIES.test(entry.name)) continue;
        if (pkg.name === 'libdbus-sys' && path === 'vendor' && !pkg.runtimeFeatures?.includes('vendored')) continue;
        visit(resolve(directory, entry.name), `${path}/`);
      } else if (
        entry.isFile() &&
        MATERIAL_NAME.test(entry.name) &&
        !/\.(?:rs|c|h|cpp|js|json|spdx)$/i.test(entry.name)
      ) {
        paths.add(path);
      }
    }
  }
  visit(root);
  return [...paths].sort();
}

/** License-file-only packages use a Cargo LicenseRef while preserving all declared SPDX expressions verbatim. */
export function declaredLicense(pkg) {
  if (pkg.license) return pkg.license;
  if (pkg.license_file) return 'LicenseRef-Cargo-license-file';
  throw new Error(`Missing declared license and license_file: ${pkg.name} ${pkg.version}`);
}

function verifyCoverage(pkg, documents, texts, supplement) {
  if (!documents.length) throw new Error(`Missing real license documents: ${pkg.name} ${pkg.version}`);
  if (!pkg.license || pkg.license === 'LicenseRef-Cargo-license-file') return;
  if (supplement?.review?.kind === 'upstream-missing-license-text') {
    if (!supplement.review.reason || !supplement.review.evidence?.length) {
      throw new Error(`Incomplete reviewed upstream exception: ${pkg.name}`);
    }
    return;
  }
  const sourceTexts = documents
    .filter((document) => !document.path.startsWith('review/'))
    .map((document) => texts[document.textId]);
  // Require every explicitly offered branch, every AND term and every WITH exception.
  let expression = pkg.license;
  if (supplement?.review?.kind === 'selected-upstream-alternative') {
    if (/\b(?:AND|WITH)\b/.test(expression) || !supplement.review.selectedLicense || !supplement.review.reason) {
      throw new Error(`Invalid reviewed alternative selection: ${pkg.name}`);
    }
    const alternatives = expression.split(/\s+OR\s+|\s*\/\s*/);
    if (!alternatives.includes(supplement.review.selectedLicense)) {
      throw new Error(`Selected license is not an upstream alternative: ${pkg.name}`);
    }
    expression = supplement.review.selectedLicense;
  }
  const terms = new Set(expression.match(/[A-Za-z0-9][A-Za-z0-9.+-]*/g));
  for (const term of terms) {
    if (['AND', 'OR', 'WITH'].includes(term)) continue;
    if (!SIGNATURES[term]) throw new Error(`Unreviewed license identifier ${term}: ${pkg.name}`);
    // Whitespace folding is for signature recognition only; stored text and hashes remain untouched.
    if (
      !sourceTexts.some((text) => {
        if (!SIGNATURES[term].test(text.replace(/\s+/g, ' '))) return false;
        return (
          term !== 'GPL-3.0-only' ||
          Array.from({ length: 18 }, (_, index) => index).every((index) =>
            new RegExp(`(?:^|\\n)\\s*${index}\\. `).test(text),
          )
        );
      })
    ) {
      throw new Error(`Missing full ${term} terms in an individual document: ${pkg.name} ${pkg.version}`);
    }
  }
}

/** Build everything in memory. Reads only local package cache and pinned supplemental material. */
export function generateLegalCatalog(root, manifest, packages, materials) {
  if (materials?.schemaVersion !== 1) throw new Error('Unsupported supplemental license material schema');
  const texts = {};
  function document(path, text, origin) {
    const normalized = normalizeLicenseText(text);
    if (!/\S/.test(normalized)) throw new Error(`Empty license document: ${path}`);
    const textId = licenseTextId(normalized);
    texts[textId] = normalized;
    return { path, textId, ...(origin ? { origin } : {}) };
  }
  function supplementDocuments(entry) {
    const documents = entry.documents.map((item) => {
      if (!item.origin || !item.revision || !item.upstreamPath || !/^[a-f0-9]{64}$/.test(item.sha256)) {
        throw new Error(`Unpinned supplemental document: ${item.path}`);
      }
      const text = readUtf8(within(root, item.path));
      if (licenseTextId(text) !== item.sha256) throw new Error(`Supplemental license hash mismatch: ${item.path}`);
      if (item.sourceSnapshot) {
        const snapshot = readFileSync(within(root, item.sourceSnapshot.path));
        const hash = createHash('sha256').update(snapshot).digest('hex');
        if (hash !== item.sourceSnapshot.sha256) throw new Error(`Authority snapshot hash mismatch: ${item.path}`);
      }
      return document(item.path, text, item.origin);
    });
    const notes = entry.documents.filter((item) => item.note).map((item) => `${item.path}: ${item.note}`);
    if (entry.review || entry.note || entry.nativeEvidence || notes.length) {
      const review = entry.review;
      const text = [
        'Project review note (not an upstream license)',
        '项目审核说明（非上游许可证）',
        '',
        `Component: ${entry.name} ${entry.version ?? '(bundled revision)'}`,
        `Cargo source: ${entry.source ?? '(frontend asset)'}`,
        ...(review ? [`Review: ${review.kind}`, `Reason: ${review.reason}`] : []),
        ...(review?.selectedLicense ? [`Selected supplied alternative: ${review.selectedLicense}`] : []),
        ...(entry.note ? ['', entry.note] : []),
        ...(notes.length ? ['', ...notes] : []),
        ...(entry.nativeEvidence
          ? [
              '',
              `Native SDK version: ${entry.nativeEvidence.sdkVersion}`,
              `Native SDK source: ${entry.nativeEvidence.origin}`,
              `Native SDK archive SHA-256: ${entry.nativeEvidence.archiveSha256}`,
              ...entry.nativeEvidence.files.map((item) => `${item.path}: SHA-256 ${item.sha256}`),
            ]
          : []),
        ...(review?.evidence?.length ? ['', 'Evidence:', ...review.evidence] : []),
        '',
        'The upstream license expression is retained without modification. This note does not grant additional rights.',
        '',
      ].join('\n');
      documents.push(document(`review/${encodeURIComponent(entry.name)}@${entry.version ?? 'bundled'}.txt`, text));
    }
    return documents;
  }
  const project = {
    copyright: PROJECT_COPYRIGHT,
    documents: PROJECT_DOCUMENTS.map((item) => ({
      ...item,
      ...document(item.path, readUtf8(within(root, item.path))),
    })),
  };
  const packageMap = new Map(packages.map((pkg) => [componentKey(pkg), pkg]));
  const usedSupplements = new Set();
  const components = manifest.components.map((component) => {
    const pkg = packageMap.get(componentKey(component));
    let documents;
    if (pkg) {
      const supplement = materials.packages.find(
        (item) => item.name === pkg.name && item.version === pkg.version && item.source === pkg.source,
      );
      if (supplement) {
        usedSupplements.add(supplement);
        const native = supplement.nativeEvidence;
        if (native) {
          if (
            !native.sdkVersion ||
            !native.origin ||
            !/^[a-f0-9]{64}$/.test(native.archiveSha256) ||
            !Array.isArray(native.files) ||
            native.files.length === 0
          ) {
            throw new Error(`Unpinned native SDK evidence: ${pkg.name}`);
          }
          for (const item of native.files) {
            const bytes = readFileSync(within(dirname(pkg.manifest_path), item.path));
            const hash = createHash('sha256').update(bytes).digest('hex');
            if (hash !== item.sha256) throw new Error(`Native SDK binary hash mismatch: ${pkg.name}/${item.path}`);
          }
        }
      }
      documents = packageLicensePaths(pkg).map((path) =>
        document(
          `cargo/${pkg.name}@${pkg.version}/${path}`,
          readUtf8(within(dirname(pkg.manifest_path), path)),
          `${pkg.source ?? pkg.repository}#${pkg.name}@${pkg.version}/${path}`,
        ),
      );
      if (supplement) documents.push(...supplementDocuments(supplement));
      verifyCoverage(pkg, documents, texts, supplement);
    } else {
      const supplement = materials.frontend.find((item) => componentKey(item) === componentKey(component));
      if (!supplement) throw new Error(`Missing frontend license material: ${component.name} ${component.version}`);
      usedSupplements.add(supplement);
      documents = supplementDocuments(supplement);
      verifyCoverage(component, documents, texts);
    }
    return { ...component, documents };
  });
  for (const supplement of [...materials.packages, ...materials.frontend]) {
    if (!usedSupplements.has(supplement)) throw new Error(`Unused supplemental material: ${supplement.name}`);
  }
  const sortedTexts = Object.fromEntries(Object.entries(texts).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  const catalog = { schemaVersion: 1, project, components, texts: sortedTexts };
  validateLegalCatalog(catalog, manifest);
  return catalog;
}
