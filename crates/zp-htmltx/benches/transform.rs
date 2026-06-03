//! Server-side throughput bench for `zp-htmltx::transform`.
//!
//! Synthetic large HTML fixture (typical mix of scripts / links / imgs /
//! anchors) to measure end-to-end transform cost. Use after U round to
//! quantify the helper-chain dedup + per-attribute alloc removal effect,
//! and to find remaining hot paths via flamegraph/criterion histogram.

use criterion::{black_box, criterion_group, criterion_main, Criterion};
use zp_htmltx::{transform, TransformOptions};

const PROXY_ORIGIN: &str = "http://proxy.localhost:18080";
const TARGET_URL: &str = "https://www.example.com/";

/// Build a synthetic page resembling a heavy SPA landing page.
/// Mix: head with link tags + inline scripts + body with anchors + imgs + scripts.
fn make_page(n_scripts: usize, n_links: usize, n_imgs: usize, n_anchors: usize) -> String {
    make_page_with_inline(n_scripts, n_links, n_imgs, n_anchors, 3)
}

fn make_page_with_inline(
    n_scripts: usize,
    n_links: usize,
    n_imgs: usize,
    n_anchors: usize,
    n_inline: usize,
) -> String {
    let mut s = String::with_capacity(64 * 1024);
    s.push_str("<!DOCTYPE html><html><head>");
    s.push_str("<meta charset=\"utf-8\">");
    s.push_str("<title>Synthetic bench fixture</title>");
    for i in 0..n_links {
        s.push_str(&format!(
            "<link rel=\"stylesheet\" href=\"https://cdn.example.com/static/css/bundle-{}.css?v=abc123def456&hash=xyz789\">",
            i
        ));
    }
    // configurable inline scripts (rewriter path — OXC parse hot path)
    for i in 0..n_inline {
        s.push_str(&format!(
            "<script>window.__init_{} = function(){{ var x = 1; var y = x + 2; return y; }};</script>",
            i
        ));
    }
    s.push_str("</head><body>");
    for i in 0..n_anchors {
        s.push_str(&format!(
            "<a href=\"/route/path-{}/sub/page.html\" onclick=\"handle{}(event)\">Link {}</a>",
            i, i, i
        ));
    }
    for i in 0..n_imgs {
        s.push_str(&format!(
            "<img src=\"https://cdn.example.com/img/asset-{}.png?w=320&h=240&q=80\" alt=\"img {}\">",
            i, i
        ));
    }
    for i in 0..n_scripts {
        s.push_str(&format!(
            "<script src=\"https://cdn.example.com/js/chunk-{}.js?v=abc123\" type=\"module\"></script>",
            i
        ));
    }
    s.push_str("</body></html>");
    s
}

fn opts() -> TransformOptions {
    TransformOptions {
        target_url: TARGET_URL.into(),
        strict: true,
        pending_gate: false,
        proxy_origin: PROXY_ORIGIN.into(),
    }
}

fn bench_typical(c: &mut Criterion) {
    let html = make_page(50, 30, 100, 200);
    let o = opts();
    println!("typical fixture size: {} bytes", html.len());
    c.bench_function("transform_typical", |b| {
        b.iter(|| transform(black_box(&html), black_box(&o)).unwrap())
    });
}

fn bench_large(c: &mut Criterion) {
    let html = make_page(200, 100, 400, 800);
    let o = opts();
    println!("large fixture size: {} bytes", html.len());
    c.bench_function("transform_large", |b| {
        b.iter(|| transform(black_box(&html), black_box(&o)).unwrap())
    });
}

fn bench_subresource_heavy(c: &mut Criterion) {
    // imgs + links dominated, exercises proxied_subresource_url + absolute_target_url
    // hot path (the helpers U round optimized).
    let html = make_page(20, 500, 500, 50);
    let o = opts();
    println!("subresource-heavy fixture size: {} bytes", html.len());
    c.bench_function("transform_subresource_heavy", |b| {
        b.iter(|| transform(black_box(&html), black_box(&o)).unwrap())
    });
}

fn bench_no_inline_scripts(c: &mut Criterion) {
    // Same as typical but ZERO inline scripts — isolates the
    // zp-rewriter::rewrite_script (OXC parse) cost vs the rest.
    let html = make_page_with_inline(50, 30, 100, 200, 0);
    let o = opts();
    c.bench_function("transform_typical_no_inline", |b| {
        b.iter(|| transform(black_box(&html), black_box(&o)).unwrap())
    });
}

fn bench_inline_heavy(c: &mut Criterion) {
    // Inline-script heavy: subset of typical but with many inline scripts.
    let html = make_page_with_inline(0, 0, 0, 0, 50);
    let o = opts();
    c.bench_function("transform_inline_only_50", |b| {
        b.iter(|| transform(black_box(&html), black_box(&o)).unwrap())
    });
}

criterion_group!(
    benches,
    bench_typical,
    bench_large,
    bench_subresource_heavy,
    bench_no_inline_scripts,
    bench_inline_heavy
);
criterion_main!(benches);
