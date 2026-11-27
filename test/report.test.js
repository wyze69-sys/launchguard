import { test } from "node:test";
import assert from "node:assert/strict";
import {
  REPORT_VERSION,
  buildReport,
  canonicalReportJson,
  digestReport,
  verifyReport,
  parseMemoDigest,
  parseMemoFields,
  compareMemoFieldsToReport,
  assessConfidence,
} from "../src/lib/report.js";
import { buildReportMemo, MEMO_MAX_LENGTH } from "../src/lib/memo.js";
import { scoreMint } from "../src/lib/risk.js";

const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const TOKEN_2022 = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";

const cleanFacts = {
  mintAuthorityActive: false,
  freezeAuthorityActive: false,
  topHolderPct: 4,
  top10HolderPct: 30,
  holderCount: 5000,
  holderCountIsFloor: false,
  supplyUi: 1_000_000,
  programId: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
  extensions: {
    hasPermanentDelegate: false, hasTransferFee: false,
    effectiveFeeBasisPoints: null, scheduledFeeBasisPoints: null, scheduledFeeEpoch: null,
    nonTransferable: false, defaultFrozen: false, hasTransferHook: false, hasConfidentialTransfer: false,
    hasMintCloseAuthority: false,
  },
  liquidity: { status: "detected", poolCount: 3, lpStatus: "not-checked" },
};

function makeReport(facts = cleanFacts, observedAt = "2026-11-27T10:00:00.000Z") {
  return buildReport({ mint: USDC, cluster: "mainnet-beta", facts, result: scoreMint(facts), observedAt });
}

// --- buildReport shape ---------------------------------------------------------

test("buildReport: canonical shape, sorted flagKeys, rounded percentages", () => {
  const facts = {
    ...cleanFacts,
    mintAuthorityActive: true,
    freezeAuthorityActive: true,
    topHolderPct: 62.345678,
    top10HolderPct: 95.001,
  };
  const report = makeReport(facts);
  assert.equal(report.version, REPORT_VERSION);
  assert.equal(report.mint, USDC);
  assert.equal(report.cluster, "mainnet-beta");
  assert.equal(report.observedAt, "2026-11-27T10:00:00.000Z");
  assert.equal(report.score, scoreMint(facts).score);
  assert.equal(report.band, "HIGH RISK");
  assert.deepEqual(report.flagKeys, [...report.flagKeys].sort());
  assert.ok(report.flagKeys.includes("mint-authority"));
  assert.ok(report.flagKeys.includes("freeze-authority"));
  // Percentages are stored at the fixed 6-decimal precision that is hashed.
  assert.equal(report.facts.topHolderPct, 62.345678);
  assert.equal(report.facts.top10HolderPct, 95.001);
  assert.equal(report.confidence.level, "high");
});

// --- canonical serialization -----------------------------------------------------

test("canonical form: object key order does not change the digest", async () => {
  const report = makeReport();
  const shuffled = {
    slot: report.slot,
    coverage: report.coverage,
    confidence: report.confidence,
    flagKeys: report.flagKeys,
    band: report.band,
    score: report.score,
    facts: Object.fromEntries(Object.entries(report.facts).reverse()),
    observedAt: report.observedAt,
    cluster: report.cluster,
    mint: report.mint,
    version: report.version,
  };
  assert.equal(canonicalReportJson(shuffled), canonicalReportJson(report));
  assert.equal(await digestReport(shuffled), await digestReport(report));
});

test("canonical form: differences at the 6th decimal DO change the digest", async () => {
  // At the old 2-decimal precision these tampered values verified as
  // identical; at 6 decimals they must not.
  const a = makeReport({ ...cleanFacts, topHolderPct: 50.001 });
  const b = makeReport({ ...cleanFacts, topHolderPct: 50.004 });
  assert.notEqual(await digestReport(a), await digestReport(b));
  const s1 = makeReport({ ...cleanFacts, supplyUi: 1000000.001 });
  const s2 = makeReport({ ...cleanFacts, supplyUi: 1000000.004 });
  assert.notEqual(await digestReport(s1), await digestReport(s2));
});

test("canonical form: float noise below 1e-6 canonicalizes the same", async () => {
  // 6-decimal rounding still absorbs float noise: values differing only
  // below 1e-6 (e.g. 0.30000000000000004-style artifacts) hash identically.
  const a = makeReport({ ...cleanFacts, topHolderPct: 50.0000001 });
  const b = makeReport({ ...cleanFacts, topHolderPct: 50.0000002 });
  assert.equal(await digestReport(a), await digestReport(b));
  const c = makeReport({ ...cleanFacts, supplyUi: 0.30000000000000004 });
  const d = makeReport({ ...cleanFacts, supplyUi: 0.3 });
  assert.equal(await digestReport(c), await digestReport(d));
});

test("canonical form: nested keys sorted, digest field excluded", async () => {
  const report = makeReport();
  const canonical = canonicalReportJson(report);
  assert.ok(!canonical.includes('"digest"'));
  const withDigest = { ...report, digest: "f".repeat(64) };
  assert.equal(canonicalReportJson(withDigest), canonical);
  assert.equal(await digestReport(withDigest), await digestReport(report));
});

test("buildReport deep-copies facts: later nested mutation cannot change the report or its digest", async () => {
  const facts = {
    ...cleanFacts,
    extensions: { ...cleanFacts.extensions },
    liquidity: { ...cleanFacts.liquidity },
  };
  const report = makeReport(facts);
  const digestBefore = await digestReport(report);
  // Mutate the CALLER's nested objects after the report was built.
  facts.extensions.hasPermanentDelegate = true;
  facts.extensions.effectiveFeeBasisPoints = 999;
  facts.liquidity.status = "unknown";
  facts.liquidity.poolCount = null;
  assert.equal(report.facts.extensions.hasPermanentDelegate, false);
  assert.equal(report.facts.extensions.effectiveFeeBasisPoints, null);
  assert.equal(report.facts.liquidity.status, "detected");
  assert.equal(report.facts.liquidity.poolCount, 3);
  assert.equal(await digestReport(report), digestBefore);
});

// --- digest + verify ---------------------------------------------------------------

test("digestReport returns 64 lowercase hex chars and is deterministic", async () => {
  const report = makeReport();
  const d1 = await digestReport(report);
  const d2 = await digestReport(report);
  assert.match(d1, /^[0-9a-f]{64}$/);
  assert.equal(d1, d2);
});

test("verifyReport: intact report verifies, tampered report does not", async () => {
  const report = makeReport();
  const digest = await digestReport(report);
  const signed = { ...report, digest };
  const okResult = await verifyReport(signed);
  assert.equal(okResult.ok, true);
  assert.equal(okResult.computedDigest, digest);
  assert.equal(okResult.storedDigest, digest);

  const tampered = { ...signed, score: signed.score + 1 };
  const badResult = await verifyReport(tampered);
  assert.equal(badResult.ok, false);
  assert.notEqual(badResult.computedDigest, badResult.storedDigest);

  const unsigned = await verifyReport(report); // no digest field at all
  assert.equal(unsigned.ok, false);
  assert.equal(unsigned.storedDigest, null);
  assert.equal(unsigned.computedDigest, digest);
});

test("verifyReport: changing any scored fact breaks verification", async () => {
  const report = makeReport();
  const signed = { ...report, digest: await digestReport(report) };
  const alteredFacts = { ...signed, facts: { ...signed.facts, topHolderPct: 99 } };
  assert.equal((await verifyReport(alteredFacts)).ok, false);
  const alteredConfidence = { ...signed, confidence: { level: "low", reasons: ["x"] } };
  assert.equal((await verifyReport(alteredConfidence)).ok, false);
});

// --- memo digest ---------------------------------------------------------------------

test("parseMemoDigest extracts h= and rejects absent/malformed digests", () => {
  const hex = "a".repeat(64);
  assert.equal(parseMemoDigest(`LG1|mint=${USDC}|h=${hex}|flags=none`), hex);
  assert.equal(parseMemoDigest(`LG1|mint=${USDC}|h=${"A".repeat(64)}`), "a".repeat(64));
  assert.equal(parseMemoDigest(`LG1|mint=${USDC}|score=1/100`), null);
  assert.equal(parseMemoDigest("h=abc123"), null);
  assert.equal(parseMemoDigest(null), null);
});

test("memo with digest: h= present, cap holds, digest never truncated", async () => {
  const report = makeReport({ ...cleanFacts, mintAuthorityActive: true });
  const digest = await digestReport(report);
  const memo = buildReportMemo(USDC, scoreMint(report.facts), {
    timestamp: report.observedAt,
    digest,
    confidence: report.confidence.level,
  });
  assert.ok(memo.includes(`h=${digest}`), memo);
  assert.ok(memo.includes("conf=high"), memo);
  assert.equal(parseMemoDigest(memo), digest);
  assert.ok(new TextEncoder().encode(memo).length <= MEMO_MAX_LENGTH);
});

test("memo under cap pressure: conf= dropped first, h= and mint= survive whole", async () => {
  const digest = "b".repeat(64);
  const longSummary = `score=42/100 band=CAUTION ${"x".repeat(5000)}`;
  const memo = buildReportMemo(USDC, longSummary, {
    timestamp: "2026-11-27T00:00:00.000Z",
    digest,
    confidence: "low",
  });
  const bytes = new TextEncoder().encode(memo).length;
  assert.ok(bytes <= MEMO_MAX_LENGTH, `memo bytes: ${bytes}`);
  assert.ok(memo.startsWith(`LG1|mint=${USDC}|`), memo.slice(0, 80));
  assert.ok(memo.includes(`h=${digest}`), "digest must never be truncated or dropped");
  assert.ok(!memo.includes("conf="), "confidence is the first field dropped under cap pressure");
});

test("parseMemoFields extracts mint/score/band/ts/digest from an LG1 memo", () => {
  const hex = "a".repeat(64);
  const memo = `LG1|mint=${USDC}|score=42/100|band=CAUTION|ts=2026-11-27T10:00:00.000Z|h=${hex}|conf=high|flags=mint-authority`;
  assert.deepEqual(parseMemoFields(memo), {
    mint: USDC,
    score: 42,
    band: "CAUTION",
    ts: "2026-11-27T10:00:00.000Z",
    digest: hex,
  });
  // Band with spaces parses whole (it runs to the next pipe).
  const spaced = parseMemoFields(`LG1|mint=${USDC}|score=0/100|band=LOWER RISK|ts=2026-11-27T10:00:00.000Z`);
  assert.equal(spaced.band, "LOWER RISK");
  assert.equal(spaced.digest, null);
  // Absent/malformed fields are null; non-string input is null overall.
  assert.deepEqual(parseMemoFields("not a memo"), { mint: null, score: null, band: null, ts: null, digest: null });
  assert.equal(parseMemoFields(null), null);
});

test("compareMemoFieldsToReport: agreeing fields give no mismatches, tampered fields are named", async () => {
  const report = makeReport({ ...cleanFacts, mintAuthorityActive: true });
  const digest = await digestReport(report);
  const memo = buildReportMemo(USDC, scoreMint(report.facts), {
    timestamp: report.observedAt,
    digest,
    confidence: report.confidence.level,
  });
  assert.deepEqual(compareMemoFieldsToReport(parseMemoFields(memo), report), []);

  // Same digest, hand-edited plain fields: every edited field is reported,
  // so a digest match can never be presented as a plain MATCH for these.
  const tampered = memo
    .replace(`mint=${USDC}`, "mint=FakeMint111111111111111111111111111111111")
    .replace(`score=${report.score}/100`, "score=0/100")
    .replace(`band=${report.band}`, "band=LOWER RISK");
  const mismatches = compareMemoFieldsToReport(parseMemoFields(tampered), report);
  assert.equal(mismatches.length, 3);
  assert.ok(mismatches.some((m) => m.startsWith("mint:")));
  assert.ok(mismatches.some((m) => m.startsWith("score:")));
  assert.ok(mismatches.some((m) => m.startsWith("band:")));
  // Absent fields are skipped, not mismatches.
  assert.deepEqual(compareMemoFieldsToReport({ mint: null, score: null, band: null, ts: null, digest: null }, report), []);
  assert.deepEqual(compareMemoFieldsToReport(null, report), []);
});

test("memo without digest/confidence keeps the original LG1 format", () => {
  const memo = buildReportMemo(USDC, "score=1/100 band=LOWER RISK flags=none", {
    timestamp: "2026-11-27T00:00:00.000Z",
  });
  assert.ok(!memo.includes("h="));
  assert.ok(!memo.includes("conf="));
  assert.ok(memo.startsWith(`LG1|mint=${USDC}|score=1/100|band=LOWER RISK|ts=2026-11-27T00:00:00.000Z|`));
});

// --- confidence -----------------------------------------------------------------------

test("assessConfidence: complete data is high with no reasons", () => {
  const c = assessConfidence(cleanFacts);
  assert.equal(c.level, "high");
  assert.deepEqual(c.reasons, []);
});

test("assessConfidence: exactly one issue is medium", () => {
  const c = assessConfidence({ ...cleanFacts, liquidity: { status: "unknown", poolCount: null, lpStatus: "not-checked" } });
  assert.equal(c.level, "medium");
  assert.equal(c.reasons.length, 1);
});

test("assessConfidence: two or more issues is low", () => {
  const c = assessConfidence({
    ...cleanFacts,
    mintAuthorityActive: null,
    holderCountIsFloor: true,
    holderCount: 20,
  });
  assert.equal(c.level, "low");
  assert.equal(c.reasons.length, 2);
});

test("assessConfidence: each documented issue is detected", () => {
  // authorities unknown
  assert.equal(assessConfidence({ ...cleanFacts, freezeAuthorityActive: null }).reasons.length, 1);
  // holder floor
  assert.equal(assessConfidence({ ...cleanFacts, holderCountIsFloor: true }).reasons.length, 1);
  // Token-2022 extensions unknown (only counts for Token-2022)
  assert.equal(
    assessConfidence({ ...cleanFacts, programId: TOKEN_2022, extensions: null }).reasons.length,
    1,
  );
  assert.equal(
    assessConfidence({ ...cleanFacts, extensions: null }).reasons.length,
    0,
    "classic-program mint with null extensions is not an issue",
  );
  // top-holder data missing
  assert.equal(assessConfidence({ ...cleanFacts, topHolderPct: null }).reasons.length, 1);
  // everything wrong at once -> low, all five reasons
  const worst = assessConfidence({
    mintAuthorityActive: null,
    freezeAuthorityActive: null,
    topHolderPct: null,
    top10HolderPct: null,
    holderCount: 20,
    holderCountIsFloor: true,
    supplyUi: null,
    programId: TOKEN_2022,
    extensions: null,
    liquidity: { status: "unknown", poolCount: null, lpStatus: "not-checked" },
  });
  assert.equal(worst.level, "low");
  assert.equal(worst.reasons.length, 5);
});
