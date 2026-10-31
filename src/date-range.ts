import * as picker from '@zag-js/date-picker';
import { VanillaMachine, normalizeProps, spreadProps } from '@zag-js/vanilla';

const arrow = (direction: 'left' | 'right') => `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="${direction === 'left' ? 'm10 4-4 4 4 4' : 'm6 4 4 4-4 4'}"/></svg>`;
const parse = (value: string) => { try { return /^\d{4}-\d{2}-\d{2}$/.test(value) ? picker.parse(value) : undefined; } catch { return undefined; } };

export function createDateRange(root: HTMLElement, apply: (from: string, to: string) => void, onOpen: () => void) {
  root.innerHTML = `<div class="date-control"><button class="icon-button date-trigger" type="button" aria-label="Custom date range" title="Custom date range"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><rect x="3" y="5" width="18" height="16" rx="3"/><path d="M7 3v4m10-4v4M3 11h18m-12 5h4"/></svg></button></div>
    <div class="date-positioner" popover="manual"><section class="date-popover">
      <header class="date-heading"><div><span class="eyebrow">FOCUS YOUR TIMELINE</span><h2>Date range</h2></div><button type="button" class="icon-button date-close" aria-label="Close date range">×</button></header>
      <div class="date-fields"><label>From<input id="from-date" aria-label="From date" autocomplete="off" spellcheck="false" placeholder="YYYY-MM-DD"/></label><span aria-hidden="true">→</span><label>To<input id="to-date" aria-label="To date" autocomplete="off" spellcheck="false" placeholder="YYYY-MM-DD"/></label></div>
      <div class="date-presets"><button type="button" data-preset="last7Days">Last 7 days</button><button type="button" data-preset="last30Days">Last 30 days</button><button type="button" data-preset="thisMonth">This month</button></div>
      <div class="date-calendar"><div class="date-navigation"><button type="button" class="icon-button date-prev">${arrow('left')}</button><button type="button" class="date-view"></button><button type="button" class="icon-button date-next">${arrow('right')}</button></div><div class="date-grids"></div></div>
      <footer class="date-footer"><span class="date-status" role="status"></span><button id="apply-dates" class="primary-button" type="button">Apply range ${arrow('right')}</button></footer>
    </section></div>`;
  const $ = <T extends HTMLElement = HTMLElement>(selector: string) => root.querySelector<T>(selector)!;
  const trigger = $<HTMLButtonElement>('.date-trigger'), positioner = $('.date-positioner'), content = $('.date-popover');
  const inputs = [$<HTMLInputElement>('#from-date'), $<HTMLInputElement>('#to-date')], applyButton = $<HTMLButtonElement>('#apply-dates');
  const machine = new VanillaMachine(picker.machine, {
    id: 'timeline-dates', selectionMode: 'range', closeOnSelect: false, fixedWeeks: true, outsideDaySelectable: true,
    locale: navigator.language, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    format: (date) => date.toString(), parse, placeholder: 'YYYY-MM-DD',
    positioning: { placement: 'top-end', strategy: 'fixed', gutter: 12, slide: true },
    onOpenChange({ open }) { if (open) onOpen(); },
  });
  const api = () => picker.connect(machine.service, normalizeProps);
  const grids = (['day', 'month', 'year'] as const).map((view) => {
    const table = document.createElement('table'); table.dataset.calendarView = view;
    const head = table.createTHead(), row = head.insertRow();
    if (view === 'day') for (let i = 0; i < 7; i++) row.append(document.createElement('th'));
    const body = table.createTBody();
    const rows = view === 'day' ? 6 : 4, columns = view === 'day' ? 7 : 3;
    for (let r = 0; r < rows; r++) { const row = body.insertRow(); for (let c = 0; c < columns; c++) { const button = document.createElement('button'); button.type = 'button'; row.insertCell().append(button); } }
    $('.date-grids').append(table);
    return { view, table, head, body };
  });
  function validity() {
    const dates = inputs.map((input) => parse(input.value));
    const valid = Boolean(dates[0] && dates[1] && dates[0].compare(dates[1]) <= 0);
    applyButton.disabled = !valid;
    for (const [index, input] of inputs.entries()) input.setAttribute('aria-invalid', String(Boolean(input.value) && !dates[index]));
    const text = valid ? 'Both dates included' : 'Choose a start and end date';
    if ($('.date-status').textContent !== text) $('.date-status').textContent = text;
  }
  function render() {
    const state = api();
    spreadProps(root, state.getRootProps());
    spreadProps($('.date-control'), state.getControlProps());
    spreadProps(trigger, { ...state.getTriggerProps(), 'aria-label': 'Custom date range' });
    spreadProps(positioner, state.getPositionerProps());
    spreadProps(content, { ...state.getContentProps(), 'aria-label': 'Custom date range' });
    inputs.forEach((input, index) => spreadProps(input, { ...state.getInputProps({ index }), 'aria-label': index ? 'To date' : 'From date' }));
    spreadProps($('.date-prev'), state.getPrevTriggerProps({ view: state.view }));
    spreadProps($('.date-next'), state.getNextTriggerProps({ view: state.view }));
    const title = state.view === 'day' ? state.visibleRangeText.start : state.view === 'month' ? String(state.visibleRange.start.year) : `${state.getDecade().start} – ${state.getDecade().end}`;
    const viewButton = $('.date-view');
    spreadProps(viewButton, state.getViewTriggerProps({ view: state.view }));
    if (viewButton.textContent !== title) viewButton.textContent = title;
    for (const { view, table, head, body } of grids) {
      table.hidden = state.view !== view;
      spreadProps(table, state.getTableProps({ view, columns: view === 'day' ? 7 : 3 }));
      spreadProps(head, state.getTableHeaderProps({ view })); spreadProps(body, state.getTableBodyProps({ view }));
      if (view === 'day') state.weekDays.forEach((day, i) => { const cell = head.rows[0].cells[i]; cell.scope = 'col'; cell.setAttribute('aria-label', day.long); if (cell.textContent !== day.short) cell.textContent = day.short; });
      const values = view === 'day' ? state.weeks : view === 'month' ? state.getMonthsGrid({ columns: 3, format: 'short' }) : state.getYearsGrid({ columns: 3 });
      Array.from(body.rows).forEach((row, r) => {
        spreadProps(row, state.getTableRowProps({ view }));
        Array.from(row.cells).forEach((cell, c) => {
          const value = values[r]?.[c], button = cell.firstElementChild as HTMLButtonElement;
          cell.hidden = !value; if (!value) return;
          if (view === 'day') {
            const day = state.weeks[r][c];
            spreadProps(cell, state.getDayTableCellProps({ value: day }));
            spreadProps(button, state.getDayTableCellTriggerProps({ value: day }));
            if (button.textContent !== String(day.day)) button.textContent = String(day.day);
          } else {
            const item = value as { value: number; label: string };
            spreadProps(cell, view === 'month' ? state.getMonthTableCellProps({ ...item, columns: 3 }) : state.getYearTableCellProps({ ...item, columns: 3 }));
            spreadProps(button, view === 'month' ? state.getMonthTableCellTriggerProps({ ...item, columns: 3 }) : state.getYearTableCellTriggerProps({ ...item, columns: 3 }));
            if (button.textContent !== item.label) button.textContent = item.label;
          }
        });
      });
    }
    positioner.hidden = !state.open;
    if (state.open && !positioner.matches(':popover-open')) positioner.showPopover?.();
    if (!state.open && positioner.matches(':popover-open')) positioner.hidePopover?.();
    trigger.classList.toggle('active', state.open); validity();
  }
  $('.date-close').addEventListener('click', () => api().setOpen(false));
  for (const button of root.querySelectorAll<HTMLElement>('[data-preset]')) button.addEventListener('click', () => {
    const state = api(), values = state.getRangePresetValue(button.dataset.preset as 'last7Days' | 'last30Days' | 'thisMonth');
    state.setValue(values); state.setFocusedValue(values[0]); state.setView('day');
  });
  applyButton.addEventListener('click', () => { validity(); if (!applyButton.disabled) { apply(inputs[0].value, inputs[1].value); api().setOpen(false); } });
  content.addEventListener('input', validity);
  root.addEventListener('keydown', (event) => event.stopPropagation());
  const stop = machine.subscribe(render); machine.start(); render();
  return {
    setRange(from: string, to: string) { const values = [from, to].map(parse).filter((d) => d !== undefined); api().setValue(values); if (values[0]) api().setFocusedValue(values[0]); },
    dispose() { stop(); machine.stop(); root.replaceChildren(); },
  };
}
