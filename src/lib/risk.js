// LaunchGuard risk scoring — pure functions, no network, fully unit-testable.
// Input is plain data assembled by solana.js from Solana RPC responses.

/**
 * Score a token mint's rug/pull risk from on-chain facts.
 * @param {object} facts
 * @param {boolean|null} facts.mintAuthorityActive  true if a mint authority can still create new supply
 * @param {boolean|null} facts.freezeAuthorityActive true if a freeze authority can freeze holder accounts
 * @param {number|null} facts.topHolderPct   % of supply held by the single largest holder (0-100)
 * @param {number|null} facts.top10HolderPct % of supply held by the 10 largest holders (0-100)
 * @param {number|null} facts.holderCount    number of token accounts with a non-zero balance
 * @param {number|null} facts.supplyUi       total supply in UI units
 * @param {string} [facts.programId]         owning token program (Token or Token-2022)
 * @param {object|null} [facts.extensions]   Token-2022 extension facts (see solana.js);
 *                                           null = Token-2022 mint but extensions unread
 * @param {object} [facts.liquidity]         { status: "detected"|"not-detected"|"unknown" }
 * @returns {{score:number, band:string, flags:Array<{key:string,severity:string,points:number,detail:string}>}}
 * score = 0 (safest) .. 100 (highest risk)
 */
export function scoreMint(facts) {
  const flags = [];
  let score = 0;
  const add = (key, severity, points, detail) => {
    score += points;
    flags.push({ key, severity, points, detail });
  };

  // LG-F3: normalise at the scorer boundary. An omitted (undefined)
  // authority means the same as null — unknown, not clean — matching
  // assessConfidence. Non-finite or out-of-range numeric facts are not
  // facts at all: they are treated as unknown (null) and no rule fires
  // on them, instead of silently scoring 0 or rendering as facts.
  const mintAuthorityActive = facts.mintAuthorityActive ?? null;
  const freezeAuthorityActive = facts.freezeAuthorityActive ?? null;
  const validPct = (v) =>
    typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 100 ? v : null;
  const topHolderPct = validPct(facts.topHolderPct);
  const top10HolderPct = validPct(facts.top10HolderPct);
  // LG2-P2: a holder count is a count — a non-integer (e.g. 24.5) is not
  // a fact and is normalised to unknown, like the LG-F3 pattern, so it
  // can never be rendered or scored as a number of token accounts.
  const holderCount =
    typeof facts.holderCount === "number" && Number.isInteger(facts.holderCount) && facts.holderCount >= 0
      ? facts.holderCount
      : null;

  if (mintAuthorityActive === true) {
    add("mint-authority", "high", 30, "Mint authority is still active: new supply can be created at any time.");
  } else if (mintAuthorityActive === null) {
    // Delta P-18: unknown never punishes — 0 points; the coverage gap is
    // carried by the data-confidence indicator (assessConfidence).
    add("mint-authority-unknown", "low", 0, "Mint authority status could not be read. Informational only: unknown is not scored; the gap is carried by the data-confidence indicator.");
  }

  if (freezeAuthorityActive === true) {
    add("freeze-authority", "high", 25, "Freeze authority is active: holder accounts can be frozen.");
  } else if (freezeAuthorityActive === null) {
    add("freeze-authority-unknown", "low", 0, "Freeze authority status could not be read. Informational only: unknown is not scored; the gap is carried by the data-confidence indicator.");
  }

  // Wording (LG-F13): these shares are about token ACCOUNTS, not owners —
  // one owner can control many accounts, and the largest account is often
  // a pool vault or exchange wallet.
  if (topHolderPct !== null) {
    if (topHolderPct >= 50) add("whale-50", "high", 25, `Largest token account holds ${topHolderPct.toFixed(1)}% of supply.`);
    else if (topHolderPct >= 25) add("whale-25", "medium", 15, `Largest token account holds ${topHolderPct.toFixed(1)}% of supply.`);
    else if (topHolderPct >= 10) add("whale-10", "low", 6, `Largest token account holds ${topHolderPct.toFixed(1)}% of supply.`);
  }

  if (top10HolderPct !== null) {
    if (top10HolderPct >= 90) add("concentration-90", "high", 15, `Top 10 token accounts hold ${top10HolderPct.toFixed(1)}% of supply.`);
    // Calibration V4, rule 1 — graduated tier (round-3 finding F3): the
    // old 70/90 steps made a 2.9-point top-10 difference (87.6% vs 90.5%)
    // swing 7 score points and dropped a real rug under the warned line.
    // The 85% tier earns the same +15 as the 90% tier: at 85% the top 10
    // already hold nearly everything that matters.
    else if (top10HolderPct >= 85) add("concentration-85", "high", 15, `Top 10 token accounts hold ${top10HolderPct.toFixed(1)}% of supply.`);
    else if (top10HolderPct >= 70) add("concentration-70", "medium", 8, `Top 10 token accounts hold ${top10HolderPct.toFixed(1)}% of supply.`);
  }

  // Calibration V3, rule 1 — compound concentration: when BOTH the
  // whale-50 and concentration-90 rules fire, one account can already
  // move the market alone AND the top 10 hold nearly everything, so
  // there is no distributed holder base left to absorb it: +20.
  if (flags.some((f) => f.key === "whale-50") && flags.some((f) => f.key === "concentration-90")) {
    add("compound-concentration", "high", 20, "Compound concentration: the largest token account holds at least 50% of supply and the top 10 hold at least 90% — one account can move the market alone and there is no distributed holder base left to absorb it.");
  }

  // Calibration V4, rule 2 — spread concentration (round-3 finding F2):
  // when concentration-90 fires WITHOUT whale-50 but WITH whale-25, the
  // supply is still controlled by a handful of accounts — it is just
  // spread across them instead of sitting in one. That is the insider
  // shape (a >=25% largest account on top of a >=90% top 10): there is
  // no distributed holder base, so the score floors at 60 (HIGH RISK),
  // mirroring the compound rule it parallels. The floor is carried by
  // this score-explaining flag holding the difference, so flag points
  // still sum to the score; additional flags still add on top.
  if (
    score < 60 &&
    flags.some((f) => f.key === "concentration-90") &&
    flags.some((f) => f.key === "whale-25") &&
    !flags.some((f) => f.key === "whale-50")
  ) {
    add("spread-concentration", "high", 60 - score, "Spread concentration: the top 10 token accounts hold at least 90% of supply and the largest holds at least 25%, spread across accounts rather than in one — a small group still controls the supply and there is no distributed holder base, so the score is at least 60.");
  }

  // Holder-count rules only apply when the count is exact. When
  // holderCountIsFloor is set the count is a floor of >=20 (the true count
  // is unknown), so neither holder rule may fire.
  if (holderCount !== null && !facts.holderCountIsFloor) {
    if (holderCount < 25) add("few-holders", "medium", 10, `Only ${holderCount} token accounts: distribution is very thin.`);
    else if (holderCount < 100) add("few-holders-100", "low", 4, `Only ${holderCount} token accounts so far.`);
  }

  // --- Token-2022 extension rules -------------------------------------------
  // Facts come from the SAME getAccountInfo jsonParsed response (no extra
  // RPC call), extracted in solana.js. Classic Token-program mints cannot
  // have extensions and get NO extension flags. `hasConfidentialTransfer`
  // is extracted and shown in the facts/report but deliberately NOT scored:
  // confidential transfers are a privacy feature, not a rug signal.
  const TOKEN_2022_PROGRAM_ID = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
  if (facts.extensions && typeof facts.extensions === "object") {
    const ext = facts.extensions;
    if (ext.hasPermanentDelegate) {
      // Delta P-19: 25 -> 30 (a permanent delegate can also burn, S-27).
      add("permanent-delegate", "high", 30, "A permanent delegate can move tokens out of any holder's account.");
    }
    if (ext.defaultFrozen) {
      // Delta P-19: 20 -> 25.
      add("default-frozen", "high", 25, "New token accounts are frozen by default: holders cannot move their tokens unless they are thawed.");
    }
    if (ext.nonTransferable) {
      // Delta P-16: 15 -> 40 — a token holders cannot move at all scored
      // below default-frozen was indefensible.
      add("non-transferable", "high", 40, "Tokens are non-transferable: holders cannot sell or move them.");
    }
    if (ext.hasTransferFee) {
      // The EFFECTIVE fee is selected by the current epoch in
      // extractExtensions (the newer schedule once its epoch arrives,
      // otherwise the older one); a differing newer fee whose epoch is
      // still ahead is only scheduled. A configured fee of exactly
      // 0 bps charges nothing, so it stays a visible fact
      // (hasTransferFee) but adds NO flag. When the fee size could not
      // be read at all (null), the flag still fires — unknown is not
      // the same as zero. LG-F6: a fee outside the valid basis-point
      // range (finite integer 0..10000) is not a fee fact either — it
      // is treated as unread (null), never rendered as a percentage.
      const rawBps = ext.effectiveFeeBasisPoints;
      const bps =
        typeof rawBps === "number" && Number.isInteger(rawBps) && rawBps >= 0 && rawBps <= 10000
          ? rawBps
          : null;
      const scheduledBps =
        typeof ext.scheduledFeeBasisPoints === "number" &&
        Number.isInteger(ext.scheduledFeeBasisPoints) &&
        ext.scheduledFeeBasisPoints >= 0 &&
        ext.scheduledFeeBasisPoints <= 10000
          ? ext.scheduledFeeBasisPoints
          : null;
      if (bps !== 0) {
        // Delta P-06: tiered scoring on the EFFECTIVE rate at the frozen
        // representative transfer of 1,000 UI tokens (see solana.js
        // REPRESENTATIVE_TRANSFER_UI): F(x)=min(ceil(x*b/10000), M).
        // GPT §1.4 tiers: <1% +2, 1-<5% +5, 5-<20% +10, 20-<50% +20,
        // >=50% +35. A fee whose size could not be read keeps the
        // historical flat +5 (unknown is not zero, and no tier can be
        // computed). Facts built without an effective-rate field fall
        // back to the configured bps as the rate.
        let points; let severity; let detail;
        if (bps === null) {
          points = 5; severity = "low";
          detail = "Transfers carry a transfer fee set in the mint (fee size could not be read).";
        } else {
          const rateBps =
            typeof ext.effectiveFeeRateBps === "number" && Number.isFinite(ext.effectiveFeeRateBps) && ext.effectiveFeeRateBps >= 0 && ext.effectiveFeeRateBps <= 10000
              ? ext.effectiveFeeRateBps
              : bps;
          if (rateBps < 100) { points = 2; severity = "low"; }
          else if (rateBps < 500) { points = 5; severity = "low"; }
          else if (rateBps < 2000) { points = 10; severity = "medium"; }
          else if (rateBps < 5000) { points = 20; severity = "medium"; }
          else { points = 35; severity = "high"; }
          detail = `Transfers carry a ${(bps / 100).toFixed(2)}% transfer fee (${bps} basis points) set in the mint.`;
          if (rateBps !== bps) {
            detail += ` After the per-transfer cap (maximum fee), the effective fee on a representative transfer of 1,000 tokens is ${(rateBps / 100).toFixed(2)}%.`;
          }
        }
        if (scheduledBps !== null) {
          detail += ` It is scheduled to change to ${(scheduledBps / 100).toFixed(2)}% at epoch ${ext.scheduledFeeEpoch}.`;
        }
        add("transfer-fee", severity, points, detail);
        // Delta P-06: +5 when the fee-config authority is still active
        // (the fee can be changed later), alongside a scored fee flag.
        if (typeof ext.transferFeeConfigAuthority === "string" && ext.transferFeeConfigAuthority.length > 0) {
          add("transfer-fee-authority", "low", 5, "The transfer fee can be changed later: the fee configuration authority is still active.");
        }
      }
      // Delta S-32: a differing scheduled fee is a distinct informational
      // flag (0 points — its points are an owner decision). Corrected
      // wording: the cap on a future fee is 100%, it takes effect from a
      // future epoch, and it is visible in advance in the schedule.
      if (scheduledBps !== null) {
        add("transfer-fee-mutable", "low", 0, `The transfer fee is scheduled to change to ${(scheduledBps / 100).toFixed(2)}% at epoch ${ext.scheduledFeeEpoch}. A fee authority can raise a transfer fee up to 100%; a scheduled change takes effect from a future epoch and is visible in advance in the mint's fee schedule, as this one is. Informational only (0 points).`);
      }
    }
    if (ext.hasTransferHook) {
      add("transfer-hook", "low", 5, "Transfers run custom program logic (transfer hook).");
    }
    // Calibration V3, rule 2 — paired control traps: a permanent
    // delegate AND default-frozen accounts together are a complete
    // take-and-lock mechanism (tokens can be moved out of any holder's
    // account, and new holders cannot move theirs), so the score floors
    // at 60 (HIGH RISK). The floor is carried by this score-explaining
    // flag holding the difference, so flag points still sum to the
    // score; additional flags still add on top.
    if (ext.hasPermanentDelegate && ext.defaultFrozen && score < 60) {
      add("paired-control-traps", "high", 60 - score, "Paired control traps: a permanent delegate (tokens can be moved out of any holder's account) together with default-frozen accounts (new holders cannot move their tokens) is a complete take-and-lock mechanism, so the score is at least 60.");
    }
    // Delta C-39/S-28: a mint whose transfers are CURRENTLY PAUSED
    // floors at 60 (paired-traps precedent): pausing blocks transfers,
    // mints and burns, so a paused token cannot be sold at all — a
    // present-tense fact, not a prediction. The floor is carried by
    // this flag so flag points still sum to the score. Merely being
    // ABLE to pause (pausableAuthorityActive) is a fact only, no points.
    if (ext.transfersPaused) {
      if (score < 60) {
        add("transfers-paused", "high", 60 - score, "Transfers are currently paused by the mint's pause authority: pausing blocks transfers, mints and burns, so this token cannot be sold at all right now, so the score is at least 60.");
      } else {
        add("transfers-paused", "high", 0, "Transfers are currently paused by the mint's pause authority: pausing blocks transfers, mints and burns, so this token cannot be sold at all right now.");
      }
    }
    // hasMintCloseAuthority is deliberately NOT scored: a mint can only
    // be closed when its supply is zero, so a close authority cannot
    // directly rug holders. It is surfaced as a fact only (facts table).
  } else if (facts.extensions === null && facts.programId === TOKEN_2022_PROGRAM_ID) {
    // Token-2022 mint whose account could not be parsed: the extension
    // risks above are unknown. This is a 0-point informational flag —
    // the same unparsed account already drives the mint/freeze
    // "unknown" flags, and the coverage gap is carried by the
    // data-confidence indicator (report.js assessConfidence), so scoring
    // it here too would charge one root cause three times.
    add("extensions-unknown", "low", 0, "This is a Token-2022 mint but its account could not be parsed, so its extensions could not be read and extension risks are unknown. Informational only: the coverage impact is carried by the data-confidence indicator, not the score.");
  }

  // --- Liquidity signal -------------------------------------------------------
  // Facts-first and deliberately weak: "not-detected" only means none of
  // the checked venues (Raydium AMM v4, Meteora DLMM, Meteora DAMM v2,
  // Meteora DAMM v1, Orca Whirlpool) had a pool for this mint in the
  // check's query shapes. The token may trade on another DEX, be
  // pre-launch, or sit in a pool layout the queries missed — none of
  // that is proof of a rug, so this is a 0-point informational flag.
  // "detected" and "unknown" add nothing (unknown must never punish a
  // mint for our own RPC failing).
  if (facts.liquidity && facts.liquidity.status === "not-detected") {
    add(
      "no-liquidity-detected",
      "low",
      0,
      "No pool was detected for this mint on the checked venues (Raydium AMM v4, Meteora DLMM, Meteora DAMM v2, Meteora DAMM v1, Orca Whirlpool). This is not proof of a rug: the token may trade on another DEX, be pre-launch, or use a pool the check cannot see.",
    );
  }

  score = Math.max(0, Math.min(100, score));
  // Delta C-33: the low band is LOWER OBSERVED RISK — the score reports
  // what was observed on-chain, not a guarantee of safety.
  const band = score >= 60 ? "HIGH RISK" : score >= 30 ? "CAUTION" : "LOWER OBSERVED RISK";
  return { score, band, flags };
}

/** One-line human summary used in the UI and in the on-chain memo. */
export function summarize(mintAddress, result) {
  const top = result.flags.slice(0, 2).map((f) => f.key).join(",") || "no major flags";
  return `LaunchGuard ${mintAddress.slice(0, 8)}.. score=${result.score}/100 band=${result.band} flags=${top}`;
}
