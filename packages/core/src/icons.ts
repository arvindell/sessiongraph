import {
  AppleIcon, ArrowDown01Icon, ArrowDownToLineIcon, ArrowLeft01Icon, ArrowLeft02Icon,
  ArrowRight01Icon, ArrowRight02Icon, ArrowUpRight01Icon, BotIcon, Calendar03Icon,
  Cancel01Icon, CenterFocusIcon, Clock01Icon, Coins01Icon, ComputerTerminal01Icon, Copy01Icon, CpuIcon,
  Database01Icon, Dollar01Icon, FileCodeIcon, FilterIcon, Folder01Icon,
  GitBranchIcon, GitCommitHorizontalIcon, GitForkIcon, GithubIcon, HelpCircleIcon,
  HierarchyIcon, KeyboardIcon, Loading03Icon, LockKeyholeIcon, Message01Icon,
  MicrosoftIcon, Orbit01Icon, PackageIcon, PanelRightIcon, PanelsTopLeftIcon,
  PauseIcon, PlayIcon, RefreshIcon, Search01Icon, Settings02Icon, Share08Icon,
  SparklesIcon, Target01Icon, Tick02Icon, UserIcon, VolumeHighIcon, VolumeOffIcon,
} from '@hugeicons/core-free-icons';

const icons = {
  apple: AppleIcon, windows: MicrosoftIcon, github: GithubIcon, search: Search01Icon,
  'chevron-down': ArrowDown01Icon, 'chevron-left': ArrowLeft01Icon, 'chevron-right': ArrowRight01Icon,
  'arrow-down': ArrowDownToLineIcon, 'arrow-left': ArrowLeft02Icon, 'arrow-right': ArrowRight02Icon,
  'arrow-up-right': ArrowUpRight01Icon, bot: BotIcon, calendar: Calendar03Icon, x: Cancel01Icon,
  clock: Clock01Icon, coins: Coins01Icon, terminal: ComputerTerminal01Icon, copy: Copy01Icon,
  cpu: CpuIcon, database: Database01Icon, 'dollar-sign': Dollar01Icon,
  'file-code-2': FileCodeIcon, 'sliders-horizontal': FilterIcon, folder: Folder01Icon,
  'git-branch': GitBranchIcon, 'git-commit': GitCommitHorizontalIcon, 'git-fork': GitForkIcon,
  'circle-help': HelpCircleIcon, network: HierarchyIcon, keyboard: KeyboardIcon,
  'loader-circle': Loading03Icon, lock: LockKeyholeIcon, message: Message01Icon,
  orbit: Orbit01Icon, box: PackageIcon, 'panel-right': PanelRightIcon, panels: PanelsTopLeftIcon,
  pause: PauseIcon, play: PlayIcon, 'refresh-cw': RefreshIcon, 'rotate-ccw': RefreshIcon,
  'settings-2': Settings02Icon, 'share-2': Share08Icon, sparkles: SparklesIcon,
  crosshair: Target01Icon, 'center-focus': CenterFocusIcon, check: Tick02Icon, user: UserIcon, 'volume-2': VolumeHighIcon, 'volume-x': VolumeOffIcon,
};
export type IconName = keyof typeof icons;
export const escapeMarkup = (value: string) => value.replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!);

/** Render the same decorative SVG in static HTML, app templates, or DOM controls. */
export function icon(name: IconName, cls = '') {
  const children = icons[name].map(([tag, attrs]) => `<${tag}${Object.entries(attrs).filter(([key]) => key !== 'key')
    .map(([key, value]) => ` ${key.replace(/[A-Z]/g, c => `-${c.toLowerCase()}`)}="${escapeMarkup(String(value))}"`).join('')}></${tag}>`).join('');
  return `<svg class="ui-icon${cls ? ` ${escapeMarkup(cls)}` : ''}" viewBox="0 0 24 24" width="24" height="24" fill="none" aria-hidden="true" focusable="false">${children}</svg>`;
}

export function iconElement(name: IconName) {
  const template = document.createElement('template');
  template.innerHTML = icon(name);
  return template.content.firstElementChild as SVGSVGElement;
}
