// LaunchGuard round-2 regression tests (studio-repair pass).
// Pins E1 (LG-P6 status-aware liquidity + LG2-P1 dedupe), E2 (calibration
// V3), E3 (GPA retry budget), LG2-F1..F4 and LG2-P2. All offline.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fetchMintFacts, fetchLiquidity, extractExtensions, RpcError } from "../src/lib/solana.js";
import { scoreMint } from "../src/lib/risk.js";
import { assessConfidence } from "../src/lib/report.js";

const MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const TOKEN_2022 = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
const ENDPOINT = "https://api.mainnet-beta.solana.com";

function jsonResponse(result, status = 200) {
  return { status, ok: status >= 200 && status < 300, async json() { return { jsonrpc: "2.0", id: 1, result }; } };
}
function rateLimited() { return { status: 429, ok: false, async json() { return {}; } }; }

// Pool entry with an exact status: 8-byte little-endian u64 at offset 0.
function pool(pubkey, status) {
  const bytes = Buffer.alloc(8); bytes[0] = status;
  return { pubkey, account: { data: [bytes.toString("base64"), "base64"] } };
}
function stubGpa(handler) {
  const original = globalThis.fetch;
  const counts = { 400: 0, 432: 0 };
  globalThis.fetch = async (endpoint, opts) => {
    const body = JSON.parse(opts.body);
    // Round-3 edit: fetchLiquidity now also queries the Meteora
    // programs; those queries return empty here so the Raydium-focused
    // E1/E3 assertions (including the exact attempt counts) keep their
    // original meaning. Meteora behaviour is pinned in round3.test.js.
    if (body.params[0] !== "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8") return jsonResponse([]);
    const offset = body.params[1].filters[0].memcmp.offset;
    counts[offset] += 1;
    return handler(offset, counts[offset]);
  };
  return { restore: () => { globalThis.fetch = original; }, counts };
}

// --- E1: status-aware pool counting -------------------------------------------

test("E1: status 0 (Uninitialized) is not a pool -> not-detected", async () => {
  const { restore } = stubGpa(() => jsonResponse([pool("PoolA11111111111111111111111111111111111111", 0)]));
  try {
    const liq = await fetchLiquidity(ENDPOINT, MINT);
    assert.deepEqual(liq, { status: "not-detected", poolCount: 0, lpStatus: "not-checked", venues: { raydiumAmmV4: 0, meteoraDlmm: 0, meteoraDammV2: 0, meteoraDammV1: 0, orcaWhirlpool: 0 } });
  } finally { restore(); }
});

test("E1: statuses 1, 6 and 7 each count as a live pool", async () => {
  for (const status of [1, 6, 7]) {
    const { restore } = stubGpa((offset) => jsonResponse(offset === 400 ? [pool("PoolA11111111111111111111111111111111111111", status)] : []));
    try {
      const liq = await fetchLiquidity(ENDPOINT, MINT);
      assert.equal(liq.status, "detected", `status ${status}`);
      assert.equal(liq.poolCount, 1);
    } finally { restore(); }
  }
});

test("E1: status >7 alone is unclassifiable -> unknown, never not-detected", async () => {
  const { restore } = stubGpa(() => jsonResponse([pool("PoolA11111111111111111111111111111111111111", 8)]));
  try {
    const liq = await fetchLiquidity(ENDPOINT, MINT);
    assert.equal(liq.status, "unknown");
    assert.equal(liq.poolCount, null);
  } finally { restore(); }
});

test("E1: short data and missing data are unclassifiable -> unknown", async () => {
  const short = { pubkey: "PoolA11111111111111111111111111111111111111", account: { data: ["Bg==", "base64"] } };
  const missing = { pubkey: "PoolB11111111111111111111111111111111111111", account: { data: ["", "base64"] } };
  for (const entry of [short, missing]) {
    const { restore } = stubGpa(() => jsonResponse([entry]));
    try {
      const liq = await fetchLiquidity(ENDPOINT, MINT);
      assert.equal(liq.status, "unknown");
      assert.equal(liq.poolCount, null);
    } finally { restore(); }
  }
});

test("E1/P1: the same pubkey returned twice or by both queries counts once", async () => {
  const p = pool("PoolA11111111111111111111111111111111111111", 6);
  const { restore } = stubGpa(() => jsonResponse([p, p]));
  try {
    const liq = await fetchLiquidity(ENDPOINT, MINT);
    assert.equal(liq.status, "detected");
    assert.equal(liq.poolCount, 1);
  } finally { restore(); }
});

test("E1: a live pool alongside a status-0 entry counts only the live pool", async () => {
  const { restore } = stubGpa((offset) => jsonResponse(offset === 400
    ? [pool("PoolA11111111111111111111111111111111111111", 0), pool("PoolB11111111111111111111111111111111111111", 6)]
    : []));
  try {
    const liq = await fetchLiquidity(ENDPOINT, MINT);
    assert.equal(liq.status, "detected");
    assert.equal(liq.poolCount, 1);
  } finally { restore(); }
});

// --- E3: GPA retry budget (call counts, not wall-clock) -------------------------

test("E3: a single 429 per liquidity query still detects, with exactly 2 attempts per query", async () => {
  const { restore, counts } = stubGpa((offset, n) => (n === 1 ? rateLimited() : jsonResponse([pool("PoolA11111111111111111111111111111111111111", 6)])));
  try {
    const liq = await fetchLiquidity(ENDPOINT, MINT);
    assert.equal(liq.status, "detected");
    assert.deepEqual(counts, { 400: 2, 432: 2 });
  } finally { restore(); }
});

test("E3: 429-forever liquidity degrades to unknown with exactly 2 attempts per query", async () => {
  const { restore, counts } = stubGpa(() => rateLimited());
  try {
    const liq = await fetchLiquidity(ENDPOINT, MINT);
    assert.equal(liq.status, "unknown");
    assert.deepEqual(counts, { 400: 2, 432: 2 });
  } finally { restore(); }
});

// --- E2: calibration V3 ---------------------------------------------------------

const clean = { mintAuthorityActive: false, freezeAuthorityActive: false, topHolderPct: 4, top10HolderPct: 30, holderCount: 5000, supplyUi: 1 };
const extBase = { hasPermanentDelegate: false, hasTransferFee: false, effectiveFeeBasisPoints: null, scheduledFeeBasisPoints: null, scheduledFeeEpoch: null, nonTransferable: false, defaultFrozen: false, hasTransferHook: false, hasConfidentialTransfer: false, hasMintCloseAuthority: false, transferFeeConfigAuthority: null, withdrawWithheldAuthority: null, transferFeeMaximumFee: null, effectiveFeeRateBps: null, transferHookAuthority: null, transferHookProgramId: null, hasPausableConfig: false, pausableAuthorityActive: false, transfersPaused: false, hasScaledUiAmount: false, scaledUiAuthorityActive: false, unknownExtensions: [], unparseableExtensionCount: 0 };

test("E2/V3: D2 shape (whale-50 + concentration-90) scores 60 HIGH with compound-concentration", () => {
  const r = scoreMint({ ...clean, topHolderPct: 60, top10HolderPct: 95 });
  assert.equal(r.score, 60);
  assert.equal(r.band, "HIGH RISK");
  const f = r.flags.find((x) => x.key === "compound-concentration");
  assert.ok(f); assert.equal(f.points, 20); assert.equal(f.severity, "high");
  assert.equal(r.flags.reduce((s, x) => s + x.points, 0), r.score);
});

test("E2/V3: CONC-MAX (92/97) scores 60; SINGLE-100 scores 70", () => {
  assert.equal(scoreMint({ ...clean, topHolderPct: 92, top10HolderPct: 97 }).score, 60);
  const single = scoreMint({ ...clean, topHolderPct: 100, top10HolderPct: 100, holderCount: 1 });
  assert.equal(single.score, 70); // 25 + 15 + 20 compound + 10 few-holders
});

test("E2/V3: delegate+frozen pair floors at 60 HIGH with paired-control-traps carrying the difference", () => {
  const r = scoreMint({ ...clean, programId: TOKEN_2022, extensions: { ...extBase, hasPermanentDelegate: true, defaultFrozen: true } });
  assert.equal(r.score, 60);
  assert.equal(r.band, "HIGH RISK");
  const f = r.flags.find((x) => x.key === "paired-control-traps");
  assert.ok(f); assert.equal(f.points, 5); // 60 - (30 + 25) after the round-3 delta raised delegate/frozen to 30/25 (P-19)
  assert.equal(r.flags.reduce((s, x) => s + x.points, 0), r.score);
});

test("E2/V3: delegate+frozen+fee floors at 60, not 65", () => {
  const r = scoreMint({ ...clean, programId: TOKEN_2022, extensions: { ...extBase, hasPermanentDelegate: true, defaultFrozen: true, hasTransferFee: true, effectiveFeeBasisPoints: 100 } });
  assert.equal(r.score, 60);
  // Round-3 delta (P-19): delegate 30 + frozen 25 + fee tier 5 = 60
  // exactly, so the paired-traps floor has nothing left to carry and no
  // floor flag is emitted; flag points still sum to the score.
  assert.ok(!r.flags.some((x) => x.key === "paired-control-traps"));
  assert.equal(r.flags.find((x) => x.key === "transfer-fee").points, 5);
  assert.equal(r.flags.reduce((sum, x) => sum + x.points, 0), r.score);
});

test("E2/V3: negative pins — no compound at concentration-70, no floor for either extension alone", () => {
  const conc80 = scoreMint({ ...clean, topHolderPct: 55, top10HolderPct: 80 });
  assert.equal(conc80.score, 33);
  assert.ok(!conc80.flags.some((f) => f.key === "compound-concentration"));
  assert.equal(scoreMint({ ...clean, programId: TOKEN_2022, extensions: { ...extBase, hasPermanentDelegate: true } }).score, 30);
  assert.equal(scoreMint({ ...clean, programId: TOKEN_2022, extensions: { ...extBase, defaultFrozen: true } }).score, 25);
});

// --- F1: epoch-fetch failure must not promote a dated newer fee ------------------

test("LG2-F1: extractExtensions with unknown epoch does not promote a dated newer-only fee", () => {
  const info = { extensions: [{ extension: "transferFeeConfig", state: { newerTransferFee: { epoch: "20", transferFeeBasisPoints: 500 } } }] };
  assert.equal(extractExtensions(info, TOKEN_2022, null).effectiveFeeBasisPoints, null);
  assert.equal(extractExtensions(info, TOKEN_2022, 10).effectiveFeeBasisPoints, null);
  assert.equal(extractExtensions(info, TOKEN_2022, 20).effectiveFeeBasisPoints, 500);
  assert.equal(extractExtensions(info, TOKEN_2022).effectiveFeeBasisPoints, null); // legacy no-epoch path
});

function stubScan(overrides = {}) {
  const original = globalThis.fetch;
  globalThis.fetch = async (endpoint, opts) => {
    const { method } = JSON.parse(opts.body);
    if (overrides[method]) return overrides[method]();
    if (method === "getAccountInfo") return jsonResponse({ value: { owner: TOKEN_PROGRAM, lamports: 1, data: { program: "spl-token", parsed: { type: "mint", info: { mintAuthority: null, freezeAuthority: null, decimals: 6, supply: "1000000", isInitialized: true } } } } });
    if (method === "getTokenSupply") return jsonResponse({ value: { amount: "1000000", decimals: 6 } });
    if (method === "getTokenLargestAccounts") return jsonResponse({ value: [{ address: "A111111111111111111111111111111111111111111", amount: "500000", decimals: 6 }] });
    if (method === "getProgramAccounts") return jsonResponse([]);
    if (method === "getEpochInfo") return jsonResponse({ epoch: 700 });
    throw new Error(`unexpected ${method}`);
  };
  return () => { globalThis.fetch = original; };
}

test("LG2-F1: epoch-fetch failure on a newer-only mint leaves the fee unasserted + uncertainty in confidence", async () => {
  const restore = stubScan({
    getAccountInfo: () => jsonResponse({ value: { owner: TOKEN_2022, lamports: 1, data: { program: "spl-token-2022", parsed: { type: "mint", info: { mintAuthority: null, freezeAuthority: null, decimals: 6, supply: "1000000", isInitialized: true, extensions: [{ extension: "transferFeeConfig", state: { newerTransferFee: { epoch: "20", transferFeeBasisPoints: 500 } } }] } } } } }),
    getEpochInfo: () => { throw new Error("epoch boom"); },
  });
  try {
    const facts = await fetchMintFacts(MINT);
    assert.equal(facts.extensions.effectiveFeeBasisPoints, null);
    assert.equal(facts.extensions.feeScheduleUncertain, true);
    const feeFlag = scoreMint(facts).flags.find((f) => f.key === "transfer-fee");
    assert.ok(feeFlag);
    assert.match(feeFlag.detail, /could not be read/);
    assert.ok(!/5\.00%/.test(feeFlag.detail), feeFlag.detail);
    assert.ok(assessConfidence(facts).reasons.some((r) => /fee schedule/i.test(r)));
  } finally { restore(); }
});

// --- F2: supply-source reconciliation ---------------------------------------------

test("LG2-F2: agreeing supply sources produce no issue and confidence can be high", async () => {
  const restore = stubScan({
    getProgramAccounts: () => jsonResponse([pool("PoolA11111111111111111111111111111111111111", 6)]),
  });
  try {
    const facts = await fetchMintFacts(MINT);
    assert.equal(facts.supplySourcesDisagree, undefined);
    const conf = assessConfidence(facts);
    assert.equal(conf.level, "high", conf.reasons.join(" | "));
  } finally { restore(); }
});

test("LG2-F2: raw-amount disagreement is a named confidence issue, never silent HIGH", async () => {
  const restore = stubScan({ getTokenSupply: () => jsonResponse({ value: { amount: "500000000", decimals: 6 } }) });
  try {
    const facts = await fetchMintFacts(MINT);
    assert.equal(facts.supplySourcesDisagree, true);
    assert.equal(facts.supplyUi, 500); // displayed supply still driven by getTokenSupply
    const conf = assessConfidence(facts);
    assert.notEqual(conf.level, "high");
    assert.ok(conf.reasons.some((r) => /supply sources disagree/i.test(r)), conf.reasons.join(" | "));
  } finally { restore(); }
});

test("LG2-F2: decimals disagreement (6 vs 9, a silent 1000x) is a named confidence issue", async () => {
  const restore = stubScan({ getTokenSupply: () => jsonResponse({ value: { amount: "1000000000", decimals: 9 } }) });
  try {
    const facts = await fetchMintFacts(MINT);
    assert.equal(facts.supplySourcesDisagree, true);
    assert.ok(assessConfidence(facts).reasons.some((r) => /supply sources disagree/i.test(r)));
  } finally { restore(); }
});

// --- F3: aggregate holder-set impossibility -----------------------------------------

test("LG2-F3: [60,60] against supply 100 makes both shares unknown, with a confidence issue and no share-based flags", async () => {
  const restore = stubScan({
    getTokenSupply: () => jsonResponse({ value: { amount: "100", decimals: 0 } }),
    getAccountInfo: () => jsonResponse({ value: { owner: TOKEN_PROGRAM, lamports: 1, data: { program: "spl-token", parsed: { type: "mint", info: { mintAuthority: null, freezeAuthority: null, decimals: 0, supply: "100", isInitialized: true } } } } }),
    getTokenLargestAccounts: () => jsonResponse({ value: [
      { address: "A111111111111111111111111111111111111111111", amount: "60", decimals: 0 },
      { address: "B111111111111111111111111111111111111111111", amount: "60", decimals: 0 },
    ] }),
  });
  try {
    const facts = await fetchMintFacts(MINT);
    assert.equal(facts.topHolderPct, null);
    assert.equal(facts.top10HolderPct, null);
    assert.equal(facts.holderSetExceedsSupply, true);
    assert.ok(assessConfidence(facts).reasons.some((r) => /sum to more than the total supply/i.test(r)));
    const r = scoreMint(facts);
    assert.ok(!r.flags.some((f) => f.key.startsWith("whale") || f.key.startsWith("concentration")), r.flags.map((f) => f.key).join(","));
  } finally { restore(); }
});

test("LG2-F3: 20 accounts of 9 against supply 100 cannot earn concentration-90", async () => {
  const many = Array.from({ length: 20 }, () => ({ address: "A111111111111111111111111111111111111111111", amount: "9", decimals: 0 }));
  const restore = stubScan({
    getTokenSupply: () => jsonResponse({ value: { amount: "100", decimals: 0 } }),
    getAccountInfo: () => jsonResponse({ value: { owner: TOKEN_PROGRAM, lamports: 1, data: { program: "spl-token", parsed: { type: "mint", info: { mintAuthority: null, freezeAuthority: null, decimals: 0, supply: "100", isInitialized: true } } } } }),
    getTokenLargestAccounts: () => jsonResponse({ value: many }),
  });
  try {
    const facts = await fetchMintFacts(MINT);
    assert.equal(facts.topHolderPct, null);
    assert.equal(facts.top10HolderPct, null);
    assert.ok(!scoreMint(facts).flags.some((f) => f.key.startsWith("concentration")));
  } finally { restore(); }
});

test("LG2-F3: a legitimate holder set (sum <= supply) is untouched", async () => {
  const restore = stubScan({
    getTokenSupply: () => jsonResponse({ value: { amount: "100", decimals: 0 } }),
    getAccountInfo: () => jsonResponse({ value: { owner: TOKEN_PROGRAM, lamports: 1, data: { program: "spl-token", parsed: { type: "mint", info: { mintAuthority: null, freezeAuthority: null, decimals: 0, supply: "100", isInitialized: true } } } } }),
    getTokenLargestAccounts: () => jsonResponse({ value: [
      { address: "A111111111111111111111111111111111111111111", amount: "60", decimals: 0 },
      { address: "B111111111111111111111111111111111111111111", amount: "30", decimals: 0 },
    ] }),
  });
  try {
    const facts = await fetchMintFacts(MINT);
    assert.equal(facts.topHolderPct, 60);
    assert.equal(facts.top10HolderPct, 90);
    assert.equal(facts.holderSetExceedsSupply, undefined);
  } finally { restore(); }
});

// --- F4: unsafe number amounts --------------------------------------------------------

test("LG2-F4: a number-typed amount at 2^53+1 throws a typed RpcError, never a rounded share", async () => {
  const restore = stubScan({
    getTokenLargestAccounts: () => jsonResponse({ value: [{ address: "A111111111111111111111111111111111111111111", amount: 9007199254740993, decimals: 6 }] }),
  });
  try {
    await assert.rejects(() => fetchMintFacts(MINT), (e) => e instanceof RpcError);
  } finally { restore(); }
});

test("LG2-F4: safe-integer number amounts still work", async () => {
  const restore = stubScan({
    getTokenSupply: () => jsonResponse({ value: { amount: 1000000, decimals: 6 } }),
    getTokenLargestAccounts: () => jsonResponse({ value: [{ address: "A111111111111111111111111111111111111111111", amount: 500000, decimals: 6 }] }),
  });
  try {
    const facts = await fetchMintFacts(MINT);
    assert.equal(facts.topHolderPct, 50);
  } finally { restore(); }
});

// --- P2: non-integer holderCount -------------------------------------------------------

test("LG2-P2: holderCount 24.5 is unknown at the scorer boundary — no count rules, no rendered count", () => {
  const r = scoreMint({ ...clean, holderCount: 24.5 });
  assert.ok(!r.flags.some((f) => f.key === "few-holders" || f.key === "few-holders-100"));
  assert.ok(!r.flags.some((f) => /24\.5/.test(f.detail)));
  assert.equal(scoreMint({ ...clean, holderCount: 24 }).flags.find((f) => f.key === "few-holders")?.points, 10);
});

// --- CSP static pin (browser proof is separate evidence) --------------------------------

test("CSP: index.html carries a meta CSP locking down scripts, objects and base-uri", () => {
  const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
  const m = html.match(/http-equiv="Content-Security-Policy" content="([^"]+)"/);
  assert.ok(m, "CSP meta present");
  const csp = m[1];
  assert.match(csp, /script-src[^;]*'self'/);
  assert.match(csp, /script-src[^;]*https:\/\/unpkg\.com/);
  assert.match(csp, /object-src 'none'/);
  assert.match(csp, /base-uri 'none'/);
  assert.match(csp, /connect-src[^;]*https:/);
  assert.ok(!/script-src[^;]*'unsafe-inline'/.test(csp), "no unsafe-inline for scripts");
});
