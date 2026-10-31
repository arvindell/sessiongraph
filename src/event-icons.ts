import { createElement, UserRound, Bot } from 'lucide';
import type { TimelineSummary } from './timeline';

export function eventIcon(item: TimelineSummary) {
  const glyph = item.role === 'user' ? UserRound : Bot;
  return createElement([glyph[0], { ...glyph[1], 'aria-hidden': 'true', 'stroke-width': 1.4 }, glyph[2]]);
}
