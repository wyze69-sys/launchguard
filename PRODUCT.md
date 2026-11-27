# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Primary: new Solana token buyers who are about to buy a token they found recently. They are not engineers; they cannot read raw mint data, and they need one clear answer — what are the warning signs on this mint — before they spend money.

Secondary: Dev3pack Global Hackathon 2026 judges evaluating the live demo. They scan the page the way a user would, then check that the report is real: live on-chain facts, a transparent score, and a record they can verify on-chain themselves.

## Product Purpose

LaunchGuard reads a Solana token mint's live on-chain facts (mint authority, freeze authority, holder concentration, supply, Token-2022 extensions, liquidity on checked venues), scores rug risk 0–100 with a transparent rule engine that explains every flag in plain words, and lets the user anchor the finished report on Solana devnet as a Memo transaction — a verifiable record of what was said, about which mint, and when. A built-in verifier recomputes a report's SHA-256 digest so anyone can check a report was not changed after the fact.

Success means: a first-time visitor pastes a mint, understands the report without help, and can prove the report is genuine — all on one page, with no account and no install.

## Positioning

The report is the product, and the report can be verified. Block explorers show the same raw facts but do not score or explain them; other risk tools give a score the user cannot check. LaunchGuard's mechanism — transparent rules, every flag explained, the exact facts listed, and the digest anchored in an on-chain memo — is the part a neighbouring tool could not truthfully copy without becoming LaunchGuard.

## Operating Context

- One static page. The whole flow is: paste a mint → read the explained report → optionally anchor it on devnet with a wallet → optionally verify a report or memo in the section below.
- Two sample buttons support the demo: an offline "ruggy token" sample that renders a full HIGH RISK report with no network, and a USDC sample that makes a live network call.
- The demo is presented live to hackathon judges; a demo-video narration follows the page order: header → input row → report → verify → footer.
- Public RPC endpoints rate-limit (HTTP 429); users can paste their own keyed Helius endpoint into the page's commented LAUNCHGUARD_CONFIG block.

## Capabilities and Constraints

- Presentation only in this release (v0.4.4): the scoring engine, RPC layer, report/digest code, wallet discovery and anchor flow are unchanged and covered by the existing test suite.
- No external assets on the page: system font stack and system monospace stack only, no webfonts, images, or CDN stylesheets. (The wallet path lazy-loads a pinned web3.js build at runtime; that is existing behaviour, not page chrome.)
- Honesty copy is fixed: the page states what was checked and what was not, names coverage gaps instead of hiding them, and the footer reads "LaunchGuard is an informational screening tool, not financial advice."
- Anchoring happens on devnet only, and only with the user's own wallet; with no wallet the page shows a clearly labelled demo mode and broadcasts nothing.
- Built solo by Wyze, a computer-science student in Cambodia, for the Dev3pack Global Hackathon 2026 (Solana, Best App Overall).

## Evidence on Hand

- Working product at v0.4.3 with a 237-test suite passing.
- Live evaluation against 25 real tokens (documented rugs and clean controls) recorded in the project build log; a real Phantom wallet anchored a BONK report on devnet on 2026-11-27 (transaction recorded in the build log).
- No testimonials, user counts, or sales figures exist; future work must not invent any.

## Product Principles

1. Show the facts behind the score. Every number on the page can be traced to an on-chain fact listed on the same page.
2. Explain, don't just label. A flag the user cannot understand does not protect them.
3. Say what was not checked. Coverage gaps are printed on the report, not buried.
4. Make verification one step. The digest, the memo, and the verifier live on the same page as the report.
5. Never imply financial advice. LaunchGuard screens; the user decides.
