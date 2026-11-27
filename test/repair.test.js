// LaunchGuard Phase-2 repair regression tests (studio-repair pass).
// Every test here pins a merged-QA finding (LG-*) so the fix cannot
// silently regress. All offline: fetch is stubbed throughout.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  fetchMintFacts,
  fetchLiquidity,
  extractExtensions,
  RpcError,
  MintNotFoundError,
  RPC_TIMEOUT_MS,
} from "../src/lib/solana.js";
import { scoreMint } from "../src/lib/risk.js";
import {
  buildReportMemo,
  buildMemoTransaction,
  buildMemoTransactionObject,
  submitMemoWithWallet,
  explorerUrlForSignature,
  sanitizeMemoField,
  WEB3_JS_CDN_URL,
} from "../src/lib/memo.js";
import { buildReport, canonicalReportJson, assessConfidence } from "../src/lib/report.js";
import { parseMemoFields, parseMemoDigest } from "../src/lib/report.js";

const MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const TOKEN_2022 = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
const ENDPOINT = "https://api.mainnet-beta.solana.com";
const BLOCKHASH = "11111111111111111111111111111111";

function jsonResponse(result, status = 200) {
  return { status, ok: status >= 200 && status < 300, async json() { return { jsonrpc: "2.0", id: 1, result }; } };
}
function stubFetch(handler) {
  const original = globalThis.fetch;
  const counts = {};
  globalThis.fetch = async (endpoint, opts) => {
    const { method } = JSON.parse(opts.body);
    counts[method] = (counts[method] ?? 0) + 1;
    return handler(method, counts[method]);
  };
  return { restore: () => { globalThis.fetch = original; }, counts };
}
const supplyResult = { value: { amount: "1000000", decimals: 6, uiAmount: 1 } };
const largestResult = {
  value: [
    { address: "A111111111111111111111111111111111111111111", amount: "500000", decimals: 6 },
    { address: "B111111111111111111111111111111111111111111", amount: "100000", decimals: 6 },
  ],
};
function mintAccount({ owner = TOKEN_PROGRAM, info = {} } = {}) {
  return {
    value: {
      owner, lamports: 1461600,
      data: { program: "spl-token", parsed: { type: "mint", info: {
        mintAuthority: null, freezeAuthority: null, decimals: 6, supply: "1000000", isInitialized: true, ...info,
      } } },
    },
  };
}
function baseHandler(overrides = {}) {
  return (method) => {
    if (overrides[method]) return overrides[method]();
    if (method === "getAccountInfo") return jsonResponse(mintAccount());
    if (method === "getTokenSupply") return jsonResponse(supplyResult);
    if (method === "getTokenLargestAccounts") return jsonResponse(largestResult);
    if (method === "getProgramAccounts") return jsonResponse([]);
    if (method === "getEpochInfo") return jsonResponse({ epoch: 700 });
    throw new Error(`unexpected method ${method}`);
  };
}

// --- LG-B1/B2/F8/F9: data-layer input hardening -------------------------------

test("LG-B1: float supply amount throws a typed RpcError, not a RangeError", async () => {
  const { restore } = stubFetch(baseHandler({
    getTokenSupply: () => jsonResponse({ value: { amount: 1000000.5, decimals: 6 } }),
  }));
  try {
    await assert.rejects(() => fetchMintFacts(MINT), (e) => e instanceof RpcError && e.kind === "rpc");
  } finally { restore(); }
});

test("LG-B1: non-numeric supply amount and null supply value throw typed RpcErrors", async () => {
  for (const bad of [{ value: { amount: "abc", decimals: 6 } }, { value: null }]) {
    const { restore } = stubFetch(baseHandler({ getTokenSupply: () => jsonResponse(bad) }));
    try {
      await assert.rejects(() => fetchMintFacts(MINT), (e) => e instanceof RpcError);
    } finally { restore(); }
  }
});

test("LG-B1: largest-account entry with a missing amount throws a typed RpcError", async () => {
  const { restore } = stubFetch(baseHandler({
    getTokenLargestAccounts: () => jsonResponse({ value: [{ address: "A111111111111111111111111111111111111111111" }] }),
  }));
  try {
    await assert.rejects(() => fetchMintFacts(MINT), (e) => e instanceof RpcError);
  } finally { restore(); }
});

test("LG-B2: non-JSON RPC body throws a typed RpcError", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => ({ status: 200, ok: true, async json() { throw new SyntaxError("not json"); } });
  try {
    await assert.rejects(() => fetchMintFacts(MINT), (e) => e instanceof RpcError && /not valid JSON/.test(e.message));
  } finally { globalThis.fetch = original; }
});

test("LG-B2: JSON-null RPC body throws a typed RpcError", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => ({ status: 200, ok: true, async json() { return null; } });
  try {
    await assert.rejects(() => fetchMintFacts(MINT), (e) => e instanceof RpcError && /malformed/.test(e.message));
  } finally { globalThis.fetch = original; }
});

test("LG-F8: missing result envelope is a typed rpc error, NOT mint-not-found", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => ({ status: 200, ok: true, async json() { return { jsonrpc: "2.0", id: 1 }; } });
  try {
    await assert.rejects(
      () => fetchMintFacts(MINT),
      (e) => e instanceof RpcError && !(e instanceof MintNotFoundError) && /missing its result/.test(e.message),
    );
  } finally { globalThis.fetch = original; }
});

test("LG-F8: RPC error without a message falls back to its code, never 'undefined'", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => ({ status: 200, ok: true, async json() { return { jsonrpc: "2.0", id: 1, error: { code: -32602 } }; } });
  try {
    await assert.rejects(
      () => fetchMintFacts(MINT),
      (e) => e instanceof RpcError && /error code -32602/.test(e.message) && !/undefined/.test(e.message),
    );
  } finally { globalThis.fetch = original; }
});

test("LG-F9: missing decimals and decimals 400 throw typed errors, never fabricated supply", async () => {
  for (const bad of [{ amount: "1000000" }, { amount: "1000000", decimals: 400 }, { amount: "-5", decimals: 6 }]) {
    const { restore } = stubFetch(baseHandler({ getTokenSupply: () => jsonResponse({ value: bad }) }));
    try {
      await assert.rejects(() => fetchMintFacts(MINT), (e) => e instanceof RpcError);
    } finally { restore(); }
  }
});

// --- LG-B3: timeouts -----------------------------------------------------------

test("LG-B3: RPC_TIMEOUT_MS is the documented 10s constant", () => {
  assert.equal(RPC_TIMEOUT_MS, 10_000);
});

test("LG-B3: a never-resolving RPC produces a typed timeout error on the main path", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = () => new Promise(() => {});
  try {
    await assert.rejects(
      () => fetchMintFacts(MINT, "mainnet-beta", { timeoutMs: 50 }),
      (e) => e instanceof RpcError && e.kind === "timeout",
    );
  } finally { globalThis.fetch = original; }
});

test("LG-B3: a never-resolving liquidity query degrades to status unknown", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = () => new Promise(() => {});
  try {
    const liq = await fetchLiquidity(ENDPOINT, MINT, { timeoutMs: 50 });
    assert.deepEqual(liq, { status: "unknown", poolCount: null, lpStatus: "not-checked", venues: { raydiumAmmV4: null, meteoraDlmm: null, meteoraDammV2: null, meteoraDammV1: null, orcaWhirlpool: null } });
  } finally { globalThis.fetch = original; }
});

// --- LG-B4/P4: classification hardening ----------------------------------------

test("LG-B4: parsed mint payload from a non-token owner throws MintNotFoundError", async () => {
  const { restore } = stubFetch(baseHandler({
    getAccountInfo: () => jsonResponse(mintAccount({ owner: "11111111111111111111111111111111" })),
  }));
  try {
    await assert.rejects(() => fetchMintFacts(MINT), (e) => e instanceof MintNotFoundError);
  } finally { restore(); }
});

test("LG-P4: an uninitialized parsed mint throws MintNotFoundError", async () => {
  const { restore } = stubFetch(baseHandler({
    getAccountInfo: () => jsonResponse(mintAccount({ info: { isInitialized: false } })),
  }));
  try {
    await assert.rejects(() => fetchMintFacts(MINT), (e) => e instanceof MintNotFoundError);
  } finally { restore(); }
});

// --- LG-B5: liquidity entry validation ------------------------------------------

test("LG-B5: garbage getProgramAccounts entries are ignored, never counted as pools", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => jsonResponse([null, "garbage", {}, 42]);
  try {
    const liq = await fetchLiquidity(ENDPOINT, MINT);
    assert.deepEqual(liq, { status: "not-detected", poolCount: 0, lpStatus: "not-checked", venues: { raydiumAmmV4: 0, meteoraDlmm: 0, meteoraDammV2: 0, meteoraDammV1: 0, orcaWhirlpool: 0 } });
  } finally { globalThis.fetch = original; }
});

test("LG-B5: well-formed entries still count alongside garbage", async () => {
  const original = globalThis.fetch;
  // E1 re-baseline: the entry carries status 6 bytes ("BgAAAAAAAAA=");
  // the same distinct pubkey returned by both queries counts once (LG2-P1).
  const pool = { pubkey: "Pool1111111111111111111111111111111111111111", account: { data: ["BgAAAAAAAAA=", "base64"] } };
  globalThis.fetch = async () => jsonResponse([null, pool, {}]);
  try {
    const liq = await fetchLiquidity(ENDPOINT, MINT);
    assert.equal(liq.status, "detected");
    assert.equal(liq.poolCount, 1); // one distinct well-formed live pool, returned by both queries
  } finally { globalThis.fetch = original; }
});

// --- LG-F4/F5: impossible values, null largest, local sort ----------------------

test("LG-F5: unsorted largest accounts are sorted locally before shares are computed", async () => {
  const { restore } = stubFetch(baseHandler({
    getTokenLargestAccounts: () => jsonResponse({ value: [
      { address: "A111111111111111111111111111111111111111111", amount: "1000", decimals: 6 },
      { address: "B111111111111111111111111111111111111111111", amount: "900000", decimals: 6 },
    ] }),
  }));
  try {
    const facts = await fetchMintFacts(MINT);
    assert.equal(facts.topHolderPct, 90);
    assert.equal(facts.top10HolderPct, 90.1);
  } finally { restore(); }
});

test("LG-F4: a holder larger than the supply makes the share unknown, never a >100% fact", async () => {
  const { restore } = stubFetch(baseHandler({
    getTokenLargestAccounts: () => jsonResponse({ value: [
      { address: "A111111111111111111111111111111111111111111", amount: "1500000", decimals: 6 },
    ] }),
  }));
  try {
    const facts = await fetchMintFacts(MINT);
    assert.equal(facts.topHolderPct, null);
    assert.equal(facts.top10HolderPct, null);
  } finally { restore(); }
});

test("LG-F4: zero supply with a non-zero holder makes shares unknown, never 0%", async () => {
  const { restore } = stubFetch(baseHandler({
    getTokenSupply: () => jsonResponse({ value: { amount: "0", decimals: 6 } }),
    getTokenLargestAccounts: () => jsonResponse({ value: [
      { address: "A111111111111111111111111111111111111111111", amount: "500", decimals: 6 },
    ] }),
  }));
  try {
    const facts = await fetchMintFacts(MINT);
    assert.equal(facts.topHolderPct, null);
    assert.equal(facts.supplyUi, 0);
  } finally { restore(); }
});

test("LG-F5: null largest-accounts value leaves holder facts unknown and fires no holder rules", async () => {
  const { restore } = stubFetch(baseHandler({
    getTokenLargestAccounts: () => jsonResponse({ value: null }),
  }));
  try {
    const facts = await fetchMintFacts(MINT);
    assert.equal(facts.holderCount, null);
    assert.equal(facts.topHolderPct, null);
    const r = scoreMint(facts);
    assert.ok(!r.flags.some((f) => f.key === "few-holders" || f.key === "few-holders-100"));
  } finally { restore(); }
});

test("LG-P7: more than 20 returned accounts keeps the returned count with floor semantics", async () => {
  const many = Array.from({ length: 25 }, (_, i) => ({ address: "A111111111111111111111111111111111111111111", amount: String(1000 - i), decimals: 6 }));
  const { restore } = stubFetch(baseHandler({
    getTokenLargestAccounts: () => jsonResponse({ value: many }),
  }));
  try {
    const facts = await fetchMintFacts(MINT);
    assert.equal(facts.holderCount, 25);
    assert.equal(facts.holderCountIsFloor, true);
  } finally { restore(); }
});

test("LG-P1: supplyUi is exact above 2^53 base units", async () => {
  const { restore } = stubFetch(baseHandler({
    getTokenSupply: () => jsonResponse({ value: { amount: "18446744073709551615", decimals: 0 } }),
    getTokenLargestAccounts: () => jsonResponse({ value: [] }),
  }));
  try {
    const facts = await fetchMintFacts(MINT);
    assert.equal(String(facts.supplyUi), "18446744073709551615");
  } finally { restore(); }
});

// --- LG-F6/F7: extension validation ----------------------------------------------

test("LG-F6: out-of-range transfer-fee bps becomes fee-unknown at extraction and at scoring", () => {
  for (const bad of [20000, -500, NaN]) {
    const info = { extensions: [{ extension: "transferFeeConfig", state: { olderTransferFee: { epoch: "1", transferFeeBasisPoints: bad } } }] };
    const ext = extractExtensions(info, TOKEN_2022);
    assert.equal(ext.hasTransferFee, true);
    assert.equal(ext.effectiveFeeBasisPoints, null, `bps ${bad} must be unknown`);
    const r = scoreMint({
      mintAuthorityActive: false, freezeAuthorityActive: false, topHolderPct: 4, top10HolderPct: 30,
      holderCount: 5000, supplyUi: 1, programId: TOKEN_2022,
      extensions: { hasPermanentDelegate: false, hasTransferFee: true, effectiveFeeBasisPoints: bad, scheduledFeeBasisPoints: null, scheduledFeeEpoch: null, nonTransferable: false, defaultFrozen: false, hasTransferHook: false, hasConfidentialTransfer: false, hasMintCloseAuthority: false },
    });
    const f = r.flags.find((x) => x.key === "transfer-fee");
    assert.ok(f, "unknown fee still flags");
    assert.match(f.detail, /could not be read/);
    assert.ok(!/NaN|20000|-500/.test(f.detail), f.detail);
  }
});

test("LG-F7: permanentDelegate entry without a delegate state does not flag", () => {
  const noState = extractExtensions({ extensions: [{ extension: "permanentDelegate" }] }, TOKEN_2022);
  assert.equal(noState.hasPermanentDelegate, false);
  const emptyState = extractExtensions({ extensions: [{ extension: "permanentDelegate", state: {} }] }, TOKEN_2022);
  assert.equal(emptyState.hasPermanentDelegate, false);
  const withDelegate = extractExtensions({ extensions: [{ extension: "permanentDelegate", state: { delegate: "Del1111111111111111111111111111111111111111" } }] }, TOKEN_2022);
  assert.equal(withDelegate.hasPermanentDelegate, true);
});

// --- LG-F11: epoch-relative transfer fee ------------------------------------------

function feeMintAccount() {
  return {
    value: {
      owner: TOKEN_2022, lamports: 1,
      data: { program: "spl-token-2022", parsed: { type: "mint", info: {
        mintAuthority: null, freezeAuthority: null, decimals: 6, supply: "1000000", isInitialized: true,
        extensions: [{ extension: "transferFeeConfig", state: {
          olderTransferFee: { epoch: "600", transferFeeBasisPoints: 0 },
          newerTransferFee: { epoch: "601", transferFeeBasisPoints: 500 },
        } }],
      } } },
    },
  };
}

test("LG-F11: after the newer fee's epoch passes, the newer fee is the effective one", async () => {
  const { restore, counts } = stubFetch(baseHandler({
    getAccountInfo: () => jsonResponse(feeMintAccount()),
    getEpochInfo: () => jsonResponse({ epoch: 700 }),
  }));
  try {
    const facts = await fetchMintFacts(MINT);
    assert.equal(counts.getEpochInfo, 1);
    assert.equal(facts.extensions.effectiveFeeBasisPoints, 500);
    assert.equal(facts.extensions.scheduledFeeBasisPoints, null);
    assert.ok(scoreMint(facts).flags.some((f) => f.key === "transfer-fee"));
  } finally { restore(); }
});

test("LG-F11: before the newer fee's epoch, the older fee is effective and the newer is scheduled", async () => {
  const { restore } = stubFetch(baseHandler({
    getAccountInfo: () => jsonResponse(feeMintAccount()),
    getEpochInfo: () => jsonResponse({ epoch: 500 }),
  }));
  try {
    const facts = await fetchMintFacts(MINT);
    assert.equal(facts.extensions.effectiveFeeBasisPoints, 0);
    assert.equal(facts.extensions.scheduledFeeBasisPoints, 500);
    assert.equal(String(facts.extensions.scheduledFeeEpoch), "601");
    assert.ok(!scoreMint(facts).flags.some((f) => f.key === "transfer-fee"));
  } finally { restore(); }
});

test("LG-F11: epoch-fetch failure falls back to the older fee and records uncertainty in confidence", async () => {
  const { restore } = stubFetch(baseHandler({
    getAccountInfo: () => jsonResponse(feeMintAccount()),
    getEpochInfo: () => { throw new Error("epoch boom"); },
  }));
  try {
    const facts = await fetchMintFacts(MINT);
    assert.equal(facts.extensions.effectiveFeeBasisPoints, 0);
    assert.equal(facts.extensions.feeScheduleUncertain, true);
    const conf = assessConfidence(facts);
    assert.ok(conf.reasons.some((r) => /fee schedule/i.test(r)), conf.reasons.join(" | "));
  } finally { restore(); }
});

test("LG-F11: extractExtensions selects by epoch when given one, keeps legacy behaviour without", () => {
  const info = { extensions: [{ extension: "transferFeeConfig", state: {
    olderTransferFee: { epoch: "600", transferFeeBasisPoints: 100 },
    newerTransferFee: { epoch: "601", transferFeeBasisPoints: 250 },
  } }] };
  assert.equal(extractExtensions(info, TOKEN_2022, 700).effectiveFeeBasisPoints, 250);
  assert.equal(extractExtensions(info, TOKEN_2022, 700).scheduledFeeBasisPoints, null);
  assert.equal(extractExtensions(info, TOKEN_2022, 500).effectiveFeeBasisPoints, 100);
  assert.equal(extractExtensions(info, TOKEN_2022).effectiveFeeBasisPoints, 100);
});

// --- LG-F10: liquidity work settles when the main flow throws ----------------------

test("LG-F10: on MintNotFound the liquidity retries stop instead of orphaning", async () => {
  let gpaCalls = 0;
  const original = globalThis.fetch;
  globalThis.fetch = async (endpoint, opts) => {
    const { method } = JSON.parse(opts.body);
    if (method === "getProgramAccounts") {
      gpaCalls += 1;
      return { status: 429, ok: false, async json() { return {}; } };
    }
    return jsonResponse({ value: null });
  };
  try {
    await assert.rejects(
      () => fetchMintFacts(MINT, "mainnet-beta", { timeoutMs: 1000 }),
      (e) => e instanceof MintNotFoundError,
    );
    const atThrow = gpaCalls;
    await new Promise((r) => setTimeout(r, 2600)); // past the first 2s backoff point
    assert.equal(gpaCalls, atThrow, "no orphaned liquidity retries after the scan failed");
  } finally { globalThis.fetch = original; }
});

// --- LG-F3: scorer boundary normalisation -------------------------------------------

test("LG-F3: undefined authorities score as unknown (0 pts each since the round-3 delta, P-18), matching assessConfidence", () => {
  const r = scoreMint({ topHolderPct: 4, top10HolderPct: 30, holderCount: 500, supplyUi: 1 });
  assert.equal(r.score, 0);
  assert.ok(r.flags.some((f) => f.key === "mint-authority-unknown"));
  assert.ok(r.flags.some((f) => f.key === "freeze-authority-unknown"));
});

test("LG-F3: NaN / negative / over-100 facts fire no rules and render no facts", () => {
  const r = scoreMint({
    mintAuthorityActive: false, freezeAuthorityActive: false,
    topHolderPct: NaN, top10HolderPct: 150, holderCount: -5, supplyUi: 1,
  });
  assert.equal(r.score, 0);
  assert.equal(r.flags.length, 0);
});

// --- LG-F14 pinning: previously unpinned correct behaviour ---------------------------

test("LG-F14: whale-10 rule pins at the 10% boundary (+6 low)", () => {
  const base = { mintAuthorityActive: false, freezeAuthorityActive: false, top10HolderPct: 30, holderCount: 5000, supplyUi: 1 };
  const at = scoreMint({ ...base, topHolderPct: 10 });
  const f = at.flags.find((x) => x.key === "whale-10");
  assert.ok(f); assert.equal(f.points, 6); assert.equal(f.severity, "low");
  assert.ok(!scoreMint({ ...base, topHolderPct: 9.9 }).flags.some((x) => x.key.startsWith("whale")));
});

test("LG-F14: concentration-70 (+8) and concentration-90 (+15) pin in isolation", () => {
  const base = { mintAuthorityActive: false, freezeAuthorityActive: false, topHolderPct: 4, holderCount: 5000, supplyUi: 1 };
  const r70 = scoreMint({ ...base, top10HolderPct: 70 });
  assert.equal(r70.flags.find((x) => x.key === "concentration-70")?.points, 8);
  // Round-3 V4 edit: 89.9% now lands in the deliberate concentration-85
  // tier (see test/round3.test.js for the full boundary pins); this line
  // previously pinned it to concentration-70.
  assert.equal(scoreMint({ ...base, top10HolderPct: 89.9 }).flags[0]?.key, "concentration-85");
  const r90 = scoreMint({ ...base, top10HolderPct: 90 });
  assert.equal(r90.flags.find((x) => x.key === "concentration-90")?.points, 15);
  assert.ok(!scoreMint({ ...base, top10HolderPct: 69.9 }).flags.some((x) => x.key.startsWith("concentration")));
});

test("LG-F14: transfer-fee null-bps branch fires with the could-not-be-read detail", () => {
  const r = scoreMint({
    mintAuthorityActive: false, freezeAuthorityActive: false, topHolderPct: 4, top10HolderPct: 30,
    holderCount: 5000, supplyUi: 1, programId: TOKEN_2022,
    extensions: { hasPermanentDelegate: false, hasTransferFee: true, effectiveFeeBasisPoints: null, scheduledFeeBasisPoints: null, scheduledFeeEpoch: null, nonTransferable: false, defaultFrozen: false, hasTransferHook: false, hasConfidentialTransfer: false, hasMintCloseAuthority: false },
  });
  const f = r.flags.find((x) => x.key === "transfer-fee");
  assert.ok(f); assert.equal(f.points, 5); assert.match(f.detail, /could not be read/);
});

test("LG-F14: exhausted 429 yields kind rate-limited; network failure yields unreachable; HTTP 500 yields rpc", async () => {
  const original = globalThis.fetch;
  try {
    globalThis.fetch = async () => ({ status: 429, ok: false, async json() { return {}; } });
    await assert.rejects(
      () => fetchMintFacts(MINT, "mainnet-beta", { timeoutMs: 1000 }),
      (e) => e instanceof RpcError && e.kind === "rate-limited" && e.status === 429,
    );
    globalThis.fetch = async () => { throw new Error("socket hang up"); };
    await assert.rejects(
      () => fetchMintFacts(MINT, "mainnet-beta", { timeoutMs: 1000 }),
      (e) => e instanceof RpcError && e.kind === "unreachable",
    );
    globalThis.fetch = async () => ({ status: 500, ok: false, async json() { return {}; } });
    await assert.rejects(
      () => fetchMintFacts(MINT, "mainnet-beta", { timeoutMs: 1000 }),
      (e) => e instanceof RpcError && e.kind === "rpc" && e.status === 500,
    );
  } finally { globalThis.fetch = original; }
});

// --- LG-F1/F2: memo sanitisation + explorer allowlist ----------------------------------

test("LG-F1: crafted memo field values cannot inject a fake h= digest or extra fields", () => {
  const evilConf = `low|h=${"a".repeat(64)}`;
  const memo = buildReportMemo(MINT, { score: 10, band: "CAUTION|X", flags: [] }, {
    timestamp: "2026-01-01T00:00:00.000Z", confidence: evilConf,
  });
  assert.equal(parseMemoDigest(memo), null, memo);
  const fields = parseMemoFields(memo);
  assert.equal(fields.band, "CAUTION X");
  const memo2 = buildReportMemo(MINT, `score=1/100 band=LOWER RISK flags=x|h=${"b".repeat(64)}`, { timestamp: "2026-01-01T00:00:00.000Z" });
  assert.equal(parseMemoDigest(memo2), null, memo2);
  assert.equal(sanitizeMemoField("a|b=c\nd"), "a b c d");
});

test("LG-F1: buildReportMemo rejects a mint carrying delimiters or non-base58 characters", () => {
  assert.throws(() => buildReportMemo("AAAAAAAAAAAAAAAAAAAA|score=0/100", "score=1/100"), /valid base58/);
  assert.throws(() => buildReportMemo("0".repeat(32), "score=1/100"), /valid base58/);
});

test("LG-F2: explorerUrlForSignature allowlists the cluster", () => {
  const SIG = "5abcSignature5abcSignature5abcSignature";
  assert.equal(explorerUrlForSignature(SIG, "devnet&customUrl=https://evil.com"), `https://explorer.solana.com/tx/${SIG}?cluster=devnet`);
  assert.equal(explorerUrlForSignature(SIG, "devnet#@evil.com"), `https://explorer.solana.com/tx/${SIG}?cluster=devnet`);
  assert.equal(explorerUrlForSignature(SIG, "testnet"), `https://explorer.solana.com/tx/${SIG}?cluster=testnet`);
  assert.equal(explorerUrlForSignature(SIG, "mainnet-beta"), `https://explorer.solana.com/tx/${SIG}`);
});

// --- LG-P2/P3: canonicaliser guards ------------------------------------------------------

test("LG-P2: BigInt facts canonicalize to decimal strings and do not collide with null", () => {
  const base = { version: 1, mint: MINT, facts: { rawSupply: 100n } };
  const withNull = { version: 1, mint: MINT, facts: { rawSupply: null } };
  assert.notEqual(canonicalReportJson(base), canonicalReportJson(withNull));
  assert.ok(canonicalReportJson(base).includes('"100"'));
});

test("LG-P2/P3: circular facts and deeply nested reports get clean typed errors, not stack overflows", () => {
  const circular = { version: 1 };
  circular.self = circular;
  assert.throws(() => canonicalReportJson(circular), /circular/);
  let deep = {};
  let cursor = deep;
  for (let i = 0; i < 5000; i++) { cursor.next = {}; cursor = cursor.next; }
  assert.throws(() => canonicalReportJson(deep), /too deeply nested/);
});

// --- LG-B7/F12/F14: wallet path ------------------------------------------------------------

class FakePublicKey { constructor(v) { this.v = String(v); } toBase58() { return this.v; } }
class FakeInstruction { constructor(o) { Object.assign(this, o); } }
class FakeTransaction {
  constructor(o) { Object.assign(this, o); this.instructions = []; }
  add(ix) { this.instructions.push(ix); return this; }
}
const fakeWeb3 = { Transaction: FakeTransaction, PublicKey: FakePublicKey, TransactionInstruction: FakeInstruction };
const SIG = "5abcSignature5abcSignature5abcSignature";

function blockhashFetch() {
  return stubFetch((method) => {
    if (method === "getLatestBlockhash") return jsonResponse({ value: { blockhash: BLOCKHASH } });
    throw new Error(`unexpected method ${method}`);
  });
}

test("LG-B7: buildMemoTransactionObject constructs a real Transaction from the same instruction bytes", () => {
  const memoText = "LG1|mint=test";
  const tx = buildMemoTransactionObject({ feePayer: MINT, recentBlockhash: BLOCKHASH, memoText, web3: fakeWeb3 });
  assert.ok(tx instanceof FakeTransaction);
  assert.equal(tx.feePayer.v, MINT);
  assert.equal(tx.recentBlockhash, BLOCKHASH);
  assert.equal(tx.instructions.length, 1);
  assert.equal(tx.instructions[0].programId.v, "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");
  assert.deepEqual(tx.instructions[0].keys, []);
  assert.equal(new TextDecoder().decode(tx.instructions[0].data), memoText);
});

test("LG-B7: submitMemoWithWallet passes a Transaction object (not bytes) when web3 is available", async () => {
  const { restore } = blockhashFetch();
  let received = null;
  const wallet = { publicKey: MINT, signAndSendTransaction: async (arg) => { received = arg; return SIG; } };
  try {
    const sig = await submitMemoWithWallet({ wallet, memoText: "LG1|mint=x", cluster: "devnet", web3: fakeWeb3 });
    assert.equal(sig, SIG);
    assert.ok(received instanceof FakeTransaction);
    assert.equal(received.feePayer.v, MINT);
    assert.equal(received.recentBlockhash, BLOCKHASH);
  } finally { restore(); }
});

test("LG-B7: raw-bytes fallback is used when web3 cannot load, byte-identical to the hand-rolled builder", async () => {
  const { restore } = blockhashFetch();
  let received = null;
  const wallet = { publicKey: MINT, signAndSendTransaction: async (arg) => { received = arg; return { signature: SIG }; } };
  try {
    const sig = await submitMemoWithWallet({ wallet, memoText: "LG1|mint=x", cluster: "devnet", loadWeb3: async () => null });
    assert.equal(sig, SIG);
    assert.ok(received instanceof Uint8Array);
    const expected = buildMemoTransaction({ feePayer: MINT, recentBlockhash: BLOCKHASH, memoText: "LG1|mint=x" });
    assert.deepEqual([...received], [...expected]);
  } finally { restore(); }
});

test("LG-B7: the pinned CDN URL names an exact web3.js version", () => {
  assert.match(WEB3_JS_CDN_URL, /@solana\/web3\.js@1\.98\.4\//);
});

test("LG-F12: user rejection is never retried (one prompt per click)", async () => {
  const { restore, counts } = blockhashFetch();
  let calls = 0;
  const wallet = { publicKey: MINT, signAndSendTransaction: async () => { calls += 1; const e = new Error("User rejected the request"); e.code = 4001; throw e; } };
  try {
    await assert.rejects(() => submitMemoWithWallet({ wallet, memoText: "LG1|mint=x", cluster: "devnet", web3: fakeWeb3 }), /rejected/i);
    assert.equal(calls, 1);
    assert.equal(counts.getLatestBlockhash, 1);
  } finally { restore(); }
});

test("LG-F12: a blockhash-expiry error is retried once with a fresh blockhash", async () => {
  const { restore, counts } = blockhashFetch();
  let calls = 0;
  const wallet = { publicKey: MINT, signAndSendTransaction: async () => { calls += 1; if (calls === 1) throw new Error("Blockhash not found"); return SIG; } };
  try {
    const sig = await submitMemoWithWallet({ wallet, memoText: "LG1|mint=x", cluster: "devnet", web3: fakeWeb3 });
    assert.equal(sig, SIG);
    assert.equal(calls, 2);
    assert.equal(counts.getLatestBlockhash, 2);
  } finally { restore(); }
});

test("LG-F12: a non-retryable error is not retried, and byte signatures are accepted", async () => {
  const { restore } = blockhashFetch();
  let calls = 0;
  const failing = { publicKey: MINT, signAndSendTransaction: async () => { calls += 1; throw new Error("wallet exploded"); } };
  try {
    await assert.rejects(() => submitMemoWithWallet({ wallet: failing, memoText: "LG1|mint=x", cluster: "devnet", web3: fakeWeb3 }), /exploded/);
    assert.equal(calls, 1);
    const bytesWallet = { publicKey: MINT, signAndSendTransaction: async () => new Uint8Array(64).fill(1) };
    const sig = await submitMemoWithWallet({ wallet: bytesWallet, memoText: "LG1|mint=x", cluster: "devnet", web3: fakeWeb3 });
    assert.equal(typeof sig, "string");
    assert.ok(sig.length >= 32);
  } finally { restore(); }
});

test("LG-F14: submitMemoWithWallet throws clearly when no wallet is available", async () => {
  await assert.rejects(() => submitMemoWithWallet({ wallet: null, memoText: "x" }), /No wallet/);
  await assert.rejects(() => submitMemoWithWallet({ wallet: {}, memoText: "x" }), /No wallet/);
});

test("LG-B3: the wallet blockhash fetch also times out instead of hanging", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = () => new Promise(() => {});
  const wallet = { publicKey: MINT, signAndSendTransaction: async () => SIG };
  try {
    await assert.rejects(
      () => submitMemoWithWallet({ wallet, memoText: "x", cluster: "devnet", web3: fakeWeb3, timeoutMs: 50 }),
      /timed out/,
    );
  } finally { globalThis.fetch = original; }
});

// --- LG-B6/F15: page-level pins (static, zero new dependencies) -----------------------------

test("LG-B6/F15: index.html carries the file:// warning, module-load detection and demo clarity copy", () => {
  const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
  assert.match(html, /id="env-warning"/);
  assert.match(html, /must be served over HTTP/);
  assert.match(html, /location\.protocol === "file:"/);
  assert.match(html, /__lgModuleLoaded/);
  assert.match(html, /e\.kind === "timeout"/);
  assert.match(html, /did not answer in time/);
  assert.match(html, /Sample: USDC \(clean — live network call\)/);
  assert.match(html, /FIELD MISMATCH means/);
  assert.match(html, /higher means riskier/);
  assert.match(html, /Largest token account/);
});
