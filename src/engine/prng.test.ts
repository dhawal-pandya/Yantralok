import { describe, expect, it } from "vitest";
import { createPrng } from "./prng";

const draw = (seed: number, n: number): number[] => {
  const p = createPrng(seed);
  return Array.from({ length: n }, () => p.nextFloat());
};

describe("prng", () => {
  it("is deterministic for a given seed", () => {
    expect(draw(123, 100)).toEqual(draw(123, 100));
  });

  it("differs across seeds", () => {
    expect(draw(1, 100)).not.toEqual(draw(2, 100));
  });

  it("produces floats in [0, 1)", () => {
    const xs = draw(7, 10_000);
    expect(Math.min(...xs)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...xs)).toBeLessThan(1);
  });

  it("restores from state and continues the same sequence", () => {
    const a = createPrng(42);
    for (let i = 0; i < 50; i++) a.nextFloat();
    const b = createPrng(0, a.getState());
    const tailA = Array.from({ length: 20 }, () => a.nextFloat());
    const tailB = Array.from({ length: 20 }, () => b.nextFloat());
    expect(tailB).toEqual(tailA);
  });

  it("exponential has mean ~ 1/rate", () => {
    const p = createPrng(99);
    const n = 200_000;
    let sum = 0;
    for (let i = 0; i < n; i++) sum += p.exponential(2);
    expect(sum / n).toBeCloseTo(0.5, 1);
  });
});
