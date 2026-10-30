import type { Preferences } from './preferences';

type Voice = { sources: AudioScheduledSourceNode[]; nodes: AudioNode[]; gain: GainNode };

/** Procedural, offline audio. The graph is created only inside a user gesture. */
export class InteractionAudio {
  private context?: AudioContext;
  private master?: GainNode;
  private analyser?: AnalyserNode;
  private voices = new Set<Voice>();
  private events = new AbortController();
  private disposed = false;
  private unavailable = false;
  private clicks = 0;
  private lastClick = 0;
  private suspendTimer?: ReturnType<typeof setTimeout>;
  private active = true;
  private interacted = false;

  constructor(private preferences: Preferences, private status: (text: string) => void) {
    const options = { signal: this.events.signal };
    document.addEventListener('click', (event) => {
      if (!event.isTrusted) return;
      const target = (event.target as Element)?.closest<HTMLElement>('button, a[href], summary, input[type="checkbox"], [role="option"]');
      if (!target || target.matches(':disabled') || target.closest('[data-sound="none"], [data-drag-panel]')) return;
      this.play(target.matches('[data-session], [data-related], [role="option"]') ? 'select' : 'click');
    }, options);
    document.addEventListener('change', (event) => {
      if (event.isTrusted && (event.target as Element)?.matches('select, input[type="range"]')) this.play('click');
    }, options);
    document.addEventListener('pointerdown', (event) => { if (event.isTrusted) { this.interacted = true; void this.unlock(); } }, { ...options, passive: true });
    document.addEventListener('keydown', (event) => { if (event.isTrusted && !event.repeat && ['Enter', ' ', 'ArrowUp', 'ArrowDown'].includes(event.key)) { this.interacted = true; void this.unlock(); } }, options);
    document.addEventListener('visibilitychange', () => this.sync(), options);
    window.addEventListener('pagehide', () => { this.active = false; this.sync(); }, options);
    window.addEventListener('pageshow', () => { this.active = true; this.sync(); }, options);
  }

  private enabled() { return !this.preferences.muted && this.preferences.clickSounds && this.preferences.clickVolume > 0; }
  private async unlock() {
    if (this.disposed || document.hidden || !this.active || !this.enabled()) return;
    try {
      if (!this.context) {
        this.context = new AudioContext();
        this.master = this.context.createGain(); this.master.gain.value = 0;
        const compressor = this.context.createDynamicsCompressor();
        compressor.threshold.value = -12; compressor.ratio.value = 6;
        this.analyser = this.context.createAnalyser(); this.analyser.fftSize = 256;
        this.master.connect(compressor).connect(this.analyser).connect(this.context.destination);
        this.context.addEventListener('statechange', () => this.report(), { signal: this.events.signal });
      }
      if (this.context.state === 'suspended') await this.context.resume();
      if (!this.disposed) this.sync();
    } catch { this.unavailable = true; this.report(); }
  }

  private ramp(param: AudioParam, value: number, seconds = .15) {
    const now = this.context!.currentTime;
    param.cancelScheduledValues(now); param.setTargetAtTime(value, now, seconds);
  }
  private cleanup(voice: Voice) { voice.nodes.forEach((node) => node.disconnect()); this.voices.delete(voice); }

  private sync() {
    clearTimeout(this.suspendTimer);
    const c = this.context;
    if (!c || this.disposed) { this.report(); return; }
    const enabled = this.enabled() && !document.hidden && this.active;
    if (enabled && c.state === 'suspended') void c.resume().catch(() => { this.unavailable = true; this.report(); });
    this.ramp(this.master!.gain, enabled ? .7 : 0, .035);
    if (!enabled) {
      // Clear transient voices before suspending their scheduled stops.
      const suspend = () => {
        for (const voice of this.voices) { voice.sources.forEach((s) => { try { s.stop(); } catch {} }); this.cleanup(voice); }
        void c.suspend().catch(() => {});
      };
      if (document.hidden || !this.active) suspend(); else this.suspendTimer = setTimeout(suspend, 180);
    }
    this.report();
  }

  private report() {
    this.status(this.unavailable ? 'Audio is unavailable in this browser.' : this.preferences.muted ? 'All sound is muted.' : document.hidden || !this.active ? 'Audio paused while the app is hidden.' : this.context?.state === 'running' ? 'Audio is ready · pauses automatically in the background.' : 'Click a control or preview to start audio.');
  }
  configure(preferences: Preferences) { this.preferences = preferences; this.sync(); if (!this.context && this.interacted) void this.unlock(); }
  async play(kind: 'click' | 'select' = 'click') {
    await this.unlock();
    const c = this.context;
    if (this.disposed || !c || c.state !== 'running' || document.hidden || !this.active || this.preferences.muted || !this.preferences.clickSounds || !this.preferences.clickVolume) return;
    if (performance.now() - this.lastClick < 45) return;
    this.lastClick = performance.now(); this.clicks++;
    const gain = c.createGain(), tone = c.createOscillator(), now = c.currentTime;
    tone.type = 'sine'; tone.frequency.setValueAtTime(kind === 'select' ? 660 : 900, now);
    tone.frequency.exponentialRampToValueAtTime(kind === 'select' ? 990 : 420, now + .065);
    gain.gain.setValueAtTime(0, now); gain.gain.linearRampToValueAtTime(this.preferences.clickVolume / 100 * .12, now + .004);
    gain.gain.exponentialRampToValueAtTime(.0001, now + (kind === 'select' ? .19 : .065));
    tone.connect(gain).connect(this.master!);
    const voice: Voice = { gain, sources: [tone], nodes: [tone, gain] }; this.voices.add(voice);
    tone.onended = () => this.cleanup(voice); tone.start(); tone.stop(now + .22);
  }
  diagnostics() {
    const samples = new Float32Array(256); this.analyser?.getFloatTimeDomainData(samples);
    return { state: this.context?.state || 'unstarted', muted: this.preferences.muted, voices: this.voices.size, clicks: this.clicks, rms: Math.sqrt(samples.reduce((n, v) => n + v * v, 0) / samples.length) };
  }
  dispose() {
    this.disposed = true; this.events.abort(); clearTimeout(this.suspendTimer);
    for (const voice of this.voices) { voice.sources.forEach((s) => { try { s.stop(); } catch {} }); this.cleanup(voice); }
    void this.context?.close().catch(() => {});
  }
}
