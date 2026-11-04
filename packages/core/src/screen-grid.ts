/** Conservative screen-space broad phase; exact hit testing stays with the renderer. */
export class ScreenGrid<T> {
  private cells = new Map<string, T[]>();
  constructor(private cellSize = 48) {}
  clear() { this.cells.clear(); }
  add(value: T, x: number, y: number, radius: number, width: number, height: number) {
    if (![x, y, radius].every(Number.isFinite) || x + radius < 0 || y + radius < 0 || x - radius > width || y - radius > height) return;
    const left = Math.floor(Math.max(0, x - radius) / this.cellSize), right = Math.floor(Math.min(width, x + radius) / this.cellSize);
    const top = Math.floor(Math.max(0, y - radius) / this.cellSize), bottom = Math.floor(Math.min(height, y + radius) / this.cellSize);
    for (let row = top; row <= bottom; row++) for (let column = left; column <= right; column++) {
      const key = `${column}:${row}`, cell = this.cells.get(key);
      if (cell) cell.push(value); else this.cells.set(key, [value]);
    }
  }
  at(x: number, y: number): readonly T[] { return this.cells.get(`${Math.floor(x / this.cellSize)}:${Math.floor(y / this.cellSize)}`) || []; }
}
