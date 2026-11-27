// LaunchGuard v0.4.3 patch tests — wallet-signing shape routing.
//
// Defect (live, real Phantom, 2026-11-27): after Connect, anchoring
// failed with "t.serialize is not a function" and nothing was signed
// or broadcast. Root cause: when web3.js could not be loaded from the
// pinned unpkg CDN, submitMemoWithWallet passed hand-rolled serialized
// BYTES to the wallet's legacy signAndSendTransaction, which requires
// a Transaction object. The v0.4.2 mocks accepted ANY argument shape,
// so the defect was invisible to the suite. These tests use STRICT
// mocks that reproduce real Phantom / Wallet Standard behaviour:
//   - PHANTOM-STRICT legacy mock: throws "t.serialize is not a
//     function" on bytes or anything without a callable serialize().
//   - Wallet Standard STRICT mock: the feature throws unless its
//     input is exactly { account, transaction: Uint8Array, chain }.
// v0.4.3 design pinned here:
//   - Wallet Standard provider -> bytes, web3.js NEVER loaded.
//   - Legacy provider -> real Transaction object only; if web3.js
//     cannot be loaded, a typed err.kind === "web3-load-failed" is
//     thrown and the wallet is NEVER invoked.
//   - Loader: unpkg -> jsdelivr mirror (same pinned version) -> one
//     retry of the sequence; null only after all attempts fail.
//   - Discovery: Wallet Standard adapter FIRST, then window.solana,
//     then window.phantom.solana.
//   - CSP: script-src gains the exact host https://cdn.jsdelivr.net.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import {
  buildMemoTransaction,
  submitMemoWithWallet,
  loadSolanaWeb3,
  base58Encode,
  WEB3_JS_CDN_URL,
  WEB3_JS_CDN_URLS,
} from "../src/lib/memo.js";

const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
const MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const BLOCKHASH = "11111111111111111111111111111111";
const SIG = "5abcSignature5abcSignature5abcSignature";

// --- offline fetch stub (getLatestBlockhash only) -------------------------------

function jsonResponse(result, status = 200) {
  return { status, ok: status >= 200 && status < 300, async json() { return { jsonrpc: "2.0", id: 1, result }; } };
}
function blockhashFetch() {
  const original = globalThis.fetch;
  globalThis.fetch = async (endpoint, opts) => {
    const { method } = JSON.parse(opts.body);
    if (method === "getLatestBlockhash") return jsonResponse({ value: { blockhash: BLOCKHASH } });
    throw new Error(`unexpected method ${method}`);
  };
  return { restore: () => { globalThis.fetch = original; } };
}
function withoutSolanaWeb3Global(fn) {
  const had = Object.prototype.hasOwnProperty.call(globalThis, "solanaWeb3");
  const saved = globalThis.solanaWeb3;
  delete globalThis.solanaWeb3;
  return Promise.resolve()
    .then(fn)
    .finally(() => { if (had) globalThis.solanaWeb3 = saved; else delete globalThis.solanaWeb3; });
}

// --- fake web3 whose Transaction is Phantom-shaped (has serialize()) ------------

class FakePublicKey { constructor(v) { this.v = String(v); } toBase58() { return this.v; } }
class FakeInstruction { constructor(o) { Object.assign(this, o); } }
class FakeTransaction {
  constructor(o) { Object.assign(this, o); this.instructions = []; }
  add(ix) { this.instructions.push(ix); return this; }
  serialize() { return new Uint8Array([1, 2, 3]); }
}
const fakeWeb3 = { Transaction: FakeTransaction, PublicKey: FakePublicKey, TransactionInstruction: FakeInstruction };

// --- PHANTOM-STRICT legacy mock ---------------------------------------------------
// Reproduces real Phantom: legacy signAndSendTransaction calls
// transaction.serialize() internally, so bytes (or anything without a
// callable serialize) throw exactly the live error string.
function phantomStrictWallet() {
  const calls = [];
  return {
    calls,
    publicKey: MINT,
    signAndSendTransaction: async (tx) => {
      calls.push(tx);
      if (!tx || typeof tx.serialize !== "function") throw new Error("t.serialize is not a function");
      tx.serialize();
      return SIG;
    },
  };
}

test("v0.4.3 PHANTOM-STRICT (i): web3 injected => submit succeeds and the strict mock received the Transaction object", async () => {
  const { restore } = blockhashFetch();
  const wallet = phantomStrictWallet();
  try {
    const sig = await submitMemoWithWallet({ wallet, memoText: "LG1|mint=x", cluster: "devnet", web3: fakeWeb3 });
    assert.equal(sig, SIG);
    assert.equal(wallet.calls.length, 1);
    assert.ok(wallet.calls[0] instanceof FakeTransaction, "legacy wallet must receive a Transaction object, never bytes");
    assert.equal(typeof wallet.calls[0].serialize, "function");
  } finally { restore(); }
});

test("v0.4.3 PHANTOM-STRICT (ii): web3 load fails => typed web3-load-failed error and the strict mock is NEVER called", async () => {
  const { restore } = blockhashFetch();
  const wallet = phantomStrictWallet();
  try {
    await withoutSolanaWeb3Global(async () => {
      await assert.rejects(
        () => submitMemoWithWallet({ wallet, memoText: "LG1|mint=x", cluster: "devnet", loadWeb3: async () => null }),
        (err) => {
          assert.equal(err.kind, "web3-load-failed");
          assert.match(err.message, /wallet library \(web3\.js\) could not be loaded/i);
          return true;
        },
      );
    });
    assert.equal(wallet.calls.length, 0, "wallet must not be invoked at all when web3.js cannot load");
  } finally { restore(); }
});

test("v0.4.3 PHANTOM-STRICT sanity: the mock itself reproduces the live defect on raw bytes", async () => {
  const wallet = phantomStrictWallet();
  await assert.rejects(() => wallet.signAndSendTransaction(new Uint8Array([9, 9, 9])), /t\.serialize is not a function/);
  assert.equal(wallet.calls.length, 1);
});

// --- Wallet Standard STRICT mock via the SHIPPED adapter -------------------------

const BEGIN = "// ==== LG WALLET DISCOVERY BEGIN (v0.4.2) ====";
const END = "// ==== LG WALLET DISCOVERY END ====";
const beginIdx = html.indexOf(BEGIN);
const endIdx = html.indexOf(END);
assert.ok(beginIdx !== -1 && endIdx > beginIdx, "discovery block markers present in index.html");
const discoverySource = html.slice(beginIdx, endIdx + END.length);
const { lgCreateWalletDiscovery, lgAdaptStandardWallet } = new Function(
  "base58Encode",
  `${discoverySource}\nreturn { lgCreateWalletDiscovery, lgAdaptStandardWallet, lgIsWalletProvider };`,
)(base58Encode);

const STD_ADDRESS = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263";
const STD_SIG_BYTES = new Uint8Array(64).fill(7);
function strictStandardWallet() {
  const account = { address: STD_ADDRESS, publicKey: new Uint8Array(32).fill(3) };
  const calls = [];
  const wallet = {
    version: "1.0.0",
    name: "Strict Standard Wallet",
    chains: ["solana:devnet"],
    accounts: [account],
    features: {
      "standard:connect": { version: "1.0.0", connect: async () => ({ accounts: [account] }) },
      "solana:signAndSendTransaction": {
        version: "1.0.0",
        supportedTransactionVersions: ["legacy"],
        signAndSendTransaction: async (input) => {
          if (!input || typeof input !== "object") throw new Error("WS-STRICT: input must be an object");
          if (input.account !== account) throw new Error("WS-STRICT: input.account mismatch");
          if (!(input.transaction instanceof Uint8Array)) throw new Error("WS-STRICT: input.transaction must be a Uint8Array");
          if (input.chain !== "solana:devnet") throw new Error("WS-STRICT: input.chain must be solana:devnet");
          calls.push(input);
          return [{ signature: STD_SIG_BYTES }];
        },
      },
    },
  };
  return { wallet, account, calls };
}

test("v0.4.3 WS-STRICT: adapted provider succeeds with the CDN unreachable, loader NEVER called, bytes byte-identical to buildMemoTransaction", async () => {
  const { restore } = blockhashFetch();
  const { wallet, calls } = strictStandardWallet();
  const provider = lgAdaptStandardWallet(wallet);
  assert.ok(provider, "standard wallet adapted");
  assert.equal(provider.isWalletStandard, true);
  let loadCalls = 0;
  try {
    const sig = await submitMemoWithWallet({
      wallet: provider,
      memoText: "LG1|mint=x",
      cluster: "devnet",
      loadWeb3: async () => { loadCalls += 1; return null; }, // CDN unreachable
    });
    assert.equal(sig, base58Encode(STD_SIG_BYTES));
    assert.equal(loadCalls, 0, "web3 loader must never be called on the Wallet Standard path");
    assert.equal(calls.length, 1, "the WS feature was called exactly once");
    const expected = buildMemoTransaction({ feePayer: STD_ADDRESS, recentBlockhash: BLOCKHASH, memoText: "LG1|mint=x" });
    assert.deepEqual([...calls[0].transaction], [...expected], "bytes at the WS feature boundary are byte-identical to the hand-rolled builder");
  } finally { restore(); }
});

// --- Discovery preference ----------------------------------------------------------

class FakeWindow {
  constructor() { this.listeners = new Map(); }
  addEventListener(type, fn) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(fn);
  }
  removeEventListener(type, fn) {
    const arr = this.listeners.get(type) ?? [];
    this.listeners.set(type, arr.filter((f) => f !== fn));
  }
  dispatchEvent(event) {
    for (const fn of [...(this.listeners.get(event.type) ?? [])]) fn(event);
    return true;
  }
}

test("v0.4.3 discovery preference: legacy provider AND Wallet Standard both present => the WS adapter wins", () => {
  const win = new FakeWindow();
  const legacy = {
    publicKey: { toBase58: () => MINT, toString: () => MINT },
    isConnected: true,
    connect: async () => ({}),
    signAndSendTransaction: async () => "sig",
  };
  win.solana = legacy;
  win.phantom = { solana: legacy };
  const { wallet } = strictStandardWallet();
  win.addEventListener("wallet-standard:app-ready", (event) => { event.detail.register(wallet); });
  const discovery = lgCreateWalletDiscovery(win);
  discovery.start();
  const provider = discovery.findProvider();
  assert.ok(provider, "a provider is discovered");
  assert.equal(provider.isWalletStandard, true, "Wallet Standard adapter is preferred over legacy layers");
  assert.notEqual(provider, legacy);
  assert.equal(provider.publicKey.toBase58(), STD_ADDRESS);
});

// --- Robust loader ------------------------------------------------------------------

function stubDocument(behavior) {
  const attempted = [];
  const globalObject = {};
  const doc = {
    createElement(tag) { assert.equal(tag, "script"); return {}; },
    head: {
      appendChild(script) {
        attempted.push(script.src);
        behavior(script, globalObject);
      },
    },
  };
  return { doc, attempted, globalObject };
}
async function withDocument(doc, fn) {
  const had = Object.prototype.hasOwnProperty.call(globalThis, "document");
  const saved = globalThis.document;
  globalThis.document = doc;
  try { return await fn(); } finally { if (had) globalThis.document = saved; else delete globalThis.document; }
}

test("v0.4.3 loader: unpkg fails, jsdelivr succeeds => namespace returned, attempt order is [unpkg, jsdelivr]", async () => {
  const FAKE_NS = { Transaction: FakeTransaction, PublicKey: FakePublicKey, TransactionInstruction: FakeInstruction };
  const { doc, attempted, globalObject } = stubDocument((script, g) => {
    if (script.src.includes("cdn.jsdelivr.net")) { g.solanaWeb3 = FAKE_NS; script.onload(); }
    else script.onerror();
  });
  const ns = await withDocument(doc, () => loadSolanaWeb3({ globalObject }));
  assert.equal(ns, FAKE_NS);
  assert.deepEqual(attempted, [WEB3_JS_CDN_URLS[0], WEB3_JS_CDN_URLS[1]]);
  assert.match(attempted[0], /unpkg\.com/);
  assert.match(attempted[1], /cdn\.jsdelivr\.net/);
});

test("v0.4.3 loader: all attempts fail (incl. retry) => resolves null after the full sequence", async () => {
  const { doc, attempted, globalObject } = stubDocument((script) => { script.onerror(); });
  const ns = await withDocument(doc, () => loadSolanaWeb3({ globalObject }));
  assert.equal(ns, null);
  assert.deepEqual(attempted, [WEB3_JS_CDN_URLS[0], WEB3_JS_CDN_URLS[1], WEB3_JS_CDN_URLS[0], WEB3_JS_CDN_URLS[1]]);
});

test("v0.4.3 loader: WEB3_JS_CDN_URLS pins the primary and the same-version jsdelivr mirror", () => {
  assert.equal(WEB3_JS_CDN_URLS[0], WEB3_JS_CDN_URL);
  assert.match(WEB3_JS_CDN_URL, /@solana\/web3\.js@1\.98\.4\//);
  assert.equal(WEB3_JS_CDN_URLS[1], "https://cdn.jsdelivr.net/npm/@solana/web3.js@1.98.4/dist/index.iife.min.js");
});

// --- CSP + page-level pins ------------------------------------------------------------

function cspMeta() {
  const m = html.match(/http-equiv="Content-Security-Policy" content="([^"]+)"/);
  assert.ok(m, "CSP meta present");
  return m[1];
}
function scriptSrcTokens() {
  const directive = cspMeta().split(";").map((s) => s.trim()).find((s) => s.startsWith("script-src "));
  assert.ok(directive, "script-src directive present");
  return directive.split(/\s+/).slice(1);
}

test("v0.4.3 CSP: script-src contains unpkg AND jsdelivr AND the extension schemes, no unsafe-inline, no wildcard", () => {
  const tokens = scriptSrcTokens();
  assert.ok(tokens.includes("https://unpkg.com"), `script-src tokens: ${tokens.join(" ")}`);
  assert.ok(tokens.includes("https://cdn.jsdelivr.net"), `script-src tokens: ${tokens.join(" ")}`);
  assert.ok(tokens.includes("chrome-extension:"));
  assert.ok(tokens.includes("moz-extension:"));
  assert.ok(tokens.includes("'self'"));
  assert.ok(!tokens.includes("'unsafe-inline'"), "script-src must not gain 'unsafe-inline'");
  assert.ok(!tokens.includes("*"), "script-src must not gain a wildcard host");
});

test("v0.4.3 CSP: both inline-script sha256 hashes in the meta match the actual inline script blocks", () => {
  const noComments = html.replace(/<!--[\s\S]*?-->/g, "");
  const blocks = [...noComments.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  assert.equal(blocks.length, 2, "exactly two real inline script blocks (LG-B6 + module)");
  const metaHashes = [...cspMeta().matchAll(/'sha256-([A-Za-z0-9+/=]+)'/g)].map((m) => m[1]);
  assert.equal(metaHashes.length, 2, "exactly two sha256 hashes pinned in the CSP meta");
  for (const block of blocks) {
    const digest = createHash("sha256").update(block, "utf8").digest("base64");
    assert.ok(metaHashes.includes(digest), `inline block hash sha256-${digest} must be pinned in the CSP meta`);
  }
});

test("v0.4.3 errors: the anchor catch shows the specific web3-load-failed text, generic text unchanged for other errors", () => {
  assert.match(html, /e\.kind === "web3-load-failed"/);
  assert.ok(html.includes("The wallet library (web3.js) could not be loaded, so nothing was sent to your wallet."));
  assert.ok(html.includes("Check your connection and try again. The memo text above is unchanged and nothing was broadcast by this page."));
  assert.ok(html.includes("Wallet anchoring failed: ${e.message}. "), "generic error prefix preserved");
});

test("v0.4.3 version: package.json is 0.4.3", () => {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(pkg.version, "0.4.6");
});
