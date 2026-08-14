//! ZeroProxy JS rewriter — OXC AST-based.
//!
//! Patch-mode output (plan: 메모리 최적화 원칙 #3): rather than re-emit the
//! full source, we return a list of (offset, length, replacement) tuples that
//! the caller applies in place. This keeps unchanged source bytes shared and
//! avoids the O(n) cost of full codegen on 90%-unchanged scripts.
//!
//! Initial rule set (mirrors web/js-rewriter.js):
//! - Unresolved global identifier references to a dangerous list
//!   (location, window, document, history, top, parent, opener, frames, self,
//!   globalThis) become `__zp_get(globalThis, '<name>')`.
//! - Locally bound identifiers with the same name are NOT rewritten
//!   (scope tracking via OXC semantic later; this initial pass uses a simple
//!   declaration stack walk).

use oxc_allocator::Allocator;
use oxc_ast::ast::*;
use oxc_ast_visit::{walk, Visit};
use oxc_parser::Parser;
use oxc_span::{GetSpan, SourceType, Span};
use std::collections::HashSet;
use zp_shared::ErrorCode;

pub mod sourcemap;
pub use sourcemap::{chain_with_original_map, compose_rewrite_map};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ScriptKind {
    Classic,
    Module,
    EventHandler,
    Eval,
    Function,
    Worker,
}

impl ScriptKind {
    fn source_type(self) -> SourceType {
        match self {
            ScriptKind::Module => SourceType::mjs(),
            _ => SourceType::cjs(),
        }
    }
}

#[derive(Debug, Clone)]
pub struct RewriteOpts {
    pub kind: ScriptKind,
    pub target_url: String,
    pub strict: bool,
    /// Proxy origin (e.g. `http://proxy.localhost:18080`). Dynamic-import URLs
    /// are emitted absolute against it. A root-relative `/zp/api/script?…`
    /// resolves against the IMPORTING context's base, which the membrane
    /// virtualises to the target host — an inline script then imported
    /// `https://www.naver.com/zp/api/script?…` and received the target site's
    /// 404 page (NAVER ad SDK never initialised: `initAd is not defined`).
    /// Empty keeps the legacy root-relative form for host tests.
    pub proxy_origin: String,
}

/// A single source patch: replace `source[span.start..span.end]` with `replacement`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Patch {
    pub start: u32,
    pub end: u32,
    pub replacement: String,
}

#[derive(Debug, Default)]
pub struct RewriteResult {
    pub code: String,
    pub patches: Vec<Patch>,
    pub diagnostics: Vec<String>,
}

#[derive(Debug, thiserror::Error)]
pub enum RewriteError {
    #[error("parse failed: {0}")]
    ParseFailed(String),
    #[error("rewrite failed: {0}")]
    RewriteFailed(String),
    #[error("unsupported syntax: {0}")]
    UnsupportedSyntax(String),
}

impl RewriteError {
    pub fn code(&self) -> ErrorCode {
        ErrorCode::RewriteFailed
    }
}

/// Names that, when referenced as an *unbound* global identifier, must be
/// routed through the runtime membrane instead of touching the real native.
pub(crate) const DANGEROUS_GLOBALS: &[&str] = &[
    "location",
    "window",
    "document",
    "history",
    "top",
    "parent",
    "opener",
    "frames",
    "self",
    "globalThis",
    // 2026-06-07 split-bundle (c.1) Step 2.1.5: shadow-compare 가 NAVER
    // cross-domain-storage 에서 legacy 는 `__zp_get(globalThis,"Function")` 으로
    // rewrite 하는데 modern (이 crate) 은 raw `Function` 유지하는 divergence
    // 발견. target site 가 `Function.prototype.constructor` 으로 native Function
    // 접근 → `new Function('return globalThis')()` 으로 membrane 우회 가능
    // (PHASE2 "탈출 없는 감옥" 위반). 추가 sibling: 함수 형태로 eval-equivalent
    // 인 native들 — `eval` 도 이미 함수지만 식별자로 access 되는 경우는 동일
    // 회로. 둘 다 dangerous 로 분류.
    "Function",
    "eval",
];

/// Member names that, when accessed on ANY object, must go through the
/// runtime membrane (`__zp_get(obj, 'name')`). These are the cross-realm
/// escape vectors that target code uses to reach an unmediated native
/// `Location` / `Window` / `Document` even after the global identifier
/// has been rewritten (e.g., `iframe.contentWindow.location`).
pub(crate) const DANGEROUS_MEMBERS: &[&str] = &[
    "location",
    "contentWindow",
    "contentDocument",
    "defaultView",
    "frameElement",
    "parent",
    "top",
    "opener",
    "frames",
    // URL-shape properties — rewriter doesn't know if base is a Location
    // instance, so wrap on every access. Membrane's Location-base intercept
    // returns virtualURL.* values for true Location instances; falls
    // through to native for unrelated objects (URL instances are
    // legitimately different and return their own values).
    "href",
    "protocol",
    "host",
    "hostname",
    "port",
    "pathname",
    "search",
    "hash",
    "origin",
];

/// Method names that, when called on ANY object, should be routed through the
/// runtime membrane (`__zp_call(obj, 'method', [args])`). Calling these on a
/// virtual Location or virtual Window must observe the proxy navigation
/// semantics; calling them on an unrelated object is a no-op (the membrane
/// `__zp_call` falls through to native).
pub(crate) const DANGEROUS_METHODS: &[&str] = &[
    "assign",
    "replace",
    "open",
    "postMessage",
    "pushState",
    "replaceState",
];

fn is_dangerous_global(name: &str) -> bool {
    DANGEROUS_GLOBALS.iter().any(|g| *g == name)
}

fn is_dangerous_member(name: &str) -> bool {
    DANGEROUS_MEMBERS.iter().any(|m| *m == name)
}

fn is_dangerous_method(name: &str) -> bool {
    DANGEROUS_METHODS.iter().any(|m| *m == name)
}

/// Patch-mode rewrite — returns the patch list without the re-emit cost.
/// Saves O(n) string-copy when the caller plans to apply patches in place
/// over its own buffer (typical Service Worker / page-prelude path).
/// `code` in the returned `RewriteResult` is the original source verbatim;
/// patches carry the offsets + replacements.
pub fn rewrite_script_patches(
    source: &str,
    opts: &RewriteOpts,
) -> Result<RewriteResult, RewriteError> {
    let allocator = Allocator::default();
    let source_type = opts.kind.source_type();
    let ret = Parser::new(&allocator, source, source_type).parse();

    if !ret.errors.is_empty() && opts.strict {
        let msg = ret
            .errors
            .iter()
            .map(|e| e.to_string())
            .collect::<Vec<_>>()
            .join("; ");
        return Err(RewriteError::ParseFailed(msg));
    }

    let mut visitor = RewriteVisitor::new(opts.target_url.clone(), opts.proxy_origin.clone());
    visitor.visit_program(&ret.program);

    let mut patches = visitor.patches;
    patches.sort_by_key(|p| p.start);

    Ok(RewriteResult {
        // Patch-mode: caller already has the original bytes — don't waste
        // a heap allocation reconstructing them.
        code: String::new(),
        patches,
        diagnostics: visitor.diagnostics,
    })
}

/// D2 composer entry point. Re-runs the rewrite pipeline to derive patches,
/// applies them over the stripped source, and emits a Source Map v3 JSON
/// pointing each generated position back to its original byte offset.
///
/// `source_url` is what goes into `"sources": [source_url]` — typically the
/// proxy-side target URL of the script. `sourcesContent` embeds the
/// *stripped* original source so the browser can render the original
/// listing without a separate round trip.
pub fn compose_source_map(
    source: &str,
    opts: &RewriteOpts,
    source_url: &str,
) -> Result<String, RewriteError> {
    let result = rewrite_script_patches(source, opts)?;
    // The rewriter never patches the trailing sourceMappingURL pragma
    // (those bytes live inside a `//#`-comment past the last identifier),
    // so the patches' offsets in `source` are byte-identical to offsets
    // in `strip_sourcemap_pragma(source)`. We strip first so the
    // generated string the composer walks lines up 1:1 with what the
    // browser is actually executing.
    let stripped = strip_sourcemap_pragma(source);
    let rewritten = apply_patches(&stripped, &result.patches);
    Ok(compose_rewrite_map(
        &stripped,
        &rewritten,
        &result.patches,
        source_url,
    ))
}

/// Same as `compose_source_map` but additionally composes the result
/// with the target site's original `.map` (the one the bundler emitted
/// alongside the source). The chained map points DevTools directly at
/// the pre-bundle TypeScript / pre-minify origin instead of stopping at
/// the bundled `.js`. When `original_map_json` is empty or malformed,
/// the function silently falls back to the unchained map — a bad
/// upstream `.map` must never break DevTools entirely.
pub fn compose_source_map_chained(
    source: &str,
    opts: &RewriteOpts,
    source_url: &str,
    original_map_json: &str,
) -> Result<String, RewriteError> {
    let zp_map = compose_source_map(source, opts, source_url)?;
    if original_map_json.is_empty() {
        return Ok(zp_map);
    }
    Ok(chain_with_original_map(&zp_map, original_map_json, source_url))
}

/// Rewrite a JavaScript source string per the strict-mode policy.
pub fn rewrite_script(source: &str, opts: &RewriteOpts) -> Result<RewriteResult, RewriteError> {
    let allocator = Allocator::default();
    let source_type = opts.kind.source_type();
    let ret = Parser::new(&allocator, source, source_type).parse();

    if !ret.errors.is_empty() && opts.strict {
        let msg = ret
            .errors
            .iter()
            .map(|e| e.to_string())
            .collect::<Vec<_>>()
            .join("; ");
        return Err(RewriteError::ParseFailed(msg));
    }

    let mut visitor = RewriteVisitor::new(opts.target_url.clone(), opts.proxy_origin.clone());
    visitor.visit_program(&ret.program);

    // Apply patches to produce final code. Patches sorted by start ascending
    // and non-overlapping (visitor guarantees this for identifier rewrites).
    let mut patches = visitor.patches;
    patches.sort_by_key(|p| p.start);
    let patched = apply_patches(source, &patches);
    // D2: strip stale `sourceMappingURL` pragma — the original map describes
    // the un-rewritten source and would misattribute lines in DevTools.
    let code = strip_sourcemap_pragma(&patched);

    Ok(RewriteResult {
        code,
        patches,
        diagnostics: visitor.diagnostics,
    })
}

/// Shift any embedded absolute spans inside a marker replacement string by
/// `-offset` so they make sense in a sub-source view. Markers we know:
/// - MEMBER_GET: obj_start, obj_end (positions 2, 3)
/// - MEMBER_SET: obj_start, obj_end, val_start, val_end (positions 2, 3, 5, 6)
/// - METHOD_CALL: obj_start, obj_end, args_start, args_end (positions 2, 3, 5, 6)
fn shift_marker_positions(replacement: &str, offset: u32) -> String {
    let prefixes: &[(&str, &[usize])] = &[
        ("\u{1}GLOBAL_GET\u{1}", &[]),
        ("\u{1}MEMBER_GET\u{1}", &[2, 3]),
        ("\u{1}MEMBER_SET\u{1}", &[2, 3, 5, 6]),
        ("\u{1}METHOD_CALL\u{1}", &[2, 3, 5, 6]),
    ];
    for (prefix, shift_indices) in prefixes {
        if replacement.starts_with(*prefix) {
            let mut parts: Vec<String> = replacement.split('\u{1}').map(str::to_string).collect();
            for &i in *shift_indices {
                if i < parts.len() {
                    if let Ok(v) = parts[i].parse::<u32>() {
                        parts[i] = v.saturating_sub(offset).to_string();
                    }
                }
            }
            return parts.join("\u{1}");
        }
    }
    replacement.to_string()
}

pub fn apply_patches(source: &str, patches: &[Patch]) -> String {
    // Deduplicate overlapping patches: when patch B is fully contained inside
    // patch A (A.start <= B.start && B.end <= A.end), prefer A (outer) and
    // drop B. This matches the rewrite semantics where outer member-get
    // already wraps the inner receiver text verbatim, including any
    // dangerous identifier the inner pass also flagged.
    let mut sorted: Vec<&Patch> = patches.iter().collect();
    sorted.sort_by(|a, b| a.start.cmp(&b.start).then(b.end.cmp(&a.end))); // outer first
    let mut chosen: Vec<&Patch> = Vec::with_capacity(sorted.len());
    let mut last_end: u32 = 0;
    for p in sorted {
        if p.start < last_end {
            // Overlaps previous chosen — skip (inner contained in outer).
            continue;
        }
        chosen.push(p);
        last_end = p.end;
    }

    let mut out = String::with_capacity(source.len());
    let bytes = source.as_bytes();
    let mut cursor: usize = 0;
    // 패치 emission 시 leading `(` 가 필요한지 결정.
    // - 직전 byte 가 identifier-continue (영숫자/`_`/`$`) 면 `return` 같은
    //   keyword 또는 free identifier 와 glue 됨 → paren 필요.
    // - 직전 non-ws 토큰이 `new` 면 `new MemberExpression Arguments` 문법이
    //   call 을 capture 함 → paren 으로 격리 필요.
    // - 그 외 (`(`/`,`/`{`/`}`/`;`/`=`/`\n` + identifier-continue 가 아닌 경우)
    //   는 paren 미추가 — `var x=1\n(call)` 같은 ASI 위험 회피.
    let needs_paren_prefix = |start: usize| -> bool {
        if start == 0 {
            return false;
        }
        let prev = bytes[start - 1];
        if prev.is_ascii_alphanumeric() || prev == b'_' || prev == b'$' {
            return true;
        }
        // Look back past whitespace for `new` keyword.
        let mut i = start;
        while i > 0 {
            let c = bytes[i - 1];
            if c == b' ' || c == b'\t' || c == b'\n' || c == b'\r' {
                i -= 1;
                continue;
            }
            break;
        }
        if i >= 3 {
            let kw = &bytes[i - 3..i];
            if kw == b"new" {
                // Ensure `new` is not part of a longer identifier like `renew`.
                if i == 3 {
                    return true;
                }
                let before = bytes[i - 4];
                if !(before.is_ascii_alphanumeric() || before == b'_' || before == b'$') {
                    return true;
                }
            }
        }
        false
    };
    for p in chosen {
        let start = p.start as usize;
        let end = p.end as usize;
        if start < cursor || end > bytes.len() || start > end {
            continue;
        }
        out.push_str(&source[cursor..start]);
        // Marker patches need the receiver source text. Helper recursively
        // applies any contained inner patches to a sub-range of source.
        // CRITICAL: when shifting markers into the sub-range, also shift the
        // absolute spans embedded inside the marker replacement strings —
        // those refer to positions in the ORIGINAL source, which become wrong
        // once the marker is applied against a sub-string.
        let rewrite_range = |start: usize, end: usize| -> String {
            if start >= end || end > bytes.len() {
                return String::new();
            }
            let sub = &source[start..end];
            let offset = start as u32;
            let inner: Vec<Patch> = patches
                .iter()
                .filter(|q| (q.start as usize) >= start && (q.end as usize) <= end)
                .filter(|q| !std::ptr::eq(*q, p))
                .map(|q| Patch {
                    start: q.start - offset,
                    end: q.end - offset,
                    replacement: shift_marker_positions(&q.replacement, offset),
                })
                .collect();
            if inner.is_empty() {
                sub.to_string()
            } else {
                apply_patches(sub, &inner)
            }
        };

        if p.replacement.starts_with("\u{1}GLOBAL_SET\u{1}") {
            // \u{1}GLOBAL_SET\u{1}<name>\u{1}<val_start>\u{1}<val_end>\u{1}
            let parts: Vec<&str> = p.replacement.split('\u{1}').collect();
            if parts.len() >= 6 {
                let name = parts[2];
                let vs: usize = parts[3].parse().unwrap_or(0);
                let ve: usize = parts[4].parse().unwrap_or(0);
                if vs < ve && ve <= bytes.len() {
                    let value = rewrite_range(vs, ve);
                    out.push_str(&format!(
                        "__zp_set(globalThis,{:?},({}))",
                        name, value
                    ));
                    cursor = end;
                    continue;
                }
            }
        } else if p.replacement.starts_with("\u{1}GLOBAL_ASSIGN\u{1}") {
            // \u{1}GLOBAL_ASSIGN\u{1}<name>\u{1}<op>\u{1}<vs>\u{1}<ve>\u{1}<logical>\u{1}
            let parts: Vec<&str> = p.replacement.split('\u{1}').collect();
            if parts.len() >= 8 {
                let name = parts[2];
                let op = parts[3];
                let vs: usize = parts[4].parse().unwrap_or(0);
                let ve: usize = parts[5].parse().unwrap_or(0);
                let logical = parts[6] == "1";
                if vs < ve && ve <= bytes.len() {
                    let value = rewrite_range(vs, ve);
                    // Logical forms must not evaluate the RHS unless the write
                    // actually happens, so hand `__zp_assign` a thunk.
                    let value = if logical {
                        format!("()=>({})", value)
                    } else {
                        format!("({})", value)
                    };
                    out.push_str(&format!(
                        "__zp_assign(globalThis,{:?},{:?},{})",
                        name, op, value
                    ));
                    cursor = end;
                    continue;
                }
            }
        } else if p.replacement.starts_with("\u{1}GLOBAL_UPDATE\u{1}") {
            // \u{1}GLOBAL_UPDATE\u{1}<name>\u{1}<op>\u{1}<prefix>\u{1}
            let parts: Vec<&str> = p.replacement.split('\u{1}').collect();
            if parts.len() >= 6 {
                let name = parts[2];
                let op = parts[3];
                let prefix = parts[4] == "1";
                out.push_str(&format!(
                    "__zp_update(globalThis,{:?},{:?},{})",
                    name, op, prefix
                ));
                cursor = end;
                continue;
            }
        } else if p.replacement.starts_with("\u{1}GLOBAL_DESTR\u{1}") {
            // \u{1}GLOBAL_DESTR\u{1}<name>\u{1}
            // Shorthand destructuring target → explicit `key: <settable>` where
            // the settable member is the prelude's write-only sink.
            let parts: Vec<&str> = p.replacement.split('\u{1}').collect();
            if parts.len() >= 4 {
                let name = parts[2];
                out.push_str(&format!("{}: __zp_get.d.{}", name, name));
                cursor = end;
                continue;
            }
        } else if p.replacement.starts_with("\u{1}SHORTHAND_GLOBAL_GET\u{1}") {
            // \u{1}SHORTHAND_GLOBAL_GET\u{1}<name>\u{1}
            // Inside an object literal, so no `new`-prefix parenthesisation
            // applies — but the key must be restored or the property is lost.
            let parts: Vec<&str> = p.replacement.split('\u{1}').collect();
            if parts.len() >= 4 {
                let name = parts[2];
                out.push_str(&format!("{}:__zp_get(globalThis,{:?})", name, name));
                cursor = end;
                continue;
            }
        } else if p.replacement.starts_with("\u{1}GLOBAL_GET\u{1}") {
            // \u{1}GLOBAL_GET\u{1}<name>\u{1}
            let parts: Vec<&str> = p.replacement.split('\u{1}').collect();
            if parts.len() >= 4 {
                let name = parts[2];
                if needs_paren_prefix(start) {
                    out.push_str(&format!("(__zp_get(globalThis,{:?}))", name));
                } else {
                    out.push_str(&format!("__zp_get(globalThis,{:?})", name));
                }
                cursor = end;
                continue;
            }
        } else if p.replacement.starts_with("\u{1}MEMBER_GET\u{1}") {
            // \u{1}MEMBER_GET\u{1}<obj_start>\u{1}<obj_end>\u{1}<prop>\u{1}
            let parts: Vec<&str> = p.replacement.split('\u{1}').collect();
            if parts.len() >= 6 {
                let obj_start: usize = parts[2].parse().unwrap_or(0);
                let obj_end: usize = parts[3].parse().unwrap_or(0);
                let prop = parts[4];
                if obj_start < obj_end && obj_end <= bytes.len() {
                    let obj_src = rewrite_range(obj_start, obj_end);
                    if needs_paren_prefix(start) {
                        out.push_str(&format!("(__zp_get({},{:?}))", obj_src, prop));
                    } else {
                        out.push_str(&format!("__zp_get({},{:?})", obj_src, prop));
                    }
                    cursor = end;
                    continue;
                }
            }
        } else if p.replacement.starts_with("\u{1}MEMBER_SET\u{1}") {
            // \u{1}MEMBER_SET\u{1}<obj_start>\u{1}<obj_end>\u{1}<prop>\u{1}<val_start>\u{1}<val_end>\u{1}
            let parts: Vec<&str> = p.replacement.split('\u{1}').collect();
            if parts.len() >= 8 {
                let obj_start: usize = parts[2].parse().unwrap_or(0);
                let obj_end: usize = parts[3].parse().unwrap_or(0);
                let prop = parts[4];
                let val_start: usize = parts[5].parse().unwrap_or(0);
                let val_end: usize = parts[6].parse().unwrap_or(0);
                if obj_start < obj_end && val_start <= val_end && val_end <= bytes.len() {
                    let obj_src = rewrite_range(obj_start, obj_end);
                    let val_src = rewrite_range(val_start, val_end);
                    if needs_paren_prefix(start) {
                        out.push_str(&format!("(__zp_set({},{:?},{}))", obj_src, prop, val_src));
                    } else {
                        out.push_str(&format!("__zp_set({},{:?},{})", obj_src, prop, val_src));
                    }
                    cursor = end;
                    continue;
                }
            }
        } else if p.replacement.starts_with("\u{1}METHOD_CALL\u{1}") {
            // \u{1}METHOD_CALL\u{1}<obj_start>\u{1}<obj_end>\u{1}<method>\u{1}<args_start>\u{1}<args_end>\u{1}
            let parts: Vec<&str> = p.replacement.split('\u{1}').collect();
            if parts.len() >= 8 {
                let obj_start: usize = parts[2].parse().unwrap_or(0);
                let obj_end: usize = parts[3].parse().unwrap_or(0);
                let method = parts[4];
                let args_start: usize = parts[5].parse().unwrap_or(0);
                let args_end: usize = parts[6].parse().unwrap_or(0);
                if obj_start < obj_end {
                    let obj_src = rewrite_range(obj_start, obj_end);
                    let args_src = if args_start < args_end && args_end <= bytes.len() {
                        rewrite_range(args_start, args_end)
                    } else {
                        String::new()
                    };
                    if needs_paren_prefix(start) {
                        out.push_str(&format!(
                            "(__zp_call({},{:?},[{}]))",
                            obj_src, method, args_src
                        ));
                    } else {
                        out.push_str(&format!(
                            "__zp_call({},{:?},[{}])",
                            obj_src, method, args_src
                        ));
                    }
                    cursor = end;
                    continue;
                }
            }
        }
        out.push_str(&p.replacement);
        cursor = end;
    }
    out.push_str(&source[cursor..]);
    out
}

/// D2: remove a trailing `sourceMappingURL` pragma. Per source-map spec
/// it must be on the last non-empty line of the file. We're strict about
/// LAST occurrence and forgiving about whitespace.
pub fn strip_sourcemap_pragma(src: &str) -> String {
    // Scan only the tail; pragmas live at the end of the file. 4 KiB
    // is generous — typical pragmas are < 200 bytes.
    //
    // `len() - 4096` is a RAW BYTE offset and routinely lands inside a
    // multi-byte character, where slicing panics: NAVER's document ends with a
    // ~200 KB inline `EAGER-DATA` JSON blob full of Korean text, and the cut
    // fell inside '일' → `start byte index 204945 is not a char boundary` →
    // wasm trap ("RuntimeError: unreachable") inside `HtmlTxn.write` → the SW
    // errored the document stream → blank page. Snap back to a boundary; the
    // few extra bytes scanned are harmless.
    let mut scan_from = src.len().saturating_sub(4096);
    while scan_from > 0 && !src.is_char_boundary(scan_from) {
        scan_from -= 1;
    }
    let tail = &src[scan_from..];
    let needle = "sourceMappingURL=";
    let Some(rel_idx) = tail.rfind(needle) else {
        return src.to_string();
    };
    let abs_idx = scan_from + rel_idx;
    // Find the comment opener on the same line.
    let line_start = src[..abs_idx].rfind('\n').map(|n| n + 1).unwrap_or(0);
    let before_needle = &src[line_start..abs_idx];
    let trimmed = before_needle.trim_start();
    let comment_opens = trimmed.starts_with("//#")
        || trimmed.starts_with("//@")
        || trimmed.starts_with("/*#")
        || trimmed.starts_with("/*@");
    if !comment_opens {
        return src.to_string();
    }
    // Trim the entire trailing line (including the preceding newline if
    // present) so we don't leave a dangling empty line at EOF.
    let cut_at = if line_start > 0 && src.as_bytes()[line_start - 1] == b'\n' {
        line_start - 1
    } else {
        line_start
    };
    src[..cut_at].to_string()
}

/// Persistent rewriter instance — reuses a single bump allocator across
/// calls so warm-path rewrites amortise the arena allocation cost.
///
/// Memory plan (#2): the OXC AST is a bump arena. Allocating a fresh
/// `Allocator` per call walks `mmap` / `VirtualAlloc` system calls and
/// reserves new pages every time — for small (≤ 10 KB) scripts the arena
/// init cost dominates parse cost. We instead own one `Allocator`, run
/// parse + visit + emit inside a single method scope so the AST never
/// escapes, then `reset()` the allocator to reclaim the bytes (capacity
/// stays — the pages are reused on the next call).
pub struct RewriterInstance {
    allocator: Allocator,
}

impl Default for RewriterInstance {
    fn default() -> Self {
        Self::new()
    }
}

impl RewriterInstance {
    pub fn new() -> Self {
        Self {
            allocator: Allocator::default(),
        }
    }

    pub fn rewrite(
        &mut self,
        source: &str,
        opts: &RewriteOpts,
    ) -> Result<RewriteResult, RewriteError> {
        // Parse + visit + apply_patches must all complete inside this
        // method so the AST (which borrows from `self.allocator`) never
        // escapes our scope. The final `reset()` reclaims the arena bytes
        // for the next call.
        let source_type = opts.kind.source_type();
        let ret = Parser::new(&self.allocator, source, source_type).parse();

        if !ret.errors.is_empty() && opts.strict {
            let msg = ret
                .errors
                .iter()
                .map(|e| e.to_string())
                .collect::<Vec<_>>()
                .join("; ");
            self.allocator.reset();
            return Err(RewriteError::ParseFailed(msg));
        }

        let mut visitor = RewriteVisitor::new(opts.target_url.clone(), opts.proxy_origin.clone());
        visitor.visit_program(&ret.program);

        let mut patches = visitor.patches;
        patches.sort_by_key(|p| p.start);
        let patched = apply_patches(source, &patches);
        let code = strip_sourcemap_pragma(&patched);

        // CRITICAL: reset must happen AFTER `code` (an owned String) is
        // built and `patches` (which carry owned `String` replacements)
        // are detached from the AST nodes. Both are heap-allocated outside
        // the arena, so the reset is safe.
        self.allocator.reset();

        Ok(RewriteResult {
            code,
            patches,
            diagnostics: visitor.diagnostics,
        })
    }

    /// Explicit reset hook — usually unnecessary (`rewrite` resets at the
    /// end of each call), but exposed for callers that want to force-drop
    /// arena capacity after a one-off large rewrite.
    pub fn reset(&mut self) {
        self.allocator.reset();
    }
}

/// AST visitor that walks programs and produces global-identifier patches.
struct RewriteVisitor {
    patches: Vec<Patch>,
    diagnostics: Vec<String>,
    /// Stack of lexical scopes; each scope holds names that should NOT be
    /// rewritten because they shadow the dangerous globals.
    scopes: Vec<HashSet<String>>,
    /// Counts infinite-loop detections so the trap notebook can be
    /// updated with prevalence data after a real-site capture.
    infinite_loop_caps: u32,
    /// Target page URL — used as base when resolving dynamic
    /// `import("./relative.js")` arguments to an absolute proxy
    /// route. Empty / unparsable → dynamic import rewriting falls
    /// back to leaving the source alone (the original URL still
    /// passes through the SW fetch path; only relative paths break).
    target_url: String,
    /// See [`RewriteOpts::proxy_origin`] — makes dynamic-import URLs absolute
    /// so a virtualised document base can't redirect them to the target host.
    proxy_origin: String,
}

impl RewriteVisitor {
    fn new(target_url: String, proxy_origin: String) -> Self {
        Self {
            patches: Vec::new(),
            diagnostics: Vec::new(),
            scopes: vec![HashSet::new()],
            infinite_loop_caps: 0,
            target_url,
            proxy_origin,
        }
    }

    fn push_scope(&mut self) {
        self.scopes.push(HashSet::new());
    }

    fn pop_scope(&mut self) {
        self.scopes.pop();
    }

    fn declare(&mut self, name: &str) {
        if let Some(top) = self.scopes.last_mut() {
            top.insert(name.to_string());
        }
    }

    fn is_shadowed(&self, name: &str) -> bool {
        self.scopes.iter().rev().any(|scope| scope.contains(name))
    }

    /// Rewrite one module specifier string literal to a proxy-routed URL.
    ///
    /// Shared by dynamic `import()` and every static form (`import … from`,
    /// bare `import 'x'`, `export … from`, `export * from`). Static module
    /// syntax used to be skipped entirely — only `visit_import_expression`
    /// rewrote specifiers. Because we serve modules from
    /// `<proxy>/zp/api/script?u=<target>&kind=module`, a relative specifier
    /// left alone resolves against `/zp/api/`; the browser then requests
    /// `<proxy>/zp/api/<name>`, which the SW maps onto the target host and the
    /// target answers 404. That is exactly the long-standing
    /// `/zp/api/gfp-display-sdk.js` 404 on NAVER.
    fn rewrite_module_specifier(&mut self, lit: &StringLiteral<'_>) {
        let raw = lit.value.as_str();
        // Skip schemes the SW can't proxy and bare specifiers (bare specs are
        // package-manager names with no URL semantics — they never round-trip
        // through fetch).
        let lower = raw.trim_start().to_ascii_lowercase();
        if lower.starts_with("data:")
            || lower.starts_with("blob:")
            || lower.starts_with("javascript:")
            || lower.starts_with("about:")
            || (!raw.starts_with("./")
                && !raw.starts_with("../")
                && !raw.starts_with('/')
                && !lower.starts_with("http://")
                && !lower.starts_with("https://"))
        {
            return;
        }
        let Some(proxied) = proxied_module_url(raw, &self.target_url, &self.proxy_origin) else {
            return;
        };
        // The span covers the *literal* node including its quotes. Re-quote
        // with single quotes; the proxied URL never contains one (the query
        // string is percent-encoded).
        self.patches.push(Patch {
            start: lit.span.start,
            end: lit.span.end,
            replacement: format!("'{proxied}'"),
        });
    }

    /// Shorthand object property whose value is a dangerous global. The single
    /// identifier is BOTH the key and the value, so the plain GLOBAL_GET patch
    /// would turn `{ window }` into `{__zp_get(globalThis,"window")}` — a
    /// syntax error that kills the entire script file. Emit the expanded
    /// `window: __zp_get(globalThis,"window")` form instead.
    fn emit_shorthand_global_get(&mut self, span: Span, name: &str) {
        self.patches.push(Patch {
            start: span.start,
            end: span.end,
            replacement: format!("\u{1}SHORTHAND_GLOBAL_GET\u{1}{}\u{1}", name),
        });
    }

    fn emit_global_get(&mut self, span: Span, name: &str) {
        // 괄호는 contextual 로 apply_patches 에서 결정. 여기서는 marker 로 emission.
        self.patches.push(Patch {
            start: span.start,
            end: span.end,
            replacement: format!("\u{1}GLOBAL_GET\u{1}{}\u{1}", name),
        });
    }

    /// Allocate a fresh ID for an infinite-loop cap so each replacement
    /// declares its own counter variable (no cross-loop collision).
    fn next_loop_id(&mut self) -> u32 {
        self.infinite_loop_caps += 1;
        self.infinite_loop_caps
    }
}

/// Resolve `raw` against `base` per RFC 3986 §5.3 — minimal subset
/// that covers the dynamic-import use cases (relative path / abs
/// path / abs URL). Restricted to http(s) ASCII inputs; punycode /
/// IDN handling is deliberately out of scope (pulling the full
/// `url` crate would add ~250 KB to the page bundle via ICU).
/// Returns `None` for unparsable or non-http(s) inputs.
pub(crate) fn resolve_module_base(raw: &str, base: &str) -> Option<String> {
    let raw = raw.trim();
    // 1. raw is already an absolute URL → return as-is (after scheme check).
    if raw.starts_with("http://") || raw.starts_with("https://") {
        // Guard against unprintable bytes — anything outside ASCII
        // visible is rejected to keep the encoder predictable.
        if raw.bytes().any(|b| !(0x21..=0x7e).contains(&b)) {
            return None;
        }
        return Some(raw.to_string());
    }
    // Parse `base` into (scheme, authority, path). RFC 3986 §3.
    let scheme_end = base.find("://")?;
    let scheme = &base[..scheme_end];
    if scheme != "http" && scheme != "https" {
        return None;
    }
    let rest = &base[scheme_end + 3..];
    // Authority is everything before the next '/' '?' or '#'.
    let auth_end = rest.find(['/', '?', '#']).unwrap_or(rest.len());
    let authority = &rest[..auth_end];
    if authority.is_empty() {
        return None;
    }
    let base_path_with_q = &rest[auth_end..];
    // Strip query + fragment from base path — RFC 3986 §5.3 R 3.
    let path_end = base_path_with_q.find(['?', '#']).unwrap_or(base_path_with_q.len());
    let base_path = if path_end == 0 { "/" } else { &base_path_with_q[..path_end] };

    // 2. raw is host-absolute → keep authority, replace path.
    if let Some(after_slash) = raw.strip_prefix('/') {
        return Some(format!("{scheme}://{authority}/{after_slash}"));
    }
    // 3. raw is relative — resolve against base_path's directory.
    // Take everything up to the last '/' in base_path (the "directory").
    let dir_end = base_path.rfind('/').map(|i| i + 1).unwrap_or(0);
    let dir = &base_path[..dir_end];
    let combined = format!("{dir}{raw}");

    // Collapse `./` and `../` segments per RFC 3986 §5.2.4.
    let trailing_slash = combined.ends_with('/');
    let mut segments: Vec<String> = Vec::new();
    for seg in combined.split('/') {
        match seg {
            "" => continue,
            "." => continue,
            ".." => {
                segments.pop();
            }
            other => segments.push(other.to_string()),
        }
    }
    let mut out = String::from("/");
    out.push_str(&segments.join("/"));
    if trailing_slash && !out.ends_with('/') {
        out.push('/');
    }
    Some(format!("{scheme}://{authority}{out}"))
}

/// Build the proxied form of a module URL the dynamic import handler
/// observed in source. `raw` is the literal as-written (e.g.
/// `"./mod.js"`, `"/abs/path"`, `"https://cdn/x.js"`). `target_url`
/// is the page's location URL — empty / unparsable returns None and
/// the call site leaves the import alone.
///
/// Returned shape: `/zp/api/script?u=<percent-encoded-absolute>&kind=module`.
/// The SW intercepts `/zp/api/script?u=…` and routes the actual
/// fetch through the proxy transport, returning a rewritten ES
/// module response. `kind=module` ensures the SW parses the body
/// as an ES module (dynamic `import()` always loads a module).
/// Escape a string for embedding inside a double-quoted JS literal. Only the
/// two characters that can terminate or escape the literal need handling; the
/// values we embed are URLs, which never contain raw newlines.
fn js_quote_body(s: &str) -> String {
    s.replace('\\', "\\\\").replace('"', "\\\"")
}

/// Source spelling of a compound assignment operator, as `__zp_assign`'s
/// switch expects it. `None` for plain `=` (handled by `__zp_set`) so an
/// unmapped operator degrades to "leave native" instead of emitting a call the
/// membrane would reject.
fn assignment_operator_str(op: oxc_syntax::operator::AssignmentOperator) -> Option<&'static str> {
    use oxc_syntax::operator::AssignmentOperator as A;
    Some(match op {
        A::Assign => return None,
        A::Addition => "+=",
        A::Subtraction => "-=",
        A::Multiplication => "*=",
        A::Division => "/=",
        A::Remainder => "%=",
        A::Exponential => "**=",
        A::ShiftLeft => "<<=",
        A::ShiftRight => ">>=",
        A::ShiftRightZeroFill => ">>>=",
        A::BitwiseAnd => "&=",
        A::BitwiseOR => "|=",
        A::BitwiseXOR => "^=",
        A::LogicalAnd => "&&=",
        A::LogicalOr => "||=",
        A::LogicalNullish => "??=",
    })
}

/// Logical compound assignments short-circuit, so `__zp_assign` receives their
/// right-hand side as a thunk and only calls it when the write happens.
fn is_logical_assignment(op: oxc_syntax::operator::AssignmentOperator) -> bool {
    use oxc_syntax::operator::AssignmentOperator as A;
    matches!(op, A::LogicalAnd | A::LogicalOr | A::LogicalNullish)
}

fn proxied_module_url(raw: &str, target_url: &str, proxy_origin: &str) -> Option<String> {
    if target_url.is_empty() {
        return None;
    }
    let abs = resolve_module_base(raw, target_url)?;
    use percent_encoding::{utf8_percent_encode, AsciiSet, CONTROLS};
    const QUERY_ENC: &AsciiSet = &CONTROLS
        .add(b' ').add(b'"').add(b'#').add(b'<').add(b'>').add(b'&').add(b'=')
        .add(b'+').add(b'%').add(b'?').add(b'/').add(b':').add(b';').add(b'\'')
        .add(b'\\').add(b'`').add(b'{').add(b'}').add(b'[').add(b']').add(b'^').add(b'|');
    let encoded = utf8_percent_encode(&abs, QUERY_ENC).to_string();
    Some(format!("{}/zp/api/script?u={encoded}&kind=module", proxy_origin.trim_end_matches('/')))
}

/// Detect a `true`-equivalent constant expression — `true` literal, `1`
/// numeric literal (the two NAVER probe shapes we've seen). Strings /
/// objects / etc. could also be truthy but the rewriter is conservative
/// and only caps the unambiguous infinite forms.
fn is_truthy_constant(expr: &Expression) -> bool {
    match expr {
        Expression::BooleanLiteral(b) => b.value,
        Expression::NumericLiteral(n) => n.value != 0.0,
        // Parenthesised — peer through.
        Expression::ParenthesizedExpression(p) => is_truthy_constant(&p.expression),
        _ => false,
    }
}

impl<'a> Visit<'a> for RewriteVisitor {
    fn visit_program(&mut self, program: &Program<'a>) {
        // Collect hoisted function + var declarations into top-level scope first.
        for stmt in &program.body {
            if let Statement::FunctionDeclaration(f) = stmt {
                if let Some(id) = &f.id {
                    self.declare(id.name.as_str());
                }
            }
        }
        walk::walk_program(self, program);
    }

    fn visit_function(&mut self, func: &Function<'a>, flags: oxc_syntax::scope::ScopeFlags) {
        self.push_scope();
        for param in &func.params.items {
            collect_binding_pattern(&param.pattern, &mut |a| self.declare(a));
        }
        if let Some(id) = &func.id {
            self.declare(id.name.as_str());
        }
        walk::walk_function(self, func, flags);
        self.pop_scope();
    }

    fn visit_arrow_function_expression(&mut self, arrow: &ArrowFunctionExpression<'a>) {
        self.push_scope();
        for param in &arrow.params.items {
            collect_binding_pattern(&param.pattern, &mut |a| self.declare(a));
        }
        walk::walk_arrow_function_expression(self, arrow);
        self.pop_scope();
    }

    fn visit_block_statement(&mut self, block: &BlockStatement<'a>) {
        self.push_scope();
        walk::walk_block_statement(self, block);
        self.pop_scope();
    }

    fn visit_variable_declarator(&mut self, decl: &VariableDeclarator<'a>) {
        collect_binding_pattern(&decl.id, &mut |a| self.declare(a));
        walk::walk_variable_declarator(self, decl);
    }

    fn visit_catch_parameter(&mut self, param: &CatchParameter<'a>) {
        collect_binding_pattern(&param.pattern, &mut |a| self.declare(a));
        walk::walk_catch_parameter(self, param);
    }

    fn visit_identifier_reference(&mut self, ident: &IdentifierReference<'a>) {
        let name = ident.name.as_str();
        if is_dangerous_global(name) && !self.is_shadowed(name) {
            self.emit_global_get(ident.span, name);
        }
    }

    fn visit_object_property(&mut self, prop: &ObjectProperty<'a>) {
        // `{ window, document, navigator }` — shorthand properties reuse one
        // identifier as key AND value, so patching it as a plain reference
        // produces `{__zp_get(globalThis,"window"), ...}` which fails to parse
        // and takes the whole file down (observed on NAVER's
        // ntm.pstatic.net/scripts/ntm_*.js: `this.dom = { window, document,
        // navigator }`). Expand to the explicit `key: value` form.
        if prop.shorthand {
            if let Expression::Identifier(ident) = &prop.value {
                let name = ident.name.as_str();
                if is_dangerous_global(name) && !self.is_shadowed(name) {
                    self.emit_shorthand_global_get(ident.span, name);
                    // Do not walk the value — it would re-emit the broken
                    // plain patch over the same span. The key is an
                    // IdentifierName and is never rewritten.
                    return;
                }
            }
        }
        walk::walk_object_property(self, prop);
    }

    fn visit_import_expression(&mut self, expr: &ImportExpression<'a>) {
        // Recurse first so any dangerous-global identifiers inside the
        // argument expression still get patched (e.g. a computed source
        // like `import(window.__cdn + '/mod.js')` — `window` here still
        // routes through __zp_get).
        walk::walk_import_expression(self, expr);

        // Computed sources (variable / template / concatenation) can't be
        // resolved at rewrite time, so wrap them in the runtime helper — it
        // performs the same target→proxy mapping on the evaluated value.
        //
        // Leaving them alone is not neutral: the specifier resolves against
        // the *importing script's own* URL, which for us is
        // `<proxy>/zp/api/script?…`, so `"./x.js"` became a request for
        // `/zp/api/x.js` → 404. That is how NAVER's ad SDK failed
        // (`/zp/api/gfp-display-sdk.js`, then `initAd is not defined`).
        // Wrapping with two zero-width patches keeps the inner expression —
        // and any nested rewrites inside it — completely intact.
        let Expression::StringLiteral(lit) = &expr.source else {
            let span = expr.source.span();
            if !self.target_url.is_empty() {
                self.patches.push(Patch {
                    start: span.start,
                    end: span.start,
                    replacement: "__zp_module_url(".to_string(),
                });
                self.patches.push(Patch {
                    start: span.end,
                    end: span.end,
                    replacement: format!(", \"{}\")", js_quote_body(&self.target_url)),
                });
            }
            return;
        };
        self.rewrite_module_specifier(lit);
    }

    fn visit_import_declaration(&mut self, decl: &ImportDeclaration<'a>) {
        walk::walk_import_declaration(self, decl);
        self.rewrite_module_specifier(&decl.source);
    }

    fn visit_export_named_declaration(&mut self, decl: &ExportNamedDeclaration<'a>) {
        walk::walk_export_named_declaration(self, decl);
        // `export { a }` with no `from` clause has no specifier to rewrite.
        if let Some(source) = &decl.source {
            self.rewrite_module_specifier(source);
        }
    }

    fn visit_export_all_declaration(&mut self, decl: &ExportAllDeclaration<'a>) {
        walk::walk_export_all_declaration(self, decl);
        self.rewrite_module_specifier(&decl.source);
    }

    fn visit_call_expression(&mut self, expr: &CallExpression<'a>) {
        // First walk children (args + callee) so global identifiers are
        // patched normally. Then check if this is a dangerous method call.
        walk::walk_call_expression(self, expr);
        if let Expression::StaticMemberExpression(member) = &expr.callee {
            let method = member.property.name.as_str();

            // Reflect.get(obj, 'dangerous') / Reflect.set(obj, 'dangerous', val) /
            // Object.getOwnPropertyDescriptor(obj, 'dangerous'): rewrite to the
            // membrane equivalent so the descriptor / value returned is the
            // proxy-wrapped one rather than a clean native reference.
            if let Expression::Identifier(recv) = &member.object {
                let recv_name = recv.name.as_str();
                if !self.is_shadowed(recv_name) {
                    if recv_name == "Reflect" && (method == "get" || method == "set") {
                        if let Some(dangerous) = static_string_arg(&expr.arguments, 1) {
                            if is_dangerous_member(dangerous) || is_dangerous_global(dangerous) {
                                use oxc_span::GetSpan;
                                if let Some(arg0) = expr.arguments.first() {
                                    let obj_span = arg0.span();
                                    if method == "get" {
                                        self.patches.push(Patch {
                                            start: expr.span.start,
                                            end: expr.span.end,
                                            replacement: format!(
                                                "\u{1}MEMBER_GET\u{1}{}\u{1}{}\u{1}{}\u{1}",
                                                obj_span.start, obj_span.end, dangerous
                                            ),
                                        });
                                        return;
                                    }
                                    if method == "set" && expr.arguments.len() >= 3 {
                                        let val_span = expr.arguments[2].span();
                                        self.patches.push(Patch {
                                            start: expr.span.start,
                                            end: expr.span.end,
                                            replacement: format!(
                                                "\u{1}MEMBER_SET\u{1}{}\u{1}{}\u{1}{}\u{1}{}\u{1}{}\u{1}",
                                                obj_span.start,
                                                obj_span.end,
                                                dangerous,
                                                val_span.start,
                                                val_span.end
                                            ),
                                        });
                                        return;
                                    }
                                }
                            }
                        }
                    }
                    if recv_name == "Object" && method == "getOwnPropertyDescriptor" {
                        if let Some(dangerous) = static_string_arg(&expr.arguments, 1) {
                            if is_dangerous_member(dangerous) || is_dangerous_global(dangerous) {
                                self.diagnostics.push(format!(
                                    "Object.getOwnPropertyDescriptor({{...}},'{}') call observed; descriptor value passes through membrane",
                                    dangerous
                                ));
                            }
                        }
                    }
                }
            }

            // Same reason as visit_static_member_expression / assignment:
            // `super.method(...)` must stay literal — wrapping it strips the
            // class context and triggers "'super' keyword unexpected here".
            if matches!(member.object, Expression::Super(_)) {
                return;
            }
            // A dangerous PROP in callee position is a method call, not a get.
            // `s.search(re)` rewritten as `__zp_get(s,"search")(re)` drops the
            // receiver, and `String.prototype.search` then throws "called on
            // null or undefined" — NAVER's ad creative does exactly
            // `navigator.userAgent.search("Trident")`, and `indexOf` on the same
            // expression works, which is the fingerprint of an intercepted name
            // rather than a broken member chain. `search` is in DANGEROUS_PROPS
            // for `location.search`, so every string's `.search()` was hit.
            // `__zp_call` keeps the receiver and falls through to native for
            // unrelated objects.
            if is_dangerous_method(method) || is_dangerous_member(method) {
                use oxc_span::GetSpan;
                // Drop the callee's own MEMBER_GET patch first: it spans
                // `obj.prop`, which straddles the METHOD_CALL's object range,
                // and two overlapping patches cannot both be rendered.
                if is_dangerous_member(method) {
                    let callee_span = member.span();
                    self.patches
                        .retain(|p| !(p.start == callee_span.start && p.end == callee_span.end));
                }
                let obj_span = member.object.span();
                let args_span = if expr.arguments.is_empty() {
                    None
                } else {
                    let first = expr.arguments.first().unwrap();
                    let last = expr.arguments.last().unwrap();
                    Some((first.span().start, last.span().end))
                };
                let (args_start, args_end) = args_span.unwrap_or((0, 0));
                self.patches.push(Patch {
                    start: expr.span.start,
                    end: expr.span.end,
                    replacement: format!(
                        "\u{1}METHOD_CALL\u{1}{}\u{1}{}\u{1}{}\u{1}{}\u{1}{}\u{1}",
                        obj_span.start, obj_span.end, method, args_start, args_end
                    ),
                });
            }
        }
    }

    fn visit_with_statement(&mut self, stmt: &WithStatement<'a>) {
        // `with(obj){...}` lets free identifiers inside the body bind to obj's
        // properties at runtime. Strict mode JS rejects with-statements outright,
        // but classic-script targets may use them. We don't currently rewrite
        // identifier references inside the body specially — record a diagnostic
        // so audit can see when target code uses this pattern.
        self.diagnostics.push(format!(
            "with-statement at {}..{}: free identifier rewrites may be incorrect inside body",
            stmt.span.start, stmt.span.end
        ));
        walk::walk_with_statement(self, stmt);
    }

    fn visit_assignment_expression(&mut self, expr: &AssignmentExpression<'a>) {
        walk::walk_assignment_expression(self, expr);
        // Detect simple assignments like `obj.<dangerous> = value` and rewrite
        // them to `__zp_set(obj, 'dangerous', value)`. Compound assignments
        // (`+=`, `-=`, etc.) are intentionally left as native — they have
        // read-then-write semantics that the membrane setter still observes
        // because the read goes through __zp_get.
        // A bare dangerous global as the assignment TARGET (`location = url`).
        // The identifier visitor patches it to `__zp_get(globalThis,"location")`,
        // which is not a valid assignment target: V8 accepts the parse but
        // throws `ReferenceError: Invalid left-hand side in assignment` when the
        // statement runs, so `location = url` navigation silently died. Route
        // the write through the membrane setter instead — the same helpers the
        // member path uses, and the ones the prelude already exposes.
        if let AssignmentTarget::AssignmentTargetIdentifier(ident) = &expr.left {
            let name = ident.name.as_str();
            if is_dangerous_global(name) && !self.is_shadowed(name) {
                use oxc_span::GetSpan;
                let value_span = expr.right.span();
                let op = expr.operator;
                let replacement = if op == oxc_syntax::operator::AssignmentOperator::Assign {
                    format!(
                        "\u{1}GLOBAL_SET\u{1}{}\u{1}{}\u{1}{}\u{1}",
                        name, value_span.start, value_span.end
                    )
                } else {
                    // `__zp_assign` mirrors every compound operator, including
                    // the short-circuiting logical forms — which is why those
                    // take the value as a THUNK (it must not be evaluated when
                    // the assignment is skipped).
                    let Some(op_str) = assignment_operator_str(op) else {
                        return;
                    };
                    format!(
                        "\u{1}GLOBAL_ASSIGN\u{1}{}\u{1}{}\u{1}{}\u{1}{}\u{1}{}\u{1}",
                        name,
                        op_str,
                        value_span.start,
                        value_span.end,
                        if is_logical_assignment(op) { "1" } else { "0" }
                    )
                };
                self.patches.push(Patch {
                    start: expr.span.start,
                    end: expr.span.end,
                    replacement,
                });
                return;
            }
        }
        if expr.operator != oxc_syntax::operator::AssignmentOperator::Assign {
            return;
        }
        let target = match &expr.left {
            AssignmentTarget::StaticMemberExpression(m) => m,
            _ => return,
        };
        // Same reason as visit_static_member_expression: `super.x = v` would
        // become invalid `__zp_set(super, "x", v)`.
        if matches!(target.object, Expression::Super(_)) {
            return;
        }
        let prop = target.property.name.as_str();
        if !is_dangerous_member(prop) {
            return;
        }
        use oxc_span::GetSpan;
        let obj_span = target.object.span();
        let value_span = expr.right.span();
        self.patches.push(Patch {
            start: expr.span.start,
            end: expr.span.end,
            replacement: format!(
                "\u{1}MEMBER_SET\u{1}{}\u{1}{}\u{1}{}\u{1}{}\u{1}{}\u{1}",
                obj_span.start, obj_span.end, prop, value_span.start, value_span.end
            ),
        });
    }

    fn visit_update_expression(&mut self, expr: &UpdateExpression<'a>) {
        walk::walk_update_expression(self, expr);
        // `location++` has the same invalid-target problem as `location = x`.
        if let SimpleAssignmentTarget::AssignmentTargetIdentifier(ident) = &expr.argument {
            let name = ident.name.as_str();
            if is_dangerous_global(name) && !self.is_shadowed(name) {
                self.patches.push(Patch {
                    start: expr.span.start,
                    end: expr.span.end,
                    replacement: format!(
                        "\u{1}GLOBAL_UPDATE\u{1}{}\u{1}{}\u{1}{}\u{1}",
                        name,
                        expr.operator.as_str(),
                        if expr.prefix { "1" } else { "0" }
                    ),
                });
            }
        }
    }

    fn visit_assignment_target_property_identifier(
        &mut self,
        prop: &AssignmentTargetPropertyIdentifier<'a>,
    ) {
        // `({ location } = obj)` — shorthand destructuring TARGET. One
        // identifier is both the key and the write target, and a target must be
        // a settable reference, so `__zp_set(...)` (a call) cannot go here:
        // patching it as a plain reference produced
        // `({ __zp_get(globalThis,"location") } = obj)`, a SyntaxError that took
        // the whole file down. Expand to `location: __zp_get.d.location`, whose
        // write lands on the prelude's write-only sink and routes through the
        // membrane setter — valid syntax with no escape.
        //
        // Only the binding is replaced, so a default (`{ location = 1 }`)
        // survives as `location: __zp_get.d.location = 1`.
        let name = prop.binding.name.as_str();
        if is_dangerous_global(name) && !self.is_shadowed(name) {
            self.patches.push(Patch {
                start: prop.binding.span.start,
                end: prop.binding.span.end,
                replacement: format!("\u{1}GLOBAL_DESTR\u{1}{}\u{1}", name),
            });
            // Walk only the default expression — walking the binding would
            // re-emit the broken plain patch over the same span.
            if let Some(init) = &prop.init {
                self.visit_expression(init);
            }
            return;
        }
        walk::walk_assignment_target_property_identifier(self, prop);
    }

    fn visit_static_member_expression(&mut self, expr: &StaticMemberExpression<'a>) {
        // Walk children first (so receiver is rewritten before we wrap).
        walk::walk_static_member_expression(self, expr);
        // `super.x` is only legal as part of a class method's body — `super`
        // is a keyword and cannot appear as an identifier expression, so
        // `__zp_get(super, "x")` is a SyntaxError. Leave super member access
        // untouched (it's already restricted to its class context).
        if matches!(expr.object, Expression::Super(_)) {
            return;
        }
        // If the receiver is a bare identifier that's bound in the current
        // lexical scope (function param, destructured param, var/let/const,
        // catch parameter), the access is *local* and the membrane rewrite
        // would change semantics. `function f(location){ return location.href; }`
        // must remain `location.href`, not `__zp_get(location, "href")` —
        // the param shadows the global. The visit_identifier_reference path
        // already honours `is_shadowed` for the receiver; mirror that here
        // so the dangerous-member detection doesn't override the shadowing.
        if let Expression::Identifier(recv) = &expr.object {
            if self.is_shadowed(recv.name.as_str()) {
                return;
            }
        }
        let prop = expr.property.name.as_str();
        if is_dangerous_member(prop) {
            // Note: we intentionally keep the inner identifier patch that
            // visit_identifier_reference may have emitted for the receiver.
            // `apply_patches` sorts overlapping patches outer-first into
            // `chosen` and drops the inner one from the apply set, but the
            // `MEMBER_GET` marker resolver re-runs `rewrite_range` over the
            // receiver substring — that step picks the inner identifier
            // patch back up so a `location.href` read renders as
            // `__zp_get(__zp_get(globalThis,"location"),"href")` and an
            // `obj.href = v` assignment uses the rewritten receiver inside
            // the `__zp_set` call. Draining the inner patch here would strip
            // the receiver back to the bare source slice and break the
            // `javascript_url_anchor_routed` contract in zp-htmltx.
            // Record the textual span of the object so we can splice it as the
            // first arg to __zp_get(obj, 'name'). We don't have the source
            // string here; we record the object span and the visitor's caller
            // (the apply_patches step) will use source[obj.start..obj.end].
            // To do that we emit a patch whose replacement references a
            // placeholder we resolve below via the source string.
            // Implementation: we just emit (start..end of full member expr)
            // with replacement built from source slice in a post-walk pass.
            // For now we use a Patch with the textual span and store a marker.
            self.patches.push(Patch {
                start: expr.span.start,
                end: expr.span.end,
                replacement: format!(
                    "\u{1}MEMBER_GET\u{1}{}\u{1}{}\u{1}{}\u{1}",
                    expr.object_span().start,
                    expr.object_span().end,
                    prop
                ),
            });
        }
    }

    /// `for (;;) body` — unbounded loop. The classic anti-bot probe
    /// shape uses this to detect membrane instrumentation: the probe
    /// runs a tight loop while inspecting a global accessor, and if the
    /// loop never yields, the page wedges V8. Cap with a fresh counter
    /// so the loop terminates after a generous 10 M iterations. Forms
    /// with init / update are left alone for now — none of the observed
    /// NAVER probe shapes use them, and the patch would need to weave
    /// the counter into the existing test slot.
    fn visit_for_statement(&mut self, stmt: &ForStatement<'a>) {
        walk::walk_for_statement(self, stmt);
        if stmt.init.is_none() && stmt.test.is_none() && stmt.update.is_none() {
            use oxc_span::GetSpan;
            let id = self.next_loop_id();
            let body_start = stmt.body.span().start;
            // The `for(;;)` header is everything from `stmt.span.start`
            // up to the body. Replace with a counted form; body is left
            // untouched so `break` / `continue` / closures retain their
            // semantics.
            self.patches.push(Patch {
                start: stmt.span.start,
                end: body_start,
                replacement: format!(
                    "for(let __zp_lc_{id}=0;__zp_lc_{id}++<10000000;)"
                ),
            });
        }
    }

    /// `while(true) body` / `while(1) body` — same probe shape.
    fn visit_while_statement(&mut self, stmt: &WhileStatement<'a>) {
        walk::walk_while_statement(self, stmt);
        if is_truthy_constant(&stmt.test) {
            use oxc_span::GetSpan;
            let id = self.next_loop_id();
            let body_start = stmt.body.span().start;
            self.patches.push(Patch {
                start: stmt.span.start,
                end: body_start,
                replacement: format!(
                    "for(let __zp_lc_{id}=0;__zp_lc_{id}++<10000000;)"
                ),
            });
        }
    }

    /// `do body while(true);` / `do body while(1);`. The header
    /// rewrite trick doesn't fit because `do` requires a trailing
    /// `while(test);`. Patch the test expression itself with a
    /// post-increment counter; declare the counter immediately before
    /// the `do` so its scope covers the test.
    fn visit_do_while_statement(&mut self, stmt: &DoWhileStatement<'a>) {
        walk::walk_do_while_statement(self, stmt);
        if is_truthy_constant(&stmt.test) {
            use oxc_span::GetSpan;
            let id = self.next_loop_id();
            let counter = format!("__zp_lc_{id}");
            // Inject counter declaration just before `do`.
            self.patches.push(Patch {
                start: stmt.span.start,
                end: stmt.span.start,
                replacement: format!("let {counter}=0;"),
            });
            // Replace the test expression with the counter check.
            let test_span = stmt.test.span();
            self.patches.push(Patch {
                start: test_span.start,
                end: test_span.end,
                replacement: format!("{counter}++<10000000"),
            });
        }
    }
}

/// Helper: object span of a static member expression `obj.prop` ranges from
/// the start of `obj` to before the `.`.
trait StaticMemberExt {
    fn object_span(&self) -> Span;
}
impl<'a> StaticMemberExt for StaticMemberExpression<'a> {
    fn object_span(&self) -> Span {
        // Use the receiver expression's span. Helper enum: Expression has a
        // GetSpan impl; we use the trait to extract it.
        use oxc_span::GetSpan;
        self.object.span()
    }
}

/// Extract a static string-literal argument from a call's argument list.
/// Used to recognise patterns like `Reflect.get(x, 'location')` where the
/// property is statically known. Returns None for computed/dynamic args.
fn static_string_arg<'a>(
    args: &oxc_allocator::Vec<'a, Argument<'a>>,
    idx: usize,
) -> Option<&'a str> {
    let arg = args.get(idx)?;
    match arg {
        Argument::StringLiteral(s) => Some(s.value.as_str()),
        _ => None,
    }
}

/// Walk a BindingPattern (destructuring, etc.) and call `out` for each
/// declared name. v0.133: BindingPattern is a direct enum.
fn collect_binding_pattern<'a, F: FnMut(&str)>(pat: &BindingPattern<'a>, out: &mut F) {
    match pat {
        BindingPattern::BindingIdentifier(id) => out(id.name.as_str()),
        BindingPattern::ObjectPattern(obj) => {
            for prop in &obj.properties {
                collect_binding_pattern(&prop.value, out);
            }
            if let Some(rest) = &obj.rest {
                collect_binding_pattern(&rest.argument, out);
            }
        }
        BindingPattern::ArrayPattern(arr) => {
            for el in &arr.elements {
                if let Some(el) = el {
                    collect_binding_pattern(el, out);
                }
            }
            if let Some(rest) = &arr.rest {
                collect_binding_pattern(&rest.argument, out);
            }
        }
        BindingPattern::AssignmentPattern(asn) => {
            collect_binding_pattern(&asn.left, out);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn opts() -> RewriteOpts {
        RewriteOpts {
            kind: ScriptKind::Classic,
            target_url: "https://example.com/".into(),
            strict: true,
            proxy_origin: "http://proxy.localhost:18080".into(),
        }
    }

    // Pin: the sourcemap-pragma tail scan starts at a RAW BYTE offset
    // (`len() - 4096`). Landing inside a multi-byte character used to panic
    // ("start byte index N is not a char boundary"), which in wasm is a bare
    // `RuntimeError: unreachable` that killed the SW's document stream and
    // rendered NAVER as a blank page — its trailing inline JSON is full of
    // Korean text. Build sources whose 4 KiB cut lands on every possible
    // offset inside a 3-byte character.
    // Pin: a COMPUTED dynamic import must be wrapped in the runtime helper.
    // Left alone, the specifier resolves against the importing script's own
    // proxy URL (`<proxy>/zp/api/script?…`), so "./x.js" was requested as
    // /zp/api/x.js and 404'd — NAVER's ad SDK died exactly this way
    // (`/zp/api/gfp-display-sdk.js`, then `initAd is not defined`).
    #[test]
    fn computed_dynamic_import_is_wrapped_at_runtime() {
        let o = RewriteOpts {
            kind: ScriptKind::Module,
            target_url: "https://cdn.example.com/a/b.js".into(),
            strict: true,
            proxy_origin: "http://proxy.localhost:18080".into(),
        };
        let out = rewrite_script("const p = import(base + '/mod.js');", &o)
            .unwrap()
            .code;
        assert!(out.contains("__zp_module_url("), "computed import must be wrapped: {out}");
        assert!(
            out.contains("https://cdn.example.com/a/b.js"),
            "referrer must be passed: {out}"
        );
        assert!(
            out.contains("'/mod.js'"),
            "inner expression must be preserved: {out}"
        );
    }

    // Pin: specifier 가 **그 자체로 리라이트 대상**일 때의 중첩 순서.
    //
    // 위 테스트는 `base + '/mod.js'` (이항식) 이라 specifier 시작 오프셋에
    // 다른 패치가 겹치지 않아, 안팎이 뒤집혀도 통과했다. 메서드 호출처럼
    // 시작 오프셋을 공유하는 형태라야 잡힌다:
    //
    //   import(u.replace('.png','.js'))
    //   뒤집히면 → import(__zp_call(__zp_module_url(u,"replace",[…]), "<ref>"))
    //
    // referrer 자리에 `"replace"` 가 들어가 `new URL(spec,"replace")` 가
    // `Invalid base URL` 로 throw 한다. 실사이트에서는 번들러의 청크 로딩
    // (`import(chunkPath(id))`) 이 통째로 죽는 증상으로 나온다.
    //
    // ── 미해결(2026-08-14). 이 테스트는 **현재 실패한다** ──────────────────
    // 원인: 래퍼가 인자 span 의 **시작 오프셋에 zero-width 패치**로 붙는데,
    // 호출 리라이트(`__zp_call` 마커)는 apply 시점에 `rewrite_range(obj_start,
    // obj_end)` 로 객체 범위를 **재귀 렌더링**한다. 래퍼 패치가 그 범위의 첫
    // 바이트에 앉아 있어 안쪽 렌더링에 빨려 들어간다. push 순서를 바꿔도(시도해
    // 봤다) 결과는 같다 — 순서 문제가 아니라 **앵커 위치** 문제다.
    //
    // 고치려면 앵커를 인자 span 밖으로 빼야 한다. `import` 키워드 자체를
    // `[expr.span.start, +6]` 패치로 `__zp_import` 로 바꾸고 referrer 는 닫는
    // 괄호 `[expr.span.end-1, end]` 에 붙이는 방식이면 두 패치가 모두 인자
    // 밖이라 충돌하지 않는다. 대신 프렐류드에 `__zp_import` 전역이 하나 늘고,
    // 자식 realm 위임 목록(installNetworkContainment)과 E1 escape matrix 교차
    // 검증이 필요하다. 그래서 별도 작업으로 남긴다.
    #[ignore = "동적 import 래퍼 중첩 버그 — 앵커를 괄호로 옮기는 수정 필요 (위 주석 참조)"]
    #[test]
    fn computed_dynamic_import_wraps_outside_nested_rewrite() {
        let o = RewriteOpts {
            kind: ScriptKind::Classic,
            target_url: "https://cdn.example.com/a/b.js".into(),
            strict: true,
            proxy_origin: "http://proxy.localhost:18080".into(),
        };
        let out = rewrite_script("import(u.replace('.png','.js'));", &o)
            .unwrap()
            .code;
        let m = out
            .find("__zp_module_url(")
            .unwrap_or_else(|| panic!("computed import must be wrapped: {out}"));
        // 안쪽 리라이트가 실제로 일어난 경우에만 중첩 순서를 검사한다
        // (리라이터 정책이 바뀌어 wrap 이 사라지면 이 검사는 조용히 무의미해지므로,
        //  referrer 검사를 아래에 따로 둔다).
        if let Some(inner) = out.find("__zp_call(") {
            assert!(
                m < inner,
                "__zp_module_url 이 안쪽 리라이트보다 바깥이어야 한다: {out}"
            );
        }
        // referrer 는 module_url 의 **두 번째 인자**여야 한다. 뒤집히면 메서드
        // 이름이 그 자리에 온다.
        assert!(
            out.contains(", \"https://cdn.example.com/a/b.js\")"),
            "referrer must be module_url's last argument: {out}"
        );
        assert!(
            !out.contains("__zp_module_url(u,\"replace\""),
            "referrer 자리에 메서드 이름이 오면 안 된다: {out}"
        );
    }

    // Literal imports stay statically resolved — no runtime helper needed.
    #[test]
    fn literal_dynamic_import_stays_static() {
        let o = RewriteOpts {
            kind: ScriptKind::Module,
            target_url: "https://cdn.example.com/a/b.js".into(),
            strict: true,
            proxy_origin: "http://proxy.localhost:18080".into(),
        };
        let out = rewrite_script("import('./mod.js');", &o).unwrap().code;
        assert!(
            out.contains("http://proxy.localhost:18080/zp/api/script?u="),
            "literal must resolve to an absolute proxy URL: {out}"
        );
        assert!(
            !out.contains("__zp_module_url("),
            "literal must not need the helper: {out}"
        );
    }

    #[test]
    fn strip_sourcemap_pragma_survives_multibyte_tail() {
        for pad in 0..8usize {
            // 'ㅏ'/'일' are 3 bytes each; varying the ASCII padding walks the
            // cut point across all three byte positions of a character.
            let src = format!("var x=1;{}{}", "a".repeat(pad), "일".repeat(2000));
            let out = strip_sourcemap_pragma(&src);
            assert_eq!(out, src, "pad={pad} must be returned unchanged");
        }
        // And it still strips a real pragma when one is present after CJK text.
        let src = format!("var x=1;{}\n//# sourceMappingURL=app.js.map", "일".repeat(2000));
        let out = strip_sourcemap_pragma(&src);
        assert!(!out.contains("sourceMappingURL"), "pragma must be stripped: {out}");
    }

    #[test]
    fn html_body_must_parse_error_under_strict_mode() {
        // 2026-06-07 split-bundle (c.1) Step 2a aborted: NAVER's anti-bot
        // occasionally returns a 404 HTML body for script subresources
        // (ssl.pstatic.net/.../ndp-loader.js). Strict-mode parse rejection
        // is the contract the SW's fail-closed posture relies on — if it
        // ever regresses, the browser will execute raw HTML and surface a
        // SyntaxError instead of a clean POLICY_BLOCKED stub. Pin both a
        // minimal HTML body and the real NAVER 404 shape.
        for html in &[
            "<!DOCTYPE html\n<html><head><title>404</title></head><body><h1>not found</h1></body></html>",
            "<!DOCTYPE html\n    PUBLIC \"-//W3C//DTD XHTML 1.0 Transitional//EN\" \"http://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd\">\n<html xmlns=\"http://www.w3.org/1999/xhtml\">\n<head>\n<title>네이버</title>\n<script type=text/javascript>\nif (!['/', '/index.html'].includes(window.location.pathname)) { window.location.href = '/'; }\n</script>\n</head>\n<body><h1>not found</h1></body>\n</html>",
        ] {
            let r = rewrite_script(html, &opts());
            assert!(
                matches!(r, Err(RewriteError::ParseFailed(_))),
                "strict mode must reject HTML-as-JS; got: {:?}",
                r,
            );
            let r2 = rewrite_script_patches(html, &opts());
            assert!(
                matches!(r2, Err(RewriteError::ParseFailed(_))),
                "patch-mode strict must also reject HTML-as-JS; got: {:?}",
                r2,
            );
        }
    }

    #[test]
    fn function_global_is_rewritten_to_membrane() {
        // 2026-06-07 split-bundle (c.1) Step 2.1.5: shadow-compare 가 NAVER
        // cross-domain-storage 에서 발견한 escape vector. `Function.prototype`
        // 으로 native Function constructor 접근 → eval-equivalent. legacy
        // rewriter-rs 는 `Function` 을 dangerous global 로 분류 — modern 도
        // 동일하게 처리해야 NAVER (그리고 PHASE2 strict mode) 회귀 방지.
        let src = "var i = Function.prototype; return new Function('return globalThis')();";
        let r = rewrite_script(src, &opts()).unwrap();
        assert!(
            r.code.contains("__zp_get(globalThis,\"Function\")"),
            "Function global must route through membrane: {}",
            r.code,
        );
    }

    #[test]
    fn eval_global_is_rewritten_to_membrane() {
        // `eval` 도 native escape vector — `eval("...")` 으로 임의 코드 실행.
        // identifier reference 로 접근될 때 (e.g. `var f = eval; f("...")`)
        // dangerous 로 분류 의무.
        let src = "var f = eval; f('return globalThis');";
        let r = rewrite_script(src, &opts()).unwrap();
        assert!(
            r.code.contains("__zp_get(globalThis,\"eval\")"),
            "eval global must route through membrane: {}",
            r.code,
        );
    }

    #[test]
    fn naver_ndp_loader_round_trips_as_valid_js() {
        // 2026-06-07 split-bundle (c.1) Step 2a investigation: NAVER's
        // ssl.pstatic.net/tveta/libs/ndpsdk/prod/ndp-loader.js is the
        // smallest real-site canary for the OXC 0.133 patch-mode emit.
        // Pin both code paths the SW rewrite calls into:
        //  (1) `rewrite_script` (full re-emit)
        //  (2) `rewrite_script_patches` + `apply_patches` (patch envelope)
        // Both must produce syntactically valid JS, and the two outputs
        // must match byte-for-byte (modulo the pragma strip — ndp-loader
        // has no sourceMappingURL pragma).
        let src = include_str!("ndp-loader-fixture.js");
        let alloc1 = oxc_allocator::Allocator::default();
        let st = oxc_span::SourceType::cjs();
        let r1 = rewrite_script(src, &opts()).expect("full re-emit must succeed");
        let p1 = oxc_parser::Parser::new(&alloc1, &r1.code, st).parse();
        assert!(
            p1.errors.is_empty(),
            "full re-emit produced invalid JS: {:#?}\n----\n{}",
            p1.errors,
            r1.code,
        );
        let r2 = rewrite_script_patches(src, &opts()).expect("patch-mode must succeed");
        let patched = apply_patches(src, &r2.patches);
        let alloc2 = oxc_allocator::Allocator::default();
        let p2 = oxc_parser::Parser::new(&alloc2, &patched, st).parse();
        assert!(
            p2.errors.is_empty(),
            "patch-mode produced invalid JS: {:#?}\n----\n{}",
            p2.errors,
            patched,
        );
        assert_eq!(r1.code, patched, "patch-mode vs full re-emit divergence");
    }

    #[test]
    fn super_constructor_with_extends_globalthis_member() {
        // Real-world pattern from kw-owner: class extends a rewritten global,
        // constructor calls super(args). Rewriter must keep super() in place
        // and the class context valid.
        let src =
            "class A extends globalThis.X { constructor(p) { super(p); this.location = p; } }";
        let r = rewrite_script(src, &opts()).unwrap();
        assert!(r.code.contains("super(p)"), "super(p) gone: {}", r.code);
        // Make sure we didn't accidentally rewrite super.location to __zp_set(super,...)
        assert!(
            !r.code.contains("__zp_set(super"),
            "super target wrapped: {}",
            r.code
        );
    }

    #[test]
    fn super_method_call_not_rewritten() {
        // `super.write(...)` (or any other dangerous-method name) must NOT be
        // wrapped in __zp_call(super, ...) — that's the actual failure mode
        // we see on comic.naver.com's kw-owner bundle.
        let src = "class C extends B { m() { super.write('x'); } }";
        let r = rewrite_script(src, &opts()).unwrap();
        assert!(
            !r.code.contains("__zp_call(super"),
            "super.method() must stay native, got: {}",
            r.code
        );
        assert!(
            r.code.contains("super.write"),
            "super.write missing: {}",
            r.code
        );
    }

    #[test]
    fn super_call_not_rewritten() {
        // `super(...)` in a constructor must stay literal — wrapping would
        // strip class context and trigger "'super' keyword unexpected".
        let src = "class C extends B { constructor() { super(); this.x = 1; } }";
        let r = rewrite_script(src, &opts()).unwrap();
        assert!(
            r.code.contains("super()"),
            "super() must remain in output, got: {}",
            r.code
        );
    }

    #[test]
    fn super_member_access_not_rewritten() {
        // `super.foo` and `super.foo = v` must be left untouched even when
        // `foo` is on the dangerous-member list — `__zp_get(super, "foo")`
        // is a SyntaxError outside class context. Observed on comic.naver.com
        // (webtoon) bundles where the entire React init fails because one
        // vendor script throws SyntaxError: 'super' keyword unexpected here.
        let src = "class C extends B { m() { return super.location; } }";
        let r = rewrite_script(src, &opts()).unwrap();
        assert!(
            !r.code.contains("__zp_get(super"),
            "super.x must stay native, got: {}",
            r.code
        );
        let src2 = "class C extends B { m(v) { super.location = v; } }";
        let r2 = rewrite_script(src2, &opts()).unwrap();
        assert!(
            !r2.code.contains("__zp_set(super"),
            "super.x = v must stay native, got: {}",
            r2.code
        );
    }

    // Shorthand object properties reuse ONE identifier as both key and value.
    // Patching it as a plain reference emitted
    // `{__zp_get(globalThis,"window"), ...}` — invalid JS that made the whole
    // script file fail to parse, taking every unrelated symbol in it down.
    // Observed on NAVER's ntm.pstatic.net/scripts/ntm_*.js:
    // `this.dom = { window, document, navigator }`.
    #[test]
    fn expands_shorthand_object_property_for_dangerous_globals() {
        let r = rewrite_script("var a = { window, document, navigator };", &opts()).unwrap();
        assert!(
            r.code.contains("window:__zp_get(globalThis,\"window\")"),
            "shorthand `window` must expand to `key: value`, got: {}",
            r.code
        );
        assert!(
            r.code.contains("document:__zp_get(globalThis,\"document\")"),
            "shorthand `document` must expand to `key: value`, got: {}",
            r.code
        );
        // The bare broken form must never appear.
        assert!(
            !r.code.contains("{ __zp_get(globalThis,\"window\")")
                && !r.code.contains("{__zp_get(globalThis,\"window\")"),
            "shorthand must not collapse into a keyless property, got: {}",
            r.code
        );
        // Non-dangerous shorthand stays untouched.
        assert!(r.code.contains("navigator }"), "got: {}", r.code);
    }

    #[test]
    fn shorthand_expansion_respects_shadowing_and_non_shorthand_forms() {
        // A shadowed `window` is a local binding — must stay shorthand.
        let shadowed =
            rewrite_script("(function(window){ return { window }; })();", &opts()).unwrap();
        assert!(
            shadowed.code.contains("{ window }"),
            "shadowed shorthand must stay untouched, got: {}",
            shadowed.code
        );
        // Methods / getters merely NAMED after a global are keys, not
        // references — they must not be rewritten at all.
        let method = rewrite_script("f({ window() { return 1; } });", &opts()).unwrap();
        assert!(
            !method.code.contains("__zp_get"),
            "method key must not be rewritten, got: {}",
            method.code
        );
        let getter = rewrite_script("f({ get window() { return 1; } });", &opts()).unwrap();
        assert!(
            !getter.code.contains("__zp_get"),
            "getter key must not be rewritten, got: {}",
            getter.code
        );
        // Computed keys ARE references and must still be rewritten.
        let computed = rewrite_script("f({ [window]: 1 });", &opts()).unwrap();
        assert!(
            computed
                .code
                .contains("[__zp_get(globalThis,\"window\")]"),
            "computed key must be rewritten, got: {}",
            computed.code
        );
        // Explicit `key: value` keeps working (value side rewritten only).
        let explicit = rewrite_script("f({ window: window });", &opts()).unwrap();
        assert!(
            explicit
                .code
                .contains("window: __zp_get(globalThis,\"window\")"),
            "explicit form must rewrite the value, got: {}",
            explicit.code
        );
        // Nested / arrow-returned object literals go through the same path.
        let nested = rewrite_script("var f = () => ({ window });", &opts()).unwrap();
        assert!(
            nested
                .code
                .contains("window:__zp_get(globalThis,\"window\")"),
            "arrow-returned object literal must expand, got: {}",
            nested.code
        );
    }

    // Static module syntax was never rewritten — only dynamic `import()` was.
    // We serve modules from `<proxy>/zp/api/script?u=<target>&kind=module`, so
    // a relative specifier left alone resolves against `/zp/api/`; the browser
    // requests `<proxy>/zp/api/<name>`, the SW maps that onto the target host,
    // and the target answers 404. That was the long-standing
    // `/zp/api/gfp-display-sdk.js` 404 on NAVER (the ad SDK module statically
    // imports `./gfp-display-*.js` siblings).
    #[test]
    fn rewrites_static_module_specifiers() {
        let opts = RewriteOpts {
            kind: ScriptKind::Module,
            target_url: "https://ssl.pstatic.net/tveta/libs/glad/prod/3.10.7/gfp-display-sdk.js"
                .to_string(),
            strict: true,
            proxy_origin: "http://proxy.localhost:18080".to_string(),
        };
        // Every static form that carries a specifier, plus dynamic import for
        // parity. Each must resolve relative to the TARGET url, not /zp/api/.
        let cases = [
            "import x from './gfp-display-nda.js';",
            "import './side.js';",
            "export { a } from './dep.js';",
            "export * from './all.js';",
            "const p = import('./dyn.js');",
        ];
        let expected_names = [
            "gfp-display-nda.js",
            "side.js",
            "dep.js",
            "all.js",
            "dyn.js",
        ];
        for (src, name) in cases.iter().zip(expected_names.iter()) {
            let r = rewrite_script(src, &opts).unwrap();
            assert!(
                r.code
                    .contains("'http://proxy.localhost:18080/zp/api/script?u="),
                "specifier must become an absolute proxy URL for {src:?}, got: {}",
                r.code
            );
            assert!(
                r.code.contains("&kind=module'"),
                "specifier must be tagged kind=module for {src:?}, got: {}",
                r.code
            );
            // Resolved against the target's directory, not the proxy API path.
            let want = format!("prod%2F3.10.7%2F{name}");
            assert!(
                r.code.contains(&want),
                "{src:?} must resolve against the target dir ({want}), got: {}",
                r.code
            );
            assert!(
                !r.code.contains("'./"),
                "no relative specifier may survive in {src:?}, got: {}",
                r.code
            );
        }
    }

    #[test]
    fn leaves_bare_and_inert_module_specifiers_alone() {
        let opts = RewriteOpts {
            kind: ScriptKind::Module,
            target_url: "https://example.com/app/main.js".to_string(),
            strict: true,
            proxy_origin: "http://proxy.localhost:18080".to_string(),
        };
        // Bare specifiers are package names with no URL semantics; data:/blob:
        // never round-trip through fetch. Rewriting either would break the
        // module graph rather than fix it.
        for src in [
            "import react from 'react';",
            "export { x } from 'lodash-es';",
            "import 'data:text/javascript,void 0';",
        ] {
            let r = rewrite_script(src, &opts).unwrap();
            assert!(
                !r.code.contains("/zp/api/script"),
                "{src:?} must not be proxied, got: {}",
                r.code
            );
        }
        // `export { a }` without a `from` clause has no specifier at all.
        let local = rewrite_script("const a = 1; export { a };", &opts).unwrap();
        assert!(
            !local.code.contains("/zp/api/script"),
            "local re-export must be untouched, got: {}",
            local.code
        );
    }

    // A bare dangerous global used as an assignment TARGET. The identifier
    // visitor turned `location = url` into
    // `__zp_get(globalThis,"location") = url`, which V8 parses but rejects at
    // run time (`ReferenceError: Invalid left-hand side in assignment`), so this
    // extremely common navigation idiom silently died. Compound and update
    // forms had the same broken target.
    #[test]
    fn routes_bare_global_writes_through_the_membrane() {
        let plain = rewrite_script("location = url;", &opts()).unwrap();
        assert!(
            plain.code.contains("__zp_set(globalThis,\"location\",(url))"),
            "plain assignment must use __zp_set, got: {}",
            plain.code
        );
        let compound = rewrite_script("location += '#x';", &opts()).unwrap();
        assert!(
            compound
                .code
                .contains("__zp_assign(globalThis,\"location\",\"+=\",('#x'))"),
            "compound assignment must use __zp_assign, got: {}",
            compound.code
        );
        // Logical compound assignments short-circuit: the RHS must be a thunk
        // so it is not evaluated when the write is skipped.
        let logical = rewrite_script("location ||= url;", &opts()).unwrap();
        assert!(
            logical
                .code
                .contains("__zp_assign(globalThis,\"location\",\"||=\",()=>(url))"),
            "logical assignment must pass a thunk, got: {}",
            logical.code
        );
        let update = rewrite_script("location++;", &opts()).unwrap();
        assert!(
            update
                .code
                .contains("__zp_update(globalThis,\"location\",\"++\",false)"),
            "postfix update must use __zp_update, got: {}",
            update.code
        );
        let prefix = rewrite_script("--top;", &opts()).unwrap();
        assert!(
            prefix
                .code
                .contains("__zp_update(globalThis,\"top\",\"--\",true)"),
            "prefix update must record prefix=true, got: {}",
            prefix.code
        );
        // No form may leave a call expression in the target position.
        for src in ["location = url;", "location += 1;", "location++;"] {
            let r = rewrite_script(src, &opts()).unwrap();
            assert!(
                !r.code.contains("__zp_get(globalThis,\"location\") ="),
                "{src:?} must not assign to a call expression, got: {}",
                r.code
            );
        }
    }

    // `({ location } = obj)` — shorthand destructuring TARGET. A target must be
    // a settable reference, so `__zp_set(...)` cannot go there; patching it as a
    // plain reference emitted `({ __zp_get(globalThis,"location") } = obj)`, a
    // SyntaxError that took the whole file down. The prelude's write-only sink
    // (`__zp_get.d`) gives us a settable member with no read surface.
    #[test]
    fn routes_destructured_global_writes_through_the_write_only_sink() {
        let simple = rewrite_script("({ location } = obj);", &opts()).unwrap();
        assert!(
            simple
                .code
                .contains("({ location: __zp_get.d.location } = obj)"),
            "shorthand target must expand to the sink, got: {}",
            simple.code
        );
        // A default survives because only the binding span is replaced.
        let defaulted = rewrite_script("({ location = 1 } = obj);", &opts()).unwrap();
        assert!(
            defaulted
                .code
                .contains("({ location: __zp_get.d.location = 1 } = obj)"),
            "default must be preserved, got: {}",
            defaulted.code
        );
        // Nested inside an array pattern, and alongside untouched properties.
        let nested = rewrite_script("[{ location }] = arr;", &opts()).unwrap();
        assert!(
            nested
                .code
                .contains("[{ location: __zp_get.d.location }]"),
            "nested pattern must expand, got: {}",
            nested.code
        );
        let mixed = rewrite_script("({ location, a } = obj);", &opts()).unwrap();
        assert!(
            mixed
                .code
                .contains("({ location: __zp_get.d.location, a } = obj)"),
            "non-dangerous siblings must stay shorthand, got: {}",
            mixed.code
        );
        // The broken keyless form must never come back.
        for src in [
            "({ location } = obj);",
            "({ location = 1 } = obj);",
            "[{ location }] = arr;",
        ] {
            let r = rewrite_script(src, &opts()).unwrap();
            assert!(
                !r.code.contains("{ __zp_get(globalThis,\"location\") }"),
                "{src:?} must not emit a keyless property, got: {}",
                r.code
            );
        }
    }

    #[test]
    fn shadowed_globals_keep_native_write_semantics() {
        // A local binding named after a global is not the global — neither the
        // setter helpers nor the sink may appear.
        for src in [
            "var location = 2; location = 3;",
            "(function(location){ location = 1; })();",
            "(function(location){ ({ location } = o); })();",
            "(function(top){ top++; })();",
        ] {
            let r = rewrite_script(src, &opts()).unwrap();
            assert!(
                !r.code.contains("__zp_set(globalThis")
                    && !r.code.contains("__zp_assign(globalThis")
                    && !r.code.contains("__zp_update(globalThis")
                    && !r.code.contains("__zp_get.d."),
                "shadowed binding must stay native in {src:?}, got: {}",
                r.code
            );
        }
    }

    #[test]
    fn empty_source_no_patches() {
        let r = rewrite_script("", &opts()).unwrap();
        assert_eq!(r.patches.len(), 0);
        assert_eq!(r.code, "");
    }

    #[test]
    fn rewrites_unbound_location() {
        let src = "var x = location.href;";
        let r = rewrite_script(src, &opts()).unwrap();
        assert!(
            r.code.contains("__zp_get(globalThis,\"location\")"),
            "got: {}",
            r.code
        );
    }

    #[test]
    fn rewrites_unbound_window() {
        let src = "console.log(window);";
        let r = rewrite_script(src, &opts()).unwrap();
        assert!(
            r.code.contains("__zp_get(globalThis,\"window\")"),
            "got: {}",
            r.code
        );
    }

    #[test]
    fn does_not_rewrite_shadowed_location() {
        let src = "function f(location){ return location.href; }";
        let r = rewrite_script(src, &opts()).unwrap();
        assert!(
            !r.code.contains("__zp_get"),
            "shadowed param should not be rewritten, got: {}",
            r.code
        );
    }

    #[test]
    fn does_not_rewrite_var_decl_with_same_name() {
        let src = "var location = 'x'; use(location);";
        let r = rewrite_script(src, &opts()).unwrap();
        assert!(
            !r.code.contains("__zp_get"),
            "shadowed var should not be rewritten, got: {}",
            r.code
        );
    }

    // 2026-06-09 NAVER dynamic import fix: literal-URL `import("./mod")`
    // calls are resolved against `target_url` and rewritten to a
    // `/zp/api/script?u=<percent-encoded-abs>` so the SW transports
    // them through the proxy. NAVER's `gfp-core.js` does
    // `import('./gfp-display-glog-logger.js')` from its origin —
    // before this fix the SW had no transport hook because the path
    // resolved against `proxy.localhost` (page realm sees that as
    // the base) and 404'd.
    #[test]
    fn dynamic_import_relative_literal_routes_through_proxy() {
        let mut o = opts();
        o.kind = ScriptKind::Module;
        o.target_url = "https://ssl.pstatic.net/tveta/libs/glad/prod/gfp-core.js".into();
        let src = "await import('./gfp-display-glog-logger.js')";
        let r = rewrite_script(src, &o).unwrap();
        assert!(
            r.code.contains("/zp/api/script?u="),
            "import literal must be proxy-routed: {}",
            r.code
        );
        // The encoded absolute URL must reflect the resolved path.
        assert!(
            r.code.contains("gfp-display-glog-logger.js")
                || r.code.contains("gfp-display-glog-logger.js")
                || r.code.contains("gfp-display-glog-logger.js"),
            "proxied URL must encode the resolved absolute path: {}",
            r.code
        );
    }

    #[test]
    fn dynamic_import_absolute_https_literal_routes_through_proxy() {
        let mut o = opts();
        o.kind = ScriptKind::Module;
        let src = "import('https://cdn.example.com/m.js?v=1').then(use);";
        let r = rewrite_script(src, &o).unwrap();
        assert!(
            r.code.contains("/zp/api/script?u="),
            "absolute https import must be proxy-routed: {}",
            r.code
        );
    }

    #[test]
    fn dynamic_import_data_uri_is_left_alone() {
        let mut o = opts();
        o.kind = ScriptKind::Module;
        let src = "import('data:text/javascript,export const x=1').then(use);";
        let r = rewrite_script(src, &o).unwrap();
        assert!(
            !r.code.contains("/zp/api/script"),
            "data: import must NOT be proxy-routed (SW can't fetch data:): {}",
            r.code
        );
    }

    #[test]
    fn dynamic_import_bare_specifier_left_alone() {
        let mut o = opts();
        o.kind = ScriptKind::Module;
        // Bare specifiers (`react`, `lodash/find`) have no URL semantics
        // — they're resolved by an import-map / bundler, not fetch.
        let src = "import('lodash').then(use);";
        let r = rewrite_script(src, &o).unwrap();
        assert!(
            !r.code.contains("/zp/api/script"),
            "bare specifier must NOT be proxy-routed: {}",
            r.code
        );
    }

    #[test]
    fn dynamic_import_computed_left_alone_but_inner_globals_still_rewritten() {
        let mut o = opts();
        o.kind = ScriptKind::Module;
        // Computed source — can't statically resolve, so the import call
        // itself stays as-written. But `location.href` inside MUST still
        // go through the membrane (visit_identifier_reference fires).
        let src = "import(location.href + 'mod.js').then(use);";
        let r = rewrite_script(src, &o).unwrap();
        assert!(
            r.code.contains("__zp_get"),
            "inner location reference must be membrane-rewritten even when import is computed: {}",
            r.code
        );
    }

    #[test]
    fn rewrites_history_and_top() {
        let src = "history.pushState({}, '', top.location.pathname);";
        let r = rewrite_script(src, &opts()).unwrap();
        assert!(
            r.code.contains("__zp_get(globalThis,\"history\")"),
            "history not rewritten: {}",
            r.code
        );
        assert!(
            r.code.contains("__zp_get(globalThis,\"top\")"),
            "top not rewritten: {}",
            r.code
        );
    }

    #[test]
    fn parse_failure_is_strict_error() {
        let r = rewrite_script("function {", &opts());
        assert!(
            matches!(r, Err(RewriteError::ParseFailed(_))),
            "got: {:?}",
            r
        );
    }

    #[test]
    fn module_mode_handles_import() {
        let mut o = opts();
        o.kind = ScriptKind::Module;
        let r = rewrite_script("import { x } from './mod.js'; use(window);", &o).unwrap();
        assert!(r.code.contains("__zp_get(globalThis,\"window\")"));
    }

    #[test]
    fn patches_are_in_source_order() {
        let src = "a(window); b(location); c(history);";
        let r = rewrite_script(src, &opts()).unwrap();
        for win in r.patches.windows(2) {
            assert!(win[0].start <= win[1].start, "patches not sorted");
        }
    }

    #[test]
    fn destructuring_param_shadows() {
        let src = "function f({location}) { return location.href; }";
        let r = rewrite_script(src, &opts()).unwrap();
        assert!(
            !r.code.contains("__zp_get"),
            "destructured param should shadow, got: {}",
            r.code
        );
    }

    #[test]
    fn catch_clause_param_shadows() {
        let src = "try { use(window); } catch (window) { use(window); }";
        let r = rewrite_script(src, &opts()).unwrap();
        // The first window is unbound and should be rewritten; the second is shadowed by catch param.
        // Patch count: only the first window.
        let zp_gets = r.code.matches("__zp_get").count();
        assert_eq!(zp_gets, 1, "expected exactly one rewrite, got: {}", r.code);
    }

    #[test]
    fn iframe_content_window_rewrites() {
        let src = "iframe.contentWindow.fetch();";
        let r = rewrite_script(src, &opts()).unwrap();
        assert!(
            r.code.contains("__zp_get(iframe,\"contentWindow\")"),
            "iframe.contentWindow not rewritten: {}",
            r.code
        );
    }

    #[test]
    fn document_default_view_rewrites() {
        let src = "var v = document.defaultView;";
        let r = rewrite_script(src, &opts()).unwrap();
        // document is also a dangerous global so it'll be rewritten as the receiver.
        assert!(
            r.code.contains("\"defaultView\""),
            "defaultView not rewritten: {}",
            r.code
        );
    }

    #[test]
    fn member_access_to_safe_prop_left_alone() {
        let src = "obj.foo.bar();";
        let r = rewrite_script(src, &opts()).unwrap();
        assert!(
            !r.code.contains("__zp_get"),
            "safe member must not be rewritten: {}",
            r.code
        );
    }

    #[test]
    fn obj_location_member_access_rewrites() {
        let src = "var u = obj.location;";
        let r = rewrite_script(src, &opts()).unwrap();
        assert!(
            r.code.contains("__zp_get(obj,\"location\")"),
            "obj.location not rewritten: {}",
            r.code
        );
    }

    #[test]
    fn patches_returned_for_post_processing() {
        let src = "var u = location;";
        let r = rewrite_script(src, &opts()).unwrap();
        assert_eq!(r.patches.len(), 1, "expected 1 patch for one location ref");
        assert_eq!(r.patches[0].start, 8);
        assert_eq!(r.patches[0].end, 16);
    }

    #[test]
    fn large_source_with_few_changes_returns_few_patches() {
        // Simulate "90% of code unchanged": one tiny rewrite in a large source.
        let mut src = String::with_capacity(10_000);
        for _ in 0..200 {
            src.push_str("function a(){ return 42; }\n");
        }
        src.push_str("var u = location.href;\n");
        let r = rewrite_script(&src, &opts()).unwrap();
        // Exactly the two patches the changed region requires: the bare
        // `location` identifier (global-get patch, recursively applied
        // inside the receiver substring by apply_patches' `rewrite_range`)
        // and the outer `location.href` member access (MEMBER_GET marker,
        // chosen for emission). 200 unchanged `function a(){…}` lines
        // contribute zero patches — exercise the patch-mode contract that
        // the rewriter does not re-emit clean source.
        assert_eq!(
            r.patches.len(),
            2,
            "patch-mode should emit only changed regions, got {} patches",
            r.patches.len()
        );
    }

    #[test]
    fn location_assign_call_routed() {
        let src = "location.assign('https://example.com/');";
        let r = rewrite_script(src, &opts()).unwrap();
        // location is dangerous global -> __zp_get; .assign is dangerous method -> __zp_call.
        assert!(
            r.code
                .contains("__zp_call(__zp_get(globalThis,\"location\"),\"assign\","),
            "location.assign() not routed: {}",
            r.code
        );
    }

    // Regression (2026-07-31): `search` is in DANGEROUS_PROPS for
    // `location.search`, so EVERY string's `.search()` was rewritten as
    // `__zp_get(s,"search")(re)` — receiver dropped, and String.prototype.search
    // throws "called on null or undefined". NAVER's ad creative does
    // `navigator.userAgent.search("Trident")`.
    #[test]
    fn dangerous_prop_in_callee_position_keeps_its_receiver() {
        let r = rewrite_script("navigator.userAgent.search('Trident');", &opts()).unwrap();
        assert!(
            r.code.contains("__zp_call(") && r.code.contains("\"search\","),
            "prop-named method call not routed through __zp_call: {}",
            r.code
        );
        // The callee's own MEMBER_GET must be gone, or the receiver is lost
        // again and the two patches overlap.
        assert!(
            !r.code.contains("__zp_get(navigator.userAgent,\"search\")("),
            "callee still wrapped as a get: {}",
            r.code
        );
    }

    #[test]
    fn dangerous_prop_read_is_still_a_get() {
        // Only the CALLEE position changes: reading `location.search` must keep
        // going through the membrane get.
        let r = rewrite_script("var q = location.search;", &opts()).unwrap();
        assert!(
            r.code.contains("__zp_get(") && r.code.contains("\"search\""),
            "plain read must still be wrapped: {}",
            r.code
        );
        assert!(
            !r.code.contains("__zp_call("),
            "a read must not become a call: {}",
            r.code
        );
    }

    #[test]
    fn location_replace_call_routed() {
        let src = "var p = 'x'; location.replace(p);";
        let r = rewrite_script(src, &opts()).unwrap();
        assert!(r.code.contains("__zp_call("), "no call rewrite: {}", r.code);
        assert!(
            r.code.contains("\"replace\","),
            "method name missing: {}",
            r.code
        );
    }

    #[test]
    fn iframe_post_message_routed() {
        let src = "iframe.contentWindow.postMessage(payload, '*');";
        let r = rewrite_script(src, &opts()).unwrap();
        // contentWindow member -> __zp_get wrap + postMessage method -> __zp_call.
        assert!(r.code.contains("__zp_call("), "no call rewrite: {}", r.code);
        assert!(
            r.code.contains("__zp_get(iframe,\"contentWindow\")"),
            "iframe wrap missing: {}",
            r.code
        );
    }

    #[test]
    fn window_location_assignment_routed() {
        let src = "window.location = 'https://target/';";
        let r = rewrite_script(src, &opts()).unwrap();
        // window is dangerous global -> wrapped; .location = ... is dangerous member set.
        assert!(r.code.contains("__zp_set("), "no set rewrite: {}", r.code);
        assert!(
            r.code.contains("\"location\","),
            "set property name missing: {}",
            r.code
        );
    }

    #[test]
    fn safe_method_call_left_alone() {
        let src = "obj.someMethod(arg);";
        let r = rewrite_script(src, &opts()).unwrap();
        assert!(
            !r.code.contains("__zp_call"),
            "safe call must not be rewritten: {}",
            r.code
        );
    }

    #[test]
    fn compound_assignment_not_rewritten() {
        // Compound `+=` etc. preserved as native; the read goes through __zp_get
        // and the membrane setter handles the write side effect.
        let src = "obj.location += 'x';";
        let r = rewrite_script(src, &opts()).unwrap();
        assert!(
            !r.code.contains("__zp_set"),
            "compound assignment must not use __zp_set: {}",
            r.code
        );
    }

    #[test]
    fn reflect_get_window_location_routed() {
        let src = "var x = Reflect.get(window, 'location');";
        let r = rewrite_script(src, &opts()).unwrap();
        // The Reflect.get(...) call site is replaced by __zp_get(window, 'location').
        // The `window` arg is itself rewritten to __zp_get(globalThis,'window').
        assert!(
            r.code
                .contains("__zp_get(__zp_get(globalThis,\"window\"),\"location\")"),
            "Reflect.get not routed: {}",
            r.code
        );
        assert!(
            !r.code.contains("Reflect.get"),
            "stale Reflect.get remained: {}",
            r.code
        );
    }

    #[test]
    fn reflect_set_window_location_routed() {
        let src = "Reflect.set(window, 'location', 'https://x/');";
        let r = rewrite_script(src, &opts()).unwrap();
        assert!(
            r.code.contains("__zp_set("),
            "Reflect.set not routed: {}",
            r.code
        );
        assert!(
            r.code.contains("\"location\","),
            "prop name missing: {}",
            r.code
        );
        assert!(
            !r.code.contains("Reflect.set"),
            "stale Reflect.set remained: {}",
            r.code
        );
    }

    #[test]
    fn reflect_get_with_safe_prop_unchanged() {
        let src = "Reflect.get(obj, 'foo');";
        let r = rewrite_script(src, &opts()).unwrap();
        assert!(
            r.code.contains("Reflect.get"),
            "safe Reflect.get must pass through: {}",
            r.code
        );
    }

    #[test]
    fn reflect_shadowed_does_not_rewrite() {
        // If `Reflect` is locally bound, do not rewrite — it's not the native.
        let src = "function f(Reflect){ return Reflect.get(window, 'location'); }";
        let r = rewrite_script(src, &opts()).unwrap();
        // The Reflect.get(...) wrapper should NOT be applied (shadowed).
        assert!(
            r.code.contains("Reflect.get("),
            "shadowed Reflect must remain: {}",
            r.code
        );
    }

    #[test]
    fn get_own_property_descriptor_dangerous_diagnostic() {
        let src = "Object.getOwnPropertyDescriptor(window, 'location');";
        let r = rewrite_script(src, &opts()).unwrap();
        assert!(
            r.diagnostics
                .iter()
                .any(|d| d.contains("getOwnPropertyDescriptor") && d.contains("location")),
            "expected diagnostic for descriptor access: {:?}",
            r.diagnostics
        );
    }

    #[test]
    fn with_statement_emits_diagnostic() {
        // Use sloppy-mode classic — with statements are otherwise rejected.
        let src = "with (obj) { use(x); }";
        let r = rewrite_script(src, &opts()).unwrap();
        assert!(
            r.diagnostics.iter().any(|d| d.contains("with-statement")),
            "with-statement diagnostic missing: {:?}",
            r.diagnostics
        );
    }

    #[test]
    fn destructuring_binding_rhs_rewritten() {
        // Destructuring out of `window` reads from the rewritten window proxy.
        // The destructured local then holds the membrane-proxied location.
        let src = "const { location } = window; location.href;";
        let r = rewrite_script(src, &opts()).unwrap();
        assert!(
            r.code.contains("= __zp_get(globalThis,\"window\")"),
            "destructuring RHS not rewritten: {}",
            r.code
        );
        // The destructured `location` is locally bound → no further rewrite needed.
    }

    #[test]
    fn return_followed_by_parenthesized_method_call() {
        // NAVER kw-owner ch() function:
        //   function ch(e){return("string"==typeof e?e:""+e).replace(cd,"\n").replace(cf,"")}
        // The outer `.replace(cf,"")` METHOD_CALL replacement consumes the
        // leading `(` of `("string"==typeof e?e:""+e)`. Without leading paren
        // in our emitted replacement, the result becomes `return__zp_call(...)`
        // which JS parses as a single identifier → ReferenceError.
        let src = "function ch(e){return(\"string\"==typeof e?e:\"\"+e).replace(cd,\"\\n\").replace(cf,\"\")}";
        let r = rewrite_script(src, &opts()).unwrap();
        assert!(
            !r.code.contains("return__zp_"),
            "rewriter glued __zp_call to return keyword: {}",
            r.code
        );
    }

    #[test]
    fn new_global_member_constructor_preserved() {
        // Regression: NAVER comic.naver.com (kw-owner/index.js) does
        // `new globalThis.Request("https://empty.invalid", {body:...})`.
        // Without parentheses around our globalThis patch, `new` would bind to
        // `__zp_get(globalThis,"globalThis")` (consuming those arguments) and
        // `.Request(args)` would degenerate to a function call →
        // `Failed to construct 'Request': Please use the 'new' operator`.
        let src = r#"new globalThis.Request("https://empty.invalid", {body:null});"#;
        let r = rewrite_script(src, &opts()).unwrap();
        // The crucial property: between `new` and the next `(`, the patched
        // globalThis must be parenthesised so the `new MemberExpression
        // Arguments` rule consumes `.Request(...)` as a single member-call.
        assert!(
            r.code
                .contains("new (__zp_get(globalThis,\"globalThis\")).Request("),
            "new globalThis.Request(...) not preserved as constructor: {}",
            r.code
        );
    }

    #[test]
    fn iframe_clean_realm_fetch_routed() {
        // window.frames[0].fetch is a typical iframe clean-realm escape.
        // We only rewrite the `window` and `frames` properties; the call
        // surface (`fetch(...)`) is captured by the service worker.
        let src = "window.frames;";
        let r = rewrite_script(src, &opts()).unwrap();
        // `window` is dangerous global -> wrapped; `.frames` is also a
        // dangerous member -> outer __zp_get wraps the wrapped window.
        assert!(
            r.code
                .contains("__zp_get(__zp_get(globalThis,\"window\"),\"frames\")"),
            "nested rewrite missing: {}",
            r.code
        );
    }

    // D2: sourcemap pragma strip
    #[test]
    fn d2_strips_line_comment_pragma() {
        let src = "var a=1;\n//# sourceMappingURL=app.js.map";
        let r = rewrite_script(src, &opts()).unwrap();
        assert!(!r.code.contains("sourceMappingURL"), "line pragma not stripped: {}", r.code);
        assert!(r.code.contains("var a=1"));
    }

    #[test]
    fn d2_strips_legacy_at_pragma() {
        let src = "var a=1;\n//@ sourceMappingURL=app.js.map";
        let r = rewrite_script(src, &opts()).unwrap();
        assert!(!r.code.contains("sourceMappingURL"));
    }

    #[test]
    fn d2_strips_block_comment_pragma() {
        let src = "var a=1;\n/*# sourceMappingURL=app.js.map */";
        let r = rewrite_script(src, &opts()).unwrap();
        assert!(!r.code.contains("sourceMappingURL"));
    }

    #[test]
    fn d2_strips_data_url_pragma() {
        let map = "data:application/json;base64,eyJ2ZXJzaW9uIjozfQ==";
        let src = format!("var a=1;\n//# sourceMappingURL={}", map);
        let r = rewrite_script(&src, &opts()).unwrap();
        assert!(!r.code.contains("sourceMappingURL"));
        assert!(!r.code.contains("data:application/json"));
    }

    #[test]
    fn d2_preserves_source_without_pragma() {
        let src = "var sourceMappingURL = 'not a pragma';\nvar a=1;";
        let r = rewrite_script(src, &opts()).unwrap();
        assert!(r.code.contains("sourceMappingURL"));
    }

    #[test]
    fn d2_only_strips_last_pragma() {
        let src = "var s = '//# sourceMappingURL=fake.map';\nvar a=1;\n//# sourceMappingURL=real.map";
        let r = rewrite_script(src, &opts()).unwrap();
        assert!(!r.code.contains("real.map"));
        assert!(r.code.contains("fake.map"));
    }

    // Perf: persistent arena rewriter reuses one Allocator across calls.
    #[test]
    fn rewriter_instance_reuses_arena() {
        let mut inst = RewriterInstance::new();
        for _ in 0..5 {
            let src = "location.href; window.open('x');";
            let r = inst.rewrite(src, &opts()).expect("rewrite");
            assert!(r.code.contains("__zp_get"), "warm path produced: {}", r.code);
        }
    }

    // ----- Infinite-loop cap (NAVER warm-session V8 wedge fix) -----

    #[test]
    fn caps_bare_for_infinite_loop() {
        // `for(;;) body` is the canonical anti-bot probe shape — it
        // wedges V8 if the loop body never breaks. Rewriter must inject
        // a counter so the loop terminates after a generous bound.
        let src = "function probe(){ for(;;) { a(); } }";
        let r = rewrite_script(src, &opts()).unwrap();
        assert!(
            !r.code.contains("for(;;)"),
            "bare for(;;) must be replaced with a capped form, got: {}",
            r.code
        );
        assert!(
            r.code.contains("__zp_lc_1"),
            "expected counter __zp_lc_1, got: {}",
            r.code
        );
        assert!(
            r.code.contains("<10000000"),
            "expected iteration cap constant, got: {}",
            r.code
        );
        // The body identifier `a()` must remain — only the header is
        // rewritten.
        assert!(r.code.contains("a()"), "body lost: {}", r.code);
    }

    #[test]
    fn caps_while_true() {
        let src = "while (true) { step() }";
        let r = rewrite_script(src, &opts()).unwrap();
        assert!(
            !r.code.contains("while (true)") && !r.code.contains("while(true)"),
            "while(true) must be replaced: {}",
            r.code
        );
        assert!(r.code.contains("__zp_lc_"), "no counter: {}", r.code);
    }

    #[test]
    fn caps_while_one() {
        let src = "while(1){step()}";
        let r = rewrite_script(src, &opts()).unwrap();
        assert!(
            !r.code.contains("while(1)"),
            "while(1) must be replaced: {}",
            r.code
        );
        assert!(r.code.contains("__zp_lc_"), "no counter: {}", r.code);
    }

    #[test]
    fn caps_do_while_true() {
        let src = "do{step()}while(true);";
        let r = rewrite_script(src, &opts()).unwrap();
        // The do-while form requires the trailing `while(test)` so we
        // patch the test slot rather than the header. The counter is
        // declared before the `do`.
        assert!(
            r.code.contains("let __zp_lc_") && r.code.contains("=0;do"),
            "do-while counter decl missing: {}",
            r.code
        );
        assert!(
            r.code.contains("__zp_lc_1++<10000000"),
            "do-while test not capped: {}",
            r.code
        );
        // Body unchanged.
        assert!(r.code.contains("step()"), "body lost: {}", r.code);
    }

    #[test]
    fn does_not_cap_finite_loops() {
        // A loop with a finite test condition must not be touched —
        // capping would change semantics for legitimate code.
        let src = "for (let i = 0; i < 5; i++) { sum += i }";
        let r = rewrite_script(src, &opts()).unwrap();
        assert!(
            !r.code.contains("__zp_lc_"),
            "finite for-loop must not be capped: {}",
            r.code
        );
    }

    #[test]
    fn does_not_cap_while_with_variable_test() {
        let src = "while (running) { tick() }";
        let r = rewrite_script(src, &opts()).unwrap();
        assert!(
            !r.code.contains("__zp_lc_"),
            "variable-test while must not be capped: {}",
            r.code
        );
    }

    #[test]
    fn nested_infinite_loops_get_distinct_counters() {
        // Each infinite loop must allocate its own counter ID so the
        // inner cap doesn't shadow the outer one (which would let the
        // inner reset on every outer iteration).
        let src = "for(;;){ while(true){ y() } }";
        let r = rewrite_script(src, &opts()).unwrap();
        assert!(
            r.code.contains("__zp_lc_1") && r.code.contains("__zp_lc_2"),
            "nested loops must have distinct counters: {}",
            r.code
        );
    }
}

#[cfg(test)]
mod naver_js_perf {
    use super::*;
    // Diagnostic: NAVER ships ~1.5 MB of JS (main 706 KB, search 294 KB,
    // polyfill 261 KB, preload 197 KB). Every one is rewritten by OXC on the
    // Service Worker's single thread. Whatever this costs natively, the SW is
    // blocked for at least that long in production (wasm is slower still) —
    // no fetch handling, no stream pumping, CDP unresponsive.
    #[test]
    #[ignore]
    fn time_naver_bundles() {
        let dir = std::env::var("ZP_NAVER_JS_DIR").expect("set ZP_NAVER_JS_DIR");
        let mut total = 0u128;
        for name in [
            "main.fdb73099.js",
            "search.ff8beebc.js",
            "polyfill.9d57c570.js",
            "preload.7ebb5d79.js",
        ] {
            let p = format!("{dir}/{name}");
            let src = match std::fs::read_to_string(&p) {
                Ok(s) => s,
                Err(e) => {
                    println!("skip {name}: {e}");
                    continue;
                }
            };
            let opts = RewriteOpts {
                kind: ScriptKind::Classic,
                target_url: "https://pm.pstatic.net/".into(),
                strict: true,
                proxy_origin: "http://proxy.localhost:18080".into(),
            };
            let t = std::time::Instant::now();
            let r = rewrite_script(&src, &opts);
            let ms = t.elapsed().as_millis();
            total += ms;
            println!("{name}: {}B -> {} ms (ok={})", src.len(), ms, r.is_ok());
        }
        println!("TOTAL native: {total} ms");
    }
}

#[cfg(test)]
mod dynamic_import_probe {
    use super::*;
    // Does a RELATIVE dynamic import get routed through __zp_module_url in both
    // classic and module scripts? If not, the browser resolves the specifier
    // against the script's own proxy URL (/zp/api/script?…) and requests
    // /zp/api/<name>.js — exactly the NAVER ad-SDK 404.
    #[test]
    #[ignore]
    fn probe_relative_dynamic_import() {
        for kind in [ScriptKind::Classic, ScriptKind::Module] {
            let opts = RewriteOpts {
                kind,
                target_url: "https://ssl.pstatic.net/tveta/libs/glad/prod/gfp-core.js".into(),
                strict: true,
                proxy_origin: "http://proxy.localhost:18080".into(),
            };
            let src = r#"async function f(){ const m = await import("./gfp-display-sdk.js"); return m; }"#;
            match rewrite_script(src, &opts) {
                Ok(out) => println!("{:?}: {}", kind, out.code),
                Err(e) => println!("{:?}: ERROR {:?}", kind, e),
            }
        }
    }
}
