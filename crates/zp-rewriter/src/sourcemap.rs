//! D2 source-map composer.
//!
//! Builds a Source Map v3 JSON document mapping each line/column in the
//! REWRITTEN source back to the corresponding line/column in the
//! ORIGINAL source. DevTools breakpoints set on `var u = __zp_loc.href`
//! therefore land on the original `var u = location.href`.
//!
//! ## Algorithm
//!
//! The rewriter emits an ordered, non-overlapping `Vec<Patch>` covering
//! the dangerous identifier / member-access sites. We use it directly as
//! the segmentation:
//!
//! * **Unchanged region** between two patches — byte-identical to the
//!   original. Emit a single mapping at the start of each generated line
//!   that points to the matching position in the original.
//! * **Patch region** (the replacement text) — emit a mapping at the
//!   replacement's start pointing to the patch start in the original.
//!   Subsequent characters of the replacement are not re-mapped; per
//!   §A.5 of the spec a missing mapping interpolates from the previous
//!   one, which is the right semantics for "the whole replacement maps
//!   back to the same original site".
//!
//! ## Out of scope (deferred)
//!
//! * Composition with the *original* source map (e.g. when the target
//!   site shipped a TypeScript-compiled artifact). Chaining
//!   `rewriter_map ∘ original_map` is the next perf-track follow-on; the
//!   wire shape here keeps the door open by carrying `sourcesContent`
//!   so the chained composer can splice in the further-original sources.
//! * `names` — currently empty (`[]`). The OXC AST has the identifier
//!   text on every patched node; populating `names` for nicer DevTools
//!   labels is a small follow-up that doesn't change correctness.
//!
//! ## References
//!
//! * Source Map v3 spec: <https://tc39.es/source-map/>
//! * §3 schema, §A.4-A.5 VLQ encoding + segment interpolation.

use crate::Patch;

const BASE64_ALPHABET: &[u8; 64] =
    b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/// Encode a signed integer in the §A.4 base64-VLQ format. The low bit
/// carries the sign, the next 5 bits carry magnitude, and a continuation
/// flag chains additional sextets.
fn vlq_encode_into(value: i64, out: &mut String) {
    // §A.4 sign-magnitude: low bit = sign, then magnitude.
    let mut vlq = if value < 0 {
        ((-value) as u64) << 1 | 1
    } else {
        (value as u64) << 1
    };
    loop {
        let mut digit = (vlq & 0b1_1111) as u8;
        vlq >>= 5;
        if vlq != 0 {
            digit |= 0b10_0000; // continuation flag
        }
        out.push(BASE64_ALPHABET[digit as usize] as char);
        if vlq == 0 {
            return;
        }
    }
}

/// JSON-escape a string into `out`. Hand-rolled to avoid pulling in
/// `serde_json` for the rewriter (kept slim — it's hot path).
fn json_escape_into(s: &str, out: &mut String) {
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            '\u{08}' => out.push_str("\\b"),
            '\u{0c}' => out.push_str("\\f"),
            c if (c as u32) < 0x20 => {
                out.push_str(&format!("\\u{:04x}", c as u32));
            }
            c => out.push(c),
        }
    }
    out.push('"');
}

/// Map a byte offset in `source` to (line_0based, col_0based) using
/// `\n` as the line terminator. Counts columns in UTF-16 code units to
/// match the Source Map v3 spec §3 ("Both the generated and original
/// column numbers are in the source's UTF-16 code unit space"). For
/// ASCII (the dominant case in JavaScript identifiers / keywords) this
/// is identical to byte counting.
fn offset_to_line_col(source: &str, offset: usize) -> (u32, u32) {
    let offset = offset.min(source.len());
    let prefix = &source[..offset];
    let mut line: u32 = 0;
    let mut col_u16: u32 = 0;
    for c in prefix.chars() {
        if c == '\n' {
            line += 1;
            col_u16 = 0;
        } else {
            col_u16 += c.len_utf16() as u32;
        }
    }
    (line, col_u16)
}

/// Compose a Source Map v3 JSON document mapping rewritten → original.
///
/// `source_url` is what goes into `"sources": [source_url]`; typically
/// the proxy-side target URL of the script. `rewritten` is required so
/// we walk its newlines in lockstep with the generated-side line counter.
pub fn compose_rewrite_map(
    source: &str,
    rewritten: &str,
    patches: &[Patch],
    source_url: &str,
) -> String {
    // ---------- Walk patches, emitting mappings as we go. ----------
    //
    // State machine: we co-iterate the rewritten string and a "cursor
    // through the original source", switching every time we cross a
    // patch boundary. Each generated line gets at least one mapping at
    // column 0 (so a missing mapping never accidentally extends to the
    // next line per §A.5).
    let mut mappings = String::with_capacity(rewritten.len() / 4 + 64);
    // VLQ deltas: prev_gen_col, prev_src_idx, prev_src_line, prev_src_col.
    let mut prev_gen_col: i64 = 0;
    let mut prev_src_line: i64 = 0;
    let mut prev_src_col: i64 = 0;
    // `prev_src_idx` is implicit (we only emit one source) — every
    // segment delta is 0 against the previous one, which collapses to a
    // single 'A' VLQ. Tracked here for clarity.
    let mut prev_src_idx: i64 = 0;
    // Track the generated-side line so we know how many ';' separators
    // we still owe in `mappings`.
    let mut current_gen_line: u32 = 0;
    let mut needs_line_separator = false;

    let emit_segment = |mappings: &mut String,
                        prev_gen_col: &mut i64,
                        prev_src_idx: &mut i64,
                        prev_src_line: &mut i64,
                        prev_src_col: &mut i64,
                        needs_comma: bool,
                        gen_col: u32,
                        src_line: u32,
                        src_col: u32| {
        if needs_comma {
            mappings.push(',');
        }
        let g = gen_col as i64;
        let sline = src_line as i64;
        let scol = src_col as i64;
        vlq_encode_into(g - *prev_gen_col, mappings);
        vlq_encode_into(0 - *prev_src_idx, mappings); // single source
        vlq_encode_into(sline - *prev_src_line, mappings);
        vlq_encode_into(scol - *prev_src_col, mappings);
        *prev_gen_col = g;
        *prev_src_idx = 0;
        *prev_src_line = sline;
        *prev_src_col = scol;
    };

    let mut gen_offset: usize = 0; // byte cursor through `rewritten`
    let mut src_offset: usize = 0; // byte cursor through `source`
    let mut had_segment_on_current_line = false;

    // Iterate alternating unchanged regions and patch regions. Patches
    // are sorted; the rewriter applies them in order, so we can pair
    // them with the matching span in `rewritten`.
    for patch in patches {
        // ---- Unchanged region [src_offset..patch.start] / mirrored in `rewritten`. ----
        let unchanged_len = patch.start as usize - src_offset;
        let unchanged_src = &source[src_offset..src_offset + unchanged_len];
        let unchanged_gen = &rewritten[gen_offset..gen_offset + unchanged_len];
        debug_assert_eq!(unchanged_src, unchanged_gen);

        // Open this generated line with a mapping at col 0 if we haven't
        // already emitted one for it.
        if !had_segment_on_current_line {
            let (sline, scol) = offset_to_line_col(source, src_offset);
            // Emit at gen_col = current gen-column. We need that column —
            // which is the col of `gen_offset` inside its line.
            let (_gline, gcol) = offset_to_line_col(rewritten, gen_offset);
            // prev_gen_col resets to 0 at the start of each generated line
            // (the spec defines deltas to reset per-line). We handle that
            // in the line-advance branch below; here just emit the segment.
            emit_segment(
                &mut mappings,
                &mut prev_gen_col,
                &mut prev_src_idx,
                &mut prev_src_line,
                &mut prev_src_col,
                needs_line_separator,
                gcol,
                sline,
                scol,
            );
            needs_line_separator = false;
            had_segment_on_current_line = true;
        }

        // Walk the unchanged span; each newline closes a line and opens
        // the next with a fresh col-0 segment.
        for c in unchanged_gen.chars() {
            if c == '\n' {
                mappings.push(';');
                current_gen_line += 1;
                prev_gen_col = 0;
                gen_offset += 1;
                src_offset += 1;
                // Open the next line with a mapping to the corresponding
                // original position.
                let (sline, scol) = offset_to_line_col(source, src_offset);
                emit_segment(
                    &mut mappings,
                    &mut prev_gen_col,
                    &mut prev_src_idx,
                    &mut prev_src_line,
                    &mut prev_src_col,
                    false, // no comma; ';' just emitted
                    0,
                    sline,
                    scol,
                );
                had_segment_on_current_line = true;
            } else {
                let len = c.len_utf8();
                gen_offset += len;
                src_offset += len;
            }
        }

        // ---- Patch region: emit one mapping at the start of the
        //      replacement pointing to (patch.start in source). All
        //      characters of the replacement map to that single site by
        //      virtue of §A.5 interpolation. ----
        let repl = patch.replacement.as_str();
        let (sline, scol) = offset_to_line_col(source, patch.start as usize);
        let (_gline_start, gcol_start) = offset_to_line_col(rewritten, gen_offset);
        emit_segment(
            &mut mappings,
            &mut prev_gen_col,
            &mut prev_src_idx,
            &mut prev_src_line,
            &mut prev_src_col,
            true, // sibling segment on the same line
            gcol_start,
            sline,
            scol,
        );

        for c in repl.chars() {
            if c == '\n' {
                mappings.push(';');
                current_gen_line += 1;
                prev_gen_col = 0;
                gen_offset += 1;
                // After a newline inside the replacement we re-anchor at
                // col 0 of the next generated line, still mapping to the
                // same (sline, scol) — every char of the replacement
                // attributes to the original patch site.
                emit_segment(
                    &mut mappings,
                    &mut prev_gen_col,
                    &mut prev_src_idx,
                    &mut prev_src_line,
                    &mut prev_src_col,
                    false,
                    0,
                    sline,
                    scol,
                );
                had_segment_on_current_line = true;
            } else {
                gen_offset += c.len_utf8();
            }
        }
        // Advance the source cursor past the patched region.
        src_offset = patch.end as usize;
        // `had_segment_on_current_line` stays true — we just emitted one
        // for the replacement.
    }

    // ---- Tail: unchanged region from the last patch end to EOF. ----
    let tail_src = &source[src_offset..];
    let tail_gen = &rewritten[gen_offset..];
    debug_assert_eq!(tail_src, tail_gen);
    if !had_segment_on_current_line && !tail_gen.is_empty() {
        let (sline, scol) = offset_to_line_col(source, src_offset);
        let (_gline, gcol) = offset_to_line_col(rewritten, gen_offset);
        emit_segment(
            &mut mappings,
            &mut prev_gen_col,
            &mut prev_src_idx,
            &mut prev_src_line,
            &mut prev_src_col,
            needs_line_separator,
            gcol,
            sline,
            scol,
        );
        let _ = needs_line_separator;
    }
    // Tail walk only needs to advance `src_offset` so we can pin a
    // segment at column 0 of each new generated line; `gen_offset` was
    // already consumed at the slice into `tail_gen` above, so further
    // ticking it would be a dead store (compiler warning).
    for c in tail_gen.chars() {
        if c == '\n' {
            mappings.push(';');
            current_gen_line += 1;
            prev_gen_col = 0;
            src_offset += 1;
            let (sline, scol) = offset_to_line_col(source, src_offset);
            emit_segment(
                &mut mappings,
                &mut prev_gen_col,
                &mut prev_src_idx,
                &mut prev_src_line,
                &mut prev_src_col,
                false,
                0,
                sline,
                scol,
            );
        } else {
            src_offset += c.len_utf8();
        }
    }
    let _ = current_gen_line;

    // ---------- Serialize JSON. ----------
    let mut out = String::with_capacity(mappings.len() + source.len() + 256);
    out.push_str("{\"version\":3,\"sources\":[");
    json_escape_into(source_url, &mut out);
    out.push_str("],\"sourcesContent\":[");
    json_escape_into(source, &mut out);
    out.push_str("],\"names\":[],\"mappings\":");
    json_escape_into(&mappings, &mut out);
    out.push('}');
    out
}

// ---------------------------------------------------------------------------
// D2 follow-on: chain the rewriter's map with the target site's *original*
// map (the `.map` file the bundler emitted alongside `bundled.js`). DevTools
// then resolves rewritten → typescript-source directly, instead of stopping
// at the bundled .js. Best-effort: any malformed input falls through to the
// unchained map so DevTools still gets *something*.
// ---------------------------------------------------------------------------

/// Compose `rewriter_map ∘ original_map` and return the JSON for the
/// composed map. When `original_map_json` is malformed / missing
/// required fields, returns `zp_map_json` verbatim — never break the
/// DevTools experience just because an upstream `.map` was bad.
pub fn chain_with_original_map(zp_map_json: &str, original_map_json: &str) -> String {
    match chain_with_original_map_impl(zp_map_json, original_map_json) {
        Ok(json) => json,
        Err(_) => zp_map_json.to_string(),
    }
}

fn chain_with_original_map_impl(
    zp_map_json: &str,
    original_map_json: &str,
) -> Result<String, sourcemap::Error> {
    use sourcemap::{SourceMap, SourceMapBuilder};
    let zp_map = SourceMap::from_slice(zp_map_json.as_bytes())?;
    let orig_map = SourceMap::from_slice(original_map_json.as_bytes())?;

    // Pre-add every original source so source IDs in `add_raw` are
    // stable. We re-add through the builder API because there's no
    // direct "clone sources" entrypoint.
    let mut builder = SourceMapBuilder::new(zp_map.get_file());
    let mut orig_src_remap = Vec::with_capacity(orig_map.get_source_count() as usize);
    for i in 0..orig_map.get_source_count() {
        let src = orig_map.get_source(i).unwrap_or("");
        let new_id = builder.add_source(src);
        if let Some(content) = orig_map.get_source_contents(i) {
            builder.set_source_contents(new_id, Some(content));
        }
        orig_src_remap.push(new_id);
    }

    // For each token in zp_map, look up its src position in orig_map.
    // If the original map covers that point, emit a chained token; if
    // not, drop this mapping (Source Map v3 §A.5 interpolation falls
    // back to the previous neighbour — usually one line above).
    for tok in zp_map.tokens() {
        if let Some(orig_tok) = orig_map.lookup_token(tok.get_src_line(), tok.get_src_col()) {
            let orig_src = orig_tok.get_src_id();
            let new_src_id =
                if orig_src != !0 && (orig_src as usize) < orig_src_remap.len() {
                    Some(orig_src_remap[orig_src as usize])
                } else {
                    None
                };
            builder.add_raw(
                tok.get_dst_line(),
                tok.get_dst_col(),
                orig_tok.get_src_line(),
                orig_tok.get_src_col(),
                new_src_id,
                None,
                false,
            );
        }
    }

    let sm = builder.into_sourcemap();
    let mut out = Vec::new();
    sm.to_writer(&mut out)?;
    Ok(String::from_utf8(out).unwrap_or_else(|e| {
        // sourcemap crate always emits UTF-8; this branch is defensive.
        String::from_utf8_lossy(&e.into_bytes()).into_owned()
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::Patch;

    fn patches(items: &[(u32, u32, &str)]) -> Vec<Patch> {
        items
            .iter()
            .map(|(s, e, r)| Patch {
                start: *s,
                end: *e,
                replacement: (*r).to_string(),
            })
            .collect()
    }

    #[test]
    fn vlq_basic_round_values() {
        // §A.4 sign-magnitude — verified against spec examples.
        let mut s = String::new();
        vlq_encode_into(0, &mut s);
        assert_eq!(s, "A");
        s.clear();
        vlq_encode_into(1, &mut s);
        assert_eq!(s, "C");
        s.clear();
        vlq_encode_into(-1, &mut s);
        assert_eq!(s, "D");
        s.clear();
        vlq_encode_into(16, &mut s);
        assert_eq!(s, "gB");
    }

    #[test]
    fn empty_source_produces_empty_mappings() {
        let map = compose_rewrite_map("", "", &[], "x.js");
        assert!(map.contains("\"mappings\":\"\""));
        assert!(map.contains("\"version\":3"));
    }

    #[test]
    fn single_patch_one_line() {
        let source = "var u = location.href;";
        let patches = patches(&[(8, 16, "__zp_loc")]);
        let rewritten = "var u = __zp_loc.href;";
        let map = compose_rewrite_map(source, rewritten, &patches, "x.js");
        // Must declare version 3 + the one source + sourcesContent embed.
        assert!(map.contains("\"version\":3"));
        assert!(map.contains("\"sources\":[\"x.js\"]"));
        assert!(map.contains("\"sourcesContent\":[\"var u = location.href;\"]"));
        // Mappings field must be present and non-empty.
        let mappings_idx = map.find("\"mappings\":\"").unwrap();
        let tail = &map[mappings_idx + "\"mappings\":\"".len()..];
        let end = tail.find('"').unwrap();
        let mappings = &tail[..end];
        assert!(!mappings.is_empty());
        // No ';' — single generated line.
        assert!(!mappings.contains(';'));
    }

    #[test]
    fn multiline_source_advances_line_separator() {
        let source = "var u = location.href;\nvar w = window.innerWidth;";
        let patches = patches(&[
            (8, 16, "__zp_loc"),
            (33, 39, "__zp_win"),
        ]);
        // Apply patches manually to build the rewritten content.
        let mut rewritten = String::new();
        rewritten.push_str(&source[..8]);
        rewritten.push_str("__zp_loc");
        rewritten.push_str(&source[16..33]);
        rewritten.push_str("__zp_win");
        rewritten.push_str(&source[39..]);
        let map = compose_rewrite_map(source, &rewritten, &patches, "x.js");
        let mappings_idx = map.find("\"mappings\":\"").unwrap();
        let tail = &map[mappings_idx + "\"mappings\":\"".len()..];
        let end = tail.find('"').unwrap();
        let mappings = &tail[..end];
        // Two generated lines → exactly one ';' separator.
        assert_eq!(mappings.matches(';').count(), 1);
    }

    #[test]
    fn json_escape_preserves_quotes_and_backslashes() {
        let mut s = String::new();
        json_escape_into("a\"b\\c\nd", &mut s);
        assert_eq!(s, "\"a\\\"b\\\\c\\nd\"");
    }

    #[test]
    fn offset_to_line_col_counts_lines() {
        let src = "abc\ndef\nghi";
        assert_eq!(offset_to_line_col(src, 0), (0, 0));
        assert_eq!(offset_to_line_col(src, 4), (1, 0));
        assert_eq!(offset_to_line_col(src, 8), (2, 0));
        assert_eq!(offset_to_line_col(src, 10), (2, 2));
    }

    // ---- D2 chaining ----

    #[test]
    fn chain_with_original_map_redirects_to_typescript_source() {
        // Scenario: target site shipped `bundled.js` compiled from
        // `original.ts` with a sibling `bundled.js.map`. We rewrote the
        // bundled.js into rewritten and emitted a zp-map. After chaining,
        // a token in the rewritten output must resolve back to a position
        // in `original.ts`, not `bundled.js`.
        //
        // Layout of the original.ts → bundled.js map:
        //   sources = ["original.ts"]
        //   sourcesContent = ["const url = location.href;\nconsole.log(url);"]
        //   Bundled.js line 0 col 6  (`const url`) ← original.ts line 0 col 6
        //   Bundled.js line 1 col 12 (`console.log`) ← original.ts line 1 col 0
        //
        // We craft the original map directly so the test stays
        // deterministic without invoking a real TS compiler.
        let mut orig = sourcemap::SourceMapBuilder::new(Some("bundled.js"));
        let src = orig.add_source("original.ts");
        orig.set_source_contents(
            src,
            Some("const url = location.href;\nconsole.log(url);"),
        );
        // (dst_line, dst_col) -> (src_line, src_col)
        orig.add_raw(0, 6, 0, 6, Some(src), None, false);
        orig.add_raw(1, 0, 1, 0, Some(src), None, false);
        let mut orig_json = Vec::new();
        orig.into_sourcemap().to_writer(&mut orig_json).unwrap();
        let orig_json = String::from_utf8(orig_json).unwrap();

        // The zp_map's source is `bundled.js` (the SW fetched it as the
        // "original" relative to the rewrite). One token that points
        // into bundled.js line 0 col 6 — the place orig_map says is
        // const-url in original.ts.
        let mut zp = sourcemap::SourceMapBuilder::new(Some("rewritten.js"));
        let zp_src = zp.add_source("bundled.js");
        zp.set_source_contents(zp_src, Some("const url = __zp_get(globalThis,'location').href;\nconsole.log(url);"));
        zp.add_raw(0, 0, 0, 0, Some(zp_src), None, false);
        zp.add_raw(0, 12, 0, 6, Some(zp_src), None, false);
        let mut zp_json = Vec::new();
        zp.into_sourcemap().to_writer(&mut zp_json).unwrap();
        let zp_json = String::from_utf8(zp_json).unwrap();

        // Compose: rewritten.js → original.ts directly.
        let chained = chain_with_original_map(&zp_json, &orig_json);
        let chained_map = sourcemap::SourceMap::from_slice(chained.as_bytes()).unwrap();

        // Sources list now contains original.ts.
        let sources: Vec<&str> = (0..chained_map.get_source_count())
            .map(|i| chained_map.get_source(i).unwrap_or(""))
            .collect();
        assert!(sources.contains(&"original.ts"), "chained map must point at original.ts, got {sources:?}");

        // At least one token in the chained map must resolve to
        // (line 0, col 6) of original.ts — the const-url site.
        let tokens: Vec<_> = chained_map.tokens().collect();
        assert!(!tokens.is_empty(), "chained map must carry tokens");
        let mapped = tokens.iter().find(|t| {
            t.get_source() == Some("original.ts")
                && t.get_src_line() == 0
                && t.get_src_col() == 6
        });
        assert!(
            mapped.is_some(),
            "expected at least one token resolving to original.ts:(0,6), got tokens: {:?}",
            tokens.iter().map(|t| (t.get_source(), t.get_src_line(), t.get_src_col())).collect::<Vec<_>>(),
        );
    }

    #[test]
    fn chain_with_malformed_original_returns_zp_map_verbatim() {
        // Best-effort guarantee: an invalid upstream `.map` must NOT
        // break DevTools. Return the rewriter map verbatim.
        let zp_json = compose_rewrite_map("a", "a", &[], "x.js");
        let chained = chain_with_original_map(&zp_json, "not a sourcemap");
        assert_eq!(chained, zp_json, "fallback must be byte-identical to the zp map");
    }

    #[test]
    fn chain_with_empty_original_map_returns_zp_map_verbatim() {
        let zp_json = compose_rewrite_map("a", "a", &[], "x.js");
        let chained = chain_with_original_map(&zp_json, "");
        assert_eq!(chained, zp_json);
    }
}
