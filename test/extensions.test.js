import { test } from "node:test";
import assert from "node:assert/strict";
import { scoreMint } from "../src/lib/risk.js";
import { fetchMintFacts, extractExtensions } from "../src/lib/solana.js";

const MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const TOKEN_2022 = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";

const baseFacts = {
  mintAuthorityActive: false,
  freezeAuthorityActive: false,
  topHolderPct: 4,
  top10HolderPct: 30,
  holderCount: 5000,
  supplyUi: 1000,
};

const noExtensions = {
  hasPermanentDelegate: false,
  hasTransferFee: false,
  effectiveFeeBasisPoints: null,
  scheduledFeeBasisPoints: null,
  scheduledFeeEpoch: null,
  nonTransferable: false,
  defaultFrozen: false,
  hasTransferHook: false,
  hasConfidentialTransfer: false,
  hasMintCloseAuthority: false,
  // Delta (round-3 delta pass): dormant-trap / pausable / scaled-UI /
  // coverage fields added to the extraction shape.
  transferFeeConfigAuthority: null,
  withdrawWithheldAuthority: null,
  transferFeeMaximumFee: null,
  effectiveFeeRateBps: null,
  transferHookAuthority: null,
  transferHookProgramId: null,
  hasPausableConfig: false,
  pausableAuthorityActive: false,
  transfersPaused: false,
  hasScaledUiAmount: false,
  scaledUiAuthorityActive: false,
  unknownExtensions: [],
  unparseableExtensionCount: 0,
};

function flag(result, key) {
  return result.flags.find((f) => f.key === key);
}

// --- scoring rules (risk.js) -------------------------------------------------------

test("permanent delegate: high, 30 pts, exact documented detail", () => {
  const r = scoreMint({ ...baseFacts, programId: TOKEN_2022, extensions: { ...noExtensions, hasPermanentDelegate: true } });
  const f = flag(r, "permanent-delegate");
  assert.ok(f);
  assert.equal(f.severity, "high");
  assert.equal(f.points, 30);
  assert.equal(f.detail, "A permanent delegate can move tokens out of any holder's account.");
  assert.equal(r.score, 30);
});

test("default frozen: high, 25 pts", () => {
  const r = scoreMint({ ...baseFacts, programId: TOKEN_2022, extensions: { ...noExtensions, defaultFrozen: true } });
  const f = flag(r, "default-frozen");
  assert.ok(f);
  assert.equal(f.severity, "high");
  assert.equal(f.points, 25);
});

test("non-transferable: high, 40 pts", () => {
  const r = scoreMint({ ...baseFacts, programId: TOKEN_2022, extensions: { ...noExtensions, nonTransferable: true } });
  const f = flag(r, "non-transferable");
  assert.ok(f);
  assert.equal(f.severity, "high");
  assert.equal(f.points, 40);
});

test("transfer fee: low, 5 pts, effective fee % in the detail when known", () => {
  const r = scoreMint({
    ...baseFacts, programId: TOKEN_2022,
    extensions: { ...noExtensions, hasTransferFee: true, effectiveFeeBasisPoints: 250 },
  });
  const f = flag(r, "transfer-fee");
  assert.ok(f);
  assert.equal(f.severity, "low");
  assert.equal(f.points, 5);
  assert.match(f.detail, /2\.50%/);
  assert.match(f.detail, /250 basis points/);

  const unknownFee = scoreMint({
    ...baseFacts, programId: TOKEN_2022,
    extensions: { ...noExtensions, hasTransferFee: true, effectiveFeeBasisPoints: null },
  });
  assert.ok(flag(unknownFee, "transfer-fee"));
  assert.match(flag(unknownFee, "transfer-fee").detail, /could not be read/);
});

test("transfer fee detail notes a scheduled fee change (effective fee shown, not the future one)", () => {
  const r = scoreMint({
    ...baseFacts, programId: TOKEN_2022,
    extensions: {
      ...noExtensions, hasTransferFee: true,
      effectiveFeeBasisPoints: 100, scheduledFeeBasisPoints: 250, scheduledFeeEpoch: "601",
    },
  });
  const f = flag(r, "transfer-fee");
  assert.ok(f);
  assert.match(f.detail, /1\.00% transfer fee \(100 basis points\)/);
  assert.match(f.detail, /scheduled to change to 2\.50% at epoch 601/);
});

test("transfer fee of 0 bps: fact stays visible but NO flag fires", () => {
  const r = scoreMint({
    ...baseFacts, programId: TOKEN_2022,
    extensions: { ...noExtensions, hasTransferFee: true, effectiveFeeBasisPoints: 0 },
  });
  assert.equal(flag(r, "transfer-fee"), undefined);
  assert.equal(r.score, 0);
  assert.equal(r.flags.length, 0);
});

test("transfer hook: low, 5 pts, documented detail", () => {
  const r = scoreMint({ ...baseFacts, programId: TOKEN_2022, extensions: { ...noExtensions, hasTransferHook: true } });
  const f = flag(r, "transfer-hook");
  assert.ok(f);
  assert.equal(f.severity, "low");
  assert.equal(f.points, 5);
  assert.equal(f.detail, "Transfers run custom program logic (transfer hook).");
});

test("confidential transfer alone is extracted but NOT scored", () => {
  const r = scoreMint({ ...baseFacts, programId: TOKEN_2022, extensions: { ...noExtensions, hasConfidentialTransfer: true } });
  assert.equal(r.score, 0);
  assert.equal(r.flags.length, 0);
});

test("all-false extensions on Token-2022: no extension flags", () => {
  const r = scoreMint({ ...baseFacts, programId: TOKEN_2022, extensions: { ...noExtensions } });
  assert.equal(r.flags.length, 0);
});

test("extensions null on Token-2022: one low 0-pt informational extensions-unknown flag", () => {
  // 0 points: the unparsed account already drives the authority-unknown
  // flags, and the coverage gap is carried by the confidence indicator —
  // one root cause must not be charged three times.
  const r = scoreMint({ ...baseFacts, programId: TOKEN_2022, extensions: null });
  assert.equal(r.flags.length, 1);
  const f = flag(r, "extensions-unknown");
  assert.ok(f);
  assert.equal(f.severity, "low");
  assert.equal(f.points, 0);
  assert.equal(r.score, 0);
  assert.match(f.detail, /could not be parsed/);
  assert.match(f.detail, /data-confidence/);
});

test("classic Token program mints get NO extension flags, even with null extensions", () => {
  const r = scoreMint({ ...baseFacts, programId: TOKEN_PROGRAM, extensions: null });
  assert.equal(r.flags.length, 0);
  const r2 = scoreMint({ ...baseFacts, programId: TOKEN_PROGRAM, extensions: { ...noExtensions } });
  assert.equal(r2.flags.length, 0);
});

test("extension flags stack with classic rules and clamp at 100", () => {
  const r = scoreMint({
    mintAuthorityActive: true, freezeAuthorityActive: true,
    topHolderPct: 99, top10HolderPct: 99, holderCount: 1, supplyUi: 1,
    programId: TOKEN_2022,
    extensions: { ...noExtensions, hasPermanentDelegate: true, defaultFrozen: true, nonTransferable: true },
  });
  assert.equal(r.score, 100);
  assert.ok(flag(r, "permanent-delegate"));
  assert.ok(flag(r, "default-frozen"));
  assert.ok(flag(r, "non-transferable"));
});

// --- extraction (solana.js extractExtensions) ---------------------------------------

test("extractExtensions: classic program mint is all-false even without an extensions array", () => {
  assert.deepEqual(extractExtensions({ mintAuthority: null }, TOKEN_PROGRAM), noExtensions);
});

test("extractExtensions: unparsed info returns null (unknown)", () => {
  assert.equal(extractExtensions(undefined, TOKEN_2022), null);
  assert.equal(extractExtensions(null, TOKEN_2022), null);
});

test("extractExtensions: Token-2022 entries map to booleans; older fee is effective, differing newer fee is scheduled", () => {
  const info = {
    extensions: [
      { extension: "permanentDelegate", state: { delegate: "Del1111111111111111111111111111111111111111" } },
      {
        extension: "transferFeeConfig",
        state: {
          olderTransferFee: { epoch: "600", maximumFee: "1000", transferFeeBasisPoints: 100 },
          newerTransferFee: { epoch: "601", maximumFee: "1000", transferFeeBasisPoints: 250 },
        },
      },
      { extension: "defaultAccountState", state: { state: "frozen" } },
      { extension: "nonTransferable", state: {} },
      { extension: "transferHook", state: { authority: null, programId: "Hook11111111111111111111111111111111111111" } },
      { extension: "confidentialTransferMint", state: {} },
    ],
  };
  assert.deepEqual(extractExtensions(info, TOKEN_2022), {
    hasPermanentDelegate: true,
    hasTransferFee: true,
    effectiveFeeBasisPoints: 100,
    scheduledFeeBasisPoints: 250,
    scheduledFeeEpoch: "601",
    nonTransferable: true,
    defaultFrozen: true,
    hasTransferHook: true,
    hasConfidentialTransfer: true,
    hasMintCloseAuthority: false,
    transferFeeConfigAuthority: null,
    withdrawWithheldAuthority: null,
    transferFeeMaximumFee: "1000",
    effectiveFeeRateBps: 100,
    transferHookAuthority: null,
    transferHookProgramId: "Hook11111111111111111111111111111111111111",
    hasPausableConfig: false,
    pausableAuthorityActive: false,
    transfersPaused: false,
    hasScaledUiAmount: false,
    scaledUiAuthorityActive: false,
    unknownExtensions: [],
    unparseableExtensionCount: 0,
  });
});

test("extractExtensions: newer fee equal to older is not a scheduled change", () => {
  const info = {
    extensions: [
      {
        extension: "transferFeeConfig",
        state: {
          olderTransferFee: { epoch: "600", maximumFee: "1000", transferFeeBasisPoints: 100 },
          newerTransferFee: { epoch: "601", maximumFee: "1000", transferFeeBasisPoints: 100 },
        },
      },
    ],
  };
  const ext = extractExtensions(info, TOKEN_2022);
  assert.equal(ext.effectiveFeeBasisPoints, 100);
  assert.equal(ext.scheduledFeeBasisPoints, null);
  assert.equal(ext.scheduledFeeEpoch, null);
});

test("extractExtensions: transfer hook counts only with a non-null programId", () => {
  const withProgram = { extensions: [{ extension: "transferHook", state: { authority: null, programId: "Hook11111111111111111111111111111111111111" } }] };
  assert.equal(extractExtensions(withProgram, TOKEN_2022).hasTransferHook, true);
  const nullProgram = { extensions: [{ extension: "transferHook", state: { authority: null, programId: null } }] };
  assert.equal(extractExtensions(nullProgram, TOKEN_2022).hasTransferHook, false);
  const noState = { extensions: [{ extension: "transferHook" }] };
  assert.equal(extractExtensions(noState, TOKEN_2022).hasTransferHook, false);
  // And the inert (null-programId) hook produces no scoring flag.
  const r = scoreMint({ ...baseFacts, programId: TOKEN_2022, extensions: { ...noExtensions, hasTransferHook: false } });
  assert.equal(flag(r, "transfer-hook"), undefined);
});

test("extractExtensions: mintCloseAuthority recorded as a fact, and NOT scored", () => {
  const withAuthority = { extensions: [{ extension: "mintCloseAuthority", state: { authority: "Close1111111111111111111111111111111111111" } }] };
  assert.equal(extractExtensions(withAuthority, TOKEN_2022).hasMintCloseAuthority, true);
  const nullAuthority = { extensions: [{ extension: "mintCloseAuthority", state: { authority: null } }] };
  assert.equal(extractExtensions(nullAuthority, TOKEN_2022).hasMintCloseAuthority, false);
  assert.equal(extractExtensions({ extensions: [] }, TOKEN_2022).hasMintCloseAuthority, false);
  // Fact only: a close authority alone adds no flag and no points (a mint
  // can only be closed at zero supply, so it cannot directly rug holders).
  const r = scoreMint({ ...baseFacts, programId: TOKEN_2022, extensions: { ...noExtensions, hasMintCloseAuthority: true } });
  assert.equal(r.score, 0);
  assert.equal(r.flags.length, 0);
});

test("extractExtensions: defaultAccountState initialized is not frozen; empty list is all-false", () => {
  const info = { extensions: [{ extension: "defaultAccountState", state: { state: "initialized" } }] };
  assert.equal(extractExtensions(info, TOKEN_2022).defaultFrozen, false);
  assert.deepEqual(extractExtensions({ extensions: [] }, TOKEN_2022), noExtensions);
  assert.deepEqual(extractExtensions({}, TOKEN_2022), noExtensions);
});

// --- end to end through fetchMintFacts ------------------------------------------------

function jsonResponse(result, status = 200) {
  return { status, ok: status >= 200 && status < 300, async json() { return { jsonrpc: "2.0", id: 1, result }; } };
}
function stubFetch(handler) {
  const original = globalThis.fetch;
  globalThis.fetch = async (endpoint, opts) => handler(JSON.parse(opts.body).method);
  return () => { globalThis.fetch = original; };
}
const supplyResult = { value: { amount: "1000000", decimals: 6, uiAmount: 1 } };
const largestResult = { value: [{ address: "A111111111111111111111111111111111111111111", amount: "10000", decimals: 6 }] };

test("fetchMintFacts: Token-2022 parsed mint yields programId + extension facts", async () => {
  const account = {
    value: {
      owner: TOKEN_2022,
      lamports: 1461600,
      data: {
        program: "spl-token-2022",
        parsed: {
          type: "mint",
          info: {
            mintAuthority: null, freezeAuthority: null, decimals: 6, supply: "1000000", isInitialized: true,
            extensions: [
              { extension: "permanentDelegate", state: { delegate: "Del1111111111111111111111111111111111111111" } },
              { extension: "transferFeeConfig", state: { newerTransferFee: { transferFeeBasisPoints: 100 } } },
            ],
          },
        },
      },
    },
  };
  const restore = stubFetch((method) => {
    if (method === "getAccountInfo") return jsonResponse(account);
    if (method === "getTokenSupply") return jsonResponse(supplyResult);
    if (method === "getTokenLargestAccounts") return jsonResponse(largestResult);
    if (method === "getProgramAccounts") return jsonResponse([]);
    throw new Error(`unexpected method ${method}`);
  });
  try {
    const facts = await fetchMintFacts(MINT, "mainnet-beta");
    assert.equal(facts.programId, TOKEN_2022);
    assert.equal(facts.extensions.hasPermanentDelegate, true);
    assert.equal(facts.extensions.hasTransferFee, true);
    // Only a newerTransferFee is present in this stub: it is the fallback
    // effective fee, and with no differing older fee nothing is scheduled.
    assert.equal(facts.extensions.effectiveFeeBasisPoints, 100);
    assert.equal(facts.extensions.scheduledFeeBasisPoints, null);
    assert.equal(facts.extensions.defaultFrozen, false);
    const r = scoreMint(facts);
    assert.ok(flag(r, "permanent-delegate"));
    assert.ok(flag(r, "transfer-fee"));
  } finally { restore(); }
});

test("fetchMintFacts: Token-2022-owned unparsed account yields extensions null", async () => {
  const restore = stubFetch((method) => {
    if (method === "getAccountInfo") return jsonResponse({ value: { owner: TOKEN_2022, lamports: 1, data: ["", "base64"] } });
    if (method === "getTokenSupply") return jsonResponse(supplyResult);
    if (method === "getTokenLargestAccounts") return jsonResponse(largestResult);
    if (method === "getProgramAccounts") return jsonResponse([]);
    throw new Error(`unexpected method ${method}`);
  });
  try {
    const facts = await fetchMintFacts(MINT, "mainnet-beta");
    assert.equal(facts.programId, TOKEN_2022);
    assert.equal(facts.extensions, null);
    assert.ok(flag(scoreMint(facts), "extensions-unknown"));
  } finally { restore(); }
});
