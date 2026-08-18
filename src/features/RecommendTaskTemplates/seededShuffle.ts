/**
 * xmur3 — turns an arbitrary string into a well-mixed 32-bit integer suitable as a PRNG seed.
 * Small avalanche: seeds differing by one character produce unrelated states.
 */
const hashSeed = (seed: string): number => {
  let h = 1_779_033_703 ^ seed.length;

  for (let i = 0; i < seed.length; i++) {
    h = Math.imul(h ^ seed.charCodeAt(i), 3_432_918_353);
    h = (h << 13) | (h >>> 19);
  }

  h = Math.imul(h ^ (h >>> 16), 2_246_822_507);
  h = Math.imul(h ^ (h >>> 13), 3_266_489_909);

  return (h ^ (h >>> 16)) >>> 0;
};

/** mulberry32 — 32-bit PRNG, returns floats in [0, 1). */
const mulberry32 = (seed: number) => {
  let state = seed >>> 0;

  return () => {
    state = (state + 0x6d_2b_79_f5) | 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
};

/**
 * Fisher–Yates shuffle driven by a seeded PRNG: pure, and deterministic for a given seed.
 * Used to vary the order of platform-managed task templates per visit without a server round trip.
 */
export const seededShuffle = <T>(items: readonly T[], seed: string): T[] => {
  const result = [...items];
  if (result.length < 2) return result;

  const random = mulberry32(hashSeed(seed));

  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }

  return result;
};
