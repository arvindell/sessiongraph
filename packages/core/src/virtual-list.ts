/** Prefix sums with O(log n) height corrections and offset lookup. */
export class RowHeights {
  private values: Float64Array;
  private tree: Float64Array;
  constructor(heights: number[]) {
    this.values = Float64Array.from(heights);
    this.tree = new Float64Array(heights.length + 1);
    for (let i = 1; i < this.tree.length; i++) {
      this.tree[i] += this.values[i - 1];
      const parent = i + (i & -i);
      if (parent < this.tree.length) this.tree[parent] += this.tree[i];
    }
  }
  get length() { return this.values.length; }
  offset(index: number) {
    let sum = 0;
    for (let i = Math.min(index, this.length); i > 0; i -= i & -i) sum += this.tree[i];
    return sum;
  }
  set(index: number, height: number) {
    const delta = height - this.values[index];
    if (Math.abs(delta) < .1) return false;
    this.values[index] = height;
    for (let i = index + 1; i < this.tree.length; i += i & -i) this.tree[i] += delta;
    return true;
  }
  /** Row containing an offset; an exact boundary belongs to the following row. */
  indexAt(offset: number) {
    let index = 0, sum = 0;
    for (let bit = 2 ** Math.floor(Math.log2(this.length || 1)); bit; bit = Math.floor(bit / 2)) {
      const next = index + bit;
      if (next <= this.length && sum + this.tree[next] <= offset) { index = next; sum += this.tree[next]; }
    }
    return Math.min(index, Math.max(0, this.length - 1));
  }
}

/** Variable-height window. Reuse mounted rows and measure only the visible slice. */
export class VirtualList<T> {
  private items: T[] = [];
  private heights = new RowHeights([]);
  private sizes = new Map<string, number>();
  private mounted = new Map<number, { wrapper: HTMLDivElement; element: HTMLElement }>();
  private content = document.createElement('div');
  private observer: ResizeObserver;
  private frame = 0;
  private width = 0;
  private pendingIndex?: number;
  private events = new AbortController();

  constructor(private viewport: HTMLElement, private options: {
    key: (item: T) => string;
    estimate: (item: T) => number;
    render: (item: T, index: number) => HTMLElement;
    overscan?: number;
  }) {
    this.content.className = 'virtual-list-content';
    this.content.style.cssText = 'position:relative;overflow-anchor:none';
    viewport.replaceChildren(this.content);
    viewport.addEventListener('scroll', this.schedule, { passive: true, signal: this.events.signal });
    viewport.addEventListener('focusout', this.schedule, { signal: this.events.signal });
    this.observer = new ResizeObserver(() => {
      const width = viewport.clientWidth;
      if (width && this.width && width !== this.width) this.resetHeights();
      if (width) this.width = width;
      this.schedule();
    });
    this.observer.observe(viewport);
  }

  setItems(items: T[], preserveScroll = false) {
    const anchor = this.heights.indexAt(this.viewport.scrollTop);
    const key = this.items[anchor] === undefined ? undefined : this.options.key(this.items[anchor]);
    const inset = this.viewport.scrollTop - this.heights.offset(anchor);
    this.clearRows();
    if (this.content.parentElement !== this.viewport) this.viewport.replaceChildren(this.content);
    if (!preserveScroll) this.sizes.clear();
    else {
      const keys = new Set(items.map(this.options.key));
      for (const key of this.sizes.keys()) if (!keys.has(key)) this.sizes.delete(key);
    }
    this.items = items;
    this.heights = new RowHeights(items.map(item => this.sizes.get(this.options.key(item)) ?? this.options.estimate(item)));
    this.pendingIndex = undefined;
    this.content.style.height = `${this.heights.offset(items.length)}px`;
    if (!preserveScroll) this.viewport.scrollTop = 0;
    else if (key !== undefined) {
      const index = items.findIndex(item => this.options.key(item) === key);
      if (index >= 0) this.viewport.scrollTop = this.heights.offset(index) + inset;
    }
    this.render();
  }

  getElement(index: number) { return this.mounted.get(index)?.element; }

  scrollToIndex(index: number) {
    if (index < 0 || index >= this.items.length) return;
    this.pendingIndex = index;
    this.render();
  }

  /** Density and wrapping changes invalidate offscreen measurements too. */
  resetHeights() {
    const anchor = this.heights.indexAt(this.viewport.scrollTop);
    const inset = this.viewport.scrollTop - this.heights.offset(anchor);
    this.sizes.clear();
    this.heights = new RowHeights(this.items.map(this.options.estimate));
    this.content.style.height = `${this.heights.offset(this.items.length)}px`;
    this.viewport.scrollTop = this.heights.offset(anchor) + inset;
    this.schedule();
  }

  private schedule = () => {
    if (!this.frame) this.frame = requestAnimationFrame(() => { this.frame = 0; this.render(); });
  };

  private reveal(index: number) {
    const top = this.heights.offset(index), bottom = this.heights.offset(index + 1);
    if (top < this.viewport.scrollTop) this.viewport.scrollTop = top;
    else if (bottom > this.viewport.scrollTop + this.viewport.clientHeight) this.viewport.scrollTop = bottom - this.viewport.clientHeight;
  }

  private render() {
    this.content.style.height = `${this.heights.offset(this.items.length)}px`;
    if (!this.items.length || !this.viewport.clientHeight) return;
    if (this.pendingIndex !== undefined) this.reveal(this.pendingIndex);
    const scroll = this.viewport.scrollTop, anchor = this.heights.indexAt(scroll);
    const overscan = this.options.overscan ?? 4;
    const start = Math.max(0, anchor - overscan);
    const end = Math.min(this.items.length, this.heights.indexAt(scroll + this.viewport.clientHeight) + overscan + 1);
    for (const [index, row] of this.mounted) {
      // Keep a focused button alive during wheel scrolling so keyboard focus
      // does not fall back to the document. At most one extra row is retained.
      if ((index < start || index >= end) && !row.wrapper.contains(document.activeElement)) {
        this.observer.unobserve(row.wrapper); row.wrapper.remove(); this.mounted.delete(index);
      }
    }
    for (let index = start; index < end; index++) if (!this.mounted.has(index)) {
      const element = this.options.render(this.items[index], index);
      const wrapper = document.createElement('div');
      wrapper.style.cssText = 'position:absolute;top:0;left:0;width:100%;display:flow-root';
      wrapper.className = 'virtual-list-row'; wrapper.append(element);
      this.mounted.set(index, { wrapper, element });
      // Maintain DOM order for assistive technologies and native tab navigation.
      const next = [...this.mounted.keys()].filter(key => key > index).sort((a, b) => a - b)[0];
      this.content.insertBefore(wrapper, this.mounted.get(next)?.wrapper ?? null);
      this.observer.observe(wrapper);
    }
    // Batch all measurements before writes to avoid per-row forced layouts.
    const measured = [...this.mounted].map(([index, row]) => [index, row.wrapper.getBoundingClientRect().height] as const);
    const before = this.heights.offset(anchor);
    let changed = false;
    for (const [index, height] of measured) if (height > 0) {
      this.sizes.set(this.options.key(this.items[index]), height);
      changed = this.heights.set(index, height) || changed;
    }
    for (const [index, row] of this.mounted) {
      const transform = `translateY(${this.heights.offset(index)}px)`;
      if (row.wrapper.style.transform !== transform) row.wrapper.style.transform = transform;
    }
    this.content.style.height = `${this.heights.offset(this.items.length)}px`;
    if (changed) this.viewport.scrollTop += this.heights.offset(anchor) - before;
    if (this.pendingIndex !== undefined) { this.reveal(this.pendingIndex); this.pendingIndex = undefined; }
    // Shorter measured rows may expose another row at the bottom.
    if (changed) this.schedule();
  }

  private clearRows() {
    for (const row of this.mounted.values()) this.observer.unobserve(row.wrapper);
    this.mounted.clear(); this.content.replaceChildren();
  }

  dispose() { cancelAnimationFrame(this.frame); this.events.abort(); this.observer.disconnect(); this.content.remove(); }
}
