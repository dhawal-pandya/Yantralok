// The ambient legibility layer's color language: one continuous green -> amber ->
// red ramp, so a comfortable tier reads green and a saturating one reads red. Used
// by both the node glow and the latency-tinted wires so they speak the same hue.
type RGB = [number, number, number];

const GREEN: RGB = [52, 211, 153]; // emerald-400, healthy
const AMBER: RGB = [245, 179, 1]; // signal amber, saturating
const RED: RGB = [248, 113, 113]; // red-400, critical

const mix = (a: RGB, b: RGB, t: number): RGB => [
  Math.round(a[0] + (b[0] - a[0]) * t),
  Math.round(a[1] + (b[1] - a[1]) * t),
  Math.round(a[2] + (b[2] - a[2]) * t),
];

/** Green (t=0) through amber (t=0.5) to red (t=1). Clamped. */
export function healthColor(t: number): RGB {
  const c = Math.max(0, Math.min(1, t));
  return c < 0.5 ? mix(GREEN, AMBER, c / 0.5) : mix(AMBER, RED, (c - 0.5) / 0.5);
}

export const rgb = ([r, g, b]: RGB) => `rgb(${r} ${g} ${b})`;
export const rgba = ([r, g, b]: RGB, a: number) => `rgb(${r} ${g} ${b} / ${a})`;
