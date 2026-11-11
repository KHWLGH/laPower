// @ts-check
/*! SPDX-FileCopyrightText: 2026 KHWLGH
 * SPDX-License-Identifier: GPL-3.0-only */
import { onLanguageChange, t } from '../i18n.js';

/** @typedef {{name: string, version: string|null, license: string, purpose?: string}} Component */
/** @typedef {{status: 'available'|'current'|'no_release', current_version: string, latest_version: string|null, tag: string|null}} UpdateCheck */
/** @typedef {{path: string, textId: string, origin?: string}} LegalDocument */
/** @typedef {LegalDocument & {id: string, title: string}} ProjectDocument */
/** @typedef {{schemaVersion: number, project: {copyright: string, documents: ProjectDocument[]}, components: (Component & {documents: LegalDocument[]})[], texts: Record<string, string>}} LegalCatalog */
/** @typedef {{document: LegalDocument, project?: ProjectDocument, component?: Component, option: HTMLOptionElement}} ReaderDocument */
/** @typedef {{id?: string, component?: Component, versions?: (string|null)[]}} LegalRequest */

const PROJECT_DOCUMENT_KEYS = { copyright: 'projectAttribution', 'gpl-3.0': 'gplLicense', 'lgpl-3.0': 'lgplLicense' };

/** Only initialises UI. A release request requires an explicit button click. */
export function initAboutView() {
  const check = /** @type {HTMLButtonElement} */ (document.getElementById('btn-check-updates'));
  const github = /** @type {HTMLButtonElement} */ (document.getElementById('btn-project-github'));
  const download = /** @type {HTMLButtonElement} */ (document.getElementById('btn-download-update'));
  const region = /** @type {HTMLElement} */ (document.getElementById('about-update'));
  const status = /** @type {HTMLElement} */ (document.getElementById('about-update-status'));
  const summary = /** @type {HTMLElement} */ (document.getElementById('about-components-summary'));
  const componentError = /** @type {HTMLElement} */ (document.getElementById('about-components-error'));
  const legalDialog = /** @type {HTMLDialogElement} */ (document.getElementById('about-legal-dialog'));
  const reader = /** @type {HTMLElement} */ (document.getElementById('about-legal-reader'));
  const legalControls = /** @type {HTMLElement} */ (document.getElementById('about-legal-controls'));
  const documentSelect = /** @type {HTMLSelectElement} */ (document.getElementById('about-legal-document'));
  const legalStatus = /** @type {HTMLElement} */ (document.getElementById('about-legal-status'));
  const legalSource = /** @type {HTMLElement} */ (document.getElementById('about-legal-source'));
  const legalText = /** @type {HTMLElement} */ (document.getElementById('about-legal-text'));
  const legalRetry = /** @type {HTMLButtonElement} */ (document.getElementById('btn-retry-legal'));
  const { invoke } = window.__TAURI__.core;
  /** @type {LegalCatalog|null} */
  let catalog = null;
  /** @type {Promise<void>|null} */
  let catalogLoading = null;
  /** @type {LegalRequest} */
  let legalRequest = { id: 'gpl-3.0' };
  /** @type {ReaderDocument[]} */
  const readerDocuments = [];
  let selectedDocument = -1;
  let legalFailed = false;
  let pending = false;
  let openPending = false;
  let errorKey = '';
  let loadFailed = false;
  /** @type {UpdateCheck|null} */
  let result = null;
  /** @type {{main: Component[], components: Component[]}|null} */
  let manifest = null;

  function renderLegal() {
    const busy = catalogLoading !== null;
    reader.setAttribute('aria-busy', String(busy));
    reader.dataset.state = legalFailed ? 'error' : busy ? 'loading' : 'ready';
    legalStatus.textContent = legalFailed ? t('legalLoadFailed') : busy ? t('legalLoading') : '';
    legalStatus.hidden = !legalFailed && !busy;
    if (legalStatus.parentElement) legalStatus.parentElement.hidden = !legalFailed && !busy;
    legalRetry.hidden = !legalFailed;
    legalControls.hidden = !catalog;
    for (const group of documentSelect.querySelectorAll('optgroup')) {
      group.label = t(group.dataset.legalGroup || '');
    }
    for (const entry of readerDocuments) {
      entry.option.textContent = entry.project
        ? t(PROJECT_DOCUMENT_KEYS[entry.project.id] || '') || entry.project.title
        : `${entry.component?.name} ${entry.component?.version || t('bundledComponent')} · ${entry.document.path.split('/').at(-1)}`;
    }
  }

  /** @param {LegalCatalog} value */
  function validateCatalog(value) {
    if (
      !value ||
      value.schemaVersion !== 1 ||
      value.project?.copyright !== 'Copyright (C) 2026 KHWLGH' ||
      !Array.isArray(value.project.documents) ||
      !Array.isArray(value.components) ||
      !value.texts ||
      typeof value.texts !== 'object' ||
      Array.isArray(value.texts)
    ) {
      throw new Error('Invalid legal catalog');
    }
    /** @param {LegalDocument} entry */
    const validDocument = (entry) =>
      entry &&
      typeof entry.path === 'string' &&
      typeof entry.textId === 'string' &&
      /^[a-f0-9]{64}$/.test(entry.textId) &&
      Object.hasOwn(value.texts, entry.textId) &&
      typeof value.texts[entry.textId] === 'string' &&
      (entry.origin === undefined || typeof entry.origin === 'string');
    if (
      !Object.keys(PROJECT_DOCUMENT_KEYS).every((id) => value.project.documents.some((entry) => entry?.id === id)) ||
      !value.project.documents.every(
        (entry) => validDocument(entry) && typeof entry.id === 'string' && typeof entry.title === 'string',
      ) ||
      !value.components.every(
        (entry) =>
          entry &&
          typeof entry.name === 'string' &&
          (entry.version === null || typeof entry.version === 'string') &&
          typeof entry.license === 'string' &&
          Array.isArray(entry.documents) &&
          entry.documents.length > 0 &&
          entry.documents.every(validDocument),
      )
    ) {
      throw new Error('Invalid legal documents');
    }
  }

  function createDocumentOptions() {
    if (!catalog) return;
    const project = document.createElement('optgroup');
    project.dataset.legalGroup = 'projectLicenses';
    const components = document.createElement('optgroup');
    components.dataset.legalGroup = 'componentLicenses';
    /** @param {LegalDocument} entry @param {HTMLOptGroupElement} group @param {ProjectDocument} [projectDocument] @param {Component} [component] */
    function addOption(entry, group, projectDocument, component) {
      const option = document.createElement('option');
      option.value = String(readerDocuments.length);
      option.title = entry.path;
      readerDocuments.push({ document: entry, project: projectDocument, component, option });
      group.append(option);
    }
    for (const entry of catalog.project.documents) {
      if (entry.id !== 'copyright') addOption(entry, project, entry);
    }
    for (const component of catalog.components) {
      for (const entry of component.documents) addOption(entry, components, undefined, component);
    }
    documentSelect.append(project, components);
  }

  async function loadLegalCatalog() {
    const response = await fetch(new URL('../legal-notices.json', import.meta.url));
    if (!response.ok) throw new Error(String(response.status));
    const value = /** @type {LegalCatalog} */ (await response.json());
    validateCatalog(value);
    catalog = value;
    createDocumentOptions();
  }

  /** Only the chosen document enters the DOM; language changes never replace its text node. @param {number} index */
  function showLegalDocument(index) {
    const entry = readerDocuments[index];
    if (!catalog || !entry) throw new Error('Legal document unavailable');
    legalRequest = entry.project ? { id: entry.project.id } : { component: entry.component };
    documentSelect.value = String(index);
    if (selectedDocument === index) return;
    selectedDocument = index;
    legalSource.textContent = [entry.document.path, entry.document.origin].filter(Boolean).join('\n');
    legalSource.hidden = false;
    legalText.textContent = catalog.texts[entry.document.textId];
    legalText.hidden = false;
    legalText.scrollTop = 0;
    legalText.scrollLeft = 0;
  }

  /** @param {LegalRequest} request */
  async function readLegal(request) {
    legalRequest = request;
    reader.hidden = false;
    if (!legalDialog.open) {
      legalDialog.showModal();
    }
    legalFailed = false;
    try {
      if (!catalog) {
        catalogLoading ||= loadLegalCatalog();
        renderLegal();
        await catalogLoading;
      }
      // Multiple clicks during loading use the most recent document request.
      let index = -1;
      const component = legalRequest.component;
      if (component) {
        // Main cards can combine explicit versions; dependency rows retain their exact version.
        for (const version of legalRequest.versions || [component.version]) {
          index = readerDocuments.findIndex(
            (entry) => entry.component?.name === component.name && entry.component?.version === version,
          );
          if (index !== -1) break;
        }
      } else {
        index = readerDocuments.findIndex((entry) => entry.project?.id === legalRequest.id);
      }
      showLegalDocument(index);
    } catch (error) {
      console.error('Loading bundled legal notices:', error);
      legalFailed = true;
    } finally {
      catalogLoading = null;
      renderLegal();
      if (legalDialog.open && !legalFailed) {
        const button = /** @type {HTMLButtonElement|null|undefined} */ (
          documentSelect.closest('.cs')?.querySelector('.cs-button')
        );
        (button || documentSelect).focus({ preventScroll: true });
      }
    }
  }

  document.getElementById('btn-legal-notices')?.addEventListener('click', () => void readLegal(legalRequest));
  document.getElementById('btn-close-legal')?.addEventListener('click', () => legalDialog.close());
  legalRetry.addEventListener('click', () => void readLegal(legalRequest));
  documentSelect.addEventListener('change', () => showLegalDocument(Number(documentSelect.value)));

  function renderStatus() {
    check.disabled = pending;
    check.setAttribute('aria-busy', String(pending));
    const label = check.querySelector('span');
    if (label) label.textContent = t(pending ? 'checkingUpdates' : 'checkUpdates');
    github.disabled = openPending;
    download.disabled = openPending;
    download.hidden = pending || result?.status !== 'available';
    region.hidden = !pending && !result && !errorKey;
    region.dataset.state = errorKey ? 'error' : pending ? 'checking' : result?.status || 'idle';
    status.textContent = pending
      ? t('checkingUpdates')
      : errorKey
        ? t(errorKey)
        : result?.status === 'available'
          ? t('updateAvailable', { version: `v${result.latest_version}` })
          : result?.status === 'current'
            ? t('updateCurrent')
            : result?.status === 'no_release'
              ? t('updateNoRelease')
              : '';
  }

  function renderComponents() {
    summary.textContent = t('allRuntimeComponents', { count: manifest?.components.length ?? 0 });
    componentError.hidden = !loadFailed;
    componentError.textContent = loadFailed ? t('componentsLoadFailed') : '';
    for (const button of document.querySelectorAll('.about-component-read')) {
      button.textContent = t('readComponentLicense');
      button.setAttribute(
        'aria-label',
        t('readComponentLicenseLabel', { name: button.getAttribute('data-component-name') }),
      );
    }
    if (!manifest) return;
    // Only translatable values change on language switches; expanded details and focus survive.
    for (const element of document.querySelectorAll('#about-components [data-component-purpose]')) {
      element.textContent = t(element.getAttribute('data-component-purpose') || '');
    }
    for (const element of document.querySelectorAll('[data-component-bundled]')) {
      element.textContent = t('bundledComponent');
    }
  }

  /** @param {Component} component @param {boolean} [main] */
  function licenseButton(component, main = false) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'btn about-component-read';
    button.dataset.componentName = component.name;
    button.addEventListener(
      'click',
      () => void readLegal({ component, versions: main ? component.version?.split(' / ') || [null] : undefined }),
    );
    return button;
  }

  /** @param {Component} component */
  function versionLabel(component) {
    const label = document.createElement('span');
    label.className = 'about-component-version';
    label.textContent = component.version || t('bundledComponent');
    if (!component.version) label.setAttribute('data-component-bundled', '');
    return label;
  }

  async function loadComponents() {
    try {
      const response = await fetch(new URL('../third-party-components.json', import.meta.url));
      if (!response.ok) throw new Error(String(response.status));
      manifest = await response.json();
      if (!manifest || !Array.isArray(manifest.main) || !Array.isArray(manifest.components))
        throw new Error('Invalid component manifest');
      const main = document.getElementById('about-components');
      const all = document.getElementById('about-dependency-list');
      const primary = document.createDocumentFragment();
      const dependencies = document.createDocumentFragment();
      for (const component of manifest.main) {
        const item = document.createElement('li');
        item.className = 'about-component';
        const heading = document.createElement('div');
        heading.className = 'about-component-heading';
        const name = document.createElement('span');
        name.className = 'about-component-name';
        name.textContent = component.name;
        heading.append(name, versionLabel(component));
        const purpose = document.createElement('p');
        purpose.className = 'settings-row-desc';
        purpose.setAttribute('data-component-purpose', component.purpose || '');
        const license = document.createElement('span');
        license.className = 'about-component-license selectable';
        license.textContent = component.license;
        item.append(heading, purpose, license, licenseButton(component, true));
        primary.append(item);
      }
      for (const component of manifest.components) {
        const item = document.createElement('li');
        const name = document.createElement('span');
        name.textContent = component.name;
        const license = document.createElement('span');
        license.textContent = component.license;
        item.append(name, versionLabel(component), license, licenseButton(component));
        dependencies.append(item);
      }
      main?.replaceChildren(primary);
      all?.replaceChildren(dependencies);
    } catch (error) {
      console.error('Loading bundled component list:', error);
      loadFailed = true;
    }
    renderComponents();
  }

  check.addEventListener('click', async () => {
    if (pending) return;
    pending = true;
    errorKey = '';
    result = null;
    renderStatus();
    try {
      result = await invoke('check_for_updates');
      if (
        !result ||
        !['available', 'current', 'no_release'].includes(result.status) ||
        (result.status === 'available' && (!result.tag || !result.latest_version))
      ) {
        result = null;
        errorKey = 'updateInvalidResponse';
      }
    } catch (error) {
      const code = /** @type {{code?: string}|null} */ (error)?.code;
      errorKey = [
        'updateTimeout',
        'updateNetworkError',
        'updateRateLimited',
        'updateServiceError',
        'updateInvalidResponse',
      ].includes(code || '')
        ? /** @type {string} */ (code)
        : 'updateCheckFailed';
    } finally {
      pending = false;
      renderStatus();
    }
  });

  /** @param {'repository'|'release'} page */
  async function openPage(page) {
    if (openPending) return;
    openPending = true;
    renderStatus();
    try {
      await invoke('open_project_page', { page, tag: page === 'release' ? result?.tag : null });
      if (errorKey === 'projectPageError') errorKey = '';
    } catch {
      errorKey = 'projectPageError';
    } finally {
      openPending = false;
      renderStatus();
    }
  }
  github.addEventListener('click', () => void openPage('repository'));
  download.addEventListener('click', () => void openPage('release'));
  onLanguageChange(() => {
    renderStatus();
    renderComponents();
    renderLegal();
  });
  renderStatus();
  renderComponents();
  void loadComponents();
}
