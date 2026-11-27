// LaunchGuard Solana data layer.
// Browser/Node compatible: uses plain JSON-RPC over fetch, no SDK dependency,
// so the demo never breaks on wallet-adapter or bundler issues.
// Facts are assembled here; all judgement lives in risk.js.
// RPC endpoints are resolved by config.js (global override -> env var ->
// public fallback). See config.js for how to add a Helius key.

import { getRpcEndpoint, RPC_TIMEOUT_MS } from "./config.js";
import { base58Encode } from "./memo.js";

export { RPC_TIMEOUT_MS };

// The memo builder lives in memo.js; re-exported here so existing imports
// (`import { buildReportMemo } from "./solana.js"`) keep working.
export { buildReportMemo } from "./memo.js";

/** Error kinds the UI can distinguish: "rate-limited" | "unreachable" | "rpc" | "timeout" */
export class RpcError extends Error {
  constructor(message, kind, status) {
    super(message);
    this.name = "RpcError";
    this.kind = kind;
    this.status = status;
  }
}

function abortableDelay(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new RpcError("RPC call aborted", "aborted"));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener?.("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new RpcError("RPC call aborted", "aborted"));
    };
    signal?.addEventListener?.("abort", onAbort, { once: true });
  });
}

async function rpc(endpoint, method, params, attempt = 0, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? RPC_TIMEOUT_MS;
  const externalSignal = opts.signal ?? null;
  if (externalSignal?.aborted) throw new RpcError(`RPC ${method} aborted`, "aborted");
  const controller = new AbortController();
  const onExternalAbort = () => controller.abort();
  externalSignal?.addEventListener?.("abort", onExternalAbort, { once: true });
  let timer = null;
  let res;
  try {
    const guard = new Promise((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new RpcError(`RPC ${method} timed out after ${timeoutMs} ms`, "timeout"));
      }, timeoutMs);
      externalSignal?.addEventListener?.(
        "abort",
        () => reject(new RpcError(`RPC ${method} aborted`, "aborted")),
        { once: true },
      );
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
    if (cause instanceof RpcError) throw cause;
    if (externalSignal?.aborted) throw new RpcError(`RPC ${method} aborted`, "aborted");
    if (cause?.name === "AbortError") {
      throw new RpcError(`RPC ${method} timed out after ${timeoutMs} ms`, "timeout");
    }
    throw new RpcError(`RPC ${method} failed: network unreachable (${cause.message})`, "unreachable");
  } finally {
    if (timer !== null) clearTimeout(timer);
    externalSignal?.removeEventListener?.("abort", onExternalAbort);
  }
  // Public RPC rate-limits aggressively (HTTP 429). Back off twice, then fail
  // loudly with a distinct kind so the UI can tell the user to add a keyed
  // endpoint (Helius) in config. See config.js.
  // Retry budget: default is two retries (documented PERF-F2 mint-path
  // behaviour). Callers may pass opts.maxRetries to narrow it — the
  // liquidity path passes 1 (E3), because its result is informational
  // and a 429-forever GPA chain otherwise adds ~5 s to every scan.
  const maxRetries = opts.maxRetries ?? 2;
  if (res.status === 429 && attempt < maxRetries) {
    await abortableDelay(attempt === 0 ? 2000 : 5000, externalSignal);
    // F-R1 (v0.4.1): a caller may pass opts.startGate (the liquidity
    // path does) — a retry is a new call START, so it must pass through
    // the same pacing gate as an initial start before it is issued.
    if (typeof opts.startGate === "function") await opts.startGate();
    return rpc(endpoint, method, params, attempt + 1, opts);
  }
  if (res.status === 429) {
    throw new RpcError(
      `RPC ${method} failed: HTTP 429 (rate limited after retries)`,
      "rate-limited",
      429,
    );
  }
  if (!res.ok) throw new RpcError(`RPC ${method} failed: HTTP ${res.status}`, "rpc", res.status);
  let body;
  try {
    body = await res.json();
  } catch {
    throw new RpcError(`RPC ${method} failed: response was not valid JSON`, "rpc");
  }
  if (!body || typeof body !== "object") {
    throw new RpcError(`RPC ${method} failed: malformed response envelope`, "rpc");
  }
  if (body.error) {
    const detail =
      typeof body.error.message === "string" && body.error.message
        ? body.error.message
        : body.error.code !== undefined
          ? `error code ${body.error.code}`
          : "unknown RPC error";
    throw new RpcError(`RPC ${method} failed: ${detail}`, "rpc");
  }
  if (!("result" in body)) {
    throw new RpcError(`RPC ${method} failed: response is missing its result field`, "rpc");
  }
  // Delta C-15: callers may capture the result's context (the slot the
  // answer was read at — Solana nests it at result.context) via
  // opts.onContext; rpc() otherwise keeps its historical result-only
  // contract.
  if (typeof opts.onContext === "function" && body.result && typeof body.result === "object" && body.result.context && typeof body.result.context === "object") {
    try { opts.onContext(body.result.context); } catch { /* context capture never breaks a call */ }
  }
  return body.result;
}

/** Thrown when the address has no account, or the account is not a token mint. */
export class MintNotFoundError extends Error {
  constructor(mintAddress) {
    super(`No token mint found at ${mintAddress}`);
    this.name = "MintNotFoundError";
    this.kind = "mint-not-found";
  }
}

const TOKEN_PROGRAM_ID = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const TOKEN_2022_PROGRAM_ID = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
export { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID };

/** Raydium AMM v4 program — one of the venues the liquidity check covers. */
export const RAYDIUM_AMM_V4_PROGRAM_ID = "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8";
// Offsets of the mint pubkeys inside the Raydium AMM v4 AMM-info account
// layout (amm_info.rs): baseMint at byte 400, quoteMint at byte 432.
const RAYDIUM_BASE_MINT_OFFSET = 400;
const RAYDIUM_QUOTE_MINT_OFFSET = 432;

/** Meteora DLMM program (round 3: the venue LIBRA/MELANIA actually trade on). */
export const METEORA_DLMM_PROGRAM_ID = "LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo";
// LbPair mint offsets, derived from the production layout and verified
// live (see round-3 worklog): the Anchor account discriminator takes
// bytes 0..8, then StaticParameters (64 bytes incl. padding) and the
// variable parameters / active-bin fields place token_x_mint at byte 88
// and token_y_mint at byte 120. Sources: Meteora DLMM program accounts
// documentation (docs.meteora.ag/developer-guides/dlmm/program/accounts,
// LbPair field order) and the Carbon indexer's load-account-state guide
// (carbon.sevenlabs.org/guides/load-account-state), which uses exactly
// memcmp offsets 88 (token X) and 120 (token Y) against this program.
// The 8-byte Anchor discriminator is sha256("account:LbPair")[..8],
// which independently reproduces the byte array the Carbon guide
// publishes ([33, 11, 49, 98, 181, 101, 177, 13]).
const METEORA_DLMM_TOKEN_X_MINT_OFFSET = 88;
const METEORA_DLMM_TOKEN_Y_MINT_OFFSET = 120;
const METEORA_DLMM_DISCRIMINATOR = [33, 11, 49, 98, 181, 101, 177, 13];

/** Meteora DAMM v2 program (cp-amm). */
export const METEORA_DAMM_V2_PROGRAM_ID = "cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG";
// Pool mint offsets from the production SDK: @meteora-ag/cp-amm-sdk
// publishes POOL_TOKEN_A_MINT_OFFSET = 168 and POOL_TOKEN_B_MINT_OFFSET
// = 200 expressly "for Pool memcmp filters on tokenAMint and tokenBMint"
// (docs.meteora.ag/developer-guides/damm-v2/typescript-sdk/reference).
// Discriminator is sha256("account:Pool")[..8], the Anchor convention.
const METEORA_DAMM_V2_TOKEN_A_MINT_OFFSET = 168;
const METEORA_DAMM_V2_TOKEN_B_MINT_OFFSET = 200;
const METEORA_DAMM_V2_DISCRIMINATOR = [241, 154, 109, 4, 17, 177, 109, 188];

/** Meteora DAMM v1 program (dynamic AMM — LIBRA's main Meteora venue). */
export const METEORA_DAMM_V1_PROGRAM_ID = "Eo7WjKq67rjJQSZxS6z3YkapzY3eMj6Xy8X5EQVn5UaB";
// Pool mint offsets derived from the production layout: the official
// DAMM v1 program-accounts documentation
// (docs.meteora.ag/developer-guides/damm-v1/program/accounts) lists the
// Pool fields in order — lp_mint first, then token_a_mint, then
// token_b_mint — so after the 8-byte Anchor discriminator and the
// 32-byte lp_mint, token_a_mint sits at byte 40 and token_b_mint at
// byte 72. Verified live on two real pools holding the target mint in
// opposite positions (see round-3 worklog). The account is also named
// "Pool", so its Anchor discriminator bytes equal DAMM v2's; the two
// venues are separate programs, so the per-program queries never mix.
const METEORA_DAMM_V1_TOKEN_A_MINT_OFFSET = 40;
const METEORA_DAMM_V1_TOKEN_B_MINT_OFFSET = 72;
const METEORA_DAMM_V1_DISCRIMINATOR = [241, 154, 109, 4, 17, 177, 109, 188];

/** Orca Whirlpool program. */
export const ORCA_WHIRLPOOL_PROGRAM_ID = "whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc";
// Whirlpool mint offsets derived from the production struct order
// (orca whirlpool state, as rendered by the whirlpool-essentials
// account types): discriminator 8 + whirlpools_config 32 +
// whirlpool_bump 1 + tick_spacing 2 + tick_spacing_seed 2 + fee_rate 2
// + protocol_fee_rate 2 + liquidity 16 + sqrt_price 16 +
// tick_current_index 4 + protocol_fee_owed_a 8 + protocol_fee_owed_b 8
// puts token_mint_a at byte 101; then token_vault_a (32) and
// fee_growth_global_a (u128, 16) put token_mint_b at byte 181.
// Verified live on five real pools across three pairs with the target
// mint in both positions (see round-3 worklog). Discriminator is
// sha256("account:Whirlpool")[..8].
const ORCA_WHIRLPOOL_TOKEN_MINT_A_OFFSET = 101;
const ORCA_WHIRLPOOL_TOKEN_MINT_B_OFFSET = 181;
const ORCA_WHIRLPOOL_DISCRIMINATOR = [63, 149, 209, 12, 225, 128, 99, 9];

// The venues the liquidity check covers. What a returned entry's first
// 8 bytes (the dataSlice every query requests) must look like for the
// entry to count as a pool of that venue:
// - raydiumAmmV4: the bytes are the AmmInfo status u64; 1..7 counts.
// - the Anchor venues (meteoraDlmm, meteoraDammV1, meteoraDammV2,
//   orcaWhirlpool): the bytes must equal the pool account discriminator
//   exactly; existence is what counts (these layouts have no
//   Raydium-style status field in the first 8 bytes to classify, and
//   the check does not pretend otherwise).
const LIQUIDITY_VENUES = [
  {
    key: "raydiumAmmV4",
    programId: RAYDIUM_AMM_V4_PROGRAM_ID,
    mintOffsets: [RAYDIUM_BASE_MINT_OFFSET, RAYDIUM_QUOTE_MINT_OFFSET],
    dataSize: 752,
    discriminator: null,
  },
  {
    key: "meteoraDlmm",
    programId: METEORA_DLMM_PROGRAM_ID,
    mintOffsets: [METEORA_DLMM_TOKEN_X_MINT_OFFSET, METEORA_DLMM_TOKEN_Y_MINT_OFFSET],
    dataSize: null,
    discriminator: METEORA_DLMM_DISCRIMINATOR,
  },
  {
    key: "meteoraDammV2",
    programId: METEORA_DAMM_V2_PROGRAM_ID,
    mintOffsets: [METEORA_DAMM_V2_TOKEN_A_MINT_OFFSET, METEORA_DAMM_V2_TOKEN_B_MINT_OFFSET],
    dataSize: null,
    discriminator: METEORA_DAMM_V2_DISCRIMINATOR,
  },
  {
    key: "meteoraDammV1",
    programId: METEORA_DAMM_V1_PROGRAM_ID,
    mintOffsets: [METEORA_DAMM_V1_TOKEN_A_MINT_OFFSET, METEORA_DAMM_V1_TOKEN_B_MINT_OFFSET],
    dataSize: null,
    discriminator: METEORA_DAMM_V1_DISCRIMINATOR,
  },
  {
    key: "orcaWhirlpool",
    programId: ORCA_WHIRLPOOL_PROGRAM_ID,
    mintOffsets: [ORCA_WHIRLPOOL_TOKEN_MINT_A_OFFSET, ORCA_WHIRLPOOL_TOKEN_MINT_B_OFFSET],
    dataSize: null,
    discriminator: ORCA_WHIRLPOOL_DISCRIMINATOR,
  },
];

const UNKNOWN_VENUES = { raydiumAmmV4: null, meteoraDlmm: null, meteoraDammV2: null, meteoraDammV1: null, orcaWhirlpool: null };
const UNKNOWN_LIQUIDITY = { status: "unknown", poolCount: null, lpStatus: "not-checked", venues: UNKNOWN_VENUES };

// A getProgramAccounts entry only counts as a pool when it has the shape
// the RPC actually returns for an account: an object carrying a pubkey
// string and an account object. Anything else is garbage from a broken
// or lying endpoint and is ignored, never counted (LG-B5).
function isWellFormedPoolEntry(entry) {
  return (
    entry !== null &&
    typeof entry === "object" &&
    typeof entry.pubkey === "string" &&
    entry.pubkey.length > 0 &&
    entry.account !== null &&
    typeof entry.account === "object"
  );
}

// Decode an entry's account data (the dataSlice every liquidity query
// requests is the first 8 bytes) to raw bytes, or null when the data is
// missing or not decodable base64.
function entryDataBytes(entry) {
  const data = entry?.account?.data;
  const b64 = Array.isArray(data) ? data[0] : typeof data === "string" ? data : null;
  if (typeof b64 !== "string" || b64.length === 0) return null;
  try {
    if (typeof Buffer !== "undefined") return Buffer.from(b64, "base64");
    const bin = atob(b64);
    return Uint8Array.from(bin, (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
}

// Decode a Raydium AMM v4 pool account's status (E1 / LG-P6): the
// AmmInfo struct's first field is `status: u64` at offset 0, little-endian
// (domain brief: three independent renderings of raydium-amm state.rs).
// Returns the status 0..7, or null when the entry cannot be classified
// (missing/short data, or a value > 7 — a genuine AmmInfo can never hold
// one, so such an entry is garbage from a lying/broken endpoint).
function decodePoolStatus(entry) {
  const bytes = entryDataBytes(entry);
  if (!bytes || bytes.length < 8) return null;
  // All valid statuses are < 256, so bytes 1..7 must be zero; any non-zero
  // high byte means the u64 is > 7 and the entry is unclassifiable.
  for (let i = 1; i < 8; i++) if (bytes[i] !== 0) return null;
  return bytes[0] <= 7 ? bytes[0] : null;
}

// Classify a Meteora pool entry: the first 8 bytes must equal the venue's
// Anchor account discriminator exactly. The GPA query already filters on
// it, but a broken or lying endpoint can return anything, so the bytes
// are verified here too — a mismatch is unclassifiable, never a pool.
function hasPoolDiscriminator(entry, discriminator) {
  const bytes = entryDataBytes(entry);
  if (!bytes || bytes.length < 8) return false;
  for (let i = 0; i < 8; i++) if (bytes[i] !== discriminator[i]) return false;
  return true;
}

/**
 * Liquidity check via plain JSON-RPC: does a pool exist for this mint on
 * any checked venue — Raydium AMM v4, Meteora DLMM, Meteora DAMM v2,
 * Meteora DAMM v1, or Orca Whirlpool (round 3; v0.3.0 covered Raydium
 * only, which is why Meteora-native tokens like LIBRA read
 * "not-detected")? Each venue gets one
 * getProgramAccounts query per mint position (the two byte offsets of
 * its mint fields), each with a memcmp filter whose bytes are the mint
 * address itself (a base58 string IS the base58 encoding of the 32
 * pubkey bytes being compared). Meteora queries add a memcmp on the
 * pool account discriminator at offset 0, so other account types owned
 * by the same program (bin arrays, positions, configs) can never match.
 * dataSlice {offset: 0, length: 8} returns exactly the bytes the
 * classifier needs: for Raydium the AmmInfo status field (u64 LE at
 * offset 0), so a Raydium pool counts only in a live status 1..7
 * (status 0 is Uninitialized — an allocated account that was never a
 * pool); for Meteora the Anchor discriminator, which must match exactly
 * — existence is what counts there, because those layouts carry no
 * equivalent status field in the first 8 bytes. The same pubkey
 * returned twice, or by both of a venue's queries, counts once per
 * venue (LG2-P1); poolCount is the total of distinct pools across
 * venues, and `venues` carries the per-venue distinct counts (null for
 * a venue whose result is unknown).
 *
 * FAILURE TOLERANCE IS THE CONTRACT: this function NEVER throws and NEVER
 * rejects. Blocked method, timeout, exhausted 429 retries, malformed
 * response — everything degrades toward status "unknown". An entry that
 * cannot be classified (missing/short data, Raydium status > 7, Meteora
 * discriminator mismatch) also degrades its venue toward "unknown":
 * when NO venue has a counting pool and at least one venue is unknown,
 * the honest answer is "unknown", never a silent "not-detected" or an
 * invented count. "not-detected" is returned only when every venue's
 * queries succeeded, every returned entry was classified, and none was
 * a counting pool. A venue WITH a counting pool resolves its count even
 * if another venue is unknown: the result is "detected" and poolCount
 * is then the sum of the resolved venues' counts (a floor).
 *
 * LP burn/lock status is NOT derived from these calls — pool existence
 * says nothing reliable about whether LP tokens are burned or locked —
 * so lpStatus is always "not-checked" rather than invented.
 */
export async function fetchLiquidity(endpoint, mintAddress, opts = {}) {
  // F-R1 (v0.4.1) — GPA start pacing. Helius free keys cap
  // getProgramAccounts at 5 starts per second, and this check issues
  // 10 GPA queries; starting all 10 in one tick risks 429s on a
  // buyer's free key. STARTS (initial and retry alike) now pass
  // through a gate that allows at most 5 starts in any 1-second
  // window: the 10 initial starts go out as two waves of 5 in the
  // flattened venue/offset order below, wave 2 no earlier than
  // 1000 ms after wave 1's first start, and a 429 retry (which rpc()
  // issues after its existing 2 s backoff) re-enters this same gate
  // via opts.startGate. Only start TIMES change: which queries run,
  // their order, their results and the degrade-to-unknown contract
  // are exactly as before. The gate is abort-aware (opts.signal), so
  // a scan that has already failed never starts a queued wave or
  // retry (LG-F10). A gate wait interrupted by abort makes that one
  // query unknown, never a throw.
  const gpaStartTimes = [];
  const gpaStartGate = async () => {
    for (;;) {
      if (opts.signal?.aborted) throw new RpcError("RPC getProgramAccounts aborted", "aborted");
      const now = Date.now();
      while (gpaStartTimes.length && gpaStartTimes[0] <= now - 1000) gpaStartTimes.shift();
      if (gpaStartTimes.length < 5) {
        gpaStartTimes.push(now);
        return;
      }
      await abortableDelay(gpaStartTimes[0] + 1000 - now, opts.signal ?? null);
    }
  };
  const query = async (venue, offset) => {
    // Filter order keeps the mint memcmp first (the shape callers and
    // tests dispatch on); Raydium keeps its historical [memcmp,
    // dataSize] pair, Meteora adds the discriminator memcmp second.
    const filters = [{ memcmp: { offset, bytes: mintAddress } }];
    if (venue.discriminator) {
      filters.push({ memcmp: { offset: 0, bytes: base58Encode(Uint8Array.from(venue.discriminator)) } });
    }
    if (venue.dataSize) {
      // dataSize 752 = the fixed Raydium AMM v4 AMM-info account size:
      // lets the RPC skip accounts that cannot be AMM-info at all.
      filters.push({ dataSize: venue.dataSize });
    }
    // F-R1: this query's start (and, via startGate, its retry's start)
    // must be admitted by the pacing gate before the RPC is issued.
    try {
      await gpaStartGate();
    } catch {
      return null; // aborted while queued -> this position is unknown
    }
    return rpc(
      endpoint,
      "getProgramAccounts",
      [venue.programId, { encoding: "base64", dataSlice: { offset: 0, length: 8 }, filters }],
      0,
      // E3: the liquidity path retries a 429 ONCE (mint path keeps two).
      { ...opts, maxRetries: 1, startGate: gpaStartGate },
    ).then(
      (result) => {
        if (!Array.isArray(result)) return null;
        const live = new Set();
        let unclassifiable = 0;
        for (const entry of result.filter(isWellFormedPoolEntry)) {
          if (venue.discriminator) {
            if (hasPoolDiscriminator(entry, venue.discriminator)) live.add(entry.pubkey);
            else unclassifiable += 1;
          } else {
            const status = decodePoolStatus(entry);
            if (status === null) unclassifiable += 1;
            else if (status >= 1) live.add(entry.pubkey); // status 0 = not a pool
          }
        }
        return { live, unclassifiable };
      },
      () => null, // any RPC error -> this position is unknown, never a throw
    );
  };
  try {
    // F-R1: the 10 queries START in flattened venue/offset order
    // (venue 1 offset 1, venue 1 offset 2, venue 2 offset 1, ...) so
    // the pacing gate admits wave 1 = the first 5 in that order and
    // wave 2 = the rest; results are regrouped per venue below in the
    // original venue order, so the result shape is unchanged.
    const flatQueries = LIQUIDITY_VENUES.flatMap((venue) =>
      venue.mintOffsets.map((offset) => ({ venue, offset })),
    );
    const flatResults = await Promise.all(flatQueries.map(({ venue, offset }) => query(venue, offset)));
    const perVenue = [];
    {
      let idx = 0;
      for (const venue of LIQUIDITY_VENUES) {
        const pair = flatResults.slice(idx, idx + venue.mintOffsets.length);
        idx += venue.mintOffsets.length;
        const [a, b] = pair;
        const live = new Set([...(a?.live ?? []), ...(b?.live ?? [])]);
        if (live.size > 0) perVenue.push({ key: venue.key, count: live.size });
        else if (a === null || b === null) perVenue.push({ key: venue.key, count: null });
        else if (a.unclassifiable + b.unclassifiable > 0) perVenue.push({ key: venue.key, count: null });
        else perVenue.push({ key: venue.key, count: 0 });
      }
    }
    const venues = {};
    let total = 0;
    let anyUnknown = false;
    for (const v of perVenue) {
      venues[v.key] = v.count;
      if (v.count === null) anyUnknown = true;
      else total += v.count;
    }
    if (total > 0) return { status: "detected", poolCount: total, lpStatus: "not-checked", venues };
    if (anyUnknown) return { status: "unknown", poolCount: null, lpStatus: "not-checked", venues };
    return { status: "not-detected", poolCount: 0, lpStatus: "not-checked", venues };
  } catch {
    return { ...UNKNOWN_LIQUIDITY, venues: { ...UNKNOWN_VENUES } };
  }
}

// Transfer-fee basis points are a u16 percentage value: only a finite
// integer in 0..10000 is a real fee; anything else means the fee size
// could not be read (LG-F6).
function validFeeBps(value) {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 10000
    ? value
    : null;
}

function epochNumber(value) {
  const n = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
  return typeof n === "number" && Number.isInteger(n) && n >= 0 ? n : null;
}

/**
 * Extract Token-2022 extension facts from a parsed mint's info object.
 * Pure function of the getAccountInfo jsonParsed payload — no extra RPC.
 * Returns an all-false object for classic Token-program mints (that
 * program has no extensions), the parsed booleans for Token-2022 mints,
 * and null when the account was not parsed (extensions unknown).
 *
 * `currentEpoch` (optional): when the caller knows the current epoch,
 * the effective transfer fee is selected by it — the newer fee is in
 * effect once its epoch has arrived, otherwise the older fee is. When
 * it is null (unknown), the older fee is reported as effective, which
 * matches the pre-epoch behaviour.
 */
// Delta C-40/S-22: the mint-extension names this extractor recognises.
// A parsed extension whose name is NOT in this set is not silently
// ignored: it is recorded in unknownExtensions and assessConfidence
// marks extension coverage incomplete.
export const KNOWN_EXTENSION_NAMES = new Set([
  "transferFeeConfig", "transferHook", "permanentDelegate",
  "defaultAccountState", "nonTransferable", "confidentialTransferMint",
  "mintCloseAuthority", "pausableConfig", "scaledUiAmountConfig",
  "interestBearingConfig", "metadataPointer", "tokenMetadata",
  "groupPointer", "tokenGroup", "tokenGroupMember",
]);

// A raw maximumFee is a non-negative integer amount (string from the
// RPC, or a safe-integer number); anything else is unread (null).
function validMaximumFee(value) {
  if (typeof value === "string" && /^\d+$/.test(value)) return value;
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return String(value);
  return null;
}

function authorityString(value) {
  return typeof value === "string" && value.length > 0 ? value : null;
}

// Delta P-06: the frozen representative transfer size, in UI tokens, at
// which the effective transfer-fee rate is computed for scoring:
// F(x) = min(ceil(x*b/10000), M); effective rate = F(x)/x.
export const REPRESENTATIVE_TRANSFER_UI = 1000;

function effectiveRateBps(bps, maximumFeeRaw, decimals) {
  if (bps === null) return null;
  if (maximumFeeRaw === null || decimals === null) return bps;
  const x = BigInt(REPRESENTATIVE_TRANSFER_UI) * 10n ** BigInt(decimals);
  if (x === 0n) return bps;
  const uncapped = (x * BigInt(bps) + 9999n) / 10000n;
  const cap = BigInt(maximumFeeRaw);
  const fee = uncapped < cap ? uncapped : cap;
  // Rate in basis points with 2-decimal precision, computed in BigInt.
  return Number((fee * 1000000n) / x) / 100;
}

export function extractExtensions(parsedInfo, owner, currentEpoch = null) {
  if (!parsedInfo) return null;
  if (owner === TOKEN_PROGRAM_ID) {
    return {
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
  }
  const list = Array.isArray(parsedInfo.extensions) ? parsedInfo.extensions : [];
  const byName = new Map();
  const unknownExtensions = [];
  let unparseableExtensionCount = 0;
  for (const entry of list) {
    if (entry && typeof entry.extension === "string") {
      byName.set(entry.extension, entry);
      if (!KNOWN_EXTENSION_NAMES.has(entry.extension) && !unknownExtensions.includes(entry.extension)) {
        unknownExtensions.push(entry.extension);
      }
    } else {
      unparseableExtensionCount += 1;
    }
  }
  // transferFeeConfig state carries older/newer fee schedules. Which one
  // is EFFECTIVE is epoch-relative: the newer fee takes over when the
  // current epoch reaches newerTransferFee.epoch (LG-F11). Record both:
  // the effective fee drives scoring/display, and a differing newer fee
  // whose epoch is still in the future is reported as a scheduled change.
  let effectiveFeeBasisPoints = null;
  let effectiveMaximumFee = null;
  let scheduledFeeBasisPoints = null;
  let scheduledFeeEpoch = null;
  const feeEntry = byName.get("transferFeeConfig");
  if (feeEntry) {
    const state = feeEntry.state ?? {};
    const older = state.olderTransferFee ?? null;
    const newer = state.newerTransferFee ?? null;
    const olderBps = validFeeBps(older?.transferFeeBasisPoints);
    const newerBps = validFeeBps(newer?.transferFeeBasisPoints);
    const newerEpoch = epochNumber(newer?.epoch);
    const directBps = validFeeBps(state.transferFeeBasisPoints);
    if (olderBps !== null) { effectiveFeeBasisPoints = olderBps; effectiveMaximumFee = validMaximumFee(older?.maximumFee); }
    else if (directBps !== null) { effectiveFeeBasisPoints = directBps; effectiveMaximumFee = validMaximumFee(state.maximumFee); }
    // LG2-F1: a DATED newer fee must NOT be promoted to "effective" when
    // the current epoch is unknown (epoch fetch failed, or the legacy
    // no-epoch call): it may not be in effect yet, so the fee stays
    // unknown — the same honest result the payload gets when the epoch
    // fetch succeeds at an earlier epoch. An UNDATED newer fee (no epoch
    // recorded) carries no future-schedule evidence and stays the
    // fallback, as before.
    else if (newerBps !== null && newerEpoch !== null && currentEpoch !== null && currentEpoch >= newerEpoch) {
      effectiveFeeBasisPoints = newerBps; effectiveMaximumFee = validMaximumFee(newer?.maximumFee);
    } else if (newerBps !== null && olderBps === null && directBps === null && newerEpoch === null) {
      effectiveFeeBasisPoints = newerBps; effectiveMaximumFee = validMaximumFee(newer?.maximumFee);
    }
    if (
      olderBps !== null &&
      newerBps !== null &&
      currentEpoch !== null &&
      newerEpoch !== null &&
      currentEpoch >= newerEpoch
    ) {
      effectiveFeeBasisPoints = newerBps; effectiveMaximumFee = validMaximumFee(newer?.maximumFee);
    }
    if (
      newerBps !== null &&
      effectiveFeeBasisPoints !== null &&
      newerBps !== effectiveFeeBasisPoints &&
      (currentEpoch === null || newerEpoch === null || currentEpoch < newerEpoch)
    ) {
      scheduledFeeBasisPoints = newerBps;
      scheduledFeeEpoch = newer.epoch ?? null;
    }
  }
  const decimals = typeof parsedInfo.decimals === "number" && Number.isInteger(parsedInfo.decimals) && parsedInfo.decimals >= 0 && parsedInfo.decimals <= 255 ? parsedInfo.decimals : null;
  // defaultAccountState state is { state: "frozen"|"initialized" } in
  // jsonParsed output; accept the bare-string form too, defensively.
  const dasStateRaw = byName.get("defaultAccountState")?.state;
  const dasState = typeof dasStateRaw === "string" ? dasStateRaw : dasStateRaw?.state;
  // A transfer hook only runs code when its programId is actually set; an
  // entry with a null programId is inert and must not count as a hook.
  const hookEntry = byName.get("transferHook");
  const hasTransferHook = Boolean(hookEntry && hookEntry.state?.programId != null);
  // Mint close authority is recorded as a FACT ONLY (never scored — see
  // risk.js): a mint can only be closed once its supply is zero, so this
  // authority cannot directly take holders' tokens.
  const closeEntry = byName.get("mintCloseAuthority");
  const hasMintCloseAuthority = Boolean(closeEntry && closeEntry.state?.authority != null);
  // A permanent delegate counts only when its delegate address is
  // actually present (LG-F7): an entry with no delegate state carries
  // no delegate and must not fabricate the flag.
  const delegateEntry = byName.get("permanentDelegate");
  const delegate = delegateEntry?.state?.delegate;
  const hasPermanentDelegate = typeof delegate === "string" && delegate.length > 0;
  // Delta C-39/S-28/S-29: pausable and scaled-UI extensions, same payload.
  const pausableEntry = byName.get("pausableConfig");
  const scaledEntry = byName.get("scaledUiAmountConfig");
  const feeState = feeEntry?.state ?? {};
  return {
    hasPermanentDelegate,
    hasTransferFee: Boolean(feeEntry),
    effectiveFeeBasisPoints,
    scheduledFeeBasisPoints,
    scheduledFeeEpoch,
    nonTransferable: byName.has("nonTransferable"),
    defaultFrozen: dasState === "frozen",
    hasTransferHook,
    hasConfidentialTransfer: byName.has("confidentialTransferMint"),
    hasMintCloseAuthority,
    // Delta C-09/C-10: dormant-trap facts already in the payload.
    transferFeeConfigAuthority: authorityString(feeState.transferFeeConfigAuthority),
    withdrawWithheldAuthority: authorityString(feeState.withdrawWithheldAuthority),
    transferFeeMaximumFee: effectiveMaximumFee,
    effectiveFeeRateBps: effectiveRateBps(effectiveFeeBasisPoints, effectiveMaximumFee, decimals),
    transferHookAuthority: authorityString(hookEntry?.state?.authority),
    transferHookProgramId: authorityString(hookEntry?.state?.programId),
    hasPausableConfig: Boolean(pausableEntry),
    pausableAuthorityActive: Boolean(authorityString(pausableEntry?.state?.authority)),
    transfersPaused: pausableEntry?.state?.paused === true,
    hasScaledUiAmount: Boolean(scaledEntry),
    scaledUiAuthorityActive: Boolean(authorityString(scaledEntry?.state?.authority)),
    unknownExtensions,
    unparseableExtensionCount,
  };
}

// Parse an RPC amount field: amounts are non-negative integer strings
// (a non-negative integer number is also accepted, as some endpoints
// return one). Anything else is a malformed payload from a broken or
// lying endpoint and becomes a typed RpcError, never an untyped
// BigInt SyntaxError/RangeError and never a fabricated value (LG-B1).
function parseAmount(value, label) {
  if (typeof value === "string" && /^\d+$/.test(value)) return BigInt(value);
  // LG2-F4: a number that is not a SAFE integer has already been rounded
  // by the JSON parser (e.g. 2^53+1 arrives as 2^53) — converting it
  // would silently fabricate a different amount, so it is a typed error.
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return BigInt(value);
  if (typeof value === "bigint" && value >= 0n) return value;
  throw new RpcError(
    `RPC returned a malformed ${label}: expected a non-negative integer amount`,
    "rpc",
  );
}

function validateDecimals(value) {
  if (typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 255) return value;
  throw new RpcError(
    "RPC returned a malformed decimals value: expected an integer between 0 and 255",
    "rpc",
  );
}

// Exact UI supply from the raw BigInt string (LG-P1): the decimal string
// is built digit-by-digit, so supplies above 2^53 base units keep every
// digit. Small values are returned as numbers (the historical shape);
// values a double cannot represent exactly are returned as the exact
// decimal string instead of a rounded number.
export function supplyUiFromRaw(totalRaw, decimals) {
  const raw = totalRaw.toString();
  let exact;
  if (decimals === 0) {
    exact = raw;
  } else if (raw.length > decimals) {
    exact = `${raw.slice(0, raw.length - decimals)}.${raw.slice(raw.length - decimals)}`;
  } else {
    exact = `0.${"0".repeat(decimals - raw.length)}${raw}`;
  }
  const asNumber = Number(exact);
  return Number.isFinite(asNumber) && Math.abs(asNumber) < 1e15 ? asNumber : exact;
}

/** Assemble the plain facts object that risk.js scores. */
export async function fetchMintFacts(mintAddress, cluster = "mainnet-beta", options = {}) {
  const endpoint = getRpcEndpoint(cluster); // throws on unknown cluster
  const rpcOpts = { timeoutMs: options.timeoutMs };

  // PERFORMANCE: the liquidity queries depend only on the mint address, so
  // they start NOW, concurrently with getAccountInfo, instead of adding a
  // sequential round after it. fetchLiquidity never rejects, so this
  // floating promise can never surface as an unhandled rejection. When
  // classification below throws, the liquidity work is aborted so it
  // does not keep retrying against the endpoint for a scan that has
  // already failed (LG-F10).
  const liquidityController = new AbortController();
  const liquidityPromise = fetchLiquidity(endpoint, mintAddress, {
    ...rpcOpts,
    signal: liquidityController.signal,
  });

  try {
    // FIX 4: fetch getAccountInfo FIRST to classify the account before
    // spending the other two calls.
    let observedSlot = null;
    const parsed = await rpc(endpoint, "getAccountInfo", [mintAddress, { encoding: "jsonParsed" }], 0, {
      ...rpcOpts,
      onContext: (ctx) => {
        if (typeof ctx?.slot === "number" && Number.isInteger(ctx.slot) && ctx.slot >= 0) observedSlot = ctx.slot;
      },
    });

    // Account missing entirely: not something we can score.
    if (!parsed?.value) {
      throw new MintNotFoundError(mintAddress);
    }

    const parsedInfo = parsed.value?.data?.parsed?.info;
    const parsedType = parsed.value?.data?.parsed?.type;
    const programId = parsed.value.owner;
    let mintAuthorityActive;
    let freezeAuthorityActive;
    let extensions;
    let needsEpoch = false;
    if (parsedInfo && parsedType === "mint") {
      // LG-B4 + LG-P4: the parsed branch must verify the account owner
      // is a token program, and an uninitialized mint is not a mint.
      if (programId !== TOKEN_PROGRAM_ID && programId !== TOKEN_2022_PROGRAM_ID) {
        throw new MintNotFoundError(mintAddress);
      }
      if (parsedInfo.isInitialized === false) {
        throw new MintNotFoundError(mintAddress);
      }
      mintAuthorityActive = parsedInfo.mintAuthority ? true : parsedInfo.mintAuthority === null ? false : null;
      freezeAuthorityActive = parsedInfo.freezeAuthority ? true : parsedInfo.freezeAuthority === null ? false : null;
      // Token-2022 extensions ride along in this same response — no extra call.
      extensions = extractExtensions(parsedInfo, programId);
      needsEpoch =
        programId === TOKEN_2022_PROGRAM_ID &&
        Array.isArray(parsedInfo.extensions) &&
        parsedInfo.extensions.some((e) => e && e.extension === "transferFeeConfig");
    } else if (!parsedInfo && (parsed.value.owner === TOKEN_PROGRAM_ID || parsed.value.owner === TOKEN_2022_PROGRAM_ID)) {
      // Owned by a token program but not parsed as a mint (e.g. unparsed /
      // Token-2022 layout): proceed with authorities unknown instead of
      // misclassifying it as not-a-mint.
      mintAuthorityActive = null;
      freezeAuthorityActive = null;
      extensions = null; // unparsed: extension set is unknown
    } else {
      // Present but not a token mint (e.g. a wallet address or a program).
      throw new MintNotFoundError(mintAddress);
    }

    // Round 2: supply + largest accounts, plus — only for a Token-2022
    // mint carrying a transferFeeConfig — getEpochInfo, so the effective
    // fee can be selected by the current epoch (LG-F11). All three run
    // concurrently; the epoch call is part of round 2, not a new round.
    let currentEpoch = null;
    let epochFailed = false;
    const epochPromise = needsEpoch
      ? rpc(endpoint, "getEpochInfo", [], 0, rpcOpts).then(
          (info) => {
            const epoch = epochNumber(info?.epoch);
            if (epoch === null) epochFailed = true;
            else currentEpoch = epoch;
          },
          () => {
            epochFailed = true;
          },
        )
      : Promise.resolve();
    // Round-3 F1: a getTokenLargestAccounts FAILURE degrades exactly
    // like the existing null-value case (LG-F5) instead of aborting the
    // scan. Mega-mints (USDC, wSOL, USDT) have so many token accounts
    // that the RPC rejects this call outright ("Too many accounts
    // requested"), and v0.3.0 returned NO verdict at all for the most
    // legitimate mints on Solana. Only THIS call degrades: the error is
    // converted to the null-value shape, holder facts become unknown,
    // and a marker on the returned facts lets assessConfidence name the
    // gap. getAccountInfo / getTokenSupply failures still throw, and a
    // malformed (successful) largest-accounts payload still throws
    // below — degradation covers the call failing, not bad data.
    let largestAccountsFailed = false;
    const largestPromise = rpc(endpoint, "getTokenLargestAccounts", [mintAddress], 0, rpcOpts).then(
      (value) => value,
      () => {
        largestAccountsFailed = true;
        return { value: null };
      },
    );
    const [supply, largest] = await Promise.all([
      rpc(endpoint, "getTokenSupply", [mintAddress], 0, rpcOpts),
      largestPromise,
      epochPromise,
    ]);
    if (needsEpoch && extensions) {
      // Re-select the effective fee now that the epoch is known. On
      // epoch-fetch failure, fall back to the older fee and record the
      // uncertainty so the confidence assessment can surface it.
      extensions = extractExtensions(parsedInfo, programId, currentEpoch);
      if (epochFailed) extensions.feeScheduleUncertain = true;
    }

    if (!supply || typeof supply !== "object" || !supply.value || typeof supply.value !== "object") {
      throw new RpcError("RPC returned a malformed getTokenSupply result: missing value", "rpc");
    }
    const totalRaw = parseAmount(supply.value.amount, "getTokenSupply amount");
    const decimals = validateDecimals(supply.value.decimals);
    const supplyUi = supplyUiFromRaw(totalRaw, decimals);

    // LG2-F2: reconcile the two supply sources. The parsed mint carries
    // its own supply/decimals; getTokenSupply is the source that drives
    // the displayed supply (unchanged), but a DISAGREEMENT between the
    // two answers this scan already holds must not be invisible: record
    // a marker that assessConfidence turns into a named issue, so a
    // 1000x disagreement can no longer carry HIGH confidence silently.
    let supplySourcesDisagree = false;
    if (parsedInfo) {
      try {
        const parsedRaw = parseAmount(parsedInfo.supply, "parsed mint supply");
        const parsedDecimals = validateDecimals(parsedInfo.decimals);
        supplySourcesDisagree = parsedRaw !== totalRaw || parsedDecimals !== decimals;
      } catch {
        supplySourcesDisagree = true; // unparseable parsed supply cannot agree
      }
    }

    if (!largest || typeof largest !== "object" || !("value" in largest)) {
      throw new RpcError("RPC returned a malformed getTokenLargestAccounts result: missing value", "rpc");
    }
    // A null largest-accounts value means the holder data could not be
    // read: holder facts become unknown (null), never a fabricated
    // "0 holders" (LG-F5).
    let accounts = null;
    if (largest.value !== null) {
      if (!Array.isArray(largest.value)) {
        throw new RpcError("RPC returned a malformed getTokenLargestAccounts result: value is not a list", "rpc");
      }
      accounts = largest.value.map((entry) => {
        if (!entry || typeof entry !== "object") {
          throw new RpcError("RPC returned a malformed largest-account entry", "rpc");
        }
        return { amount: parseAmount(entry.amount, "largest-account amount") };
      });
      // Do not trust the RPC's ordering (LG-F5): sort locally by raw
      // amount, descending, before computing any share.
      accounts.sort((a, b) => (a.amount > b.amount ? -1 : a.amount < b.amount ? 1 : 0));
    }

    const pctOf = (amt) => (totalRaw === 0n ? 0 : Number((amt * 10000n) / totalRaw) / 100);
    let topHolderPct = null;
    let top10HolderPct = null;
    let top20HolderPct = null;
    // LG2-F3: aggregate honesty (extends the LG-F4 per-share principle).
    // If the returned largest accounts sum to MORE than the supply, the
    // holder set cannot all be true, so NO share derived from it is a
    // fact: both shares become unknown and a confidence marker is set.
    let holderSetExceedsSupply = false;
    if (accounts !== null && accounts.length) {
      const sumAll = accounts.reduce((sum, a) => sum + a.amount, 0n);
      if (sumAll > totalRaw) holderSetExceedsSupply = true;
    }
    if (holderSetExceedsSupply) {
      topHolderPct = null;
      top10HolderPct = null;
    } else if (accounts !== null && accounts.length) {
      if (totalRaw === 0n && accounts.some((a) => a.amount > 0n)) {
        // Holders with a zero supply is a contradiction: the shares are
        // unknown, never a fabricated 0% (LG-F4).
        topHolderPct = null;
        top10HolderPct = null;
      } else {
        const top = pctOf(accounts[0].amount);
        const top10 = pctOf(accounts.slice(0, 10).reduce((sum, a) => sum + a.amount, 0n));
        // Delta C-02: the top-20 share is displayed as a fact (the data
        // is already fetched); it is deliberately NOT a scored rule.
        const top20 = pctOf(accounts.slice(0, 20).reduce((sum, a) => sum + a.amount, 0n));
        // Impossible shares (>100%) are honest unknowns, never facts.
        topHolderPct = top > 100 ? null : top;
        top10HolderPct = top10 > 100 ? null : top10;
        top20HolderPct = top20 > 100 ? null : top20;
      }
    }

    // Liquidity has been running concurrently since before getAccountInfo;
    // by now it has usually already settled. It never rejects.
    const liquidity = await liquidityPromise;

    return {
      mintAuthorityActive,
      freezeAuthorityActive,
      topHolderPct,
      top10HolderPct,
      top20HolderPct,
      slot: observedSlot,
      // Exact holder count needs an indexer; largest-accounts returns at
      // most 20 accounts, so when 20 come back the count is only a floor.
      // A null (unreadable) largest-accounts result leaves it unknown.
      holderCount: accounts === null ? null : accounts.length,
      holderCountIsFloor: accounts === null ? false : accounts.length >= 20,
      ...(supplySourcesDisagree ? { supplySourcesDisagree: true } : {}),
      ...(holderSetExceedsSupply ? { holderSetExceedsSupply: true } : {}),
      ...(largestAccountsFailed ? { largestAccountsUnavailable: true } : {}),
      supplyUi,
      programId,
      extensions,
      liquidity,
    };
  } catch (err) {
    // The scan has failed: settle the floating liquidity work instead of
    // letting its retries keep firing against the endpoint (LG-F10).
    liquidityController.abort();
    throw err;
  }
}
