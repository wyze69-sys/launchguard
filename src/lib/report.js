// LaunchGuard verifiable reports.
//
// A report is a plain object that fully determines a LaunchGuard verdict:
//
//   {
//     version: 1,
//     mint: "<base58 address>",
//     cluster: "mainnet-beta" | "devnet",
//     observedAt: "<ISO timestamp>",
//     facts: { ...every fact the score was computed from... },
//     score: 0..100,
//     band: "LOWER OBSERVED RISK" | "CAUTION" | "HIGH RISK",
//     flagKeys: ["freeze-authority", ...],   // sorted
//     confidence: { level, reasons },        // see assessConfidence()
//     digest: "<sha256 hex>"                 // optional; set after hashing
//   }
//
// Anyone holding the report JSON can recompute its SHA-256 digest and check
// it against (a) the report's own `digest` field and (b) the `h=` field of
// the on-chain memo anchor. The digest binds the report's values at
// 6-decimal precision: if any scored fact (at that precision), the score,
// the band, a flag KEY, or the confidence changes, the digest changes —
// tampering at or above that precision is detectable without trusting
// LaunchGuard. Note what is NOT bound: the human-readable flag DETAIL text
// lives only in risk.js and is not part of the report object, so the
// digest covers the sorted flag keys, never the detail wording.
//
// CANONICAL SERIALIZATION (the exact bytes that are hashed):
//   - JSON with object keys sorted lexicographically, recursively, at every
//     depth. Array order is preserved (arrays are meaningful sequences).
//   - No whitespace. Strings/booleans/null use standard JSON encoding.
//   - Numbers: non-finite numbers canonicalize to null. Every finite
//     number is rounded to SIX decimal places (Number(n.toFixed(6))) and
//     printed with String(), i.e. the JS shortest round-trip decimal form
//     (so 62.5 and 62.50 hash identically, and float noise below 1e-6 —
//     e.g. 0.30000000000000004 vs 0.3 — can never break verification).
//     For magnitudes >= 1e21 that shortest form uses exponent notation;
//     that is fine — the form is deterministic for this implementation,
//     which is all verification requires. Percentages are additionally
//     rounded to 6 decimals when the report is built (see buildReport),
//     so the stored report already shows the exact values that were hashed.
//   - Object properties whose value is `undefined` are omitted; `undefined`
//     array elements become null (both mirror JSON.stringify semantics).
//   - The report's own `digest` field is EXCLUDED from the hashed bytes,
//     so a report can carry its digest without a circular definition.
//
// The digest is SHA-256 over the UTF-8 bytes of that canonical string,
// computed with WebCrypto (globalThis.crypto.subtle), available in modern
// browsers (secure contexts) and Node 20+.

/** Report format version. Bump when the canonical shape changes. */
export const REPORT_VERSION = 1;

const TOKEN_2022_PROGRAM_ID = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";

// ---------------------------------------------------------------------------
// Data-confidence indicator
// ---------------------------------------------------------------------------

/**
 * Assess how much trust the underlying data deserves, independent of the
 * risk score itself. A mint can be low-risk AND low-confidence (e.g. the
 * RPC could not tell us its authorities).
 *
 * Rule (exact): start at "high" with no issues. Each issue below adds one
 * reason. 0 issues -> "high", exactly 1 issue -> "medium", 2 or more
 * issues -> "low".
 *   - either authority is unknown (null/undefined)
 *   - holderCountIsFloor (holder count is a >=20 floor, not exact)
 *   - Token-2022 mint whose extensions could not be read (extensions null)
 *   - liquidity status "unknown" (or no liquidity fact at all)
 *   - top-holder data missing (topHolderPct null/undefined); when the
 *     largest-accounts request itself failed (largestAccountsUnavailable,
 *     the mega-mint case), that named reason replaces the generic one
 *   - the mint supports confidential balances (extensions.hasConfidentialTransfer):
 *     holder shares cover publicly visible balances only (F-R2, v0.4.1)
 *
 * @param {object} facts the same facts object scoreMint() consumes
 * @returns {{level: "high"|"medium"|"low", reasons: string[]}}
 */
export function assessConfidence(facts) {
  const reasons = [];
  if (facts.mintAuthorityActive == null || facts.freezeAuthorityActive == null) {
    reasons.push("Mint or freeze authority status could not be read.");
  }
  if (facts.holderCountIsFloor) {
    reasons.push("Holder count is a floor (>=20), not an exact count.");
  }
  if (facts.programId === TOKEN_2022_PROGRAM_ID && facts.extensions == null) {
    reasons.push("Token-2022 extensions could not be read, so extension risks are unknown.");
  }
  if (!facts.liquidity || facts.liquidity.status === "unknown") {
    reasons.push("Liquidity check did not produce a result (status unknown).");
  }
  if (facts.largestAccountsUnavailable) {
    // Round-3 F1: the largest-accounts call itself failed (mega-mints
    // such as USDC/wSOL/USDT have too many token accounts for it), so
    // holder shares are unknown for a named reason — this replaces the
    // generic missing-data reason rather than double-counting one gap.
    reasons.push("Holder data could not be read: the largest-accounts request failed (this mint has too many token accounts for that call), so holder shares are unknown.");
  } else if (facts.topHolderPct == null) {
    reasons.push("Top-holder data is missing.");
  }
  // Delta C-40/S-22: an extension the extractor does not recognise (or
  // cannot parse) means extension coverage is incomplete — named here,
  // never silently ignored, and never scored.
  if (facts.extensions && typeof facts.extensions === "object") {
    const unknown = Array.isArray(facts.extensions.unknownExtensions) ? facts.extensions.unknownExtensions : [];
    const unparseable = typeof facts.extensions.unparseableExtensionCount === "number" ? facts.extensions.unparseableExtensionCount : 0;
    if (unknown.length || unparseable > 0) {
      const parts = [];
      if (unknown.length) parts.push(`unrecognised extension(s): ${unknown.join(", ")}`);
      if (unparseable > 0) parts.push(`${unparseable} extension entr${unparseable === 1 ? "y" : "ies"} could not be parsed`);
      reasons.push(`Extension coverage is incomplete: this mint carries ${parts.join(" and ")}, so any risks in them are not scored.`);
    }
  }
  if (facts.extensions && facts.extensions.feeScheduleUncertain) {
    reasons.push("Transfer-fee schedule could not be confirmed against the current epoch, so the older fee is reported as effective.");
  }
  if (facts.supplySourcesDisagree) {
    reasons.push("Supply sources disagree: the parsed mint and getTokenSupply returned different supply or decimals, so the supply and holder shares may be unreliable.");
  }
  if (facts.holderSetExceedsSupply) {
    reasons.push("Largest-account amounts sum to more than the total supply, so holder shares are unknown.");
  }
  // F-R2 (v0.4.1): a mint that supports confidential balances can hold
  // value that no public balance shows (a deposit converts public
  // balance into confidential pending balance), so the holder shares
  // this scan computed cover publicly visible balances only and the
  // observed concentration is a lower bound. Coverage disclosure only:
  // zero points, and the score/band are never changed by this reason.
  if (facts.extensions && facts.extensions.hasConfidentialTransfer) {
    reasons.push("This mint supports confidential balances: holder shares cover publicly visible balances only, so observed concentration may understate actual concentration.");
  }
  const level = reasons.length === 0 ? "high" : reasons.length === 1 ? "medium" : "low";
  return { level, reasons };
}

// ---------------------------------------------------------------------------
// Checked-vs-Not-Checked receipt (Delta P-37/C-16)
// ---------------------------------------------------------------------------

/**
 * The trust receipt: in buyer-readable plain language, what this scan
 * actually checked and what it did not check, derived only from facts
 * already present. The not-checked list always names the Pro-only
 * checks (LP lock/burn, owner clusters, deployer history) so a free
 * report never implies coverage it does not have.
 * @param {object} facts the same facts object scoreMint() consumes
 * @returns {{checked: string[], notChecked: string[]}}
 */
export function buildCoverageReceipt(facts) {
  const checked = [];
  const notChecked = [];
  if (facts.mintAuthorityActive != null && facts.freezeAuthorityActive != null) {
    checked.push("Mint and freeze authorities: who can create new supply or freeze holder accounts.");
  } else {
    notChecked.push("Mint or freeze authority status: it could not be read in this scan.");
  }
  // F-R2 (v0.4.1): the holder-concentration line itself carries the
  // confidential-balance caveat as a named coverage limitation (not a
  // footnote) whenever the mint supports confidential balances.
  const confidentialCaveat =
    facts.extensions && facts.extensions.hasConfidentialTransfer
      ? " Caveat: this mint supports confidential balances — holder shares cover publicly visible balances only, so observed concentration may understate actual concentration."
      : "";
  if (facts.topHolderPct != null) {
    checked.push(`Holder concentration: the largest token account's share, and the top 10 and top 20 accounts' shares of supply.${confidentialCaveat}`);
  } else {
    notChecked.push(`Holder concentration: holder data could not be read in this scan.${confidentialCaveat}`);
  }
  if (facts.programId && facts.programId !== TOKEN_2022_PROGRAM_ID) {
    checked.push("Token-2022 extensions: none apply — this is a classic Token program mint.");
  } else if (facts.extensions && typeof facts.extensions === "object") {
    checked.push("Token-2022 extensions, read by name from the mint account (including transfer fee, transfer hook, permanent delegate, pausable and scaled-UI extensions when present).");
    const unknown = Array.isArray(facts.extensions.unknownExtensions) ? facts.extensions.unknownExtensions : [];
    const unparseable = typeof facts.extensions.unparseableExtensionCount === "number" ? facts.extensions.unparseableExtensionCount : 0;
    if (unknown.length || unparseable > 0) {
      notChecked.push(`Extension coverage is incomplete: ${unknown.length ? `unrecognised extension(s) (${unknown.join(", ")})` : ""}${unknown.length && unparseable > 0 ? " and " : ""}${unparseable > 0 ? "extension entries that could not be parsed" : ""} were not checked.`);
    }
  } else {
    notChecked.push("Token-2022 extensions: they could not be read in this scan.");
  }
  const liqStatus = facts.liquidity?.status;
  if (liqStatus === "detected" || liqStatus === "not-detected") {
    checked.push(`Liquidity pools on the checked venues (Raydium AMM v4, Meteora DLMM, Meteora DAMM v2, Meteora DAMM v1, Orca Whirlpool)${liqStatus === "not-detected" ? ": none were found" : ""}.`);
  } else {
    notChecked.push("Liquidity pools: the check did not produce a result in this scan.");
  }
  notChecked.push("Whether liquidity pool (LP) tokens are locked or burned: not checked in this free version (Pro).");
  notChecked.push("Whether several holder accounts belong to the same owner (owner clusters): not checked in this free version (Pro).");
  notChecked.push("The token deployer's history with other tokens: not checked in this free version (Pro).");
  return { checked, notChecked };
}

// ---------------------------------------------------------------------------
// Canonical serialization
// ---------------------------------------------------------------------------

function formatCanonicalNumber(n) {
  if (!Number.isFinite(n)) return "null";
  // Round to 6 decimals, then print the shortest round-trip form:
  // 62.50 -> "62.5", 50 -> "50". -0 normalizes to "0". Six decimals is
  // precise enough that real tampering (e.g. supplyUi 1000000.001 vs
  // 1000000.004) changes the digest, while float noise below 1e-6
  // (0.30000000000000004) still canonicalizes away.
  const rounded = Number(n.toFixed(6));
  return String(Object.is(rounded, -0) ? 0 : rounded);
}

const MAX_CANONICAL_DEPTH = 100;

function serializeCanonical(value, seen = new Set(), depth = 0) {
  if (value === null) return "null";
  if (typeof value === "number") return formatCanonicalNumber(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "string") return JSON.stringify(value);
  // LG-P2: a BigInt fact canonicalizes to its decimal STRING form, so
  // two reports differing only in a BigInt field no longer collide on
  // the digest the way BigInt -> null aliasing made them.
  if (typeof value === "bigint") return JSON.stringify(value.toString());
  if (Array.isArray(value) || (typeof value === "object" && value !== null)) {
    // LG-P2/P3: cycles and pathological nesting get a clean, friendly
    // typed error instead of a stack overflow (RangeError).
    if (depth > MAX_CANONICAL_DEPTH) {
      throw new Error("Report is too deeply nested to digest. Paste a complete LaunchGuard report JSON.");
    }
    if (seen.has(value)) {
      throw new Error("Report contains a circular structure and cannot be digested.");
    }
    seen.add(value);
    try {
      if (Array.isArray(value)) {
        return "[" + value.map((v) => (v === undefined ? "null" : serializeCanonical(v, seen, depth + 1))).join(",") + "]";
      }
      const keys = Object.keys(value).filter((k) => value[k] !== undefined).sort();
      return "{" + keys.map((k) => JSON.stringify(k) + ":" + serializeCanonical(value[k], seen, depth + 1)).join(",") + "}";
    } finally {
      seen.delete(value);
    }
  }
  return "null";
}

/**
 * The canonical byte string (as text) that digestReport() hashes for a
 * report: recursively key-sorted JSON, 6-decimal number rounding, and the
 * report's own `digest` field excluded.
 */
export function canonicalReportJson(report) {
  if (!report || typeof report !== "object") throw new Error("canonicalReportJson: report must be an object");
  const { digest: _excluded, ...rest } = report;
  return serializeCanonical(rest);
}

// ---------------------------------------------------------------------------
// Report construction
// ---------------------------------------------------------------------------

function round6(n) {
  return typeof n === "number" && Number.isFinite(n) ? Number(n.toFixed(6)) : n;
}

// Deep copy so nested objects (facts.extensions, facts.liquidity) are not
// shared by reference with the caller: mutating the caller's facts after
// buildReport must never change a report that was already digested.
function deepCopyFacts(facts) {
  if (typeof structuredClone === "function") {
    try {
      return structuredClone(facts);
    } catch {
      // Fall through to the JSON round-trip for non-cloneable values.
    }
  }
  return JSON.parse(JSON.stringify(facts ?? null));
}

/**
 * Build the canonical report object for a scored mint.
 * @param {{mint: string, cluster: string, facts: object,
 *          result: {score:number, band:string, flags:Array},
 *          observedAt?: string|Date}} args
 */
export function buildReport({ mint, cluster, facts, result, observedAt }) {
  // DEEP-copy the facts so later mutation of the caller's object (including
  // nested extensions/liquidity) cannot change a report that was already
  // digested, and round the percentages to the fixed 6-decimal precision
  // used by the canonical form. Confidence is assessed on the copy, so the
  // report is fully self-contained.
  const factsCopy = deepCopyFacts(facts);
  factsCopy.topHolderPct = round6(factsCopy.topHolderPct);
  factsCopy.top10HolderPct = round6(factsCopy.top10HolderPct);
  if ("top20HolderPct" in factsCopy) factsCopy.top20HolderPct = round6(factsCopy.top20HolderPct);
  return {
    version: REPORT_VERSION,
    mint,
    cluster,
    // Delta C-15: the slot the mint account was read at (null when the
    // RPC response carried no context), alongside the client timestamp.
    slot: typeof factsCopy.slot === "number" ? factsCopy.slot : null,
    // Delta P-37/C-16: the Checked-vs-Not-Checked receipt.
    coverage: buildCoverageReceipt(factsCopy),
    observedAt:
      observedAt instanceof Date
        ? observedAt.toISOString()
        : typeof observedAt === "string"
          ? observedAt
          : new Date().toISOString(),
    facts: factsCopy,
    score: result.score,
    band: result.band,
    flagKeys: result.flags.map((f) => f.key).sort(),
    confidence: assessConfidence(factsCopy),
  };
}

// ---------------------------------------------------------------------------
// Digest + verification
// ---------------------------------------------------------------------------

/**
 * SHA-256 digest of a report's canonical form, as lowercase hex (64 chars).
 * The report's own `digest` field, if present, is ignored.
 * @param {object} report
 * @returns {Promise<string>}
 */
export async function digestReport(report) {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) {
    throw new Error(
      "WebCrypto (crypto.subtle) is unavailable in this context; digests need a secure context (https/localhost) or Node 20+",
    );
  }
  const bytes = new TextEncoder().encode(canonicalReportJson(report));
  const hash = await subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Verify a report object: recompute its digest (ignoring any stored
 * `digest` field) and compare with the stored one.
 * @param {object} reportObject a parsed report JSON (with or without digest)
 * @returns {Promise<{ok: boolean, computedDigest: string|null, storedDigest: string|null}>}
 *   ok is true only when a stored digest exists and matches exactly.
 */
export async function verifyReport(reportObject) {
  if (!reportObject || typeof reportObject !== "object" || Array.isArray(reportObject)) {
    return { ok: false, computedDigest: null, storedDigest: null };
  }
  const storedDigest =
    typeof reportObject.digest === "string" ? reportObject.digest.toLowerCase() : null;
  const computedDigest = await digestReport(reportObject);
  return { ok: storedDigest !== null && storedDigest === computedDigest, computedDigest, storedDigest };
}

/**
 * Extract the `h=<64 hex>` digest from a pasted memo text.
 * @param {string} memoText
 * @returns {string|null} lowercase hex digest, or null when absent/malformed
 */
export function parseMemoDigest(memoText) {
  if (typeof memoText !== "string") return null;
  const match = memoText.match(/h=([0-9a-fA-F]{64})/);
  return match ? match[1].toLowerCase() : null;
}

/**
 * Parse the structured fields of an LG1 report memo (see memo.js):
 *   LG1|mint=<address>|score=<n>/100|band=<band>|ts=<ISO>|h=<hex>|...
 * The memo's plain fields are NOT covered by the digest, so a verifier
 * must cross-check them against the report it displays — a memo could
 * carry a valid digest for one mint next to a hand-edited mint=/score=
 * for another. parseMemoFields + compareMemoFieldsToReport do that check.
 * @param {string} memoText
 * @returns {{mint: string|null, score: number|null, band: string|null,
 *            ts: string|null, digest: string|null}|null}
 *   null only for non-string input; absent/malformed fields are null.
 */
export function parseMemoFields(memoText) {
  if (typeof memoText !== "string") return null;
  const fields = { mint: null, score: null, band: null, ts: null, digest: null };
  for (const segment of memoText.split("|")) {
    const eq = segment.indexOf("=");
    if (eq <= 0) continue;
    const key = segment.slice(0, eq).trim();
    const value = segment.slice(eq + 1).trim();
    if (key === "mint" && value) fields.mint = value;
    else if (key === "score") {
      const m = value.match(/^(\d+)\/100$/);
      fields.score = m ? Number(m[1]) : null;
    } else if (key === "band" && value) fields.band = value;
    else if (key === "ts" && value) fields.ts = value;
    else if (key === "h" && /^[0-9a-fA-F]{64}$/.test(value)) fields.digest = value.toLowerCase();
  }
  return fields;
}

/**
 * Cross-check parsed memo fields against a report object. Only fields
 * actually present in the memo are checked (absent fields are skipped).
 * @param {object|null} fields output of parseMemoFields()
 * @param {object|null} report a report object (mint/score/band)
 * @returns {string[]} human-readable mismatches; empty means consistent
 */
export function compareMemoFieldsToReport(fields, report) {
  const mismatches = [];
  if (!fields || !report) return mismatches;
  if (fields.mint != null && report.mint != null && fields.mint !== report.mint) {
    mismatches.push(`mint: memo says ${fields.mint}, report shows ${report.mint}`);
  }
  if (fields.score != null && typeof report.score === "number" && fields.score !== report.score) {
    mismatches.push(`score: memo says ${fields.score}/100, report shows ${report.score}/100`);
  }
  if (fields.band != null && report.band != null && fields.band !== report.band) {
    mismatches.push(`band: memo says ${fields.band}, report shows ${report.band}`);
  }
  return mismatches;
}
