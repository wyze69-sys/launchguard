import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MEMO_PROGRAM_ID,
  MEMO_MAX_LENGTH,
  base58Encode,
  base58Decode,
  buildMemoInstruction,
  buildMemoTransaction,
  serializeTransactionBase64,
  buildReportMemo,
  anchorReportDemoMode,
  explorerUrlForSignature,
} from "../src/lib/memo.js";
import { buildReportMemo as buildReportMemoFromSolana } from "../src/lib/solana.js";
import { scoreMint, summarize } from "../src/lib/risk.js";

const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const FEE_PAYER = "11111111111111111111111111111111"; // 32 zero bytes, valid base58

// --- base58 -----------------------------------------------------------------

test("base58: all-ones string is 32 zero bytes", () => {
  const bytes = base58Decode("11111111111111111111111111111111");
  assert.equal(bytes.length, 32);
  assert.ok(bytes.every((b) => b === 0));
  assert.equal(base58Encode(new Uint8Array(32)), "11111111111111111111111111111111");
});

test("base58: memo program id decodes to 32 bytes and round-trips", () => {
  const bytes = base58Decode(MEMO_PROGRAM_ID);
  assert.equal(bytes.length, 32);
  assert.equal(base58Encode(bytes), MEMO_PROGRAM_ID);
});

test("base58: known vector round-trips", () => {
  // "Hello World!" in base58 (well-known Bitcoin test vector).
  const bytes = new TextEncoder().encode("Hello World!");
  assert.equal(base58Encode(bytes), "2NEpo7TZRRrLZSi2U");
  assert.deepEqual([...base58Decode("2NEpo7TZRRrLZSi2U")], [...bytes]);
});

test("base58: USDC mint round-trips and invalid chars throw", () => {
  assert.equal(base58Encode(base58Decode(USDC)), USDC);
  assert.throws(() => base58Decode("0OIl"), /invalid character/);
});

// --- memo instruction ---------------------------------------------------------

test("memo instruction shape: program id, no keys, UTF-8 data", () => {
  const ix = buildMemoInstruction("LaunchGuard ✓ report");
  assert.equal(ix.programId, MEMO_PROGRAM_ID);
  assert.deepEqual(ix.keys, []);
  assert.ok(ix.data instanceof Uint8Array);
  assert.equal(new TextDecoder().decode(ix.data), "LaunchGuard ✓ report");
});

// --- transaction serialization --------------------------------------------------

// Minimal parser for the hand-built legacy transaction, used only by tests.
function parseTx(tx) {
  let offset = 0;
  const readShortvec = () => {
    let len = 0;
    let shift = 0;
    for (;;) {
      const byte = tx[offset++];
      len |= (byte & 0x7f) << shift;
      if ((byte & 0x80) === 0) break;
      shift += 7;
    }
    return len;
  };
  const sigCount = readShortvec();
  const signatures = [];
  for (let i = 0; i < sigCount; i++) {
    signatures.push(tx.slice(offset, offset + 64));
    offset += 64;
  }
  const header = [...tx.slice(offset, offset + 3)];
  offset += 3;
  const keyCount = readShortvec();
  const accountKeys = [];
  for (let i = 0; i < keyCount; i++) {
    accountKeys.push(tx.slice(offset, offset + 32));
    offset += 32;
  }
  const blockhash = tx.slice(offset, offset + 32);
  offset += 32;
  const ixCount = readShortvec();
  const instructions = [];
  for (let i = 0; i < ixCount; i++) {
    const programIdIndex = tx[offset++];
    const acctCount = readShortvec();
    const accounts = [...tx.slice(offset, offset + acctCount)];
    offset += acctCount;
    const dataLen = readShortvec();
    const data = tx.slice(offset, offset + dataLen);
    offset += dataLen;
    instructions.push({ programIdIndex, accounts, data });
  }
  assert.equal(offset, tx.length, "parser must consume the whole transaction");
  return { sigCount, signatures, header, accountKeys, blockhash, instructions };
}

test("transaction serialization parses back with the expected layout", () => {
  const memoText = "LG1|test memo";
  const blockhash = base58Encode(new Uint8Array(32).fill(7));
  const tx = buildMemoTransaction({ feePayer: FEE_PAYER, recentBlockhash: blockhash, memoText });
  const parsed = parseTx(tx);

  // Signature section: count 1, one 64-byte zero-filled placeholder.
  assert.equal(parsed.sigCount, 1);
  assert.equal(parsed.signatures.length, 1);
  assert.equal(parsed.signatures[0].length, 64);
  assert.ok(parsed.signatures[0].every((b) => b === 0), "unsigned tx must have a zero placeholder signature");

  // Header: 1 required signature, 0 readonly signed, 1 readonly unsigned.
  assert.deepEqual(parsed.header, [1, 0, 1]);

  // Account keys: fee payer first, then the memo program.
  assert.equal(parsed.accountKeys.length, 2);
  assert.deepEqual([...parsed.accountKeys[0]], [...base58Decode(FEE_PAYER)]);
  assert.deepEqual([...parsed.accountKeys[1]], [...base58Decode(MEMO_PROGRAM_ID)]);

  // Blockhash carried through unchanged.
  assert.deepEqual([...parsed.blockhash], [...new Uint8Array(32).fill(7)]);

  // One instruction referencing the memo program (index 1), no accounts,
  // data exactly the memo bytes.
  assert.equal(parsed.instructions.length, 1);
  assert.equal(parsed.instructions[0].programIdIndex, 1);
  assert.deepEqual(parsed.instructions[0].accounts, []);
  assert.equal(new TextDecoder().decode(parsed.instructions[0].data), memoText);
});

test("transaction accepts Uint8Array fee payer and blockhash", () => {
  const tx = buildMemoTransaction({
    feePayer: new Uint8Array(32).fill(1),
    recentBlockhash: new Uint8Array(32).fill(2),
    memoText: "hi",
  });
  const parsed = parseTx(tx);
  assert.ok(parsed.accountKeys[0].every((b) => b === 1));
  assert.ok(parsed.blockhash.every((b) => b === 2));
});

test("transaction rejects wrong-length fee payer / blockhash", () => {
  assert.throws(
    () => buildMemoTransaction({ feePayer: new Uint8Array(10), recentBlockhash: new Uint8Array(32), memoText: "x" }),
    /exactly 32 bytes/,
  );
  assert.throws(
    () => buildMemoTransaction({ feePayer: FEE_PAYER, recentBlockhash: "not base58!!", memoText: "x" }),
    /invalid character/,
  );
});

test("serializeTransactionBase64 round-trips the exact bytes", () => {
  const tx = buildMemoTransaction({
    feePayer: FEE_PAYER,
    recentBlockhash: new Uint8Array(32),
    memoText: "base64 check",
  });
  const b64 = serializeTransactionBase64(tx);
  assert.equal(typeof b64, "string");
  assert.deepEqual([...Buffer.from(b64, "base64")], [...tx]);
});

// --- report memo ----------------------------------------------------------------

test("buildReportMemo includes version marker, mint, score, band and timestamp", () => {
  const result = scoreMint({
    mintAuthorityActive: true, freezeAuthorityActive: true,
    topHolderPct: 62, top10HolderPct: 95, holderCount: 12, supplyUi: 1_000_000,
  });
  const memo = buildReportMemo(USDC, summarize(USDC, result), { timestamp: "2026-11-27T00:00:00.000Z" });
  assert.ok(memo.startsWith("LG1|"), memo);
  assert.ok(memo.includes(`mint=${USDC}`), memo);
  assert.ok(memo.includes(`score=${result.score}/100`), memo);
  assert.ok(memo.includes(`band=${result.band}`), memo);
  assert.ok(memo.includes("ts=2026-11-27T00:00:00.000Z"), memo);
  assert.ok(memo.length <= MEMO_MAX_LENGTH, `memo too long: ${memo.length}`);
});

test("buildReportMemo accepts a scoreMint result object directly", () => {
  const result = scoreMint({
    mintAuthorityActive: false, freezeAuthorityActive: false,
    topHolderPct: 4, top10HolderPct: 30, holderCount: 5000, supplyUi: 10,
  });
  const memo = buildReportMemo(USDC, result, { timestamp: "2026-11-27T00:00:00.000Z" });
  assert.ok(memo.startsWith("LG1|"));
  assert.ok(memo.includes("score=0/100"));
  assert.ok(memo.includes("band=LOWER OBSERVED RISK"));
});

test("buildReportMemo stays within the limit for very long summaries", () => {
  const memo = buildReportMemo(USDC, `score=1/100 band=LOWER RISK ${"x".repeat(5000)}`);
  assert.ok(memo.length <= MEMO_MAX_LENGTH);
});

test("buildReportMemo is re-exported from solana.js for existing imports", () => {
  assert.equal(buildReportMemoFromSolana, buildReportMemo);
});

// --- demo mode + explorer ---------------------------------------------------------

test("demo mode returns the unsigned tx and never claims broadcast", () => {
  const result = scoreMint({
    mintAuthorityActive: true, freezeAuthorityActive: false,
    topHolderPct: 5, top10HolderPct: 20, holderCount: 300, supplyUi: 10,
  });
  const demo = anchorReportDemoMode({ mintAddress: USDC, summary: summarize(USDC, result) });
  assert.equal(demo.demo, true);
  assert.equal(demo.broadcast, false);
  assert.equal(demo.sent, false);
  assert.ok(demo.memoText.startsWith("LG1|"));
  assert.match(demo.explanation, /nothing was broadcast/i);
  assert.match(demo.explanation, /DEMO MODE/);
  // The unsigned transaction is real, parseable, and unsigned (zero sig).
  const tx = new Uint8Array(Buffer.from(demo.unsignedTransactionBase64, "base64"));
  const parsed = parseTx(tx);
  assert.ok(parsed.signatures[0].every((b) => b === 0));
  assert.equal(new TextDecoder().decode(parsed.instructions[0].data), demo.memoText);
});

test("explorer URL for a signature points at devnet by default", () => {
  // FIX 7: signatures must be 32-128 base58 chars, so the placeholder was
  // lengthened to a valid-length base58 string (assertion intent unchanged).
  const SIG = "5abcSignature5abcSignature5abcSignature";
  assert.equal(
    explorerUrlForSignature(SIG),
    `https://explorer.solana.com/tx/${SIG}?cluster=devnet`,
  );
  assert.equal(
    explorerUrlForSignature(SIG, "mainnet-beta"),
    `https://explorer.solana.com/tx/${SIG}`,
  );
});

test("explorer URL returns null for a non-base58 signature (FIX 7)", () => {
  assert.equal(explorerUrlForSignature("abc?cluster=mainnet"), null);
  assert.equal(explorerUrlForSignature("5abcSignature5abcSignature5abcSig?cluster=mainnet"), null);
  assert.equal(
    explorerUrlForSignature("5abcSignature5abcSignature5abcSignature"),
    "https://explorer.solana.com/tx/5abcSignature5abcSignature5abcSignature?cluster=devnet",
  );
});

test("base58: empty input round-trips (FIX 12)", () => {
  assert.equal(base58Encode(new Uint8Array(0)), "");
  assert.deepEqual([...base58Decode("")], []);
  assert.equal(base58Encode(base58Decode("")), "");
});

test("buildReportMemo caps at 566 BYTES with multi-byte summary, prefix intact (FIX 5)", () => {
  const memo = buildReportMemo(USDC, `score=42/100 band=CAUTION ${"✓".repeat(300)}`, { timestamp: "2026-11-27T00:00:00.000Z" });
  assert.ok(new TextEncoder().encode(memo).length <= 566, `memo bytes: ${new TextEncoder().encode(memo).length}`);
  assert.ok(memo.includes("score=42/100"), memo.slice(0, 120));
  assert.ok(memo.startsWith(`LG1|mint=${USDC}|`), memo.slice(0, 120));
  // No split multi-byte character / replacement char at the truncation point.
  assert.ok(!memo.includes("�"), "truncation must not split a multi-byte character");
});

test("buildMemoTransaction throws for a 600-byte memo (FIX 5)", () => {
  assert.throws(
    () => buildMemoTransaction({ feePayer: FEE_PAYER, recentBlockhash: new Uint8Array(32), memoText: "x".repeat(600) }),
    /exceeding the 566-byte limit/,
  );
});

test("buildReportMemo: 566-byte cap holds for a 1,000-char ts, h= intact", () => {
  const digest = "c".repeat(64);
  const memo = buildReportMemo(USDC, { score: 10, band: "CAUTION", flags: [] }, {
    timestamp: "T".repeat(1000),
    digest,
  });
  assert.ok(new TextEncoder().encode(memo).length <= MEMO_MAX_LENGTH, `memo bytes: ${new TextEncoder().encode(memo).length}`);
  assert.ok(memo.includes(`h=${digest}`), "digest must survive whole");
  assert.ok(memo.includes(`ts=${"T".repeat(40)}`), "ts is bounded to 40 chars");
  assert.ok(!memo.includes("T".repeat(41)), "ts must not exceed the bound");
});

test("buildReportMemo: 566-byte cap holds for a 1,000-char band, h= intact", () => {
  const digest = "d".repeat(64);
  const memo = buildReportMemo(USDC, { score: 10, band: "B".repeat(1000), flags: [] }, {
    timestamp: "2026-11-27T00:00:00.000Z",
    digest,
  });
  assert.ok(new TextEncoder().encode(memo).length <= MEMO_MAX_LENGTH, `memo bytes: ${new TextEncoder().encode(memo).length}`);
  assert.ok(memo.includes(`h=${digest}`), "digest must survive whole");
  assert.ok(memo.includes(`band=${"B".repeat(32)}`), "band is bounded to 32 chars");
  assert.ok(!memo.includes("B".repeat(33)), "band must not exceed the bound");
});

test("buildReportMemo throws for a bad mint string (FIX 5)", () => {
  assert.throws(() => buildReportMemo("short", "score=1/100 band=LOWER RISK"), /mintAddress must be a string of length 32-44/);
  assert.throws(() => buildReportMemo(123, "score=1/100"), /mintAddress must be a string of length 32-44/);
});

test("transaction with a 300-byte memo has a two-byte shortvec data length (FIX 13)", () => {
  const memoText = "x".repeat(300);
  const tx = buildMemoTransaction({ feePayer: FEE_PAYER, recentBlockhash: new Uint8Array(32), memoText });
  const parsed = parseTx(tx);
  assert.equal(new TextDecoder().decode(parsed.instructions[0].data), memoText);
  assert.equal(parsed.instructions[0].data.length, 300);
  // Data-length shortvec sits at offset 168 in this fixed layout:
  // 1 sig-count + 64 sig + 3 header + 1 key-count + 64 keys + 32 blockhash
  // + 1 ix-count + 1 programIdIndex + 1 account-count = 168.
  // 300 encodes as two shortvec bytes [172, 2] (44|0x80, then 2).
  assert.equal(tx[168], 172);
  assert.equal(tx[169], 2);
});
