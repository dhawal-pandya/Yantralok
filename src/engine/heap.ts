// Generic binary min-heap. Order is fully determined by `less`.
export class MinHeap<T> {
  private items: T[];

  constructor(
    private readonly less: (a: T, b: T) => boolean,
    items?: T[],
  ) {
    this.items = items ? items.slice() : [];
    if (this.items.length > 1) this.heapify();
  }

  get size(): number {
    return this.items.length;
  }

  peek(): T | undefined {
    return this.items[0];
  }

  push(item: T): void {
    this.items.push(item);
    this.siftUp(this.items.length - 1);
  }

  pop(): T | undefined {
    const items = this.items;
    const n = items.length;
    if (n === 0) return undefined;
    const top = items[0];
    const last = items.pop()!;
    if (n > 1) {
      items[0] = last;
      this.siftDown(0);
    }
    return top;
  }

  /** Shallow copy of the backing array, for snapshots. */
  toArray(): T[] {
    return this.items.slice();
  }

  private heapify(): void {
    for (let i = (this.items.length >> 1) - 1; i >= 0; i--) this.siftDown(i);
  }

  private siftUp(i: number): void {
    const items = this.items;
    const node = items[i];
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (!this.less(node, items[parent])) break;
      items[i] = items[parent];
      i = parent;
    }
    items[i] = node;
  }

  private siftDown(i: number): void {
    const items = this.items;
    const n = items.length;
    const node = items[i];
    for (;;) {
      const l = 2 * i + 1;
      const r = l + 1;
      let smallest = i;
      let smallestVal = node;
      if (l < n && this.less(items[l], smallestVal)) {
        smallest = l;
        smallestVal = items[l];
      }
      if (r < n && this.less(items[r], smallestVal)) {
        smallest = r;
        smallestVal = items[r];
      }
      if (smallest === i) break;
      items[i] = items[smallest];
      i = smallest;
    }
    items[i] = node;
  }
}
