import { describe, it, expect } from "vitest";
import { mixHash, hashUnit } from "../rng";

describe("mixHash / hashUnit (per-event deterministic entropy)", () => {
  it("is a pure function of its inputs (same coords -> same value)", () => {
    expect(mixHash(7, 42, 100, 1)).toBe(mixHash(7, 42, 100, 1));
    expect(hashUnit(7, 42, 100, 1)).toBe(hashUnit(7, 42, 100, 1));
  });

  it("returns a uint32", () => {
    for (const v of [mixHash(0), mixHash(1, 2, 3), mixHash(-1), mixHash(2 ** 31)]) {
      expect(Number.isInteger(v)).toBe(true);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(0xffffffff);
    }
  });

  it("hashUnit stays in [0, 1)", () => {
    for (let i = 0; i < 5000; i++) {
      const u = hashUnit(i, i * 7 + 1, (i % 13) + 1);
      expect(u).toBeGreaterThanOrEqual(0);
      expect(u).toBeLessThan(1);
    }
  });

  it("is order- and argument-sensitive (avalanche)", () => {
    expect(mixHash(1, 2)).not.toBe(mixHash(2, 1));
    expect(mixHash(1, 2, 3)).not.toBe(mixHash(1, 2, 4));
    // a one-bit change in any coordinate should change the output
    expect(mixHash(1000, 0, 0)).not.toBe(mixHash(1001, 0, 0));
    expect(mixHash(0, 0, 0)).not.toBe(mixHash(0, 0, 1));
  });

  it("is roughly uniform over [0,1) (no gross bias)", () => {
    const bins = new Array(10).fill(0);
    const N = 20000;
    for (let i = 0; i < N; i++) {
      bins[Math.floor(hashUnit(i, 0xabcdef, i * 31) * 10)]++;
    }
    // each bin should hold ~10% of N; allow generous slack
    for (const b of bins) {
      expect(b).toBeGreaterThan(N * 0.07);
      expect(b).toBeLessThan(N * 0.13);
    }
  });
});
