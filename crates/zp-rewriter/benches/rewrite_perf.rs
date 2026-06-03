//! Performance baseline for `zp-rewriter`.
//!
//! Plan target (E3): patch-mode warm rewrite ≥5x faster than cold full re-emit
//! on large scripts. We measure cold (new RewriterInstance per call) and warm
//! (reused instance) latency across script size buckets.

use criterion::{black_box, criterion_group, criterion_main, BenchmarkId, Criterion, Throughput};
use zp_rewriter::{rewrite_script, RewriteOpts, RewriterInstance, ScriptKind};

fn opts() -> RewriteOpts {
    RewriteOpts {
        kind: ScriptKind::Classic,
        target_url: "https://example.com/".into(),
        strict: true,
    }
}

/// Build a synthetic JS source approximately `target_bytes` long, mostly
/// "background" code with a sprinkling of dangerous-global references so the
/// patch-mode path has real work to do.
fn synth_source(target_bytes: usize) -> String {
    let unit =
        "function noop_{i}() { var x = 42; var y = String.fromCharCode(65); return x + y; }\n";
    let escape_line =
        "var u_{i} = location.href; var w_{i} = window.innerWidth; var d_{i} = document.title;\n";
    let mut s = String::with_capacity(target_bytes + 256);
    let mut i: usize = 0;
    while s.len() < target_bytes {
        s.push_str(&unit.replace("{i}", &i.to_string()));
        if i % 20 == 0 {
            s.push_str(&escape_line.replace("{i}", &i.to_string()));
        }
        i += 1;
    }
    s
}

fn bench_cold_rewrites(c: &mut Criterion) {
    let mut group = c.benchmark_group("rewrite_cold");
    for &size_kb in &[10_usize, 100, 500, 1024] {
        let src = synth_source(size_kb * 1024);
        group.throughput(Throughput::Bytes(src.len() as u64));
        group.bench_with_input(BenchmarkId::from_parameter(size_kb), &src, |b, s| {
            b.iter(|| {
                let r = rewrite_script(black_box(s), &opts()).expect("rewrite");
                black_box(r.patches.len());
            });
        });
    }
    group.finish();
}

fn bench_warm_rewrites(c: &mut Criterion) {
    let mut group = c.benchmark_group("rewrite_warm");
    for &size_kb in &[10_usize, 100, 500, 1024] {
        let src = synth_source(size_kb * 1024);
        group.throughput(Throughput::Bytes(src.len() as u64));
        group.bench_with_input(BenchmarkId::from_parameter(size_kb), &src, |b, s| {
            let mut inst = RewriterInstance::new();
            b.iter(|| {
                let r = inst.rewrite(black_box(s), &opts()).expect("rewrite");
                black_box(r.patches.len());
            });
        });
    }
    group.finish();
}

fn bench_patch_count_sanity(c: &mut Criterion) {
    let mut group = c.benchmark_group("patch_count");
    let src = "var u = location.href; var w = window.innerWidth;";
    group.bench_function("small_two_rewrites", |b| {
        b.iter(|| {
            let r = rewrite_script(black_box(src), &opts()).expect("rewrite");
            assert!(r.patches.len() >= 2);
        });
    });
    group.finish();
}

criterion_group!(
    benches,
    bench_cold_rewrites,
    bench_warm_rewrites,
    bench_patch_count_sanity
);
criterion_main!(benches);
