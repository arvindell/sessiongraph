import { timeX } from './layout';
import type { Graph } from './types';

type TimeRange = Pick<Graph, 'start' | 'end' | 'timeFrame' | 'calendarTime'>;
const monthFormat = new Intl.DateTimeFormat('en', { month: 'short' });
const monthYearFormat = new Intl.DateTimeFormat('en', { month: 'short', year: 'numeric' });

/** Keep calendar ticks aligned to the same local dates and linear scale as sessions. */
export function monthTicks(graph: TimeRange) {
  if (graph.calendarTime === false || !(graph.end > graph.start)) return [];
  const start = new Date(graph.start), end = new Date(graph.end);
  if (!Number.isFinite(+start) || !Number.isFinite(+end)) return [];
  const index = (date: Date) => date.getFullYear() * 12 + date.getMonth();
  const first = index(start), last = index(end);
  const minimum = Math.ceil((last - first + 1) / 24);
  const stride = [1, 2, 3, 6, 12].find(value => value >= minimum) ?? Math.ceil(minimum / 12) * 12;
  const format = first === last || start.getFullYear() !== end.getFullYear() ? monthYearFormat : monthFormat;
  const ticks = [];
  for (let i = Math.ceil(first / stride) * stride; i <= last; i += stride) {
    const date = new Date(0);
    date.setFullYear(Math.floor(i / 12), i % 12, 1);
    date.setHours(0, 0, 0, 0);
    if (+date >= graph.start && +date <= graph.end) ticks.push({ x: timeX(+date, graph), label: format.format(date) });
  }
  if (!ticks.length && first === last) ticks.push({ x: timeX(graph.start, graph), label: format.format(start) });
  return ticks;
}
