// @ts-check
import { onLanguageChange, t } from '../i18n.js';

/** @typedef {{name: string, version: string|null, license: string, purpose?: string}} Component */
/** @typedef {{status: 'available'|'current'|'no_release', current_version: string, latest_version: string|null, tag: string|null}} UpdateCheck */

/** Only initialises UI. A release request requires an explicit button click. */
export function initAboutView() {
  const check = /** @type {HTMLButtonElement} */ (document.getElementById('btn-check-updates'));
  const github = /** @type {HTMLButtonElement} */ (document.getElementById('btn-project-github'));
  const download = /** @type {HTMLButtonElement} */ (document.getElementById('btn-download-update'));
  const region = /** @type {HTMLElement} */ (document.getElementById('about-update'));
  const status = /** @type {HTMLElement} */ (document.getElementById('about-update-status'));
  const summary = /** @type {HTMLElement} */ (document.getElementById('about-components-summary'));
  const componentError = /** @type {HTMLElement} */ (document.getElementById('about-components-error'));
  const { invoke } = window.__TAURI__.core;
  let pending = false;
  let openPending = false;
  let errorKey = '';
  let loadFailed = false;
  /** @type {UpdateCheck|null} */
  let result = null;
  /** @type {{main: Component[], components: Component[]}|null} */
  let manifest = null;

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
    if (!manifest) return;
    // Only translatable values change on language switches; expanded details and focus survive.
    for (const element of document.querySelectorAll('#about-components [data-component-purpose]')) {
      element.textContent = t(element.getAttribute('data-component-purpose') || '');
    }
    for (const element of document.querySelectorAll('[data-component-bundled]')) {
      element.textContent = t('bundledComponent');
    }
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
        item.append(heading, purpose, license);
        primary.append(item);
      }
      for (const component of manifest.components) {
        const item = document.createElement('li');
        const name = document.createElement('span');
        name.textContent = component.name;
        const license = document.createElement('span');
        license.textContent = component.license;
        item.append(name, versionLabel(component), license);
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
  });
  renderStatus();
  renderComponents();
  void loadComponents();
}
