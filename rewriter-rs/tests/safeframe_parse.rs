use oxc_allocator::Allocator;
use oxc_parser::Parser;
use oxc_span::SourceType;

#[test]
fn parse_safeframe_raw() {
    let src = std::fs::read_to_string(".lean-ctx/safeframe.js")
        .or_else(|_| std::fs::read_to_string("../.lean-ctx/safeframe.js"))
        .expect("safeframe.js missing");
    let allocator = Allocator::default();
    let ret = Parser::new(&allocator, &src, SourceType::cjs()).parse();
    eprintln!("raw errors: {}", ret.errors.len());
    for (i, e) in ret.errors.iter().enumerate().take(15) {
        eprintln!("  raw [{}] {:?}", i, e);
    }
    assert!(ret.errors.is_empty(), "raw parse failed");
}

#[test]
fn parse_safeframe_module() {
    let src = std::fs::read_to_string(".lean-ctx/safeframe.js")
        .or_else(|_| std::fs::read_to_string("../.lean-ctx/safeframe.js"))
        .expect("safeframe.js missing");
    let allocator = Allocator::default();
    let ret = Parser::new(&allocator, &src, SourceType::mjs()).parse();
    eprintln!("module errors: {}", ret.errors.len());
    for (i, e) in ret.errors.iter().enumerate().take(5) {
        eprintln!("  module [{}] {:?}", i, e);
    }
}
