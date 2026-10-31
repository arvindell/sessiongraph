import { createElement, UserRound, Bot, Wrench, CheckCheck, Brain, FileCode2, Archive, CircleAlert, MessageCircle, Terminal, Search, type IconNode } from 'lucide';
import type { TimelineSummary } from './timeline';

export function eventIcon(item: TimelineSummary) {
  let glyph: IconNode = MessageCircle;
  if (item.kind === 'message') glyph = item.role === 'user' ? UserRound : item.role === 'assistant' ? Bot : MessageCircle;
  else if (item.kind === 'tool_call') glyph = /shell|bash|terminal|exec/i.test(item.name) ? Terminal : /search|grep|glob|find/i.test(item.name) ? Search : /edit|write|patch/i.test(item.name) ? FileCode2 : Wrench;
  else glyph = ({ tool_result: CheckCheck, reasoning: Brain, file_change: FileCode2, compaction: Archive, error: CircleAlert, event: MessageCircle } as const)[item.kind];
  return createElement([glyph[0], { ...glyph[1], 'aria-hidden': 'true', 'stroke-width': 1.4 }, glyph[2]]);
}
