import * as select from '@zag-js/select';
import { VanillaMachine, normalizeProps, spreadProps } from '@zag-js/vanilla';

const chevron = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="m4 6 4 4 4-4"/></svg>';
const controls = new Map<HTMLSelectElement, ReturnType<typeof enhanceSelect>>();
let sequence = 0;

/** Keep native values/events as the application contract; Zag owns accessible interaction. */
function enhanceSelect(native: HTMLSelectElement) {
  const root = document.createElement('span'); root.className = 'ui-select';
  root.innerHTML = `<button type="button" class="ui-select-trigger"><span></span>${chevron}</button><div class="ui-select-positioner" popover="manual"><div class="ui-select-menu"></div></div>`;
  native.after(root); native.hidden = true;
  const trigger = root.querySelector<HTMLButtonElement>('button')!, label = trigger.querySelector('span')!;
  const positioner = root.querySelector<HTMLElement>('.ui-select-positioner')!, content = root.querySelector<HTMLElement>('.ui-select-menu')!;
  let items: { value: string; label: string; disabled: boolean }[] = [], fingerprint = '', selected = native.value, disabled = native.disabled;
  const machine = new VanillaMachine(select.machine, {
    id: `select-${++sequence}`, collection: select.collection({ items }), defaultValue: [selected], disabled,
    positioning: { placement: 'bottom-start', strategy: 'fixed', sameWidth: true, gutter: 6 },
    onValueChange({ value }) {
      if (native.value === value[0]) return;
      selected = native.value = value[0] ?? '';
      native.dispatchEvent(new Event('input', { bubbles: true }));
      native.dispatchEvent(new Event('change', { bubbles: true }));
    },
  });
  const api = () => select.connect(machine.service, normalizeProps);
  function render() {
    const state = api();
    spreadProps(root, state.getRootProps());
    spreadProps(trigger, { ...state.getTriggerProps(), 'aria-label': native.getAttribute('aria-label') || native.labels?.[0]?.textContent?.trim(), 'aria-labelledby': undefined });
    spreadProps(positioner, state.getPositionerProps());
    spreadProps(content, { ...state.getContentProps(), 'aria-label': native.getAttribute('aria-label'), 'aria-labelledby': undefined });
    const text = native.selectedOptions[0]?.textContent || 'Choose…';
    if (label.textContent !== text) label.textContent = text;
    items.forEach((item, index) => {
      const row = content.children[index] as HTMLElement;
      spreadProps(row, state.getItemProps({ item }));
    });
    positioner.hidden = !state.open;
    if (state.open && !positioner.matches(':popover-open')) positioner.showPopover?.();
    if (!state.open && positioner.matches(':popover-open')) positioner.hidePopover?.();
  }
  function sync() {
    const next = Array.from(native.options, (o) => ({ value: o.value, label: o.text, disabled: o.disabled }));
    const key = JSON.stringify(next);
    if (key !== fingerprint) {
      fingerprint = key; items = next;
      content.replaceChildren(...items.map((item) => {
        const row = document.createElement('div'); row.className = 'ui-select-option'; row.textContent = item.label; return row;
      }));
      machine.updateProps({ collection: select.collection({ items }) });
    }
    if (selected !== native.value) { selected = native.value; api().setValue([selected]); }
    if (disabled !== native.disabled) { disabled = native.disabled; machine.updateProps({ disabled }); }
    render();
  }
  root.addEventListener('keydown', (event) => event.stopPropagation());
  native.addEventListener('change', sync);
  const stop = machine.subscribe(render); machine.start(); sync();
  return { sync, focus: () => trigger.focus(), dispose() { native.removeEventListener('change', sync); stop(); machine.stop(); root.remove(); native.hidden = false; } };
}

export function refreshSelects(root: ParentNode = document) {
  for (const [native, control] of controls) if (!native.isConnected) { control.dispose(); controls.delete(native); }
  for (const native of root.querySelectorAll<HTMLSelectElement>('select:not([data-native])')) {
    if (!controls.has(native)) controls.set(native, enhanceSelect(native));
    else controls.get(native)!.sync();
  }
}
export function focusSelect(native: HTMLSelectElement) { refreshSelects(native.parentElement!); controls.get(native)?.focus(); }
export function observeSelects() {
  const observer = new MutationObserver((records) => {
    if (records.some((r) => r.target instanceof Element && (r.target.matches('select, option') || [...r.addedNodes, ...r.removedNodes].some((n) => n instanceof Element && (n.matches('select') || n.querySelector('select')))))) refreshSelects();
  });
  observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['disabled'] });
  refreshSelects();
  return () => { observer.disconnect(); for (const control of controls.values()) control.dispose(); controls.clear(); };
}
