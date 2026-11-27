import { test } from "node:test";
import assert from "node:assert/strict";
import { fetchMintFacts, fetchLiquidity, RAYDIUM_AMM_V4_PROGRAM_ID } from "../src/lib/solana.js";
import { scoreMint } from "../src/lib/risk.js";

const MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const ENDPOINT = "https://api.mainnet-beta.solana.com";

function jsonResponse(result, status = 200) {
  return { status, ok: status >= 200 && status < 300, async json() { return { jsonrpc: "2.0", id: 1, result }; } };
}
function errorResponse(message = "Method not found") {
  return { status: 200, ok: true, async json() { return { jsonrpc: "2.0", id: 1, error: { code: -32601, message } }; } };
}

// Stub fetch dispatching on method; for getProgramAccounts the handler
// also receives the memcmp offset (400 = baseMint, 432 = quoteMint).
function stubFetch(handler) {
  const original = globalThis.fetch;
  globalThis.fetch = async (endpoint, opts) => {
    const body = JSON.parse(opts.body);
    const offset = body.method === "getProgramAccounts" ? body.params[1].filters[0].memcmp.offset : null;
    return handler(body.method, offset, body.params);
  };
  return () => { globalThis.fetch = original; };
}

// E1 re-baseline (LG-P6): a pool entry now carries its 8 status bytes —
// "BgAAAAAAAAA=" is status 6 (SwapOnly, the normal live state), u64 LE.
const poolAccount = { pubkey: "Pool1111111111111111111111111111111111111111", account: { data: ["BgAAAAAAAAA=", "base64"] } };
const poolAccount2 = { pubkey: "Pool2222222222222222222222222222222222222222", account: { data: ["BgAAAAAAAAA=", "base64"] } };
const poolAccount3 = { pubkey: "Pool3333333333333333333333333333333333333333", account: { data: ["AQAAAAAAAAA=", "base64"] } };

// --- fetchLiquidity behaviour ---------------------------------------------------------

test("liquidity: pool in base position -> detected with pool count", async () => {
  const restore = stubFetch((method, offset) => {
    assert.equal(method, "getProgramAccounts");
    return jsonResponse(offset === 400 ? [poolAccount] : []);
  });
  try {
    const liq = await fetchLiquidity(ENDPOINT, MINT);
    assert.equal(liq.status, "detected");
    assert.equal(liq.poolCount, 1);
    assert.equal(liq.lpStatus, "not-checked");
  } finally { restore(); }
});

test("liquidity: pools in both positions are summed", async () => {
  const restore = stubFetch((method, offset) => jsonResponse(offset === 400 ? [poolAccount, poolAccount2] : [poolAccount3]));
  try {
    const liq = await fetchLiquidity(ENDPOINT, MINT);
    assert.equal(liq.status, "detected");
    assert.equal(liq.poolCount, 3);
  } finally { restore(); }
});

test("liquidity: both queries succeed empty -> not-detected", async () => {
  const restore = stubFetch(() => jsonResponse([]));
  try {
    const liq = await fetchLiquidity(ENDPOINT, MINT);
    assert.deepEqual(liq, { status: "not-detected", poolCount: 0, lpStatus: "not-checked", venues: { raydiumAmmV4: 0, meteoraDlmm: 0, meteoraDammV2: 0, meteoraDammV1: 0, orcaWhirlpool: 0 } });
  } finally { restore(); }
});

test("liquidity: RPC error on both queries -> unknown, never throws", async () => {
  const restore = stubFetch(() => errorResponse());
  try {
    const liq = await fetchLiquidity(ENDPOINT, MINT);
    assert.deepEqual(liq, { status: "unknown", poolCount: null, lpStatus: "not-checked", venues: { raydiumAmmV4: null, meteoraDlmm: null, meteoraDammV2: null, meteoraDammV1: null, orcaWhirlpool: null } });
  } finally { restore(); }
});

test("liquidity: network failure (fetch rejects) -> unknown, never throws", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error("socket hang up"); };
  try {
    const liq = await fetchLiquidity(ENDPOINT, MINT);
    assert.equal(liq.status, "unknown");
    assert.equal(liq.poolCount, null);
  } finally { globalThis.fetch = original; }
});

test("liquidity: one query fails, other finds a pool -> detected (failure tolerated)", async () => {
  const restore = stubFetch((method, offset) => (offset === 400 ? errorResponse() : jsonResponse([poolAccount])));
  try {
    const liq = await fetchLiquidity(ENDPOINT, MINT);
    assert.equal(liq.status, "detected");
    assert.equal(liq.poolCount, 1);
  } finally { restore(); }
});

test("liquidity: one query fails, other finds nothing -> unknown (not a false not-detected)", async () => {
  const restore = stubFetch((method, offset) => (offset === 400 ? errorResponse() : jsonResponse([])));
  try {
    const liq = await fetchLiquidity(ENDPOINT, MINT);
    assert.equal(liq.status, "unknown");
    assert.equal(liq.poolCount, null);
  } finally { restore(); }
});

test("liquidity: query shape targets Raydium v4 with memcmp on the mint at offsets 400/432", async () => {
  const seen = [];
  const restore = stubFetch((method, offset, params) => {
    seen.push(params);
    return jsonResponse([]);
  });
  try {
    await fetchLiquidity(ENDPOINT, MINT);
    // Round-3 edit: the check now queries 5 venues x 2 mint positions =
    // 10 queries; the original assertions below are preserved, scoped to
    // the Raydium pair (Meteora shapes are pinned in round3.test.js).
    const raydium = seen.filter((p) => p[0] === RAYDIUM_AMM_V4_PROGRAM_ID);
    assert.equal(seen.length, 10);
    assert.equal(raydium.length, 2);
    for (const params of raydium) {
      assert.equal(params[0], RAYDIUM_AMM_V4_PROGRAM_ID);
      assert.deepEqual(params[1].dataSlice, { offset: 0, length: 8 });
      assert.equal(params[1].filters[0].memcmp.bytes, MINT);
      // AMM-info accounts have a fixed size: the dataSize filter lets the
      // RPC skip anything that cannot be a Raydium AMM v4 pool account.
      assert.deepEqual(params[1].filters[1], { dataSize: 752 });
    }
    assert.deepEqual(raydium.map((p) => p[1].filters[0].memcmp.offset).sort((a, b) => a - b), [400, 432]);
  } finally { restore(); }
});

// --- scoring treatment ------------------------------------------------------------------

const baseFacts = {
  mintAuthorityActive: false, freezeAuthorityActive: false,
  topHolderPct: 4, top10HolderPct: 30, holderCount: 5000, supplyUi: 1000,
};

test("scoring: not-detected adds a 0-point low informational flag only", () => {
  const r = scoreMint({ ...baseFacts, liquidity: { status: "not-detected", poolCount: 0, lpStatus: "not-checked" } });
  assert.equal(r.score, 0);
  assert.equal(r.flags.length, 1);
  const f = r.flags[0];
  assert.equal(f.key, "no-liquidity-detected");
  assert.equal(f.severity, "low");
  assert.equal(f.points, 0);
  assert.match(f.detail, /not proof of a rug/);
});

test("scoring: detected and unknown liquidity add no flag", () => {
  for (const status of ["detected", "unknown"]) {
    const r = scoreMint({ ...baseFacts, liquidity: { status, poolCount: status === "detected" ? 2 : null, lpStatus: "not-checked" } });
    assert.equal(r.flags.length, 0, `status ${status} must add no flag`);
    assert.equal(r.score, 0);
  }
});

// --- concurrency + failure tolerance inside fetchMintFacts ---------------------------------

const supplyResult = { value: { amount: "1000000", decimals: 6, uiAmount: 1 } };
const largestResult = { value: [{ address: "A111111111111111111111111111111111111111111", amount: "500000", decimals: 6 }] };
const mintAccountResult = {
  value: {
    owner: TOKEN_PROGRAM,
    lamports: 1461600,
    data: {
      program: "spl-token",
      parsed: {
        type: "mint",
        info: { mintAuthority: null, freezeAuthority: "FreezeAuth1111111111111111111111111111111", decimals: 6, supply: "1000000", isInitialized: true },
      },
    },
  },
};

test("fetchMintFacts: liquidity overlaps getAccountInfo and its failure never rejects the report", async () => {
  const original = globalThis.fetch;
  const calls = []; // request keys in ISSUE order
  const resolvers = new Map();
  let inFlight = 0;
  let maxInFlight = 0;
  globalThis.fetch = (endpoint, opts) => {
    const body = JSON.parse(opts.body);
    const key = body.method === "getProgramAccounts"
      ? `getProgramAccounts:${body.params[1].filters[0].memcmp.offset}`
      : body.method;
    calls.push(key);
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    return new Promise((resolve) => {
      resolvers.set(key, (resp) => { inFlight -= 1; resolve(resp); });
    });
  };
  try {
    const promise = fetchMintFacts(MINT, "mainnet-beta");
    // Let the synchronous issue phase settle.
    await new Promise((r) => setImmediate(r));

    // Liquidity was issued CONCURRENTLY with getAccountInfo (before it
    // resolved), and getTokenSupply has NOT been issued yet because
    // classification still depends on getAccountInfo.
    assert.ok(calls.includes("getProgramAccounts:400"), `calls: ${calls}`);
    assert.ok(calls.includes("getProgramAccounts:432"), `calls: ${calls}`);
    assert.ok(calls.includes("getAccountInfo"), `calls: ${calls}`);
    assert.ok(!calls.includes("getTokenSupply"), "supply must still wait for classification");
    assert.ok(maxInFlight >= 3, `expected >=3 concurrent requests, saw ${maxInFlight}`);

    // Resolve ONLY getAccountInfo: supply + largest are issued while the
    // liquidity requests are still in flight — i.e. the liquidity requests
    // were issued BEFORE getTokenSupply even started, let alone resolved.
    resolvers.get("getAccountInfo")(jsonResponse(mintAccountResult));
    await new Promise((r) => setImmediate(r));
    assert.ok(calls.includes("getTokenSupply"));
    assert.ok(calls.indexOf("getProgramAccounts:400") < calls.indexOf("getTokenSupply"));
    assert.ok(calls.indexOf("getProgramAccounts:432") < calls.indexOf("getTokenSupply"));

    // Fail ALL liquidity queries (RPC error body) and complete the rest.
    // Round-3 edit: the liquidity check now issues 10 GPA queries (5
    // venues x 2 positions), so every GPA resolver is failed here, not
    // just the two Raydium ones; the assertions below are unchanged in
    // strength (plus the new venues shape).
    for (const key of [...resolvers.keys()].filter((k) => k.startsWith("getProgramAccounts:"))) {
      resolvers.get(key)(errorResponse("blocked"));
    }
    resolvers.get("getTokenSupply")(jsonResponse(supplyResult));
    resolvers.get("getTokenLargestAccounts")(jsonResponse(largestResult));

    // The liquidity failure must NOT reject fetchMintFacts.
    const facts = await promise;
    assert.equal(facts.mintAuthorityActive, false);
    assert.equal(facts.topHolderPct, 50);
    assert.deepEqual(facts.liquidity, { status: "unknown", poolCount: null, lpStatus: "not-checked", venues: { raydiumAmmV4: null, meteoraDlmm: null, meteoraDammV2: null, meteoraDammV1: null, orcaWhirlpool: null } });
  } finally {
    globalThis.fetch = original;
  }
});

test("fetchMintFacts: end-to-end facts include detected liquidity", async () => {
  const restore = stubFetch((method, offset) => {
    if (method === "getAccountInfo") return jsonResponse(mintAccountResult);
    if (method === "getTokenSupply") return jsonResponse(supplyResult);
    if (method === "getTokenLargestAccounts") return jsonResponse(largestResult);
    if (method === "getProgramAccounts") return jsonResponse(offset === 432 ? [poolAccount] : []);
    throw new Error(`unexpected method ${method}`);
  });
  try {
    const facts = await fetchMintFacts(MINT, "mainnet-beta");
    assert.deepEqual(facts.liquidity, { status: "detected", poolCount: 1, lpStatus: "not-checked", venues: { raydiumAmmV4: 1, meteoraDlmm: 0, meteoraDammV2: 0, meteoraDammV1: 0, orcaWhirlpool: 0 } });
    assert.equal(facts.programId, TOKEN_PROGRAM);
    assert.ok(facts.extensions && facts.extensions.hasPermanentDelegate === false);
  } finally { restore(); }
});
