# ZeroProxy Landing Page — Design Brief

## Read first

- `context/product-philosophy.md` — what ZeroProxy is, who uses it, the "탈출 없는 감옥" spirit
- `context/current-index.html` — the page you're redesigning, exactly as it ships today
- `context/csp-policy.md` — hard constraints on fonts, scripts, images, weight

Don't skip these. The design only works if it sits inside the constraints and reflects the product's actual identity.

## The job

Redesign `current-index.html`. Functionally complete already — visually generic. Goal: **trendy + sophisticated** for a privacy/security tool. Not friendly-consumer, not enterprise-SaaS. Closer to a precision instrument.

## Workflow

### Step 1 — Three directions

Propose three design directions that are **philosophically distinct**, not three palettes of the same idea. Each direction is one paragraph: the aesthetic, the reference points, how it interprets "containment / isolation / mediated transport," and what the status messages feel like inside it.

Example axes (pick three from different rows, or invent your own):

- Terminal / system console — monospace, status indicators, "transport: ready" tickers, dense information
- Kenya Hara minimalism — overwhelming whitespace, one small mark, single focal action, near-silent
- Field.io / Linear dark — subtle gradient depth, micro-motion, precise typography, glassless
- Swiss / Pentagram editorial — large headline grid, hard typographic hierarchy, color used as accent only
- Brutalist hacker — exposed structure, raw HTML feel reframed as choice, declarative

Skip these (overused):
- Floating gradient blobs
- Generic glassmorphism / frosted cards
- "Trusted by Google, Meta…" logo strip
- 3-up feature card grid
- Dashboard hero screenshot
- "Get started in 60 seconds ✨" copy
- Emoji-heavy UI (this is a security tool)

### Step 2 — Three variants

User picks a direction. You then produce **three variants** under that direction, each a complete self-contained HTML file:

```
drafts/variant-a.html
drafts/variant-b.html
drafts/variant-c.html
```

Variants should differ in something meaningful (composition, motion strategy, density, mark vs no-mark, mono vs sans, etc.) — not just colors.

### Step 3 — User picks one, you polish

User selects one variant. Polish that one: typography rhythm, spacing math, motion easing, error state, focus ring, mobile breakpoint, prefers-reduced-motion fallback.

## Hard requirements (will break the page if violated)

### DOM contract — keep verbatim

The page boots via inline JS that depends on these exact IDs and tags. The boot script in `current-index.html` (the entire `<script>(() => { 'use strict'; ... })();</script>` block at the bottom) **must be copied into every variant unchanged**.

Required elements:

```html
<form id="open">
  <input id="url" autocomplete="url" spellcheck="false" 
         placeholder="https://example.com" required>
  <button type="submit">…label here…</button>
</form>
<p id="status" role="status"></p>
<script src="/zp/assets/zp-core.js"></script>
<script>(() => { /* boot script — paste exactly as in current-index.html */ })();</script>
```

You can:
- Change the button label
- Change the placeholder text
- Add wrapper divs / sections / aside content around the form
- Add decorative inline SVG anywhere
- Change `<h1>` content, replace `<p>` description with whatever
- Add additional `<p>`, `<div>`, etc.
- Style everything inside `<style>`

You cannot:
- Remove `id="open"`, `id="url"`, `id="status"`
- Remove `role="status"` from the status paragraph
- Add `type="email"` or change input attributes that affect form behavior
- Touch the boot `<script>` block

### CSP / weight — see `context/csp-policy.md`

Summary: no external fonts/CSS/JS/images. Inline everything. Target < 15KB total per file. The CSP meta tag from current-index.html (line 4) must remain in every variant.

### Status messages are a design surface

`<p id="status">` is the user's only feedback during the ~1s Service Worker boot. Possible texts that will appear there:

- `Preparing isolated transport…` (boot)
- `Ready.` (boot done)
- `Opening through ZeroProxy…` (after form submit)
- Error codes (in `.err` class — red currently, palette can change)

Design these states intentionally. Skeleton, pulse, monospace ticker, status dot, animated ellipsis — all welcome. Don't leave the status as an afterthought paragraph.

## Deliverable layout

```
drafts/
  variant-a.html    # full self-contained replacement
  variant-b.html
  variant-c.html
  NOTES.md          # one paragraph per variant: the central idea + what's different
```

User will integrate the chosen variant into `web/index.html` themselves — you don't need to touch anything outside `drafts/`.
