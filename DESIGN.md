# Design

LaunchGuard v0.4.4 visual system. Replacement world (2026-11-27): the v0.4.3 dark page with Solana purple-green gradient glow is an anti-reference and is discarded, not polished. This document describes the system the page actually ships.

## Direction

Surface mode: **Operate**. The visitor has one job — check a mint before buying — so the page behaves like a tool, not a landing page. The world is the one its users already trust for checking things: the near-neutral, flat, densely-legible tooling family of Linear, Stripe Dashboard, and GitHub. White and light-gray surfaces, hairline borders, one blue accent used only where action or linkage lives, and data set in the system monospace. Nothing glows, nothing is decorated, and the only dark element on the page is the score readout, which earns its contrast: the score's colour is set by the scoring code (red / amber / green), and all three read clearly only on a dark ground.

Direction contract (surface brief, summary): THESIS — a risk report should look like a document you can check, not a poster. OWN-WORLD — flat light surfaces, 1px borders, system sans + system mono, one blue accent, one dark readout panel. STORY — paste mint → explained report → verify or anchor. FIRST VIEWPORT — product name and one-line job at the top, the mint input row directly under it, nothing competing. FORM — pinned by the redesign brief (near-neutral tooling world); seed: none (pinned). FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance.

## Colour

Restrained strategy: neutrals plus one accent. All values are CSS custom properties on `:root` in index.html.

| Token | Value | Job |
|---|---|---|
| `--bg` | `#f6f8fa` | Page ground |
| `--surface` | `#ffffff` | Panels, inputs, report blocks |
| `--inset` | `#f6f8fa` | Code, memo text, pre blocks |
| `--border` | `#d1d9e0` | Hairlines and panel borders |
| `--border-strong` | `#afb8c1` | Input borders, emphasis edges |
| `--text` | `#1f2328` | Primary text |
| `--muted` | `#59636e` | Secondary text, labels (4.5:1+ on white) |
| `--accent` | `#0969da` | Primary button, links, focus ring, brand mark |
| `--accent-hover` | `#0757ba` | Primary button hover |
| `--readout` | `#0d1117` | Score panel ground (the page's one dark surface) |
| `--high` | `#cf222e` | High-severity flags and errors |
| `--high-bg` | `#ffebe9` | High-severity flag tint |
| `--medium` | `#9a6700` | Medium-severity flags |
| `--medium-bg` | `#fff8c5` | Medium-severity flag tint |
| `--low` | `#59636e` | Low-severity flags |
| `--low-bg` | `#f6f8fa` | Low-severity flag tint |

Severity is never carried by colour alone: every flag prints its key and point value in bold text, and the score panel prints the band name in words next to the number.

The score number and the verify-result line take their colour from the existing JavaScript (inline styles, unchanged). The stylesheet never overrides those colours; it gives them grounds they remain legible on — the dark readout for the score, and a dark status line for a non-empty verify result.

## Typography

Two system stacks, no loaded fonts:

- Sans: `system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif` — all prose, labels, controls, headings.
- Mono: `ui-monospace, "SFMono-Regular", Menlo, Consolas, monospace` — mint addresses, digests, memo text, code, report JSON input. Data is mono because it is data, not as decoration.

Role scale (fixed, not fluid — this is an Operate surface):

| Role | Size / weight / leading |
|---|---|
| Product name (h1) | 20px / 600 / 1.25 |
| Panel heading (h3) | 15px / 600 / 1.35 |
| Body | 14px / 400 / 1.55 |
| Secondary / muted | 13px / 400 / 1.55 |
| Small print (RPC line) | 12.5px / 400 / 1.5 |
| Data (mono) | 12.5–13px / 400 / 1.5 |
| Score number | 56px / 700 / 1, tabular numerals |

Body measure is capped by the 760px column (≈75ch at 14px). Headings use `text-wrap: balance`; body copy uses `text-wrap: pretty`.

## Layout and spacing

- One column, max-width 760px, centred; page padding 32px sides-collapse to 16px under 640px.
- Spacing rhythm on a 4px base: 4 / 8 / 12 / 16 / 24 / 32. Related items sit 8–12px apart; sections separate by 24px; more space above a heading than below it.
- Flow order is fixed: header → scanner (input row, samples, RPC line) → report (`#out`) → verify panel → footer.
- Panels are flat white surfaces with a 1px border and 8px radius. No shadows except a single soft focus ring; no cards inside cards — flags and the score are report blocks, not nested panels.
- At ≤640px the input row stacks full-width and every control keeps a ≥44px touch height.

## Components

- **Primary button** ("Score it", anchor action): solid accent, white text, 6px radius, 44px min-height. Hover darkens one step; focus shows a 3px accent ring at 40% opacity plus a 2px white offset; disabled is visibly muted with a wait cursor.
- **Secondary buttons** (samples, Verify, Copy report JSON): white surface, 1px strong border, text colour; hover tints to the page ground.
- **Inputs**: white, 1px strong border, 6px radius; the mint input is mono. Focus border is the accent with the same ring as buttons. Placeholders use the muted colour.
- **Score readout**: flat `#0d1117` panel, 8px radius, the number in its runtime colour at 56px with the band as a bordered chip in the same colour. No gradient, no glow, no progress bar.
- **Flags**: full 1px border in the severity colour plus the severity tint as background (never a one-sided bar). The flag key and points are bold; the explanation follows in body text.
- **Facts table**: two columns (label 42%, value), hairline row separators, no row striping or hover paint; values that are addresses or digests wrap anywhere.
- **Errors** (`.err`): high-severity tint background, full border, body text — an error reads as a report block, not a toast.
- **Footer**: hairline top border, centred muted small print, honesty line verbatim.

## Motion and states

No decorative motion. The only transitions are 120ms background/border changes on controls. Every interactive element has default, hover, focus-visible, active, and disabled states. `::selection` is the accent at 20%. The page respects browser zoom and user font settings; nothing is sized in viewport units.

## Anti-references (do not reintroduce)

Purple-green gradients or glows anywhere; oversized hero headlines; pill/badge spam (the product name carries one plain-text descriptor, not a badge); cards inside cards; dark page chrome; emoji or unicode glyphs as icons; any external font, image, or stylesheet.

## Structure — v0.4.5 (top nav + 3 screens)

Added 2026-11-27 (v0.4.5) inside the v0.4.4 world above; no token, colour, or typography changes. The single long page is now three screens under a sticky top navigation bar.

- **Top nav (`.topnav`, sticky, `top: 0`)**: white surface, hairline bottom border, one compact row on a 760px inner column matching `main`. Left: the existing brand mark (same shield SVG in a bordered tile) + "LaunchGuard" (the page's `h1`) + the plain-text "Solana Risk Screening" descriptor (hidden at ≤640px to keep the row compact). Centre-left: text links **Check | Verify | About** — no hamburger at any width. Right: `#rpc-line`, moved into the nav unchanged in ID, muted small-print styling, and host-only text; it is single-line with an ellipsis when space is tight (full text remains in the DOM), right-aligned via `margin-left: auto`. At 390px the row stays single-line: tighter padding/gaps, 13px links, 11.5px RPC line, no horizontal overflow.
- **Screen 1 — Check (`#check`, default)**: the Check intro (the former hero sub-line and hero-note, verbatim), the scanner card (`#mint`, `#cluster`, `#go`, `#sample-ruggy`, `#sample-usdc`), `#env-warning` (+`#env-warning-text`), and `#out`. The report and the wallet anchor panel both render inside `#out` and stay on this screen.
- **Screen 2 — Verify (`#verify`)**: the existing verify panel (`#verify-input`, `#verify-btn`, `#verify-result`) with its explanatory copy moved verbatim, including the FIELD MISMATCH paragraph.
- **Screen 3 — About (`#about`)**: how it works; what is checked / not checked (coverage honesty, sourced from README "Honest limits" and the report's own coverage receipt); the scoring-band summary (0-29 LOWER OBSERVED RISK · 30-59 CAUTION · 60-100 HIGH RISK, with the naming note that the low band reports what was observed, not a safety guarantee); and the footer honesty block ("LaunchGuard is an informational screening tool, not financial advice."), moved here from the page foot. One stale README line was NOT copied: its claim that Wallet Standard discovery is not implemented is outdated (v0.4.3 implemented it, first in priority) — About states the implemented priority order instead.
- **Switching — CSS only, zero new JavaScript**: sections `#check` / `#verify` / `#about` (new static section IDs; all 12 functional IDs unchanged, exactly once each). Default: `#check { display: block }`, the other screens `display: none`. Deep links: `body:has(#verify:target)` / `body:has(#about:target)` hide Check and show the targeted screen; loading with `#verify` or `#about` opens that screen, no hash opens Check, `#check` opens Check. All screens stay in the DOM at load, so the frozen module script binds by ID at load and writes into hidden containers without error. The active nav link is indicated with the same state: the Check link carries the active styling (accent text, hairline border, inset ground) by default, and the `:has(...:target)` rules move that styling to the Verify or About link when their screen is targeted.
- **Flow order** (supersedes the v0.4.4 line above): top nav → active screen (Check: intro → scanner → report; Verify: verify panel; About: how it works → checked/not checked → scoring bands → footer honesty block).

## Copy layering — v0.4.6 (clarity pass)

Added 2026-11-27 (v0.4.6). No token, colour, typography, structure, or script changes — only the static words and their layering changed, after the owner rejected the v0.4.5 screens as developer-grade jargon walls.

- **Two layers on every screen.** The surface carries only the plain, short version: short sentences, everyday words, second person, no unexplained jargon. Every technical specific (venue/program names, the largest-accounts floor, unparsed-extension handling, wallet discovery order, public-RPC rate limits / HTTP 429, FIELD MISMATCH mechanics, SHA-256 canonical-form mechanics) lives in a collapsed native `<details>` section labelled "Technical details". Code identifiers (`window.solana`, `window.phantom.solana`) appear only inside details, never on the surface. Honesty terms that must stay on the surface carry a plain gloss in the same breath (e.g. "its fingerprint (SHA-256) — a code that changes if anyone edits the report").
- **Disclosure is native `<details>`/`<summary>` — zero JavaScript.** It reuses the existing details styling (hairline border, 6px radius, white surface); the summary is accent-coloured text with the standard focus ring, keyboard-operable natively. Nothing honest was deleted: every fact from the v0.4.5 copy is on the surface in plain words, inside details, or dropped with a written stale/false reason in the round's copy table.
- **Per screen.** Check: one-line job statement + one-line mint explainer on the surface; network/RPC specifics in details. Verify: two plain surface sentences plus one plain mismatch sentence ("If they don't match, don't trust that memo."); all mechanics in details. About: 2–3 sentence plain "How it works"; short plain "What we check" / "What we don't check" lists; scoring as a simple 3-row band list (`.bands`: hairline-separated rows, band name in bold, plain gloss after the dash); the "not financial advice" footer stays visible, never collapsed.
- **Mode stays Operate.** The rewrite follows the impeccable clarify playbook (message hierarchy: the one fact needed now, then the next action, then supporting detail behind disclosure) with distill's progressive-disclosure rule; the visual world above is untouched.
