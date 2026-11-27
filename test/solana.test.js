import { test } from "node:test";
import assert from "node:assert/strict";
import { fetchMintFacts, MintNotFoundError } from "../src/lib/solana.js";

const MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";

function jsonResponse(result, status = 200) {
  return {
    status,
    ok: status >= 200 && status < 300,
    async json() { return { jsonrpc: "2.0", id: 1, result }; },
  };
}
function statusResponse(status) {
  return { status, ok: false, async json() { return {}; } };
}

// Install a stub fetch that dispatches on the JSON-RPC method in the body.
// handler(method, callIndexForMethod) must return a response object.
function stubFetch(handler) {
  const original = globalThis.fetch;
  const counts = {};
  globalThis.fetch = async (endpoint, opts) => {
    const { method } = JSON.parse(opts.body);
    counts[method] = (counts[method] ?? 0) + 1;
    return handler(method, counts[method]);
  };
  return () => { globalThis.fetch = original; };
}

const supplyResult = { value: { amount: "1000000", decimals: 6, uiAmount: 1 } };
const largestResult = {
  value: [
    { address: "A111111111111111111111111111111111111111111", amount: "500000", decimals: 6 },
    { address: "B111111111111111111111111111111111111111111", amount: "100000", decimals: 6 },
  ],
};
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

test("fetchMintFacts: account info null throws MintNotFoundError (FIX 4a)", async () => {
  const restore = stubFetch((method) => {
    if (method === "getAccountInfo") return jsonResponse({ value: null });
    throw new Error(`unexpected call ${method} — classification must happen first`);
  });
  try {
    await assert.rejects(() => fetchMintFacts(MINT, "mainnet-beta"), (e) => e instanceof MintNotFoundError);
  } finally { restore(); }
});

test("fetchMintFacts: valid parsed mint assembles facts (FIX 4b)", async () => {
  const restore = stubFetch((method) => {
    if (method === "getAccountInfo") return jsonResponse(mintAccountResult);
    if (method === "getTokenSupply") return jsonResponse(supplyResult);
    if (method === "getTokenLargestAccounts") return jsonResponse(largestResult);
    throw new Error(`unexpected method ${method}`);
  });
  try {
    const facts = await fetchMintFacts(MINT, "mainnet-beta");
    assert.equal(facts.mintAuthorityActive, false);
    assert.equal(facts.freezeAuthorityActive, true);
    assert.equal(facts.topHolderPct, 50);
    assert.equal(facts.top10HolderPct, 60);
    assert.equal(facts.holderCount, 2);
    assert.equal(facts.holderCountIsFloor, false);
    assert.equal(facts.supplyUi, 1);
  } finally { restore(); }
});

test("fetchMintFacts: token-owned unparsed account proceeds with unknown authorities (FIX 4)", async () => {
  const restore = stubFetch((method) => {
    if (method === "getAccountInfo") return jsonResponse({ value: { owner: TOKEN_PROGRAM, lamports: 1, data: ["", "base64"] } });
    if (method === "getTokenSupply") return jsonResponse(supplyResult);
    if (method === "getTokenLargestAccounts") return jsonResponse(largestResult);
    throw new Error(`unexpected method ${method}`);
  });
  try {
    const facts = await fetchMintFacts(MINT, "mainnet-beta");
    assert.equal(facts.mintAuthorityActive, null);
    assert.equal(facts.freezeAuthorityActive, null);
  } finally { restore(); }
});

test("fetchMintFacts: non-token-owned unparsed account throws MintNotFoundError (FIX 4)", async () => {
  const restore = stubFetch((method) => {
    if (method === "getAccountInfo") return jsonResponse({ value: { owner: "11111111111111111111111111111111", lamports: 1, data: ["", "base64"] } });
    throw new Error(`unexpected call ${method}`);
  });
  try {
    await assert.rejects(() => fetchMintFacts(MINT, "mainnet-beta"), (e) => e instanceof MintNotFoundError);
  } finally { restore(); }
});

test("fetchMintFacts: 429 on first getAccountInfo retries and succeeds (FIX 4c, ~2s backoff)", async () => {
  const restore = stubFetch((method, n) => {
    if (method === "getAccountInfo" && n === 1) return statusResponse(429);
    if (method === "getAccountInfo") return jsonResponse(mintAccountResult);
    if (method === "getTokenSupply") return jsonResponse(supplyResult);
    if (method === "getTokenLargestAccounts") return jsonResponse(largestResult);
    throw new Error(`unexpected method ${method}`);
  });
  try {
    const facts = await fetchMintFacts(MINT, "mainnet-beta");
    assert.equal(facts.mintAuthorityActive, false);
    assert.equal(facts.topHolderPct, 50);
  } finally { restore(); }
});
