//! Mulberry32 and the murmur3-style mixHash, ported byte-for-byte from
//! `src/rng.ts`. The simulation core, the static table generators, and
//! the test scenarios all share a single definition; behaviour must
//! match TS exactly so that any future cross-impl golden test produces
//! identical draws.
//!
//! All arithmetic is wrapping 32-bit, matching the TS `Math.imul` and
//! `|0` semantics. We use `u32::wrapping_*` / `i32` casts to avoid
//! debug-only overflow panics.

/// Deterministic PRNG, drop-in for the TS `mulberry32(seed)` closure.
/// Each call to `next_f64` advances state and returns a uniform value
/// in `[0, 1)`. Same state -> same sequence as the TS version.
pub struct Mulberry32 {
    state: u32,
}

impl Mulberry32 {
    pub fn new(seed: u32) -> Self {
        Self { state: seed }
    }

    /// Returns the next raw u32 -- the value before division by 2^32
    /// in `next_f64`. Useful when generating integer-domain draws
    /// without going through float and back.
    pub fn next_u32(&mut self) -> u32 {
        self.state = self.state.wrapping_add(0x6d2b79f5);
        let mut t = self.state;
        t = (t ^ (t >> 15)).wrapping_mul(t | 1);
        t ^= t.wrapping_add((t ^ (t >> 7)).wrapping_mul(t | 61));
        t ^ (t >> 14)
    }

    /// Drop-in for the TS `() => number` closure -- uniform in [0, 1).
    pub fn next_f64(&mut self) -> f64 {
        self.next_u32() as f64 / 4_294_967_296.0
    }

    /// Current internal state, for save/load. A `Mulberry32::new` of
    /// the returned value resumes the same sequence.
    pub fn peek_state(&self) -> u32 {
        self.state
    }
}

/// 32-bit murmur3-style mixer matching the TS `mixHash(...vals)`. Takes
/// arbitrarily many integer coordinates; each is mixed into the
/// accumulator with the same constants and shift/multiply pattern the
/// TS implementation uses. Inputs are coerced to `i32` to match the
/// `| 0` semantics of the source.
pub fn mix_hash(vals: &[i32]) -> u32 {
    let mut h: i32 = 0x9e3779b9u32 as i32;
    for &v in vals {
        let mut k: u32 = v as u32;
        k = (k ^ (k >> 16)).wrapping_mul(0x85ebca6b);
        k = (k ^ (k >> 13)).wrapping_mul(0xc2b2ae35);
        k ^= k >> 16;
        let h_u = (h as u32) ^ k;
        let h_u = h_u.wrapping_mul(0x9e3779b1);
        let h_u = h_u.rotate_left(13);
        h = h_u.wrapping_mul(5).wrapping_add(0xe6546b64) as i32;
    }
    let mut h_u = h as u32;
    h_u ^= h_u >> 16;
    h_u = h_u.wrapping_mul(0x85ebca6b);
    h_u ^= h_u >> 13;
    h_u = h_u.wrapping_mul(0xc2b2ae35);
    h_u ^= h_u >> 16;
    h_u
}

/// Uniform double in `[0, 1)` from `mix_hash`. Matches TS `hashUnit`.
pub fn hash_unit(vals: &[i32]) -> f64 {
    mix_hash(vals) as f64 / 4_294_967_296.0
}

#[cfg(test)]
mod tests {
    use super::*;

    // Goldens captured by running the TS implementation against the
    // same seeds; any drift here means the Rust and TS halves of the
    // sim would disagree.

    #[test]
    fn mulberry_seed_0_first_five() {
        // Captured from: const r = mulberry32(0); [r(),r(),r(),r(),r()]
        let mut r = Mulberry32::new(0);
        let got = [
            r.next_f64(),
            r.next_f64(),
            r.next_f64(),
            r.next_f64(),
            r.next_f64(),
        ];
        let expected = [
            0.26642920868471265,
            0.0003297457005828619,
            0.2232720274478197,
            0.1462021479383111,
            0.46732782293111086,
        ];
        for (a, b) in got.iter().zip(expected.iter()) {
            assert!((a - b).abs() < 1e-15, "got {a}, expected {b}");
        }
    }

    #[test]
    fn mulberry_seed_5eed9a1c_first_three() {
        // The exact seed chemistry.ts uses to scramble generic chems.
        let mut r = Mulberry32::new(0x5EED9A1C);
        let got = [r.next_f64(), r.next_f64(), r.next_f64()];
        let expected = [
            0.39913066755980253,
            0.30863338615745306,
            0.9289909563958645,
        ];
        for (a, b) in got.iter().zip(expected.iter()) {
            assert!((a - b).abs() < 1e-15, "got {a}, expected {b}");
        }
    }

    #[test]
    fn mix_hash_matches_ts() {
        // Captured from running TS mixHash on these inputs.
        assert_eq!(mix_hash(&[0]), 3_275_541_411);
        assert_eq!(mix_hash(&[1, 2, 3]), 94_004_840);
        assert_eq!(mix_hash(&[42, -1, 0x7fff_ffff]), 1_549_003_877);
    }
}
