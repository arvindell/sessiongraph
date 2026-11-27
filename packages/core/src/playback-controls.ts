import { createElement, Play } from 'lucide';
import './playback-controls.css';

type Part = 'play' | 'histogram' | 'scrubber' | 'cursor' | 'date' | 'period' | 'summary' | 'sessions' | 'tokens' | 'coverage';

/** One player layout for the local app, publication preview, and public profiles. */
export function playbackControls(header: string, ids: Partial<Record<Part, string>> = {}, { showCoverage = true } = {}) {
  const attrs = (part: Part) => `data-playback="${part}"${ids[part] ? ` id="${ids[part]}"` : ''}`;
  const play = createElement([Play[0], { ...Play[1], 'aria-hidden': 'true', 'stroke-width': 1.5 }, Play[2]]).outerHTML;
  return `<div class="timeline-top">${header}</div>
    <div class="timeline-track"><button type="button" class="play-button" ${attrs('play')} aria-label="Play timeline">${play}</button><div class="histogram-wrap"><div class="histogram" ${attrs('histogram')} aria-hidden="true"></div><input ${attrs('scrubber')} type="range" min="0" max="1000" value="1000" aria-label="Timeline playback position"><div class="timeline-cursor" ${attrs('cursor')}></div></div><output class="playback-date" ${attrs('date')}>—</output></div>
    <div class="playback-period" ${attrs('period')} aria-label="Playback position">—</div>
    <div class="playback-summary" ${attrs('summary')} hidden><span><strong ${attrs('sessions')}>0</strong><span>Sessions</span></span><span data-token-total><strong ${attrs('tokens')}>—</strong><span>Burnt tokens</span></span>${showCoverage ? `<small ${attrs('coverage')}></small>` : ''}</div>`;
}
