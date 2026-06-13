# AGENTS.md - rewriter-rs

## OVERVIEW

Standalone Rust crate that compiles to WASM and rewrites target HTML, CSS,
JavaScript, import maps, and share URLs for the browser membrane.

## STRUCTURE

```text
rewriter-rs/
+-- Cargo.toml          # crate manifest and clippy lint policy
+-- clippy.toml         # cognitive-complexity threshold
`-- src/
    +-- lib.rs          # wasm exports and public rewrite surface
    +-- html/           # lol_html document rewriting
    +-- css/            # SWC CSS parser/codegen URL rewriting
    +-- js/             # SWC JS parser/codegen URL/module rewriting
    `-- import_map/     # import-map address rewriting
```

## WHERE TO LOOK

| Task | Location | Notes |
| --- | --- | --- |
| WASM export surface | `src/lib.rs` | Build script consumes this through wasm-bindgen. |
| HTML document transform | `src/html/document.rs`, `src/html/mod.rs` | Large behavioral surface; protect with corpus tests. |
| JS module/dynamic URL rewriting | `src/js/swc_rewriter.rs`, `src/js/module_urls.rs` | Parser/codegen behavior is Rust-only coverage. |
| CSS URL replacement | `src/css/` | SWC CSS path. |
| Import maps | `src/import_map/` | Address normalization and rewrite rules. |
| Share URLs | `src/share_url.rs` | Crypto and URL envelope handling. |

## CONVENTIONS

- Rust behavior is not covered by `npm test`. Run
  `cargo test --manifest-path rewriter-rs/Cargo.toml` after rewriter changes.
- `npm run lint:rust` is clippy plus rustfmt only:
  `cargo clippy --manifest-path rewriter-rs/Cargo.toml --all-targets -- -D warnings`
  and `cargo fmt --manifest-path rewriter-rs/Cargo.toml --all --check`.
- `clippy::cognitive_complexity` is denied at threshold 15 through
  `Cargo.toml` and `clippy.toml`. Keep functions under budget without inline
  `#[allow(clippy::cognitive_complexity)]`.
- `scripts/build.mjs` builds this crate for `wasm32-unknown-unknown --release`
  and then runs `wasm-bindgen` into `rewriter-rs/target/wasm-bindgen`.

## ANTI-PATTERNS

- Do not edit `target/` or wasm-bindgen output as source.
- Do not rely on JS/Puppeteer tests alone for parser or rewriter changes.
- Do not introduce panic/unwrap paths into target-controlled input handling.
- Do not widen public wasm exports casually; browser assets and Go adapters may
  depend on exact names and result shapes.
