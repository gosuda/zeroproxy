# ZeroProxy — product context for design

## What it is

A **security/privacy proxy** that lets users load untrusted web pages through an isolation layer.

- User types a URL on the landing page → the proxy fetches the target site
- Before the target's JS reaches the browser, a **Rust→WASM AST rewriter** (built on OXC) transforms every script
- The rewritten script sees a *virtual* `location`, `window`, `document.cookie`, storage, fetch, etc. — not the real ones
- A **Service Worker** intercepts every subresource request the page makes
- Net effect: the target page can't tell what origin it's really running on, can't reach the user's real cookies, can't fingerprint via real `navigator`, can't escape into the parent

## Philosophy: 탈출 없는 감옥 (escape-proof prison)

The team's internal name for the strict mode is "the prison the page can't escape from." Every API surface is mediated; there is no hole through which a hostile script can introspect its real environment. Design should communicate **containment, mediation, careful isolation** — not friendly approachability.

This is closer in spirit to:
- A vault door
- An airlock
- A clean-room transfer chamber
- A debugger's sandbox

Than to:
- A "browse safely!" consumer VPN
- A friendly "get started in 60 seconds" SaaS
- A productivity app

## Who uses it

- Security researchers analyzing suspicious pages
- Developers testing how their sites behave under origin confusion
- Privacy-conscious users who want to view content without leaking identity
- People who treat the open web as adversarial

All of them are technical. None of them need to be sold on the idea — they need the tool to feel **precise and trustworthy** the moment they see it.

## The two flows from the landing page

1. **Open a new target**
   - User types URL → form submit
   - JS encrypts the URL, registers it with the Service Worker
   - Browser navigates to `/zp/p/<encrypted>#k=<key>` on the proxy origin
   - Target page renders there, fully sandboxed

2. **Land on a share link**
   - URL already looks like `/zp/p/<encrypted>#k=<key>`
   - Page auto-detects, decrypts, hands off to the SW, navigates
   - User sees status messages during the ~1s handoff: 
     "Preparing isolated transport…" → "Opening through ZeroProxy…"

Both flows route through the **same `index.html`**. The form is visible always; the share flow just runs in the background and redirects before the user typically interacts.

## Status messages (the only feedback during boot)

These currently render in `<p id="status" role="status">`:

| State | Message |
|---|---|
| SW registering | `Preparing isolated transport…` |
| Page ready | `Ready.` |
| Form submitted | `Opening through ZeroProxy…` |
| Share link decrypting | (silent, then redirect) |
| Failure | error code text, in `.err` class (red) |

Treat these as a first-class design surface. They are the user's only signal that the isolation chamber is real. Skeleton states, status dots, monospace tickers, subtle pulses — all welcome. The current red error color (#991b1b) can change to fit the chosen palette.

## What the page is *not*

- Not a marketing site
- Not a dashboard
- Not a product listing
- Not a settings panel

It is a **single-action launcher** with status feedback. One input, one button, one status line, identity. That's the whole canvas. The challenge is making something with that little ceremony feel sophisticated rather than empty.
