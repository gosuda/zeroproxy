#[test]
fn rewrite_safeframe_full() {
    let src = std::fs::read_to_string(".lean-ctx/safeframe.js")
        .or_else(|_| std::fs::read_to_string("../.lean-ctx/safeframe.js"))
        .expect("safeframe.js missing");
    let out = zp_rewriter::rewrite_script(&src, "classic", "https://www.naver.com/", "/zp/");
    eprintln!("ok={} err={:?} code_len={}", out.ok(), out.error(), out.code().len());
    assert!(out.ok(), "rewrite failed: {}", out.error());
}
