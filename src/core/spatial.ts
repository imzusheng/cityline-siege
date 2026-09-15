// Uniform spatial hash. All neighbour queries go through here — never O(n^2).

export class SpatialHash {
  readonly cell: number;
  readonly cols: number;
  readonly rows: number;
  private head: Int32Array;
  /** per-slot next index; length is grown to the store size */
  private next: Int32Array;

  constructor(worldW: number, worldH: number, cell: number) {
    this.cell = cell;
    this.cols = Math.ceil(worldW / cell);
    this.rows = Math.ceil(worldH / cell);
    this.head = new Int32Array(this.cols * this.rows).fill(-1);
    this.next = new Int32Array(1024);
  }

  clear(): void { this.head.fill(-1); }

  private ensure(n: number): void {
    if (this.next.length < n) {
      let cap = this.next.length;
      while (cap < n) cap *= 2;
      const grown = new Int32Array(cap);
      grown.set(this.next);
      this.next = grown;
    }
  }

  cellIndex(x: number, y: number): number {
    let cx = (x / this.cell) | 0, cy = (y / this.cell) | 0;
    if (cx < 0) cx = 0; else if (cx >= this.cols) cx = this.cols - 1;
    if (cy < 0) cy = 0; else if (cy >= this.rows) cy = this.rows - 1;
    return cy * this.cols + cx;
  }

  /** Insert item index i located at (x,y). Caller must have called clear() first. */
  insert(i: number, x: number, y: number, storeSize: number): void {
    this.ensure(storeSize);
    const h = this.cellIndex(x, y);
    this.next[i] = this.head[h]!;
    this.head[h] = i;
  }

  /** Iterate every index in cells overlapping the square [x-r, x+r]. */
  forEachNear(x: number, y: number, r: number, cb: (i: number, cellX: number, cellY: number) => void): void {
    const c = this.cell;
    let x0 = ((x - r) / c) | 0, x1 = ((x + r) / c) | 0;
    let y0 = ((y - r) / c) | 0, y1 = ((y + r) / c) | 0;
    if (x0 < 0) x0 = 0; if (y0 < 0) y0 = 0;
    if (x1 >= this.cols) x1 = this.cols - 1;
    if (y1 >= this.rows) y1 = this.rows - 1;
    for (let cy = y0; cy <= y1; cy++) {
      const row = cy * this.cols;
      for (let cx = x0; cx <= x1; cx++) {
        let i = this.head[row + cx]!;
        let guard = 0;
        while (i >= 0 && guard++ < 512) {
          cb(i, cx, cy);
          i = this.next[i]!;
        }
      }
    }
  }
}
