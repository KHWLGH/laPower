// @ts-check
import { t } from '../i18n.js';

/** @param {string} id @param {number} value */
export function echoDisplayStepper(id, value) {
  const output = document.getElementById(id);
  if (!(output instanceof HTMLOutputElement)) return;
  output.value = String(value);
  for (const button of output.parentElement?.querySelectorAll('button[data-direction]') ?? []) {
    const atLimit =
      button.getAttribute('data-direction') === 'up'
        ? value >= Number(output.dataset.max)
        : value <= Number(output.dataset.min);
    button.setAttribute('aria-disabled', String(atLimit));
  }
}

/** @param {string} id @param {(value: number) => void} onChange */
export function bindDisplayStepper(id, onChange) {
  const output = document.getElementById(id);
  if (!(output instanceof HTMLOutputElement)) return;
  const buttons = document.createElement('span');
  buttons.className = 'display-stepper-buttons';
  const min = Number(output.dataset.min);
  const max = Number(output.dataset.max);
  const step = Number(output.dataset.step);
  for (const direction of /** @type {const} */ (['up', 'down'])) {
    const button = document.createElement('button');
    const label = direction === 'up' ? 'displayIncrease' : 'displayDecrease';
    button.type = 'button';
    button.id = `${id}-${direction}`;
    button.dataset.direction = direction;
    button.dataset.i18nTitle = label;
    button.dataset.i18nAriaLabel = label;
    button.title = t(label);
    button.setAttribute('aria-label', t(label));
    button.setAttribute('aria-labelledby', `${button.id} ${output.getAttribute('aria-labelledby')}`);
    button.addEventListener('click', () => {
      if (button.getAttribute('aria-disabled') === 'true') return;
      const previous = Number(output.value);
      const next = previous + (direction === 'up' ? step : -step);
      const value = previous * next < 0 ? 0 : Math.min(max, Math.max(min, next));
      echoDisplayStepper(id, value);
      onChange(value);
    });
    buttons.append(button);
  }
  output.parentElement?.append(buttons);
  echoDisplayStepper(id, Number(output.value));
}
