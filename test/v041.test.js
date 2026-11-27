// LaunchGuard v0.4.1 patch tests (F-R2 confidential-balance coverage
// caveat + F-R1 GPA start pacing). All offline; the pacing tests use a
// stubbed global fetch and the real clock, recording the timestamp of
// every getProgramAccounts start.
import { test } from "node:test";
import assert from "node:assert/strict";
import { assessConfidence, buildCoverageReceipt, buildReport } from "../src/lib/report.js";
import { scoreMint } from "../src/lib/risk.js";
import { fetchLiquidity, RAYDIUM_AMM_V4_PROGRAM_ID } from "../src/lib/solana.js";

const TOKEN_2022 = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
const ENDPOINT = "https://api.mainnet-beta.solana.com";
const MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

const CAVEAT = "confidential balances";
const CONFIDENTIAL_REASON =
  "This mint supports confidential balances: holder shares cover publicly visible balances only, so observed concentration may understate actual concentration.";

const noExtensions = {
  hasPermanentDelegate: false, hasTransferFee: false,
  effectiveFeeBasisPoints: null, scheduledFeeBasisPoints: null, scheduledFeeEpoch: null,
  nonTransferable: false, defaultFrozen: false, hasTransferHook: false, hasConfidentialTransfer: false,
  hasMintCloseAuthority: false,
  transferFeeConfigAuthority: null, withdrawWithheldAuthority: null, transferFeeMaximumFee: null,
  effectiveFeeRateBps: null, transferHookAuthority: null, transferHookProgramId: null,
  hasPausableConfig: false, pausableAuthorityActive: false, transfersPaused: false,
  hasScaledUiAmount: false, scaledUiAuthorityActive: false,
  unknownExtensions: [], unparseableExtensionCount: 0,
};

// Clean, fully-read facts: assessConfidence yields ZERO reasons for
// these, so any reason that appears is attributable to the one change
// under test.
const cleanFacts = {
  mintAuthorityActive: false,
  freezeAuthorityActive: false,
  topHolderPct: 4,
  top10HolderPct: 30,
  top20HolderPct: 40,
  holderCount: 5000,
  holderCountIsFloor: false,
  supplyUi: 1_000_000,
  programId: TOKEN_2022,
  extensions: { ...noExtensions },
  liquidity: { status: "detected", poolCount: 3, lpStatus: "not-checked" },
};
const confidentialFacts = {
  ...cleanFacts,
  extensions: { ...noExtensions, hasConfidentialTransfer: true },
};

// --- F-R2 (a): confidence reason present iff hasConfidentialTransfer -------------

test("F-R2: assessConfidence adds the confidential-balance caveat reason when the mint supports confidential balances", () => {
  const conf = assessConfidence(confidentialFacts);
  assert.ok(conf.reasons.includes(CONFIDENTIAL_REASON), `reasons: ${JSON.stringify(conf.reasons)}`);
  // It is the ONLY reason for otherwise-clean facts, so the level drops
  // exactly one step (high -> medium): a coverage disclosure, not a score.
  assert.deepEqual(conf.reasons, [CONFIDENTIAL_REASON]);
  assert.equal(conf.level, "medium");
});

test("F-R2: assessConfidence has no confidential-balance caveat when the extension is false or absent", () => {
  for (const facts of [
    cleanFacts,
    { ...cleanFacts, extensions: { ...noExtensions, hasConfidentialTransfer: false } },
    { ...cleanFacts, extensions: null },
    { ...cleanFacts, extensions: undefined },
  ]) {
    const conf = assessConfidence(facts);
    assert.ok(!conf.reasons.some((r) => r.includes(CAVEAT)), `reasons: ${JSON.stringify(conf.reasons)}`);
  }
  // The clean baseline itself stays high-confidence with zero reasons.
  assert.deepEqual(assessConfidence(cleanFacts), { level: "high", reasons: [] });
});

// --- F-R2 (b): coverage receipt holder-concentration line carries the caveat ----

test("F-R2: coverage receipt holder-concentration line carries the confidential-balance caveat", () => {
  const receipt = buildCoverageReceipt(confidentialFacts);
  const holderLines = receipt.checked.filter((x) => /Holder concentration/.test(x));
  assert.equal(holderLines.length, 1);
  assert.ok(holderLines[0].includes(CAVEAT), holderLines[0]);
  assert.ok(holderLines[0].includes("publicly visible balances only"), holderLines[0]);
  assert.ok(holderLines[0].includes("understate actual concentration"), holderLines[0]);

  const plain = buildCoverageReceipt(cleanFacts);
  const plainHolder = plain.checked.filter((x) => /Holder concentration/.test(x));
  assert.equal(plainHolder.length, 1);
  assert.ok(!plainHolder[0].includes(CAVEAT), plainHolder[0]);
  // And no other receipt line gains the caveat in the plain case either.
  assert.ok(![...plain.checked, ...plain.notChecked].some((x) => x.includes(CAVEAT)));
});

// --- F-R2 (c): score and band are identical with vs without the extension -------

test("F-R2: scoreMint and buildReport score/band are identical for a confidential-transfer mint vs the same mint without it", () => {
  for (const base of [
    cleanFacts,
    // A non-trivial score too, so the pin is not only about the 0 case:
    { ...cleanFacts, mintAuthorityActive: true, topHolderPct: 55, top10HolderPct: 92 },
  ]) {
    const withExt = { ...base, extensions: { ...noExtensions, hasConfidentialTransfer: true } };
    const withoutExt = { ...base, extensions: { ...noExtensions, hasConfidentialTransfer: false } };
    const a = scoreMint(withExt);
    const b = scoreMint(withoutExt);
    assert.equal(a.score, b.score);
    assert.equal(a.band, b.band);
    assert.deepEqual(a.flags.map((f) => f.key), b.flags.map((f) => f.key));

    const ra = buildReport({ mint: MINT, cluster: "mainnet-beta", facts: withExt, result: a, observedAt: "2026-11-27T10:00:00.000Z" });
    const rb = buildReport({ mint: MINT, cluster: "mainnet-beta", facts: withoutExt, result: b, observedAt: "2026-11-27T10:00:00.000Z" });
    assert.equal(ra.score, rb.score);
    assert.equal(ra.band, rb.band);
  }
});

// --- F-R1: GPA start pacing -------------------------------------------------------

function jsonResponse(result, status = 200) {
  return { status, ok: status >= 200 && status < 300, async json() { return { jsonrpc: "2.0", id: 1, result }; } };
}

// Assert the pacing invariant on recorded GPA start times: no window
// of 1 second contains more than 5 starts. Checked as: the 6th-next
// start is never less than ~1 s after a start (50 ms tolerance for
// clock/fetch recording jitter; unpaced starts would all land within
// a few ms of each other, so this cannot pass by accident).
function assertPaced(starts) {
  const sorted = [...starts].sort((a, b) => a - b);
  for (let i = 0; i + 5 < sorted.length; i++) {
    assert.ok(
      sorted[i + 5] - sorted[i] >= 950,
      `starts ${i} and ${i + 5} are only ${sorted[i + 5] - sorted[i]} ms apart: ${JSON.stringify(sorted)}`,
    );
  }
}

test("F-R1: fetchLiquidity paces the 10 GPA starts to at most 5 per second", async () => {
  const original = globalThis.fetch;
  const starts = [];
  globalThis.fetch = async (endpoint, opts) => {
    const body = JSON.parse(opts.body);
    assert.equal(body.method, "getProgramAccounts");
    starts.push(Date.now());
    return jsonResponse([]);
  };
  try {
    const liq = await fetchLiquidity(ENDPOINT, MINT);
    // Result semantics unchanged: every venue queried, all empty.
    assert.deepEqual(liq, {
      status: "not-detected", poolCount: 0, lpStatus: "not-checked",
      venues: { raydiumAmmV4: 0, meteoraDlmm: 0, meteoraDammV2: 0, meteoraDammV1: 0, orcaWhirlpool: 0 },
    });
    assert.equal(starts.length, 10);
    assertPaced(starts);
  } finally { globalThis.fetch = original; }
});

test("F-R1: a first-wave 429 retry also passes through the pacing gate (<=5 starts per second overall)", async () => {
  const original = globalThis.fetch;
  const starts = [];
  let raydiumBaseCalls = 0;
  globalThis.fetch = async (endpoint, opts) => {
    const body = JSON.parse(opts.body);
    assert.equal(body.method, "getProgramAccounts");
    starts.push(Date.now());
    const programId = body.params[0];
    const offset = body.params[1].filters[0].memcmp.offset;
    // The Raydium base-mint query (a first-wave start) 429s once, then
    // succeeds empty on its single retry.
    if (programId === RAYDIUM_AMM_V4_PROGRAM_ID && offset === 400) {
      raydiumBaseCalls += 1;
      if (raydiumBaseCalls === 1) return { status: 429, ok: false, async json() { return {}; } };
    }
    return jsonResponse([]);
  };
  try {
    const liq = await fetchLiquidity(ENDPOINT, MINT);
    // The retry succeeded, so the venue resolves instead of degrading.
    assert.equal(raydiumBaseCalls, 2);
    assert.equal(liq.status, "not-detected");
    assert.equal(liq.venues.raydiumAmmV4, 0);
    // 10 initial starts + 1 retry start, all inside the pacing rule.
    assert.equal(starts.length, 11);
    assertPaced(starts);
  } finally { globalThis.fetch = original; }
});
