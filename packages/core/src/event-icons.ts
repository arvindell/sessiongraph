import { iconElement } from './icons';
import type { TimelineSummary } from './timeline';

export function eventIcon(item: TimelineSummary) {
  return iconElement(item.kind === 'commit' ? 'git-commit' : item.role === 'user' ? 'user' : 'bot');
}
