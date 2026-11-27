// Round-3 delta pass (W4): regression pins for the absorbed ADOPT NOW
// items from the fact-checked AI-review register. Each test names its
// register item. Items that failed the pre-registered constraint gate
// (P-15 authority cut, P-14 family caps) are NOT pinned here — they are
// follow-ups in the delta worklog.
import { test } from "node:test";
import assert from "node:assert/strict";
import { scoreMint } from "../src/lib/risk.js";
import { extractExtensions } from "../src/lib/solana.js";
import { assessConfidence, buildReport, buildCoverageReceipt } from "../src/lib/report.js";

const TOKEN_2022 = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
const base = { mintAuthorityActive: false, freezeAuthorityActive: false, topHolderPct: 4, top10HolderPct: 30, holderCount: 5000, supplyUi: 1000 };
const extBase = { hasPermanentDelegate: false, hasTransferFee: false, effectiveFeeBasisPoints: null, scheduledFeeBasisPoints: null, scheduledFeeEpoch: null, nonTransferable: false, defaultFrozen: false, hasTransferHook: false, hasConfidentialTransfer: false, hasMintCloseAuthority: false, transferFeeConfigAuthority: null, withdrawWithheldAuthority: null, transferFeeMaximumFee: null, effectiveFeeRateBps: null, transferHookAuthority: null, transferHookProgramId: null, hasPausableConfig: false, pausableAuthorityActive: false, transfersPaused: false, hasScaledUiAmount: false, scaledUiAuthorityActive: false, unknownExtensions: [], unparseableExtensionCount: 0 };
const flag = (r, k) => r.flags.find((f) => f.key === k);

// --- Item 4 (P-18): unknown authorities score 0 --------------------------------
test("delta P-18: unknown authority flags exist at 0 points and confidence carries the gap", () => {
  const facts = { ...base, mintAuthorityActive: null, freezeAuthorityActive: null };
  const r = scoreMint(facts);
  assert.equal(flag(r, "mint-authority-unknown").points, 0);
  assert.equal(flag(r, "freeze-authority-unknown").points, 0);
  assert.equal(r.score, 0);
  const c = assessConfidence({ ...facts, liquidity: { status: "detected" } });
  assert.ok(c.reasons.some((x) => /authority status could not be read/.test(x)));
});

// --- Item 2 (P-06): effective-rate fee tiers ------------------------------------
test("delta P-06: fee tiers on the effective rate (fallback = configured bps)", () => {
  const fee = (bps) => scoreMint({ ...base, programId: TOKEN_2022, extensions: { ...extBase, hasTransferFee: true, effectiveFeeBasisPoints: bps } });
  assert.equal(flag(fee(50), "transfer-fee").points, 2);   // 0.5%
  assert.equal(flag(fee(100), "transfer-fee").points, 5);  // 1%
  assert.equal(flag(fee(499), "transfer-fee").points, 5);  // 4.99%
  assert.equal(flag(fee(500), "transfer-fee").points, 10); // 5%
  assert.equal(flag(fee(2000), "transfer-fee").points, 20); // 20%
  assert.equal(flag(fee(5000), "transfer-fee").points, 35); // 50%
  assert.equal(flag(fee(5000), "transfer-fee").severity, "high");
  // unread fee size still fires at flat +5; 0 bps still fires nothing
  assert.equal(flag(fee(null), "transfer-fee").points, 5);
  assert.equal(flag(fee(0), "transfer-fee"), undefined);
});

test("delta P-06: maximumFee caps the effective rate at the frozen 1,000-token size", () => {
  // decimals 6, 50% bps, cap 1000 raw (=0.001 tokens): on 1,000 tokens the
  // uncapped fee would be 500 tokens; the cap makes it 0.001 -> ~0% rate.
  const info = { decimals: 6, extensions: [{ extension: "transferFeeConfig", state: { olderTransferFee: { epoch: "1", maximumFee: "1000", transferFeeBasisPoints: 5000 }, newerTransferFee: { epoch: "1", maximumFee: "1000", transferFeeBasisPoints: 5000 } } }] };
  const ext = extractExtensions(info, TOKEN_2022, 5);
  assert.equal(ext.effectiveFeeBasisPoints, 5000);
  assert.equal(ext.transferFeeMaximumFee, "1000");
  assert.ok(ext.effectiveFeeRateBps < 1, `rate ${ext.effectiveFeeRateBps}`);
  const r = scoreMint({ ...base, programId: TOKEN_2022, extensions: ext });
  assert.equal(flag(r, "transfer-fee").points, 2); // capped rate is in the lowest tier
  // No cap: same 50% configured rate scores the top tier.
  const info2 = { decimals: 6, extensions: [{ extension: "transferFeeConfig", state: { olderTransferFee: { epoch: "1", maximumFee: "999999999999", transferFeeBasisPoints: 5000 }, newerTransferFee: { epoch: "1", maximumFee: "999999999999", transferFeeBasisPoints: 5000 } } }] };
  const r2 = scoreMint({ ...base, programId: TOKEN_2022, extensions: extractExtensions(info2, TOKEN_2022, 5) });
  assert.equal(flag(r2, "transfer-fee").points, 35);
});

test("delta P-06: active fee-config authority adds +5 alongside a scored fee", () => {
  const r = scoreMint({ ...base, programId: TOKEN_2022, extensions: { ...extBase, hasTransferFee: true, effectiveFeeBasisPoints: 100, transferFeeConfigAuthority: "Auth111111111111111111111111111111111111111" } });
  assert.equal(flag(r, "transfer-fee-authority").points, 5);
  const r0 = scoreMint({ ...base, programId: TOKEN_2022, extensions: { ...extBase, hasTransferFee: true, effectiveFeeBasisPoints: 0, transferFeeConfigAuthority: "Auth111111111111111111111111111111111111111" } });
  assert.equal(flag(r0, "transfer-fee-authority"), undefined); // no scored fee, no surcharge
});

// --- Item 3 (S-32): mutable-fee flag, 0 points, corrected wording ----------------
test("delta S-32: scheduled fee change emits a distinct 0-point mutable-fee flag", () => {
  const r = scoreMint({ ...base, programId: TOKEN_2022, extensions: { ...extBase, hasTransferFee: true, effectiveFeeBasisPoints: 100, scheduledFeeBasisPoints: 9000, scheduledFeeEpoch: "700" } });
  const f = flag(r, "transfer-fee-mutable");
  assert.ok(f); assert.equal(f.points, 0);
  assert.match(f.detail, /up to 100%/);
  assert.match(f.detail, /future epoch/);
  assert.match(f.detail, /visible in advance/);
  assert.equal(r.flags.reduce((s, x) => s + x.points, 0), r.score);
});

// --- Item 1 (C-09/C-10): dormant-trap facts --------------------------------------
test("delta C-09: fee/hook authorities and maximumFee are extracted from the payload", () => {
  const info = { decimals: 6, extensions: [
    { extension: "transferFeeConfig", state: { transferFeeConfigAuthority: "FeeAuth11111111111111111111111111111111111", withdrawWithheldAuthority: "WdAuth111111111111111111111111111111111111", olderTransferFee: { epoch: "1", maximumFee: "5000", transferFeeBasisPoints: 100 }, newerTransferFee: { epoch: "2", maximumFee: "5000", transferFeeBasisPoints: 100 } } },
    { extension: "transferHook", state: { authority: "HookAuth1111111111111111111111111111111111", programId: "HookProg1111111111111111111111111111111111" } },
  ] };
  const ext = extractExtensions(info, TOKEN_2022, 1);
  assert.equal(ext.transferFeeConfigAuthority, "FeeAuth11111111111111111111111111111111111");
  assert.equal(ext.withdrawWithheldAuthority, "WdAuth111111111111111111111111111111111111");
  assert.equal(ext.transferHookAuthority, "HookAuth1111111111111111111111111111111111");
  assert.equal(ext.transferHookProgramId, "HookProg1111111111111111111111111111111111");
  assert.equal(ext.transferFeeMaximumFee, "5000");
});

// --- Item 5 (C-40/S-22): unrecognized extension => coverage incomplete ------------
test("delta C-40: unknown extension names are recorded and named by assessConfidence", () => {
  const info = { extensions: [{ extension: "someFutureExtension", state: {} }, { state: {} }] };
  const ext = extractExtensions(info, TOKEN_2022);
  assert.deepEqual(ext.unknownExtensions, ["someFutureExtension"]);
  assert.equal(ext.unparseableExtensionCount, 1);
  const c = assessConfidence({ ...base, programId: TOKEN_2022, extensions: ext, liquidity: { status: "detected" } });
  assert.ok(c.reasons.some((x) => /Extension coverage is incomplete/.test(x) && /someFutureExtension/.test(x)));
  // Known names (incl. pausable/scaled) are NOT unknown.
  const known = extractExtensions({ extensions: [{ extension: "pausableConfig", state: {} }, { extension: "scaledUiAmountConfig", state: {} }] }, TOKEN_2022);
  assert.deepEqual(known.unknownExtensions, []);
});

// --- Item 6 (C-39/S-28/S-29): pausable + scaled-UI --------------------------------
test("delta S-28: paused token floors at 60 via transfers-paused; can-pause alone is fact only", () => {
  const info = { extensions: [{ extension: "pausableConfig", state: { authority: "Pause1111111111111111111111111111111111111", paused: true } }] };
  const ext = extractExtensions(info, TOKEN_2022);
  assert.equal(ext.hasPausableConfig, true);
  assert.equal(ext.pausableAuthorityActive, true);
  assert.equal(ext.transfersPaused, true);
  const r = scoreMint({ ...base, programId: TOKEN_2022, extensions: ext });
  assert.equal(r.score, 60); assert.equal(r.band, "HIGH RISK");
  assert.equal(flag(r, "transfers-paused").points, 60);
  assert.match(flag(r, "transfers-paused").detail, /cannot be sold at all/);
  // Can-pause but not paused: no flag, no points.
  const ext2 = extractExtensions({ extensions: [{ extension: "pausableConfig", state: { authority: "Pause1111111111111111111111111111111111111", paused: false } }] }, TOKEN_2022);
  const r2 = scoreMint({ ...base, programId: TOKEN_2022, extensions: ext2 });
  assert.equal(r2.score, 0); assert.equal(flag(r2, "transfers-paused"), undefined);
});

test("delta S-29: scaled-UI amount is extracted as a fact and never scored", () => {
  const ext = extractExtensions({ extensions: [{ extension: "scaledUiAmountConfig", state: { authority: "Scale1111111111111111111111111111111111111", multiplier: 2 } }] }, TOKEN_2022);
  assert.equal(ext.hasScaledUiAmount, true);
  assert.equal(ext.scaledUiAuthorityActive, true);
  const r = scoreMint({ ...base, programId: TOKEN_2022, extensions: ext });
  assert.equal(r.score, 0); assert.equal(r.flags.length, 0);
});

// --- Items 7+8+9 (C-15/P-37/C-02): slot, receipt, top-20 in the report ------------
test("delta C-15/P-37/C-02: report carries slot, coverage receipt and top-20 fact", () => {
  const facts = { ...base, top20HolderPct: 55.5, slot: 123456789, programId: TOKEN_2022, extensions: { ...extBase }, liquidity: { status: "detected", poolCount: 3, lpStatus: "not-checked" } };
  const report = buildReport({ mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", cluster: "mainnet-beta", facts, result: scoreMint(facts), observedAt: "2026-11-27T00:00:00.000Z" });
  assert.equal(report.slot, 123456789);
  assert.equal(report.facts.top20HolderPct, 55.5);
  assert.ok(report.coverage.checked.some((x) => /Holder concentration/.test(x)));
  assert.ok(report.coverage.checked.some((x) => /Liquidity pools/.test(x)));
  assert.ok(report.coverage.notChecked.some((x) => /LP\) tokens are locked or burned/.test(x)));
  assert.ok(report.coverage.notChecked.some((x) => /owner clusters/.test(x)));
  assert.ok(report.coverage.notChecked.some((x) => /deployer/.test(x)));
  const receipt = buildCoverageReceipt({ ...facts, topHolderPct: null, liquidity: { status: "unknown" } });
  assert.ok(receipt.notChecked.some((x) => /Holder concentration/.test(x)));
  assert.ok(receipt.notChecked.some((x) => /Liquidity pools/.test(x)));
});

// --- Item 10 (C-33): band rename ---------------------------------------------------
test("delta C-33: low band is LOWER OBSERVED RISK everywhere the scorer produces it", () => {
  assert.equal(scoreMint(base).band, "LOWER OBSERVED RISK");
});

// --- Item 12 (P-16/P-19): raised extension weights ---------------------------------
test("delta P-16/P-19: non-transferable 40, delegate 30, default-frozen 25", () => {
  assert.equal(flag(scoreMint({ ...base, programId: TOKEN_2022, extensions: { ...extBase, nonTransferable: true } }), "non-transferable").points, 40);
  assert.equal(flag(scoreMint({ ...base, programId: TOKEN_2022, extensions: { ...extBase, hasPermanentDelegate: true } }), "permanent-delegate").points, 30);
  assert.equal(flag(scoreMint({ ...base, programId: TOKEN_2022, extensions: { ...extBase, defaultFrozen: true } }), "default-frozen").points, 25);
});
