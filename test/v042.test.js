// LaunchGuard v0.4.2 patch tests — wallet detection fix.
//
// Defect (live, 2026-11-27): with Phantom installed + unlocked, the
// anchor panel stayed in DEMO MODE because the page CSP blocked the
// wallet's injected provider script and the detection read only
// window.solana. Three layers are pinned here:
//   1. CSP: script-src admits chrome-extension:/moz-extension:, stays
//      free of 'unsafe-inline'/wildcards, and both inline-script
//      sha256 hashes in the meta still match the shipped blocks.
//   2+3. Discovery: the REAL discovery block is extracted verbatim
//      from index.html (between its BEGIN/END markers) and evaluated,
//      so these tests exercise the shipped code path, not a copy:
//      (a) window.solana, (b) window.phantom.solana only,
//      (c) Wallet Standard registration (both handshake directions)
//      adapted to the provider shape, (d) nothing -> null (demo mode).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { base58Encode } from "../src/lib/memo.js";

const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");

// --- Layer 1: CSP ---------------------------------------------------------------

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

test("v0.4.2 CSP: script-src admits extension schemes for wallet injection, with no unsafe-inline and no wildcard", () => {
  const tokens = scriptSrcTokens();
  assert.ok(tokens.includes("chrome-extension:"), `script-src tokens: ${tokens.join(" ")}`);
  assert.ok(tokens.includes("moz-extension:"), `script-src tokens: ${tokens.join(" ")}`);
  assert.ok(!tokens.includes("'unsafe-inline'"), "script-src must not gain 'unsafe-inline'");
  assert.ok(!tokens.includes("*"), "script-src must not gain a wildcard host");
  // The pre-existing allowlist survives unchanged alongside the schemes.
  assert.ok(tokens.includes("'self'"));
  assert.ok(tokens.includes("https://unpkg.com"));
});

test("v0.4.2 CSP: both inline-script sha256 hashes in the meta match the actual inline script blocks", () => {
  // Strip HTML comments first: the commented-out LAUNCHGUARD_CONFIG
  // example contains a <script> tag that is not a real script block.
  const noComments = html.replace(/<!--[\s\S]*?-->/g, "");
  const blocks = [...noComments.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  assert.equal(blocks.length, 2, "exactly two real inline script blocks (LG-B6 + module)");
  const meta = cspMeta();
  const metaHashes = [...meta.matchAll(/'sha256-([A-Za-z0-9+/=]+)'/g)].map((m) => m[1]);
  assert.equal(metaHashes.length, 2, "exactly two sha256 hashes pinned in the CSP meta");
  for (const block of blocks) {
    const digest = createHash("sha256").update(block, "utf8").digest("base64");
    assert.ok(metaHashes.includes(digest), `inline block hash sha256-${digest} must be pinned in the CSP meta`);
  }
});

// --- Layers 2+3: discovery, extracted verbatim from the shipped page -------------

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

test("v0.4.2 wiring: the anchor section looks its wallet up through the discovery registry", () => {
  assert.match(html, /lgWalletDiscovery\.findProvider\(\)/);
  assert.ok(!html.includes("const wallet = globalThis.solana;"), "the v0.4.1 window.solana-only lookup is gone");
});

// Minimal window-like event target: just enough of the EventTarget
// surface the discovery block uses (addEventListener/dispatchEvent),
// plus whatever provider globals a case installs on it.
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

function legacyProvider(label) {
  return {
    label,
    publicKey: { toBase58: () => "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", toString: () => "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v" },
    isConnected: true,
    connect: async () => ({}),
    signAndSendTransaction: async () => "sig",
  };
}

test("v0.4.2 discovery (a): window.solana present -> used, unchanged from v0.4.1", () => {
  const win = new FakeWindow();
  const provider = legacyProvider("solana");
  win.solana = provider;
  const discovery = lgCreateWalletDiscovery(win);
  discovery.start();
  assert.equal(discovery.findProvider(), provider);
});

test("v0.4.2 discovery (b): ONLY window.phantom.solana present -> used (the live defect case)", () => {
  const win = new FakeWindow();
  const provider = legacyProvider("phantom-namespaced");
  win.phantom = { solana: provider };
  assert.equal(win.solana, undefined);
  const discovery = lgCreateWalletDiscovery(win);
  discovery.start();
  assert.equal(discovery.findProvider(), provider);
});

test("v0.4.2 discovery: a window.phantom.solana without signAndSendTransaction is not a provider", () => {
  const win = new FakeWindow();
  win.phantom = { solana: { isPhantom: true } };
  const discovery = lgCreateWalletDiscovery(win);
  discovery.start();
  assert.equal(discovery.findProvider(), null);
});

// A Wallet Standard wallet double: one account, a standard:connect
// feature, and a solana:signAndSendTransaction feature that records
// its inputs and returns a fixed signature.
const STD_ADDRESS = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263";
const STD_SIG_BYTES = new Uint8Array(64).fill(7);
function standardWallet() {
  const account = { address: STD_ADDRESS, publicKey: new Uint8Array(32).fill(3) };
  const calls = [];
  const wallet = {
    version: "1.0.0",
    name: "Mock Standard Wallet",
    chains: ["solana:devnet"],
    accounts: [account],
    features: {
      "standard:connect": { version: "1.0.0", connect: async () => ({ accounts: [account] }) },
      "solana:signAndSendTransaction": {
        version: "1.0.0",
        supportedTransactionVersions: ["legacy"],
        signAndSendTransaction: async (input) => { calls.push(input); return [{ signature: STD_SIG_BYTES }]; },
      },
    },
  };
  return { wallet, account, calls };
}

test("v0.4.2 discovery (c): Wallet Standard wallet registering via wallet-standard:app-ready is adapted and used", async () => {
  const win = new FakeWindow();
  const { wallet, account, calls } = standardWallet();
  // The wallet's side of the handshake: it listens for app-ready and
  // registers itself with the API object the event carries.
  win.addEventListener("wallet-standard:app-ready", (event) => { event.detail.register(wallet); });
  const discovery = lgCreateWalletDiscovery(win);
  discovery.start();

  const provider = discovery.findProvider();
  assert.ok(provider, "a provider is discovered");
  assert.equal(provider.isWalletStandard, true);
  assert.equal(typeof provider.signAndSendTransaction, "function");
  assert.equal(provider.isConnected, true);
  // publicKey in the shape memo.js walletPublicKeyBase58 consumes.
  assert.equal(provider.publicKey.toBase58(), STD_ADDRESS);

  // The adapter serializes the web3.js-shaped transaction the anchor
  // flow builds and calls the standard feature with {account,
  // transaction, chain}; the returned signature bytes come back as
  // the base58 string the existing flow expects.
  const txBytes = new Uint8Array([9, 8, 7]);
  const fakeTx = { serialize: (opts) => { assert.equal(opts.requireAllSignatures, false); return txBytes; } };
  const signature = await provider.signAndSendTransaction(fakeTx);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].account, account);
  assert.deepEqual(calls[0].transaction, txBytes);
  assert.equal(calls[0].chain, "solana:devnet");
  assert.equal(signature, base58Encode(STD_SIG_BYTES));

  // Raw serialized bytes (the no-web3 fallback shape) pass through too.
  const signature2 = await provider.signAndSendTransaction(txBytes);
  assert.deepEqual(calls[1].transaction, txBytes);
  assert.equal(signature2, base58Encode(STD_SIG_BYTES));
});

test("v0.4.2 discovery (c2): Wallet Standard wallet announcing via wallet-standard:register-wallet is adapted and used", () => {
  const win = new FakeWindow();
  const { wallet } = standardWallet();
  const discovery = lgCreateWalletDiscovery(win);
  discovery.start();
  // The wallet's other handshake direction: it dispatches an event
  // whose detail is a callback the app must invoke with its API.
  win.dispatchEvent(new CustomEvent("wallet-standard:register-wallet", {
    detail: (api) => { api.register(wallet); },
  }));
  const provider = discovery.findProvider();
  assert.ok(provider, "a provider is discovered");
  assert.equal(provider.isWalletStandard, true);
  assert.equal(provider.publicKey.toBase58(), STD_ADDRESS);
});

test("v0.4.2 discovery: a standard wallet without the signAndSendTransaction feature is not adapted", () => {
  const { wallet } = standardWallet();
  delete wallet.features["solana:signAndSendTransaction"];
  assert.equal(lgAdaptStandardWallet(wallet), null);
  const win = new FakeWindow();
  win.addEventListener("wallet-standard:app-ready", (event) => { event.detail.register(wallet); });
  const discovery = lgCreateWalletDiscovery(win);
  discovery.start();
  assert.equal(discovery.findProvider(), null);
});

test("v0.4.2 discovery: adapter connect() runs standard:connect and exposes the connected account", async () => {
  const { wallet, account } = standardWallet();
  wallet.accounts = []; // not connected yet: no accounts until connect
  const provider = lgAdaptStandardWallet(wallet);
  assert.ok(provider);
  assert.equal(provider.isConnected, false);
  assert.equal(provider.publicKey, null);
  await provider.connect();
  assert.equal(provider.isConnected, true);
  assert.equal(provider.publicKey.toBase58(), account.address);
});

test("v0.4.2 discovery (d): nothing present -> null, so the anchor panel takes the DEMO MODE path", () => {
  const win = new FakeWindow();
  const discovery = lgCreateWalletDiscovery(win);
  discovery.start();
  assert.equal(discovery.findProvider(), null);
  // The DEMO MODE honesty path itself is untouched: it still comes
  // from memo.js anchorReportDemoMode with its explicit explanation.
  assert.match(html, /anchorReportDemoMode\(/);
});
