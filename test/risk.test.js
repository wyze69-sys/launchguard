import { test } from "node:test";
import assert from "node:assert/strict";
import { scoreMint, summarize } from "../src/lib/risk.js";

test("clean mint scores low", () => {
  const r = scoreMint({
    mintAuthorityActive: false,
    freezeAuthorityActive: false,
    topHolderPct: 4,
    top10HolderPct: 30,
    holderCount: 5000,
    supplyUi: 1_000_000_000,
  });
  assert.equal(r.score, 0);
  assert.equal(r.band, "LOWER OBSERVED RISK");
  assert.equal(r.flags.length, 0);
});

test("classic rug setup scores high", () => {
  const r = scoreMint({
    mintAuthorityActive: true,
    freezeAuthorityActive: true,
    topHolderPct: 62,
    top10HolderPct: 95,
    holderCount: 12,
    supplyUi: 1_000_000,
  });
  assert.ok(r.score >= 60, `expected >=60, got ${r.score}`);
  assert.equal(r.band, "HIGH RISK");
  assert.ok(r.flags.some((f) => f.key === "mint-authority"));
  assert.ok(r.flags.some((f) => f.key === "freeze-authority"));
});

test("unknown authorities score 0 points (round-3 delta, P-18: unknown never punishes)", () => {
  const r = scoreMint({
    mintAuthorityActive: null,
    freezeAuthorityActive: null,
    topHolderPct: null,
    top10HolderPct: null,
    holderCount: null,
    supplyUi: null,
  });
  assert.equal(r.score, 0);
  assert.equal(r.band, "LOWER OBSERVED RISK");
  assert.ok(r.flags.some((f) => f.key === "mint-authority-unknown" && f.points === 0));
  assert.ok(r.flags.some((f) => f.key === "freeze-authority-unknown" && f.points === 0));
});

test("score is clamped to 100", () => {
  const r = scoreMint({
    mintAuthorityActive: true,
    freezeAuthorityActive: true,
    topHolderPct: 99,
    top10HolderPct: 99,
    holderCount: 1,
    supplyUi: 1,
  });
  assert.ok(r.score <= 100);
});

test("summarize includes score and band", () => {
  const r = scoreMint({
    mintAuthorityActive: true, freezeAuthorityActive: false,
    topHolderPct: 5, top10HolderPct: 20, holderCount: 300, supplyUi: 10,
  });
  const s = summarize("AbCdEfGh1111111111111111111111111111111111", r);
  assert.match(s, /score=30\/100/);
  assert.match(s, /CAUTION/);
});

// --- FIX 1: holder-count floor ------------------------------------------------

test("holderCountIsFloor suppresses holder rules (FIX 1)", () => {
  const clean = {
    mintAuthorityActive: false, freezeAuthorityActive: false,
    topHolderPct: 4, top10HolderPct: 30, supplyUi: 1000,
  };
  const floored = scoreMint({ ...clean, holderCount: 20, holderCountIsFloor: true });
  assert.equal(floored.score, 0);
  assert.ok(!floored.flags.some((f) => f.key === "few-holders" || f.key === "few-holders-100"));
  const exactFalse = scoreMint({ ...clean, holderCount: 20, holderCountIsFloor: false });
  assert.ok(exactFalse.flags.some((f) => f.key === "few-holders"));
  const exactAbsent = scoreMint({ ...clean, holderCount: 20 });
  assert.ok(exactAbsent.flags.some((f) => f.key === "few-holders"));
});

// --- FIX 13: boundaries ---------------------------------------------------------

test("boundary: topHolderPct 49.9 is whale-25, 50 is whale-50", () => {
  const base = { mintAuthorityActive: false, freezeAuthorityActive: false, top10HolderPct: 30, holderCount: 5000, supplyUi: 10 };
  const r49 = scoreMint({ ...base, topHolderPct: 49.9 });
  assert.ok(r49.flags.some((f) => f.key === "whale-25"));
  assert.ok(!r49.flags.some((f) => f.key === "whale-50"));
  const r50 = scoreMint({ ...base, topHolderPct: 50 });
  assert.ok(r50.flags.some((f) => f.key === "whale-50"));
});

test("boundary: holderCount 24 / 25 / 100 holder flags", () => {
  const base = { mintAuthorityActive: false, freezeAuthorityActive: false, topHolderPct: 4, top10HolderPct: 30, supplyUi: 10 };
  const r24 = scoreMint({ ...base, holderCount: 24 });
  assert.ok(r24.flags.some((f) => f.key === "few-holders" && f.points === 10));
  const r25 = scoreMint({ ...base, holderCount: 25 });
  assert.ok(r25.flags.some((f) => f.key === "few-holders-100" && f.points === 4));
  assert.ok(!r25.flags.some((f) => f.key === "few-holders"));
  const r100 = scoreMint({ ...base, holderCount: 100 });
  assert.ok(!r100.flags.some((f) => f.key === "few-holders" || f.key === "few-holders-100"));
});

test("boundary: band edges 29 / 30 / 59 / 60", () => {
  // Delta: unknown authorities no longer contribute the +10 this fixture
  // used to rely on (P-18), so the 29-point edge is now built from scored
  // facts only: whale-25 (15) + concentration-70 (8) + few-holders-100 (4)
  // + a sub-1% transfer fee at the lowest tier (2) = 29.
  const r29 = scoreMint({ mintAuthorityActive: false, freezeAuthorityActive: false, topHolderPct: 30, top10HolderPct: 80, holderCount: 50, supplyUi: 10, programId: "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb", extensions: { hasTransferFee: true, effectiveFeeBasisPoints: 50 } });
  assert.equal(r29.score, 29);
  assert.equal(r29.band, "LOWER OBSERVED RISK");
  const r30 = scoreMint({ mintAuthorityActive: true, freezeAuthorityActive: false, topHolderPct: 4, top10HolderPct: 30, holderCount: 5000, supplyUi: 10 });
  assert.equal(r30.score, 30);
  assert.equal(r30.band, "CAUTION");
  const r59 = scoreMint({ mintAuthorityActive: true, freezeAuthorityActive: true, topHolderPct: 4, top10HolderPct: 30, holderCount: 50, supplyUi: 10 });
  assert.equal(r59.score, 59);
  assert.equal(r59.band, "CAUTION");
  const r60 = scoreMint({ mintAuthorityActive: true, freezeAuthorityActive: false, topHolderPct: 30, top10HolderPct: 95, holderCount: 5000, supplyUi: 10 });
  assert.equal(r60.score, 60);
  assert.equal(r60.band, "HIGH RISK");
});

test("maxed-out mint scores exactly 100", () => {
  const r = scoreMint({
    mintAuthorityActive: true, freezeAuthorityActive: true,
    topHolderPct: 99, top10HolderPct: 99, holderCount: 1, supplyUi: 1,
  });
  assert.equal(r.score, 100);
});
