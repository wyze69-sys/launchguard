# LaunchGuard

Paste a Solana token mint. Get a risk report you can verify.

LaunchGuard reads live on-chain facts about a token mint (mint authority,
freeze authority, holder concentration, supply, Token-2022 extensions,
Raydium liquidity), scores rug/pull risk with a transparent rule engine,
explains every flag in plain words, rates its own data confidence, and can
anchor the finished report — including a SHA-256 digest of the full report
JSON — on Solana itself (a Memo transaction on devnet) so anyone can verify
that a report with that digest existed, for which mint, at what time.

LaunchGuard is an informational screening tool, not financial advice.

## Why both AI/agent + Solana are essential

- Remove the scoring agent and there is no report: raw RPC numbers do not tell
  a new buyer whether a mint is dangerous. The scoring agent is a
  deterministic, transparent rule engine (an automated scoring agent — no
  black-box model, no LLM): the same facts always produce the same score,
  and every rule is listed below.
- Remove Solana and there is nothing to score and no verifiable record: the
  facts come from Solana RPC and the report record lives in a Solana
  transaction.

## Quick start

ES modules do not load from `file://`, so serve the folder over HTTP:

```bash
cd launchguard
npx serve .            # or: python3 -m http.server 8000
# then open http://localhost:3000  (npx serve) or http://localhost:8000 (python)
```

Open `index.html`, paste a mint address, choose a cluster, press **Score it**.
Two sample buttons are built in:

- **Sample: ruggy token (offline demo data)** — renders a HIGH RISK report
  from built-in sample facts through the same scoring engine. No RPC call is
  made; the UI labels it as offline demo data.
- **Sample: USDC (clean)** — fills the real USDC mint
  (`EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v`) and runs the live mainnet path.

## Run the tests

```bash
npm test   # node:test, fully offline, no network calls
```

Covers the scoring engine (`test/risk.test.js`), RPC endpoint resolution
(`test/config.test.js`), the memo/transaction builder
(`test/memo.test.js`: base58 vectors, instruction shape, transaction
serialization parsed back byte by byte, report-memo format, demo mode),
the RPC data layer (`test/solana.test.js`), Token-2022 extension flags
(`test/extensions.test.js`), the liquidity check — including a
stubbed-fetch concurrency test proving the liquidity queries are issued
concurrently with `getAccountInfo` and that their failure never rejects
a report (`test/liquidity.test.js`) — and verifiable reports: canonical
serialization, digest stability, tamper detection, memo digest round-trip
and the confidence rules (`test/report.test.js`).

## How to add your Helius key

The public Solana RPC endpoints rate-limit aggressively (HTTP 429), and the
hackathon organizers' own tip is "never demo on a public RPC endpoint". A
free Helius endpoint fixes this. Pick ONE of the two routes:

### Browser (the demo page)

1. Go to https://dashboard.helius.dev, create a free account and a project,
   and copy your endpoint URL. It looks like
   `https://mainnet.helius-rpc.com/?api-key=YOUR_KEY` (with your real key in
   place of `YOUR_KEY`).
2. Open `index.html` and find the commented `LAUNCHGUARD_CONFIG` script block
   just above the module script (search for `LAUNCHGUARD_CONFIG`).
3. Uncomment the block and paste your URL over the placeholder.
4. Reload the page. The muted line under the buttons shows the RPC host in
   use (host only — your key is never displayed).

Alternatively, edit `src/lib/config.js`: it documents the same snippet and
the exact placeholder location.

### Node (scripts/tests)

Set environment variables — no file edits needed:

```bash
LAUNCHGUARD_RPC_MAINNET="https://mainnet.helius-rpc.com/?api-key=YOUR_KEY" \
LAUNCHGUARD_RPC_DEVNET="https://devnet.helius-rpc.com/?api-key=YOUR_KEY" \
node your-script.js
```

Resolution order (first match wins), implemented in `src/lib/config.js`:

1. `globalThis.LAUNCHGUARD_CONFIG?.rpcEndpoints?.[cluster]` (browser snippet)
2. `LAUNCHGUARD_RPC_MAINNET` / `LAUNCHGUARD_RPC_DEVNET` environment variables
3. Public endpoints: `https://api.mainnet-beta.solana.com`,
   `https://api.devnet.solana.com`

Never commit a real API key to git. The placeholders in this repo are
placeholders only.

## How scoring works

`src/lib/risk.js` is a pure function: facts in, score + flags out. Score is
0 (safest) to 100 (highest risk), clamped to that range. Bands:
**0-29 LOWER OBSERVED RISK · 30-59 CAUTION · 60-100 HIGH RISK**. (The low band is named LOWER OBSERVED RISK: the score reports what was observed on-chain, not a guarantee of safety.)

| Rule | Condition | Points | Severity |
|---|---|---|---|
| Mint authority | still active (new supply can be created) | +30 | high |
| Mint authority | status could not be read | +0 (informational — unknown never punishes; the gap is carried by the data-confidence indicator) | low |
| Freeze authority | active (holder accounts can be frozen) | +25 | high |
| Freeze authority | status could not be read | +0 (informational — unknown never punishes; the gap is carried by the data-confidence indicator) | low |
| Largest token account | holds ≥ 50% of supply | +25 | high |
| Largest token account | holds ≥ 25% of supply | +15 | medium |
| Largest token account | holds ≥ 10% of supply | +6 | low |
| Top 10 token accounts | hold ≥ 90% of supply | +15 | high |
| Top 10 token accounts | hold ≥ 85% of supply | +15 | high |
| Top 10 token accounts | hold ≥ 70% of supply | +8 | medium |
| Compound concentration | largest token account holds ≥ 50% of supply AND top 10 hold ≥ 90% — one account can already move the market alone, and when the top 10 also hold nearly everything there is no distributed holder base left to absorb it | +20 | high |
| Spread concentration | top 10 hold ≥ 90% of supply AND the largest token account holds ≥ 25% but under 50% — the supply is still controlled by a small group, just spread across accounts instead of sitting in one, and there is no distributed holder base | score is at least 60 (HIGH RISK); the flag carries the difference | high |
| Token-account count | fewer than 25 token accounts | +10 | medium |
| Token-account count | fewer than 100 token accounts | +4 | low |
| Permanent delegate (Token-2022) | a permanent delegate is set — it can move tokens out of any holder's account (and burn from it) | +30 | high |
| Default account state (Token-2022) | new token accounts are frozen by default | +25 | high |
| Paired control traps (Token-2022) | BOTH a permanent delegate AND default-frozen accounts — together a complete take-and-lock mechanism (tokens can be moved out of any holder's account, and new holders cannot move theirs), not two partial risks | score is at least 60 (HIGH RISK); the flag carries the difference | high |
| Non-transferable (Token-2022) | tokens cannot be transferred at all | +40 | high |
| Transfer fee (Token-2022) | tiered on the EFFECTIVE fee rate at a representative transfer of 1,000 tokens (see the transfer-fee note below): above 0% and below 1% | +2 | low |
| Transfer fee (Token-2022) | effective rate 1% to below 5% | +5 | low |
| Transfer fee (Token-2022) | effective rate 5% to below 20% | +10 | medium |
| Transfer fee (Token-2022) | effective rate 20% to below 50% | +20 | medium |
| Transfer fee (Token-2022) | effective rate 50% or above | +35 | high |
| Transfer fee (Token-2022) | fee size could not be read (unknown is not zero, and no tier can be computed) | +5 | low |
| Transfer-fee authority (Token-2022) | the fee configuration authority is still active alongside a scored fee (the fee can be changed later) | +5 | low |
| Transfer fee mutable (Token-2022) | a different fee is scheduled for a future epoch (informational: a fee authority can raise a fee up to 100%, and scheduled changes are visible in advance in the mint's fee schedule) | +0 | low |
| Transfers paused (Token-2022) | transfers are currently paused by the mint's pause authority — pausing blocks transfers, mints and burns, so the token cannot be sold at all right now | score is at least 60 (HIGH RISK); the flag carries the difference | high |
| Transfer hook (Token-2022) | transfers run custom program logic (only counted when the hook's programId is actually set) | +5 | low |
| Extensions unknown (Token-2022) | the mint is Token-2022 but its account could not be parsed, so its extension list could not be read (informational only — the same unparsed account already drives the authority-unknown flags, and the coverage gap is carried by the data-confidence indicator, so it is not charged a third time in the score) | +0 | low |
| Liquidity | no pool detected on any checked venue — Raydium AMM v4, Meteora DLMM, Meteora DAMM v2, Meteora DAMM v1 or Orca Whirlpool (informational only — **not** proof of a rug; the token may trade on another DEX or be pre-launch) | +0 | low |

Every flag is shown in the report with its points and a plain-words
explanation, and the UI shows the exact facts table the score came from.

**Intentional single-family HIGH RISK paths (by design, no family caps):**
HIGH RISK does **not** require flags from two different families, and no
per-family cap is applied — a single flag family can reach HIGH RISK on
its own, by design. The concentration family reaches exactly 60 on its
own: whale-50 (+25), concentration-90 (+15) and compound-concentration
(+20) sum to 60 (Calibration V3 — the LIBRA archetype, a token whose
supply sits in a handful of accounts, is meant to land exactly on the
HIGH RISK line). The Token-2022 control family can also pass 60 by
accumulation alone: for example, permanent-delegate (+30) together with
non-transferable (+40) sums to 70. Every point still comes from a named
flag whose points sum to the score — nothing is added by a hidden floor
or a cross-family rule on these paths.

Notes on the newer rules:

- **Token-2022 extensions** are read from the *same* `getAccountInfo`
  (jsonParsed) response as the authorities — `parsed.info.extensions` —
  with no extra RPC call. Classic Token-program mints cannot have
  extensions and never get extension flags. `hasConfidentialTransfer` is
  extracted and shown in the facts, but deliberately **not scored**:
  confidential transfers are a privacy feature, not a rug signal.
  `hasMintCloseAuthority` (a mint close authority is set) is likewise a
  **fact only, never scored**: a mint can only be closed once its supply
  is zero, so a close authority cannot directly take holders' tokens.
- **Transfer fees** use the *effective* fee, selected by the current
  epoch: in the `transferFeeConfig` extension, `olderTransferFee` is in
  effect until the current epoch reaches `newerTransferFee.epoch`, from
  which point the newer fee is the effective one. To make that call the
  scan fetches `getEpochInfo` in its second round — only for Token-2022
  mints that carry a `transferFeeConfig` — so a full scan of such a mint
  makes **6 RPC calls in 2 rounds** (every other mint still makes 5).
  If the epoch call fails, the older fee is reported as effective and
  the report's data-confidence reasons record the fee-schedule
  uncertainty. If there is no older fee — only a newer, future-dated
  one — the fee is reported as unknown rather than asserted as already
  in effect. The flag detail shows the effective fee and, when a
  different fee is scheduled for a future epoch, notes "scheduled to
  change to X% at epoch N".
- **Dormant-trap facts (authorities and fee cap):** the same parsed
  payload also carries who can change the transfer fee
  (`transferFeeConfigAuthority`), who can withdraw withheld fees
  (`withdrawWithheldAuthority`), the transfer hook's own authority, and
  the fee's per-transfer cap (`maximumFee`). These are surfaced in the
  facts table. The cap is what makes the fee tiers above *effective*
  rates: the fee on a transfer of `x` is `min(ceil(x * bps / 10000),
  maximumFee)`, scored at the frozen representative size of 1,000 UI
  tokens — a 50% rate with a tiny cap is not a 50% effective fee.
- **Pausable and scaled-UI extensions:** a mint that can be paused is a
  fact in the report; a mint whose transfers are *currently paused*
  floors at 60 (above). A scaled-UI-amount extension (displayed
  balances are scaled by an authority-set multiplier) is a fact-only
  line and is never scored — the raw amounts are unaffected.
- **Unrecognised extensions:** if a mint carries an extension this tool
  does not recognise (or an extension entry that cannot be parsed), the
  report's data-confidence reasons say so and mark extension coverage
  incomplete; the unknown extension is never silently ignored and never
  scored.
- **Slot and coverage receipt:** every report records the slot the mint
  account was read at (next to the timestamp), and carries a
  Checked-vs-Not-Checked receipt in plain language — what the scan
  checked (authorities, holder concentration, extensions by name,
  liquidity per venue) and what it did not check (whether LP tokens are
  locked or burned, whether holder accounts belong to the same owner,
  and the deployer's history — those are Pro checks). The facts table
  also displays the top-20 accounts' share of supply (display only; it
  is not a scored rule).
- **What revoking the mint authority does and does not mean:** a
  revoked mint authority means no further minting through that
  mechanism. It does not prevent burns, and it does not establish a
  permanently constant outstanding supply.
- **Concentration calibration (V4):** the top-10 tiers are graduated
  (≥70% → +8, ≥85% → +15, ≥90% → +15) so a token just under a step no
  longer falls off a cliff, and two compound shapes floor at HIGH RISK:
  one account holding ≥50% with the top 10 at ≥90% (compound
  concentration, +20), and the same top-10 control spread across
  accounts with the largest at ≥25% (spread concentration, floor 60).
  Both describe the same underlying fact — a small group controls the
  supply and there is no distributed holder base — whether the supply
  sits in one account or ten.
- **Holder wording:** the concentration facts are about token
  *accounts* (from `getTokenLargestAccounts`), not owners — one owner
  can control many accounts, and the largest account is often a pool
  vault or exchange wallet. The UI and flag text say "token account(s)"
  where accounts are meant.
- **Liquidity** is checked with plain JSON-RPC `getProgramAccounts`
  against five venue programs: Raydium AMM v4
  (`675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8`), Meteora DLMM
  (`LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo`), Meteora DAMM v2
  (`cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG`), Meteora DAMM v1
  (`Eo7WjKq67rjJQSZxS6z3YkapzY3eMj6Xy8X5EQVn5UaB`) and Orca Whirlpool
  (`whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc`). Each venue gets one
  query per mint position, memcmp on the mint address at that venue's
  pool-layout offsets — Raydium AMM-info baseMint (400) / quoteMint
  (432); Meteora DLMM LbPair token X mint (88) / token Y mint (120);
  Meteora DAMM v2 Pool token A mint (168) / token B mint (200), the
  offsets the Meteora cp-amm SDK publishes for exactly this filter;
  Meteora DAMM v1 Pool token A mint (40) / token B mint (72), from the
  documented Pool field order (lp_mint, then the two token mints);
  Orca Whirlpool token mint A (101) / token mint B (181) —
  with `dataSlice {offset: 0, length: 8}` returning the bytes the
  classifier needs. For Raydium that is the pool's status field (a u64
  at offset 0 of the AMM-info account): "detected" needs at least one
  **distinct** pool whose status is 1–7 (a live, initialized pool
  state); status 0 (uninitialized) is not a pool. The other venues'
  queries also memcmp the pool account's Anchor discriminator at
  offset 0, and a returned entry counts only when its first 8 bytes
  match that discriminator exactly — for those venues the check counts
  pool *existence*; their layouts carry no Raydium-style status field
  in the first 8 bytes, so none is claimed. Every offset above was
  verified against live pool accounts before it shipped (the mint
  bytes sit at the stated offsets in the raw account data). The same
  pool returned twice counts once per venue, the fact records a
  per-venue breakdown (`liquidity.venues`) alongside the total
  `poolCount`, and an entry that cannot be classified degrades its
  venue toward `unknown`.
  "Not-detected" means **no pool was found on those five venues** —
  it does **not** mean the token has no liquidity anywhere: it may
  trade on a venue the check does not cover (Pump.fun bonding curves,
  Raydium CLMM/CPMM, …), be pre-launch, or sit in a pool layout the
  queries miss, which is why the signal stays a 0-point informational
  flag.
  Any failure (blocked method, timeout, rate-limit — the liquidity
  queries retry a 429 once) degrades to status `unknown` and
  never fails the report. Every RPC call has a 10-second timeout
  (`RPC_TIMEOUT_MS` in `src/lib/config.js`), so a hung endpoint produces
  a typed timeout outcome instead of hanging the scan. LP burn/lock status is **not** inferred from
  these calls — the fact records `lpStatus: "not-checked"` rather than
  inventing a value.
- **Mega-mint holder data:** for mints with very large numbers of
  token accounts (USDC, wrapped SOL and USDT are the canonical cases)
  the RPC rejects the `getTokenLargestAccounts` call outright ("too
  many accounts requested"). When that happens the scan no longer
  fails: holder shares are reported as **unknown**, the verdict is
  computed from the remaining facts (authorities, extensions,
  liquidity), and the report's data-confidence reasons name the gap.
  Other RPC failures still fail the scan as before.
- **Data confidence** is reported alongside the score (it is not part of
  the score): `assessConfidence()` starts at `high` and adds one reason
  per problem — an authority unknown, holder count being a floor,
  Token-2022 extensions unknown, liquidity status `unknown`, or
  top-holder data missing. 0 reasons → `high`, 1 → `medium`, 2+ → `low`.
  Two honesty checks feed it as well: the displayed supply comes from
  `getTokenSupply`, and if the parsed mint's own supply/decimals
  disagree with it, a "supply sources disagree" reason is recorded;
  and if the returned largest accounts sum to more than the supply,
  the holder shares are reported as unknown (with a reason) instead of
  being scored.

## How the memo anchor verifies a report

After a report renders, the page shows an **Anchor this report on devnet**
section.

- **With a wallet connected** (e.g. Phantom set to devnet): the button builds
  a Solana Memo transaction containing the report memo text, asks the wallet
  to sign and send it, and links to the transaction on Solana Explorer.
  For this wallet path only, the page lazily loads a pinned build of
  `@solana/web3.js` (version 1.98.4, from CDN, only when the anchor
  button is clicked) so the wallet receives a real `Transaction` object
  — the shape Phantom expects. The transaction is built from the same
  memo instruction bytes as the hand-rolled builder. If web3.js cannot
  load (offline, blocked CDN), the page falls back to passing the
  hand-rolled serialized transaction bytes, and if the wallet rejects
  those, the failure is reported and nothing is broadcast. The shipped
  page itself has no npm dependencies; web3.js is never loaded for
  scoring, demo mode, or page load.
- **Without a wallet**: demo mode shows the exact memo text plus the unsigned
  transaction (base64), clearly labelled as NOT broadcast. Nothing is sent.

The memo text is a single versioned line (max 566 bytes, UTF-8):

```
LG1|mint=<mint address>|score=<n>/100|band=<band>|ts=<ISO timestamp>|h=<sha256 digest>|conf=<level>|<summary>
```

`LG1` is the format version marker. `h=` and `conf=` are optional: under
the 566-byte cap, `conf=` is dropped first and only then is the summary
detail truncated; `mint=`, `score=`, `band=`, `ts=` and `h=` are never
dropped. The two free-text prefix fields are length-bounded when the memo
is built (`ts=` to 40 chars, `band=` to 32 chars), so the cap holds for
any input. When the page builds a memo for a scored report, `ts=` is the
report's own `observedAt` — the timestamp inside the hashed report — not
a second clock reading. To verify a report later:

1. Open the transaction on https://explorer.solana.com (devnet cluster).
2. Read the Memo program instruction — its data is the memo text above.
3. The transaction's on-chain block time plus the memo's `ts=` field show
   when the report existed; the `mint=`, `score=` and `band=` fields show
   exactly what was claimed, for which token.
4. Compare the memo's `h=` digest with the digest of the report JSON (see
   below) — they must match exactly.

"Verify" means exactly this: the memo proves **that a report with this
exact digest existed on-chain by that time, for the mint named in the
memo, signed and submitted by the wallet that anchored it**, in a record
nobody can quietly edit afterwards. It does not prove LaunchGuard
authored the report (there is no LaunchGuard project key in this flow —
anyone can anchor a memo), and it does not prove the score was right —
that is why the scoring rules above are public and the engine is
unit-tested.

## Verifiable reports (canonical JSON + SHA-256 digest)

Every scored report is also a portable JSON object (`src/lib/report.js`):

```json
{
  "version": 1,
  "mint": "<address>",
  "cluster": "mainnet-beta",
  "slot": 123456789,
  "coverage": { "checked": ["..."], "notChecked": ["..."] },
  "observedAt": "<ISO timestamp>",
  "facts": { "...": "every fact the score was computed from" },
  "score": 0,
  "band": "LOWER OBSERVED RISK",
  "flagKeys": ["sorted", "flag", "keys"],
  "confidence": { "level": "high", "reasons": [] },
  "digest": "<sha256 hex, added after hashing>"
}
```

**Canonical serialization** (the exact bytes that are hashed): JSON with
object keys sorted lexicographically, recursively; no whitespace; array
order preserved; numbers rounded to **six decimal places** and printed
in the JS shortest round-trip form (so `62.5` and `62.50` hash
identically, and float noise below 1e-6 — e.g. `0.30000000000000004` —
can never break verification, while a real change at the 6th decimal,
such as supply `1000000.001` vs `1000000.004`, does change the digest).
At magnitudes ≥ 1e21 that shortest form uses exponent notation; it is
deterministic for this implementation, which is all verification
requires. Non-finite numbers canonicalize to `null`. The report's own
`digest` field is excluded from the hashed bytes. The digest is SHA-256
over the UTF-8 bytes of that string, via WebCrypto
(`crypto.subtle`, browser secure contexts + Node 20+), lowercase hex.

The digest binds the report's values **at 6-decimal precision**: the
facts, the score, the band, the sorted flag keys and the confidence.
The human-readable flag *detail* text is not part of the report object
and is **not** digest-bound — only the flag keys are.

**Verify it yourself:**

- In the page: use the **Verify a report** section — paste a report JSON
  (recomputed digest must equal its stored `digest`), or paste a memo
  text (its `h=` is compared against the currently displayed report, and
  its `mint=`/`score=`/`band=` fields are cross-checked against that
  report, since those plain fields are not covered by the digest — a
  digest match with disagreeing fields is reported as a field mismatch,
  never a plain match). The report panel's **Copy report JSON** button
  copies the full report including its digest.
- In code: `verifyReport(reportObject)` recomputes the digest ignoring
  the stored field and compares; `parseMemoDigest(memoText)` extracts
  `h=` from a memo, `parseMemoFields(memoText)` parses its fields, and
  `compareMemoFieldsToReport(fields, report)` cross-checks them. Change
  any scored fact (at 6-decimal precision), the score, the band, a flag
  key or the confidence and verification fails.

The transaction builder (`src/lib/memo.js`) is hand-rolled with no SDK: it
base58-decodes the fee payer and blockhash, compiles one memo instruction,
and emits a legacy transaction whose signature slot is zero-filled until the
wallet signs it. For the wallet submission path, the same instruction bytes
are also wrapped in a real web3.js `Transaction` (see the anchor section
above); both forms serialize to identical bytes for identical inputs.

## Architecture / layout

- `src/lib/risk.js` — pure scoring engine (0-100, flags with explanations). Unit-tested.
- `src/lib/solana.js` — JSON-RPC data layer (supply, largest accounts, mint
  authorities, Token-2022 extensions from the same response, liquidity
  check across Raydium AMM v4, Meteora DLMM/DAMM v2/DAMM v1 and Orca
  Whirlpool) with 429
  backoff (2s, then 5s, then a distinct rate-limit
  error). The liquidity queries run concurrently with `getAccountInfo`.
  Re-exports `buildReportMemo` from `memo.js` for compatibility.
- `src/lib/report.js` — canonical report objects, deterministic
  serialization, SHA-256 digest (WebCrypto), verifier, memo-digest parser,
  and the data-confidence assessment.
- `src/lib/config.js` — RPC endpoint resolution (global override → env var →
  public fallback) and the documented Helius placeholder.
- `src/lib/memo.js` — base58 codec, Memo instruction + hand-built legacy
  transaction, report-memo format (with report digest), wallet submission
  (web3.js Transaction object with serialized-bytes fallback), demo mode.
- `index.html` — the demo UI. Single file, dark theme, no build step; all
  dynamic content is rendered with `textContent`/DOM APIs (no `innerHTML`
  interpolation), and the mint input is validated client-side before any
  RPC call is made.
- `test/` — `risk.test.js`, `config.test.js`, `memo.test.js`,
  `solana.test.js`, `extensions.test.js`, `liquidity.test.js`,
  `report.test.js` (all offline).

No npm dependencies, no build step: plain ES modules served statically.

## Honest limits (v1, hackathon scope)

- Holder count is a floor derived from the largest-accounts call, not a full
  indexer count. When the call returns 20 accounts, the holder count is a
  floor of 20 (the exact count needs an indexer) and the holder-count
  scoring rules are skipped in that case, because the true count is unknown.
  Below 20, the count is exact only if the RPC returns all non-zero token
  accounts for the mint in that call. Counts are of token accounts, not
  owners.
- Token-2022 extensions are read from the parsed mint response (permanent
  delegate, transfer fee, non-transferable, default frozen, transfer hook,
  confidential transfer, pausable, scaled UI amount). If a Token-2022
  account comes back unparsed, the extension set is honestly recorded as
  unknown and scored as such; an extension the tool does not recognise is
  named in the data-confidence reasons as incomplete coverage.
- Liquidity detection covers Raydium AMM v4, Meteora DLMM, Meteora
  DAMM v2, Meteora DAMM v1 and Orca Whirlpool pools — a mint trading
  solely on another venue (Pump.fun bonding curves, Raydium CLMM/CPMM,
  …) reads as "not-detected", which is why that signal is a 0-point
  informational flag and never proof of anything. For the non-Raydium
  venues the check counts pool existence (verified by the pool account
  discriminator); it does not classify those pools' state the way it
  classifies Raydium's status field. LP burn/lock status is not
  checked (`lpStatus: "not-checked"`): pool existence alone cannot
  establish it.
- The on-chain anchor is a devnet Memo transaction; mainnet anchoring is a
  configuration change, not new code.
- Wallet anchoring builds a real web3.js `Transaction` object for the
  wallet's `signAndSendTransaction` when the pinned web3.js build can be
  loaded (see above); the serialized-bytes form remains only as a
  fallback for providers that accept it. Wallet Standard discovery is
  not implemented — the page reaches the Phantom-style injected provider
  (`window.solana`).
- A memo anchor proves what was said and when — not that the score was
  correct. Scoring is heuristic: a clean score is not a safety guarantee.
- Public RPC endpoints rate-limit (HTTP 429). The data layer backs off twice
  and then fails with a specific message; use a keyed endpoint (Helius) for
  anything beyond a quick look.

Built solo by Wyze for the Dev3pack Global Hackathon 2026 (Nov 27-29).
