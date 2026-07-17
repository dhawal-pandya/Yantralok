import { describe, expect, it } from "vitest";
import { MinHeap } from "./heap";
import { createPrng } from "./prng";

const numLess = (a: number, b: number): boolean => a < b;

describe("MinHeap", () => {
  it("pops items in ascending order", () => {
    const p = createPrng(5);
    const input = Array.from({ length: 1000 }, () => Math.floor(p.nextFloat() * 1e6));
    const heap = new MinHeap(numLess);
    for (const x of input) heap.push(x);
    const out: number[] = [];
    for (let v = heap.pop(); v !== undefined; v = heap.pop()) out.push(v);
    expect(out).toEqual([...input].sort((a, b) => a - b));
  });

  it("heapifies an initial array", () => {
    const heap = new MinHeap(numLess, [9, 3, 7, 1, 8, 2]);
    const out: number[] = [];
    for (let v = heap.pop(); v !== undefined; v = heap.pop()) out.push(v);
    expect(out).toEqual([1, 2, 3, 7, 8, 9]);
  });

  it("returns undefined when empty", () => {
    expect(new MinHeap(numLess).pop()).toBeUndefined();
  });
});
