# Trap Notebook

Historical record to prevent repeating the same regressions. Judge current behavior from the code and the verification evidence of the corresponding commit.
Past measurements, hypotheses, and retired implementations are not currently accepted specifications or proof of current test passage.

## Reading and Recording
- At the start of a task, read the first 40 lines of `INDEX.md` and task keywords, then open only the relevant detail anchors.
- `INDEX.md` is a curated list of recent, unresolved, and recurrence-prevention entries. `LOG.md` preserves **only the body entries moved out of `INDEX.md` on 2026-08-25** and is not a full backup of subsequent category text. Locate source text in order from the detail anchor to the pinned commit link for that category.
- Record a new trap in its category file immediately after fixing it and prepend one row at the top of `INDEX.md`.
- Required detail fields: symptom and root cause, resolution or forbidden invariant, status and verification evidence, and code, commit, or related links.
- State the execution timestamp and scope for every verification. Distinguish unexecuted, unresolved, refuted, and retracted hypotheses from subsequent corrections.
- If a regression test exists, record its path under `Closed by`. Do not claim passage of a test that does not exist.
- Fold repeated experiments into their conclusion and refutation evidence while keeping an explicit anchor, key before-and-after metrics, and a minimal reproduction or trace method. Preserve pre-condensation category source links pinned to full commit SHAs rather than branch names.
- Never record strict CSP relaxation, direct egress, unrewritten source execution fallbacks, or site-specific stubs/no-ops as resolutions.

## INDEX Contract
`| YYYY-MM-DD | Category / Status | Single-sentence summary | category.md#existing-anchor |`
- One entry per line, with the summary at most 160 characters. Keep measurement dumps and investigation narratives in the detail files only.
- Place `{#anchor}` or `<a id="anchor"></a>` on the detail heading and link to an anchor that exists in the target file.
- Merge entries from the same investigation into a single row. State explicitly in the detail file when a later correction supersedes an earlier hypothesis.
- `test/js/static-policy.test.js` enforces the index length and link resolution contract.

## Categories and History
- [rewriter.md](rewriter.md): AST, HTML/CSS, URL rewriting, and page membrane.
- [sw-integration.md](sw-integration.md): document/request context, redirects, cookies, responses, and Service Worker lifecycle.
- [transport-regression.md](transport-regression.md), [tls-fingerprint.md](tls-fingerprint.md): client-TLS, transport, and wire identity.
- [wasm-page-rt.md](wasm-page-rt.md): raw ABI, linear memory, DOM boundary, and performance.
- [real-site-compat.md](real-site-compat.md), [build-deploy.md](build-deploy.md): real-site compatibility, build pipeline, and instrumentation.
- [LOG.md](LOG.md) is an immutable raw archive of the 2026-08-25 `INDEX.md` body entries. Do not edit it or append new entries. Find the original text of later category entries via the pinned commit links in each section.
- Current work and remaining CI acceptance criteria follow the [refactoring plan](../design/website-compat-refactor.md).

## Preserving Local Investigation Data
- The **27 scripts with uncommitted local modifications** in `.ai/dogfood` reported by the maintainer are not authorized for cleanup or deletion. This documentation pass did not access that workstation or recover uncommitted data.
- Before any cleanup, **back up both tracked and untracked files along with uncommitted changes outside the working tree and verify the backup**. Never discard local work without user permission; keep useful reproduction changes or migrate them into maintained test paths before cleaning up.
- Git history protects **committed source files only**. Running `checkout` or `reset` restores committed originals rather than recovering local edits, and bulk restoration of historical experiments is not a substitute for preserving local work.
- When reporting size reduction ratios, state the comparison commit, file set, measurement unit, and denominator. Do not generalize unverified percentages or reductions in a subset of documents to the entire repository or all evidence.
