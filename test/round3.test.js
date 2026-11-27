// LaunchGuard round-3 regression tests (studio-repair + studio-excellence pass).
// Pins F1 (largest-accounts failure degradation), V4 calibration
// (concentration-85 tier + spread-concentration floor, pre-registered
// constraints), and Meteora DLMM + DAMM v2 liquidity coverage. All offline.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  fetchMintFacts,
  fetchLiquidity,
  RpcError,
  METEORA_DLMM_PROGRAM_ID,
  METEORA_DAMM_V2_PROGRAM_ID,
  METEORA_DAMM_V1_PROGRAM_ID,
  ORCA_WHIRLPOOL_PROGRAM_ID,
  RAYDIUM_AMM_V4_PROGRAM_ID,
} from "../src/lib/solana.js";
import { scoreMint } from "../src/lib/risk.js";
import { assessConfidence } from "../src/lib/report.js";

const MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const ENDPOINT = "https://api.mainnet-beta.solana.com";

function jsonResponse(result, status = 200) {
  return { status, ok: status >= 200 && status < 300, async json() { return { jsonrpc: "2.0", id: 1, result }; } };
}
function errorResponse(message = "Method not found") {
  return { status: 200, ok: true, async json() { return { jsonrpc: "2.0", id: 1, error: { code: -32601, message } }; } };
}

// --- F1: getTokenLargestAccounts failure degrades, nothing else does -----------

const supplyResult = { value: { amount: "1000000", decimals: 6, uiAmount: 1 } };
const mintAccountResult = {
  value: {
    owner: TOKEN_PROGRAM,
    lamports: 1461600,
    data: {
      program: "spl-token",
      parsed: {
        type: "mint",
        info: { mintAuthority: null, freezeAuthority: null, decimals: 6, supply: "1000000", isInitialized: true },
      },
    },
  },
};

function stubScan(overrides = {}) {
  const original = globalThis.fetch;
  globalThis.fetch = async (endpoint, opts) => {
    const { method } = JSON.parse(opts.body);
    if (overrides[method]) return overrides[method]();
    if (method === "getAccountInfo") return jsonResponse(mintAccountResult);
    if (method === "getTokenSupply") return jsonResponse(supplyResult);
    if (method === "getTokenLargestAccounts") return jsonResponse({ value: [{ address: "A111111111111111111111111111111111111111111", amount: "500000", decimals: 6 }] });
    if (method === "getProgramAccounts") return jsonResponse([]);
    throw new Error(`unexpected ${method}`);
  };
  return () => { globalThis.fetch = original; };
}

test("F1: largest-accounts RPC error (mega-mint shape) degrades to unknown holder facts, scan continues", async () => {
  const restore = stubScan({
    getTokenLargestAccounts: () => errorResponse("Too many accounts requested (10000000 pubkeys), try adding filters to narrow down results"),
  });
  try {
    const facts = await fetchMintFacts(MINT, "mainnet-beta");
    assert.equal(facts.mintAuthorityActive, false);
    assert.equal(facts.freezeAuthorityActive, false);
    assert.equal(facts.supplyUi, 1);
    assert.equal(facts.topHolderPct, null);
    assert.equal(facts.top10HolderPct, null);
    assert.equal(facts.holderCount, null);
    assert.equal(facts.holderCountIsFloor, false);
    assert.equal(facts.largestAccountsUnavailable, true);
    // The scan still produces a verdict from the remaining facts.
    const r = scoreMint(facts);
    assert.equal(r.score, 0);
    assert.ok(!r.flags.some((f) => f.key.startsWith("whale") || f.key.startsWith("concentration")));
    // Confidence names the gap with the specific reason (not just generic).
    const conf = assessConfidence(facts);
    assert.ok(conf.reasons.some((x) => /largest-accounts request failed/.test(x)), conf.reasons.join(" | "));
    assert.ok(!conf.reasons.some((x) => x === "Top-holder data is missing."), "specific reason replaces the generic one, no double count");
  } finally { restore(); }
});

test("F1: getTokenSupply failure still throws (only the largest-accounts call degrades)", async () => {
  const restore = stubScan({ getTokenSupply: () => errorResponse("supply boom") });
  try {
    await assert.rejects(() => fetchMintFacts(MINT, "mainnet-beta"), (e) => e instanceof RpcError);
  } finally { restore(); }
});

test("F1: getAccountInfo failure still throws", async () => {
  const restore = stubScan({ getAccountInfo: () => errorResponse("account boom") });
  try {
    await assert.rejects(() => fetchMintFacts(MINT, "mainnet-beta"), (e) => e instanceof RpcError);
  } finally { restore(); }
});

test("F1: a malformed (successful) largest-accounts payload still throws, never degrades", async () => {
  const restore = stubScan({ getTokenLargestAccounts: () => jsonResponse({ value: "not-a-list" }) });
  try {
    await assert.rejects(() => fetchMintFacts(MINT, "mainnet-beta"), (e) => e instanceof RpcError);
  } finally { restore(); }
});

test("F1: successful largest-accounts call sets no marker", async () => {
  const restore = stubScan();
  try {
    const facts = await fetchMintFacts(MINT, "mainnet-beta");
    assert.equal(facts.largestAccountsUnavailable, undefined);
    assert.equal(facts.topHolderPct, 50);
  } finally { restore(); }
});

// --- V4 calibration: concentration-85 tier --------------------------------------

const clean = { mintAuthorityActive: false, freezeAuthorityActive: false, holderCount: 5000, supplyUi: 1 };

test("V4: concentration tier boundaries 84.9 / 85 / 89.9 / 90", () => {
  const at = (t10) => scoreMint({ ...clean, topHolderPct: 4, top10HolderPct: t10 }).flags.find((f) => f.key.startsWith("concentration"));
  assert.equal(at(84.9).key, "concentration-70");
  assert.equal(at(84.9).points, 8);
  assert.equal(at(85).key, "concentration-85");
  assert.equal(at(85).points, 15);
  assert.equal(at(89.9).key, "concentration-85");
  assert.equal(at(90).key, "concentration-90");
  assert.equal(at(90).points, 15);
});

test("V4: HAWK shape (31.16 / 87.64) reaches exactly 30 CAUTION via concentration-85", () => {
  const r = scoreMint({ ...clean, topHolderPct: 31.16, top10HolderPct: 87.64 });
  assert.equal(r.score, 30);
  assert.equal(r.band, "CAUTION");
  assert.deepEqual(r.flags.map((f) => f.key), ["whale-25", "concentration-85"]);
  assert.equal(r.flags.reduce((s, f) => s + f.points, 0), r.score);
});

// --- V4 calibration: spread-concentration floor ---------------------------------

test("V4: MELANIA shape (30 / 90.54) floors at 60 HIGH via spread-concentration carrying the difference", () => {
  const r = scoreMint({ ...clean, topHolderPct: 30, top10HolderPct: 90.54 });
  assert.equal(r.score, 60);
  assert.equal(r.band, "HIGH RISK");
  const f = r.flags.find((x) => x.key === "spread-concentration");
  assert.ok(f);
  assert.equal(f.points, 30); // 60 - (15 whale-25 + 15 concentration-90)
  assert.equal(f.severity, "high");
  assert.match(f.detail, /spread across accounts/i);
  assert.equal(r.flags.reduce((s, x) => s + x.points, 0), r.score);
});

test("V4: spread-concentration boundaries — needs concentration-90 AND whale-25 AND no whale-50", () => {
  // Largest below 25%: no spread floor.
  const low = scoreMint({ ...clean, topHolderPct: 24.9, top10HolderPct: 95 });
  assert.equal(low.score, 21);
  assert.ok(!low.flags.some((f) => f.key === "spread-concentration"));
  // Largest exactly 25% with top-10 exactly 90%: floor fires.
  const edge = scoreMint({ ...clean, topHolderPct: 25, top10HolderPct: 90 });
  assert.equal(edge.score, 60);
  assert.equal(edge.flags.find((f) => f.key === "spread-concentration").points, 30);
  // Top-10 at 89.9 (concentration-85, not -90): no floor, score is 30.
  const under = scoreMint({ ...clean, topHolderPct: 30, top10HolderPct: 89.9 });
  assert.equal(under.score, 30);
  assert.ok(!under.flags.some((f) => f.key === "spread-concentration"));
  // Whale-50 shape: compound-concentration fires instead, never spread.
  const whale = scoreMint({ ...clean, topHolderPct: 50, top10HolderPct: 95 });
  assert.equal(whale.score, 60);
  assert.ok(whale.flags.some((f) => f.key === "compound-concentration"));
  assert.ok(!whale.flags.some((f) => f.key === "spread-concentration"));
});

test("V4: spread floor tops up a partial score and yields to an already-HIGH score", () => {
  // Freeze authority (25) + whale-25 (15) + concentration-90 (15) = 55 -> +5.
  const partial = scoreMint({ ...clean, freezeAuthorityActive: true, topHolderPct: 30, top10HolderPct: 95 });
  assert.equal(partial.score, 60);
  assert.equal(partial.flags.find((f) => f.key === "spread-concentration").points, 5);
  assert.equal(partial.flags.reduce((s, f) => s + f.points, 0), partial.score);
  // Mint authority (30) + whale-25 (15) + concentration-90 (15) = 60 already: no floor flag.
  const already = scoreMint({ ...clean, mintAuthorityActive: true, topHolderPct: 30, top10HolderPct: 95 });
  assert.equal(already.score, 60);
  assert.ok(!already.flags.some((f) => f.key === "spread-concentration"));
});

test("V4: pre-registered constraints — controls unchanged, LIBRA unchanged, null holders earn nothing", () => {
  // Controls (baseline live shapes): scores must not rise, bands stay LOWER.
  assert.equal(scoreMint({ ...clean, topHolderPct: 24.97, top10HolderPct: 77.76 }).score, 14); // RAY
  assert.equal(scoreMint({ ...clean, topHolderPct: 10.39, top10HolderPct: 40.58 }).score, 6); // BONK
  assert.equal(scoreMint({ ...clean, topHolderPct: 5.73, top10HolderPct: 33.96 }).score, 0); // Fartcoin
  // LIBRA shape stays exactly 60 via the compound rule.
  const libra = scoreMint({ ...clean, topHolderPct: 50, top10HolderPct: 98.75 });
  assert.equal(libra.score, 60);
  assert.equal(libra.band, "HIGH RISK");
  // Constraint (e): unknown holder facts (post-F1 hard cases) earn no
  // holder-rule points at all.
  const unknown = scoreMint({ ...clean, topHolderPct: null, top10HolderPct: null, holderCount: null });
  assert.equal(unknown.score, 0);
  assert.ok(!unknown.flags.some((f) => /whale|concentration/.test(f.key)));
});

// --- Meteora liquidity coverage ---------------------------------------------------

const DLMM_DISC = [33, 11, 49, 98, 181, 101, 177, 13];
const DAMM_DISC = [241, 154, 109, 4, 17, 177, 109, 188];
const discEntry = (pubkey, disc) => ({ pubkey, account: { data: [Buffer.from(disc).toString("base64"), "base64"] } });
const raydiumEntry = (pubkey, status = 6) => {
  const bytes = Buffer.alloc(8); bytes[0] = status;
  return { pubkey, account: { data: [bytes.toString("base64"), "base64"] } };
};

// Stub fetch dispatching on (programId, mint-memcmp offset).
function stubVenues(handler) {
  const original = globalThis.fetch;
  globalThis.fetch = async (endpoint, opts) => {
    const body = JSON.parse(opts.body);
    assert.equal(body.method, "getProgramAccounts");
    return handler(body.params[0], body.params[1].filters[0].memcmp.offset, body.params);
  };
  return () => { globalThis.fetch = original; };
}

test("Meteora: DLMM pool in token-X position -> detected with per-venue breakdown", async () => {
  const restore = stubVenues((program, offset) =>
    jsonResponse(program === METEORA_DLMM_PROGRAM_ID && offset === 88 ? [discEntry("DlmmPool111111111111111111111111111111111", DLMM_DISC)] : []));
  try {
    const liq = await fetchLiquidity(ENDPOINT, MINT);
    assert.equal(liq.status, "detected");
    assert.equal(liq.poolCount, 1);
    assert.deepEqual(liq.venues, { raydiumAmmV4: 0, meteoraDlmm: 1, meteoraDammV2: 0, meteoraDammV1: 0, orcaWhirlpool: 0 });
  } finally { restore(); }
});

test("Meteora: DLMM dedupe — same pubkey from both positions counts once, distinct pools count each", async () => {
  const same = discEntry("DlmmPool111111111111111111111111111111111", DLMM_DISC);
  const restore1 = stubVenues((program) => jsonResponse(program === METEORA_DLMM_PROGRAM_ID ? [same, same] : []));
  try {
    const liq = await fetchLiquidity(ENDPOINT, MINT);
    assert.equal(liq.venues.meteoraDlmm, 1);
    assert.equal(liq.poolCount, 1);
  } finally { restore1(); }
  const restore2 = stubVenues((program, offset) =>
    jsonResponse(program === METEORA_DLMM_PROGRAM_ID
      ? [discEntry(offset === 88 ? "DlmmPool111111111111111111111111111111111" : "DlmmPool222222222222222222222222222222222", DLMM_DISC)]
      : []));
  try {
    const liq = await fetchLiquidity(ENDPOINT, MINT);
    assert.equal(liq.venues.meteoraDlmm, 2);
    assert.equal(liq.poolCount, 2);
  } finally { restore2(); }
});

test("Meteora: DAMM v2 pool in token-B position -> detected with per-venue breakdown", async () => {
  const restore = stubVenues((program, offset) =>
    jsonResponse(program === METEORA_DAMM_V2_PROGRAM_ID && offset === 200 ? [discEntry("DammPool111111111111111111111111111111111", DAMM_DISC)] : []));
  try {
    const liq = await fetchLiquidity(ENDPOINT, MINT);
    assert.equal(liq.status, "detected");
    assert.deepEqual(liq.venues, { raydiumAmmV4: 0, meteoraDlmm: 0, meteoraDammV2: 1, meteoraDammV1: 0, orcaWhirlpool: 0 });
  } finally { restore(); }
});

test("Meteora: cross-venue totals sum distinct pools per venue", async () => {
  const restore = stubVenues((program, offset) => {
    if (program === RAYDIUM_AMM_V4_PROGRAM_ID) return jsonResponse(offset === 400 ? [raydiumEntry("RayPool1111111111111111111111111111111111")] : []);
    if (program === METEORA_DLMM_PROGRAM_ID) return jsonResponse(offset === 120 ? [discEntry("DlmmPool111111111111111111111111111111111", DLMM_DISC)] : []);
    if (program === METEORA_DAMM_V2_PROGRAM_ID) return jsonResponse(offset === 168 ? [discEntry("DammPool111111111111111111111111111111111", DAMM_DISC)] : []);
    return jsonResponse([]);
  });
  try {
    const liq = await fetchLiquidity(ENDPOINT, MINT);
    assert.equal(liq.status, "detected");
    assert.equal(liq.poolCount, 3);
    assert.deepEqual(liq.venues, { raydiumAmmV4: 1, meteoraDlmm: 1, meteoraDammV2: 1, meteoraDammV1: 0, orcaWhirlpool: 0 });
  } finally { restore(); }
});

test("Meteora: discriminator mismatch is unclassifiable -> venue unknown, never a pool and never not-detected", async () => {
  // A Raydium-status-shaped entry returned for a DLMM query (lying endpoint).
  const restore = stubVenues((program) =>
    jsonResponse(program === METEORA_DLMM_PROGRAM_ID ? [raydiumEntry("FakePool11111111111111111111111111111111")] : []));
  try {
    const liq = await fetchLiquidity(ENDPOINT, MINT);
    assert.equal(liq.status, "unknown");
    assert.equal(liq.poolCount, null);
    assert.equal(liq.venues.meteoraDlmm, null);
    assert.equal(liq.venues.raydiumAmmV4, 0);
  } finally { restore(); }
});

test("Meteora: garbage entries are filtered; a well-formed entry with missing data is unclassifiable", async () => {
  const restore = stubVenues((program) =>
    jsonResponse(program === METEORA_DLMM_PROGRAM_ID ? [null, "garbage", {}, 42] : []));
  try {
    const liq = await fetchLiquidity(ENDPOINT, MINT);
    assert.equal(liq.status, "not-detected");
    assert.deepEqual(liq.venues, { raydiumAmmV4: 0, meteoraDlmm: 0, meteoraDammV2: 0, meteoraDammV1: 0, orcaWhirlpool: 0 });
  } finally { restore(); }
  const noData = { pubkey: "DlmmPool111111111111111111111111111111111", account: { data: ["", "base64"] } };
  const restore2 = stubVenues((program) => jsonResponse(program === METEORA_DLMM_PROGRAM_ID ? [noData] : []));
  try {
    const liq = await fetchLiquidity(ENDPOINT, MINT);
    assert.equal(liq.status, "unknown");
    assert.equal(liq.venues.meteoraDlmm, null);
  } finally { restore2(); }
});

test("Meteora: one venue's RPC failure degrades honestly — detected elsewhere still detects, otherwise unknown", async () => {
  const restore = stubVenues((program, offset) => {
    if (program === METEORA_DLMM_PROGRAM_ID) return errorResponse("blocked");
    if (program === RAYDIUM_AMM_V4_PROGRAM_ID) return jsonResponse(offset === 400 ? [raydiumEntry("RayPool1111111111111111111111111111111111")] : []);
    return jsonResponse([]);
  });
  try {
    const liq = await fetchLiquidity(ENDPOINT, MINT);
    assert.equal(liq.status, "detected");
    assert.equal(liq.poolCount, 1);
    assert.equal(liq.venues.meteoraDlmm, null);
    assert.equal(liq.venues.raydiumAmmV4, 1);
  } finally { restore(); }
  const restore2 = stubVenues((program) => (program === METEORA_DLMM_PROGRAM_ID ? errorResponse("blocked") : jsonResponse([])));
  try {
    const liq = await fetchLiquidity(ENDPOINT, MINT);
    assert.equal(liq.status, "unknown");
    assert.equal(liq.poolCount, null);
  } finally { restore2(); }
});

test("Meteora: query shapes — programs, mint offsets 88/120 and 168/200, discriminator memcmp at offset 0", async () => {
  const seen = [];
  const restore = stubVenues((program, offset, params) => { seen.push(params); return jsonResponse([]); });
  try {
    await fetchLiquidity(ENDPOINT, MINT);
    assert.equal(seen.length, 10);
    const byProgram = (p) => seen.filter((x) => x[0] === p);
    const dlmm = byProgram(METEORA_DLMM_PROGRAM_ID);
    assert.deepEqual(dlmm.map((p) => p[1].filters[0].memcmp.offset).sort((a, b) => a - b), [88, 120]);
    for (const p of dlmm) {
      assert.equal(p[1].filters[0].memcmp.bytes, MINT);
      assert.deepEqual(p[1].dataSlice, { offset: 0, length: 8 });
      // Discriminator memcmp: base58 of sha256("account:LbPair")[..8].
      assert.equal(p[1].filters[1].memcmp.offset, 0);
      assert.equal(p[1].filters[1].memcmp.bytes, "6XZoLajBWVJ");
    }
    const damm = byProgram(METEORA_DAMM_V2_PROGRAM_ID);
    assert.deepEqual(damm.map((p) => p[1].filters[0].memcmp.offset).sort((a, b) => a - b), [168, 200]);
    for (const p of damm) {
      assert.equal(p[1].filters[0].memcmp.bytes, MINT);
      // Discriminator memcmp: base58 of sha256("account:Pool")[..8].
      assert.equal(p[1].filters[1].memcmp.offset, 0);
      assert.equal(p[1].filters[1].memcmp.bytes, "hQrXeCntzbV");
    }
  } finally { restore(); }
});

test("Meteora DAMM v1: pool in token-A position -> detected; query shape pins offsets 40/72 and the Pool discriminator", async () => {
  const seen = [];
  const restore = stubVenues((program, offset, params) => {
    seen.push(params);
    return jsonResponse(program === METEORA_DAMM_V1_PROGRAM_ID && offset === 40 ? [discEntry("DammV1Pool1111111111111111111111111111111", DAMM_DISC)] : []);
  });
  try {
    const liq = await fetchLiquidity(ENDPOINT, MINT);
    assert.equal(liq.status, "detected");
    assert.equal(liq.venues.meteoraDammV1, 1);
    assert.equal(liq.poolCount, 1);
    const damm1 = seen.filter((p) => p[0] === METEORA_DAMM_V1_PROGRAM_ID);
    assert.deepEqual(damm1.map((p) => p[1].filters[0].memcmp.offset).sort((a, b) => a - b), [40, 72]);
    for (const p of damm1) {
      assert.equal(p[1].filters[0].memcmp.bytes, MINT);
      // Same Anchor "Pool" discriminator bytes as DAMM v2, different program.
      assert.equal(p[1].filters[1].memcmp.bytes, "hQrXeCntzbV");
    }
  } finally { restore(); }
});

test("Orca: whirlpool in mint-B position -> detected; query shape pins offsets 101/181 and the Whirlpool discriminator", async () => {
  const ORCA_DISC = [63, 149, 209, 12, 225, 128, 99, 9];
  const seen = [];
  const restore = stubVenues((program, offset, params) => {
    seen.push(params);
    return jsonResponse(program === ORCA_WHIRLPOOL_PROGRAM_ID && offset === 181 ? [discEntry("WhirlPool11111111111111111111111111111111", ORCA_DISC)] : []);
  });
  try {
    const liq = await fetchLiquidity(ENDPOINT, MINT);
    assert.equal(liq.status, "detected");
    assert.equal(liq.venues.orcaWhirlpool, 1);
    assert.equal(liq.poolCount, 1);
    const orca = seen.filter((p) => p[0] === ORCA_WHIRLPOOL_PROGRAM_ID);
    assert.deepEqual(orca.map((p) => p[1].filters[0].memcmp.offset).sort((a, b) => a - b), [101, 181]);
    for (const p of orca) {
      assert.equal(p[1].filters[0].memcmp.bytes, MINT);
      assert.equal(p[1].filters[1].memcmp.bytes, "BdrfaPg3xM6");
    }
    // A DAMM-discriminator entry returned for an Orca query does not count.
    const restore2 = stubVenues((program) => jsonResponse(program === ORCA_WHIRLPOOL_PROGRAM_ID ? [discEntry("FakePool11111111111111111111111111111111", DAMM_DISC)] : []));
    try {
      const liq2 = await fetchLiquidity(ENDPOINT, MINT);
      assert.equal(liq2.status, "unknown");
      assert.equal(liq2.venues.orcaWhirlpool, null);
    } finally { restore2(); }
  } finally { restore(); }
});

test("Meteora: no-liquidity flag text names every checked venue", () => {
  const r = scoreMint({
    mintAuthorityActive: false, freezeAuthorityActive: false,
    topHolderPct: 4, top10HolderPct: 30, holderCount: 5000, supplyUi: 1000,
    liquidity: { status: "not-detected", poolCount: 0, lpStatus: "not-checked", venues: { raydiumAmmV4: 0, meteoraDlmm: 0, meteoraDammV2: 0, meteoraDammV1: 0, orcaWhirlpool: 0 } },
  });
  const f = r.flags.find((x) => x.key === "no-liquidity-detected");
  assert.ok(f);
  assert.match(f.detail, /Raydium AMM v4/);
  assert.match(f.detail, /Meteora DLMM/);
  assert.match(f.detail, /Meteora DAMM v2/);
  assert.match(f.detail, /Meteora DAMM v1/);
  assert.match(f.detail, /Orca Whirlpool/);
  assert.match(f.detail, /not proof of a rug/);
  assert.equal(f.points, 0);
});
