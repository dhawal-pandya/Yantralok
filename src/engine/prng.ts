// Seeded xoshiro128** PRNG. Deterministic; state is snapshot-able.
export interface Prng {
  /** Uniform float in [0, 1). */
  nextFloat(): number;
  /** Exponential sample with the given rate (mean 1/rate). */
  exponential(rate: number): number;
  /** Internal state, for snapshot/restore. */
  getState(): number[];
}

function splitmix32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x9e3779b9) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 16), 0x21f0aaad) >>> 0;
    t = Math.imul(t ^ (t >>> 15), 0x735a2d97) >>> 0;
    return (t ^ (t >>> 15)) >>> 0;
  };
}

const rotl = (x: number, k: number): number =>
  ((x << k) | (x >>> (32 - k))) >>> 0;

export function createPrng(seed: number, state?: number[]): Prng {
  let s0: number, s1: number, s2: number, s3: number;
  if (state) {
    [s0, s1, s2, s3] = state;
  } else {
    const sm = splitmix32(seed);
    s0 = sm();
    s1 = sm();
    s2 = sm();
    s3 = sm();
  }

  const nextU32 = (): number => {
    const result = Math.imul(rotl(Math.imul(s1, 5) >>> 0, 7), 9) >>> 0;
    const t = (s1 << 9) >>> 0;
    s2 ^= s0;
    s3 ^= s1;
    s1 ^= s2;
    s0 ^= s3;
    s2 ^= t;
    s3 = rotl(s3, 11);
    return result;
  };

  const nextFloat = (): number => nextU32() / 0x100000000;

  // Math.log is V8-consistent; cross-engine determinism would need a pinned log.
  const exponential = (rate: number): number =>
    -Math.log(1 - nextFloat()) / rate;

  const getState = (): number[] => [s0 >>> 0, s1 >>> 0, s2 >>> 0, s3 >>> 0];

  return { nextFloat, exponential, getState };
}
