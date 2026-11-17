/**
 * Deterministic sine and cosine built only from + - * / and Math.round, which IEEE-754
 * defines exactly. Math.sin/Math.cos may differ in the last bit between JavaScript engines;
 * the physics uses these instead so that a solution replays to the identical result in every
 * browser and on the score-verification server. Accurate to about 1e-15.
 */
const PI = 3.141592653589793;
const HALF_PI = 1.5707963267948966;
const TWO_PI = 6.283185307179586;

export function dsin(a: number): number {
  let x = a - TWO_PI * Math.round(a / TWO_PI);
  if (x > HALF_PI) x = PI - x;
  else if (x < -HALF_PI) x = -PI - x;
  const x2 = x * x;
  return x * (1 + x2 * (-1 / 6 + x2 * (1 / 120 + x2 * (-1 / 5040 + x2 * (1 / 362880 + x2 * (-1 / 39916800
    + x2 * (1 / 6227020800 + x2 * (-1 / 1307674368000 + x2 * (1 / 355687428096000 + x2 * (-1 / 121645100408832000))))))))));
}

export function dcos(a: number): number {
  return dsin(a + HALF_PI);
}
