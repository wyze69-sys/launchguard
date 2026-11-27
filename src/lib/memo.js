// LaunchGuard on-chain anchor — Solana Memo program, dependency-free.
//
// A finished risk report is anchored by putting its summary text into a
// Solana Memo transaction (devnet by default). Anyone can later open that
// transaction on a block explorer and read the exact memo text, the mint it
// refers to, its score/band, and the transaction's on-chain timestamp.
// That is what "verify a report" means here: the memo proves that a
// report with this exact digest existed on-chain by that time, signed
// and submitted by the wallet that anchored it. There is no LaunchGuard
// project key in this flow, so the memo does not prove LaunchGuard
// authored the report, and it does not prove the score was correct —
// the scoring rules in risk.js are public for that.
//
// This module builds legacy transactions BY HAND (no @solana/web3.js), so
// the static demo page keeps working with zero dependencies and no build
// step. Transactions built here are UNSIGNED: the signature section is
// zero-filled placeholders and the user's wallet must sign before anything
// can be broadcast.

import { getRpcEndpoint, RPC_TIMEOUT_MS } from "./config.js";

export { RPC_TIMEOUT_MS };

/** Solana Memo program id (base58). The memo program takes no accounts. */
export const MEMO_PROGRAM_ID = "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr";

/** Memo payload limit in BYTES (UTF-8). FIX 5: bytes, not characters. */
export const MEMO_MAX_LENGTH = 566;

/** Version marker prefixed to every anchored report memo. */
export const MEMO_VERSION = "LG1";

// ---------------------------------------------------------------------------
// Base58 (pure JS, Bitcoin/Solana alphabet)
// ---------------------------------------------------------------------------

const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const BASE58_INDEX = new Map([...BASE58_ALPHABET].map((ch, i) => [ch, i]));

/** Encode bytes to a base58 string. */
export function base58Encode(bytes) {
  const input = bytes instanceof Uint8Array ? bytes : Uint8Array.from(bytes);
  if (input.length === 0) return "";
  let leadingZeros = 0;
  while (leadingZeros < input.length && input[leadingZeros] === 0) leadingZeros++;

  // Convert to base58 digits (little-endian scratch array).
  const digits = [0];
  for (let i = leadingZeros; i < input.length; i++) {
    let carry = input[i];
    for (let j = 0; j < digits.length; j++) {
      carry += digits[j] << 8;
      digits[j] = carry % 58;
      carry = Math.floor(carry / 58);
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = Math.floor(carry / 58);
    }
  }
  let out = "1".repeat(leadingZeros);
  for (let i = digits.length - 1; i >= 0; i--) out += BASE58_ALPHABET[digits[i]];
  // All-zero input: digits is [0], which would add a spurious "1".
  if (input.every((b) => b === 0)) return "1".repeat(input.length);
  return out;
}

/** Decode a base58 string to bytes. Throws on invalid characters. */
export function base58Decode(text) {
  if (typeof text !== "string") {
    throw new Error("base58Decode: expected a string");
  }
  // FIX 12: empty input decodes to empty bytes, symmetric with
  // base58Encode of an empty input returning "".
  if (text.length === 0) return new Uint8Array(0);
  let leadingZeros = 0;
  while (leadingZeros < text.length && text[leadingZeros] === "1") leadingZeros++;

  const bytes = [0];
  for (let i = leadingZeros; i < text.length; i++) {
    const value = BASE58_INDEX.get(text[i]);
    if (value === undefined) throw new Error(`base58Decode: invalid character "${text[i]}"`);
    let carry = value;
    for (let j = 0; j < bytes.length; j++) {
      carry += bytes[j] * 58;
      bytes[j] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }
  const body = text.length === leadingZeros ? [] : [...bytes].reverse();
  const out = new Uint8Array(leadingZeros + body.length);
  out.set(body, leadingZeros);
  // FIX 12: the former special case here (body === [0] with no leading
  // "1"s) was unreachable: body is [0] only when no non-"1" character was
  // processed, in which case body is [] above. Traced and removed.
  return out;
}

/** The memo program id as raw 32 bytes. */
export const MEMO_PROGRAM_ID_BYTES = base58Decode(MEMO_PROGRAM_ID);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function to32Bytes(value, label) {
  const bytes = typeof value === "string" ? base58Decode(value) : value instanceof Uint8Array ? value : null;
  if (!bytes || bytes.length !== 32) {
    throw new Error(`${label} must be a base58 string or Uint8Array of exactly 32 bytes`);
  }
  return bytes;
}

// Solana "shortvec" (compact-u16) length encoding.
function encodeShortvecLength(len) {
  const out = [];
  let remaining = len;
  for (;;) {
    let byte = remaining & 0x7f;
    remaining >>= 7;
    if (remaining === 0) {
      out.push(byte);
      break;
    }
    byte |= 0x80;
    out.push(byte);
  }
  return Uint8Array.from(out);
}

function concatBytes(parts) {
  const total = parts.reduce((sum, p) => sum + p.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/** Serialize transaction bytes to base64 (browser + Node, no dependencies). */
export function serializeTransactionBase64(txBytes) {
  const bytes = txBytes instanceof Uint8Array ? txBytes : Uint8Array.from(txBytes);
  if (typeof Buffer !== "undefined") {
    return Buffer.from(bytes).toString("base64");
  }
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

// ---------------------------------------------------------------------------
// Memo instruction + hand-built legacy transaction
// ---------------------------------------------------------------------------

/**
 * Build a Memo program instruction.
 * The memo program takes NO accounts and the instruction itself requires
 * no signer — the memo text is simply the instruction data (UTF-8 bytes).
 * @param {string} memoText
 * @returns {{programId: string, keys: Array, data: Uint8Array}}
 */
export function buildMemoInstruction(memoText) {
  return {
    programId: MEMO_PROGRAM_ID,
    keys: [],
    data: new TextEncoder().encode(String(memoText)),
  };
}

/**
 * Build a serialized, UNSIGNED legacy Solana transaction containing a
 * single memo instruction.
 *
 * Layout:
 *   signatures:  shortvec count (1) + 64 zero bytes (placeholder —
 *                the wallet replaces this with a real signature)
 *   message header: [1 required signature, 0 readonly signed,
 *                    1 readonly unsigned (the memo program)]
 *   account keys:  [feePayer, memoProgram]
 *   recent blockhash: 32 bytes
 *   instructions:  one compiled instruction pointing at account index 1
 *                  (the memo program), no account indices, memo data.
 *
 * @param {{feePayer: string|Uint8Array, recentBlockhash: string|Uint8Array, memoText: string}} args
 *   feePayer / recentBlockhash may be base58 strings or 32-byte arrays.
 * @returns {Uint8Array} serialized transaction bytes (unsigned)
 */
export function buildMemoTransaction({ feePayer, recentBlockhash, memoText }) {
  const feePayerBytes = to32Bytes(feePayer, "feePayer");
  const blockhashBytes = to32Bytes(recentBlockhash, "recentBlockhash");
  const instruction = buildMemoInstruction(memoText);
  // FIX 5: the memo cap is in BYTES (UTF-8), not characters.
  if (instruction.data.length > MEMO_MAX_LENGTH) {
    throw new Error(`Memo is ${instruction.data.length} bytes, exceeding the ${MEMO_MAX_LENGTH}-byte limit`);
  }

  const message = concatBytes([
    // Header: 1 required sig, 0 readonly signed, 1 readonly unsigned.
    Uint8Array.from([1, 0, 1]),
    encodeShortvecLength(2), // account key count
    feePayerBytes,
    MEMO_PROGRAM_ID_BYTES,
    blockhashBytes,
    encodeShortvecLength(1), // instruction count
    Uint8Array.from([1]), // programIdIndex -> account key 1 (memo program)
    encodeShortvecLength(0), // no instruction accounts
    encodeShortvecLength(instruction.data.length),
    instruction.data,
  ]);

  return concatBytes([
    encodeShortvecLength(1), // signature count
    new Uint8Array(64), // zero-filled placeholder signature — wallet signs it
    message,
  ]);
}

// ---------------------------------------------------------------------------
// Report memo text
// ---------------------------------------------------------------------------

/**
 * Build the memo text anchored on-chain for a report.
 *
 * Format (single line, pipe-separated, versioned):
 *   LG1|mint=<address>|score=<n>/100|band=<band>|ts=<ISO timestamp>[|h=<sha256 hex>][|conf=<level>]|<summary>
 *
 * The `h=` field carries the report digest (see report.js): anyone with
 * the report JSON can recompute it and compare against this anchored
 * value. Under the 566-byte cap, fields are sacrificed in this order:
 * `conf=` is dropped FIRST; only then is the trailing summary detail
 * truncated. `mint=`, `score=`, `band=`, `ts=` and `h=` are never dropped.
 * To keep that guarantee for ANY input, the two free-text prefix fields
 * are length-bounded when the memo is built (`ts=` to 40 chars, `band=`
 * to 32 chars), so the mandatory prefix always fits far under the cap.
 *
 * @param {string} mintAddress
 * @param {string|{score:number, band:string, flags?:Array}} summary
 *   Either the human summary string from risk.js summarize() (score/band
 *   are parsed out of it) or a scoreMint() result object.
 * @param {{timestamp?: string|Date, digest?: string, confidence?: string}} [options]
 *   Injectable timestamp for tests; optional report digest (64 hex chars)
 *   and confidence level ("high"|"medium"|"low") from report.js.
 * @returns {string} memo text, at most MEMO_MAX_LENGTH bytes (UTF-8).
 */
// LG-F1: every value interpolated into the pipe-separated memo is
// delimiter-sanitised: "|" and "=" (and line breaks) can never survive
// into a field value, so a crafted band/mint/confidence/summary cannot
// inject extra memo fields (such as a fake h= digest) that
// parseMemoFields would accept.
export function sanitizeMemoField(value) {
  return String(value).replace(/[|=\r\n]+/g, " ").trim();
}

const BASE58_ADDRESS_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export function buildReportMemo(mintAddress, summary, options = {}) {
  // FIX 5 + LG-F1: validate the mint address shape before embedding it —
  // length AND the base58 charset, so the mint field itself cannot
  // carry delimiter characters into the memo.
  if (
    typeof mintAddress !== "string" ||
    mintAddress.length < 32 ||
    mintAddress.length > 44 ||
    !BASE58_ADDRESS_RE.test(mintAddress)
  ) {
    throw new Error("buildReportMemo: mintAddress must be a string of length 32-44 and valid base58");
  }
  const tsRaw = options.timestamp ?? new Date();
  // Bound the free-text prefix fields so the 566-byte guarantee holds for
  // ANY input (a 1,000-char ts=/band= must not push h= out of the memo).
  // ISO timestamps are 24 chars and real bands are <= 10, so these caps
  // never bite legitimate values.
  const timestamp = sanitizeMemoField(tsRaw instanceof Date ? tsRaw.toISOString() : String(tsRaw)).slice(0, 40);

  let score = null;
  let band = null;
  let detail = "";
  if (summary && typeof summary === "object") {
    score = summary.score;
    band = typeof summary.band === "string" ? sanitizeMemoField(summary.band).slice(0, 32) : summary.band;
    detail = Array.isArray(summary.flags) && summary.flags.length
      ? `flags=${summary.flags.slice(0, 2).map((f) => sanitizeMemoField(f.key)).join(",")}`
      : "flags=none";
  } else if (typeof summary === "string") {
    detail = sanitizeMemoField(summary);
    const scoreMatch = summary.match(/score=(\d+)\/100/);
    if (scoreMatch) score = Number(scoreMatch[1]);
    const bandMatch = summary.match(/band=([A-Z][A-Z ]*?)(?:\s+flags=|\s*$)/);
    if (bandMatch) band = sanitizeMemoField(bandMatch[1]).slice(0, 32);
  }

  const parts = [`${MEMO_VERSION}|mint=${mintAddress}`];
  if (score !== null && score !== undefined) parts.push(`score=${score}/100`);
  if (band) parts.push(`band=${band}`);
  parts.push(`ts=${timestamp}`);
  // The digest is a mandatory field once supplied: it joins the prefix
  // that is never truncated.
  if (typeof options.digest === "string" && /^[0-9a-fA-F]{64}$/.test(options.digest)) {
    parts.push(`h=${options.digest.toLowerCase()}`);
  }
  // FIX 5: cap at MEMO_MAX_LENGTH BYTES. The structured prefix is never
  // truncated; only the trailing detail segment is cut, on a UTF-8 byte
  // boundary so no multi-byte character is split.
  const encoder = new TextEncoder();
  const byteLen = (s) => encoder.encode(s).length;
  const prefix = parts.join("|");
  // Optional confidence segment: kept only when EVERYTHING fits without
  // truncation. Under cap pressure it is dropped FIRST (before the detail
  // segment loses a single byte), per the field-priority rule above.
  const confSegment =
    typeof options.confidence === "string" && options.confidence.length > 0
      ? `|conf=${sanitizeMemoField(options.confidence)}`
      : "";
  if (!detail) {
    return byteLen(prefix + confSegment) <= MEMO_MAX_LENGTH ? prefix + confSegment : prefix;
  }
  const withConf = `${prefix}${confSegment}|${detail}`;
  if (byteLen(withConf) <= MEMO_MAX_LENGTH) return withConf;
  const barePrefix = `${prefix}|`;
  const budget = Math.max(0, MEMO_MAX_LENGTH - byteLen(barePrefix));
  return barePrefix + truncateUtf8(detail, budget);
}

// Truncate a string to at most maxBytes of UTF-8 without splitting a
// multi-byte character (decode-safe: back off until decoding succeeds).
function truncateUtf8(str, maxBytes) {
  const encoder = new TextEncoder();
  const encoded = encoder.encode(str);
  if (encoded.length <= maxBytes) return str;
  let sliced = encoded.slice(0, maxBytes);
  while (sliced.length > 0) {
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(sliced);
    } catch {
      sliced = sliced.slice(0, sliced.length - 1);
    }
  }
  return "";
}

// ---------------------------------------------------------------------------
// Explorer link, wallet submission, demo mode
// ---------------------------------------------------------------------------

/** Solana Explorer URL for a transaction signature, or null if the
 *  signature is not a plausible base58 signature (FIX 7: never let an
 *  attacker-shaped string such as "x?cluster=mainnet" become a link). */
export function explorerUrlForSignature(signature, cluster = "devnet") {
  if (typeof signature !== "string" || !/^[1-9A-HJ-NP-Za-km-z]{32,128}$/.test(signature)) return null;
  // LG-F2: the cluster is allowlisted, never interpolated raw — an
  // unlisted value falls back to the devnet form instead of becoming
  // query/fragment injection on the explorer link.
  if (cluster === "mainnet-beta") return `https://explorer.solana.com/tx/${signature}`;
  const safeCluster = cluster === "testnet" ? "testnet" : "devnet";
  return `https://explorer.solana.com/tx/${signature}?cluster=${safeCluster}`;
}

async function rpcCall(endpoint, method, params, attempt = 0, timeoutMs = RPC_TIMEOUT_MS) {
  // LG-B3: per-call timeout, raced against the fetch so a stubbed or
  // real fetch that never settles still produces a typed timeout error
  // instead of hanging the anchor flow forever.
  const controller = new AbortController();
  let timer = null;
  let res;
  try {
    const guard = new Promise((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new Error(`RPC ${method} timed out after ${timeoutMs} ms`));
      }, timeoutMs);
    });
    res = await Promise.race([
      fetch(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
        signal: controller.signal,
      }),
      guard,
    ]);
  } catch (cause) {
    if (cause instanceof Error && /timed out/.test(cause.message)) throw cause;
    if (cause?.name === "AbortError") throw new Error(`RPC ${method} timed out after ${timeoutMs} ms`);
    throw new Error(`RPC ${method} failed: network unreachable (${cause.message})`);
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
  // FIX 11: same 429 backoff as solana.js (retry up to 2 times, 2s then 5s).
  if (res.status === 429 && attempt < 2) {
    await new Promise((r) => setTimeout(r, attempt === 0 ? 2000 : 5000));
    return rpcCall(endpoint, method, params, attempt + 1, timeoutMs);
  }
  if (!res.ok) throw new Error(`RPC ${method} failed: HTTP ${res.status}`);
  let body;
  try {
    body = await res.json();
  } catch {
    // FIX 11: wrap parse failures instead of leaking a raw SyntaxError.
    throw new Error(`RPC ${method} returned a non-JSON response`);
  }
  if (!body || typeof body !== "object") throw new Error(`RPC ${method} returned a malformed response`);
  if (body.error) {
    const detail =
      typeof body.error.message === "string" && body.error.message
        ? body.error.message
        : body.error.code !== undefined
          ? `error code ${body.error.code}`
          : "unknown RPC error";
    throw new Error(`RPC ${method} failed: ${detail}`);
  }
  if (!("result" in body)) throw new Error(`RPC ${method} failed: response is missing its result field`);
  return body.result;
}

function walletPublicKeyBase58(wallet) {
  const pk = wallet?.publicKey;
  if (!pk) throw new Error("Wallet is connected but exposes no publicKey");
  if (typeof pk === "string") return pk;
  if (typeof pk.toBase58 === "function") return pk.toBase58();
  if (pk instanceof Uint8Array) return base58Encode(pk);
  return String(pk);
}

/** Pinned @solana/web3.js build used ONLY for the wallet path (LG-B7). */
export const WEB3_JS_VERSION = "1.98.4";
export const WEB3_JS_CDN_URL = `https://unpkg.com/@solana/web3.js@${WEB3_JS_VERSION}/dist/index.iife.min.js`;
/** Pinned jsdelivr mirror of the SAME web3.js version (v0.4.3): the
 *  legacy-wallet path needs a real Transaction object, so the loader
 *  falls back to this mirror when the primary CDN cannot be reached. */
export const WEB3_JS_CDN_URL_JSDELIVR = `https://cdn.jsdelivr.net/npm/@solana/web3.js@${WEB3_JS_VERSION}/dist/index.iife.min.js`;
/** Ordered loader attempt list: primary first, mirror second. */
export const WEB3_JS_CDN_URLS = [WEB3_JS_CDN_URL, WEB3_JS_CDN_URL_JSDELIVR];

/**
 * Build a real web3.js Transaction for the memo, from exactly the same
 * instruction bytes the hand-rolled builder produces. The web3 namespace
 * is dependency-injected so this is unit-testable offline with a fake
 * Transaction class, and so the shipped product stays dependency-free:
 * the library itself is lazy-loaded from the pinned CDN build only when
 * a wallet anchor is attempted in a browser.
 */
export function buildMemoTransactionObject({ feePayer, recentBlockhash, memoText, web3 }) {
  if (!web3 || typeof web3.Transaction !== "function" || typeof web3.PublicKey !== "function" || typeof web3.TransactionInstruction !== "function") {
    throw new Error("buildMemoTransactionObject: a web3 namespace with Transaction/PublicKey/TransactionInstruction is required");
  }
  const instruction = buildMemoInstruction(memoText);
  if (instruction.data.length > MEMO_MAX_LENGTH) {
    throw new Error(`Memo is ${instruction.data.length} bytes, exceeding the ${MEMO_MAX_LENGTH}-byte limit`);
  }
  const data = typeof Buffer !== "undefined" ? Buffer.from(instruction.data) : instruction.data;
  const tx = new web3.Transaction({
    feePayer: new web3.PublicKey(feePayer),
    recentBlockhash,
  });
  tx.add(
    new web3.TransactionInstruction({
      keys: [],
      programId: new web3.PublicKey(MEMO_PROGRAM_ID),
      data,
    }),
  );
  return tx;
}

/**
 * Lazy-load the pinned web3.js build (browser only). Resolves to the
 * `solanaWeb3` global, or null when loading is impossible (Node, no
 * document, blocked CDNs, offline). Attempt order (v0.4.3): the pinned
 * unpkg URL, then the pinned jsdelivr mirror of the same version, then
 * one retry of the whole sequence; null is resolved only after every
 * attempt has failed. Never called on page load or in demo mode, and
 * never called at all for Wallet Standard providers (their path is
 * bytes-native). The { url, urls, globalObject } parameters are the
 * test-injection surface: a single `url` narrows the sequence to that
 * one URL; `urls` replaces the sequence outright.
 */
export async function loadSolanaWeb3({ url, urls, globalObject = globalThis } = {}) {
  if (globalObject.solanaWeb3) return globalObject.solanaWeb3;
  if (typeof document === "undefined" || typeof document.createElement !== "function") return null;
  const sequence = Array.isArray(urls) && urls.length ? [...urls] : url ? [url] : [...WEB3_JS_CDN_URLS];
  const loadOne = (candidate) =>
    new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = candidate;
      script.async = true;
      script.onload = () => resolve();
      script.onerror = () => reject(new Error("web3.js failed to load"));
      (document.head || document.body || document.documentElement).appendChild(script);
    });
  // Two passes over the sequence (initial attempt + one retry).
  for (let pass = 0; pass < 2; pass++) {
    for (const candidate of sequence) {
      try {
        await loadOne(candidate);
      } catch {
        continue; // try the next mirror, then the retry pass
      }
      if (globalObject.solanaWeb3) return globalObject.solanaWeb3;
    }
  }
  return globalObject.solanaWeb3 ?? null;
}

function isUserRejection(err) {
  if (!err) return false;
  if (err.code === 4001) return true;
  return /reject|denied|user cancelled|user canceled/i.test(String(err.message ?? err));
}

function isRetryableSubmissionError(err) {
  if (!err || isUserRejection(err)) return false;
  return /blockhash|expir|too old|block height|not processed|node is behind/i.test(String(err.message ?? err));
}

/**
 * Browser path: anchor a memo via a connected wallet.
 *
 * Fetches the latest blockhash, then submits through the wallet. The
 * shape handed to the wallet is routed by provider kind (v0.4.3):
 *   - Wallet Standard adapter (`wallet.isWalletStandard === true`):
 *     the hand-rolled serialized BYTES are passed — the Wallet
 *     Standard feature is bytes-native — and web3.js is never loaded
 *     on this path.
 *   - Legacy provider (anything else): ONLY a real web3.js Transaction
 *     object may be passed (LG-B7) — Phantom's legacy
 *     `signAndSendTransaction` calls `transaction.serialize()` and
 *     throws "t.serialize is not a function" on raw bytes. web3.js is
 *     taken from the injected namespace or lazily loaded from the
 *     pinned CDN builds; if it still cannot be loaded, a typed error
 *     (`err.kind === "web3-load-failed"`) is thrown and the wallet is
 *     NEVER invoked.
 *
 * Retry policy (LG-F12): a submission is retried ONCE with a fresh
 * blockhash only for blockhash/expiry-class errors. A user rejection is
 * never retried (the user said no), and nothing is ever retried after a
 * signature has been obtained.
 *
 * @param {{wallet: object, memoText: string, cluster?: string,
 *          web3?: object, loadWeb3?: Function, timeoutMs?: number}} args
 * @returns {Promise<string>} the transaction signature (base58)
 */
export async function submitMemoWithWallet({ wallet, memoText, cluster = "devnet", web3, loadWeb3, timeoutMs }) {
  if (!wallet || typeof wallet.signAndSendTransaction !== "function") {
    throw new Error("No wallet with signAndSendTransaction is available");
  }
  const endpoint = getRpcEndpoint(cluster);
  const feePayer = walletPublicKeyBase58(wallet);

  // Shape routing (v0.4.3): Wallet Standard providers are bytes-native
  // and must not trigger a web3.js load at all. Legacy providers get a
  // real Transaction object or a typed failure — never raw bytes.
  const isWalletStandard = wallet.isWalletStandard === true;
  let web3ns = null;
  if (!isWalletStandard) {
    web3ns = web3 ?? globalThis.solanaWeb3 ?? null;
    if (!web3ns) {
      try {
        web3ns = loadWeb3 ? await loadWeb3() : await loadSolanaWeb3();
      } catch {
        web3ns = null;
      }
    }
    if (!web3ns) {
      const err = new Error(
        "The wallet library (web3.js) could not be loaded, so the transaction could not be prepared for your wallet.",
      );
      err.kind = "web3-load-failed";
      throw err;
    }
  }

  const fetchBlockhash = async () => {
    const latest = await rpcCall(endpoint, "getLatestBlockhash", [{ commitment: "confirmed" }], 0, timeoutMs ?? RPC_TIMEOUT_MS);
    const blockhash = latest?.value?.blockhash;
    if (!blockhash) throw new Error("RPC did not return a recent blockhash");
    return blockhash;
  };

  const attemptOnce = async () => {
    const recentBlockhash = await fetchBlockhash();
    if (isWalletStandard) {
      const txBytes = buildMemoTransaction({ feePayer, recentBlockhash, memoText });
      return wallet.signAndSendTransaction(txBytes);
    }
    const txObject = buildMemoTransactionObject({ feePayer, recentBlockhash, memoText, web3: web3ns });
    return wallet.signAndSendTransaction(txObject);
  };

  let result;
  try {
    result = await attemptOnce();
  } catch (firstError) {
    if (!isRetryableSubmissionError(firstError)) throw firstError;
    result = await attemptOnce();
  }
  // Wallets return either a signature string, { signature }, or raw bytes.
  if (typeof result === "string") return result;
  if (result && typeof result.signature === "string") return result.signature;
  if (result instanceof Uint8Array) return base58Encode(result);
  throw new Error("Wallet did not return a transaction signature");
}

/**
 * DEMO mode — for when no wallet is connected.
 *
 * Builds the exact memo text and the unsigned transaction (with a
 * placeholder fee payer — the mint address itself — and a zero blockhash)
 * so a judge/user can inspect precisely what WOULD be anchored.
 * NOTHING is broadcast, signed, or sent. The returned object says so
 * explicitly (`broadcast: false`) and the explanation is human-readable.
 *
 * @param {{mintAddress: string, summary: string|object,
 *          digest?: string, confidence?: string, timestamp?: string|Date}} args
 *   digest/confidence/timestamp are passed through to buildReportMemo
 *   (see report.js). Callers anchoring a scored report pass the report's
 *   observedAt as the timestamp, so the memo's ts= equals the timestamp
 *   inside the hashed report instead of being a second, unhashed clock.
 * @returns {{demo: true, broadcast: false, sent: false, memoText: string,
 *            unsignedTransactionBase64: string, unsignedTransaction: string,
 *            explanation: string}}
 */
export function anchorReportDemoMode({ mintAddress, summary, digest, confidence, timestamp }) {
  const memoText = buildReportMemo(mintAddress, summary, { digest, confidence, timestamp });
  // Placeholder fee payer (the mint's own bytes) + zero blockhash: the tx
  // is well-formed in shape but cannot be broadcast as-is — a real wallet
  // supplies its own fee payer, a fresh blockhash, and the signature.
  const txBytes = buildMemoTransaction({
    feePayer: mintAddress,
    recentBlockhash: new Uint8Array(32),
    memoText,
  });
  const unsignedTransactionBase64 = serializeTransactionBase64(txBytes);
  return {
    demo: true,
    broadcast: false,
    sent: false,
    memoText,
    unsignedTransactionBase64,
    unsignedTransaction: unsignedTransactionBase64,
    explanation:
      "DEMO MODE: no wallet is connected, so nothing was signed and nothing was broadcast to Solana. " +
      "Above is the exact memo text and the unsigned transaction that a connected wallet would sign and send on devnet. " +
      "Connect a wallet (for example Phantom, set to devnet) and use the anchor button to broadcast it for real.",
  };
}
