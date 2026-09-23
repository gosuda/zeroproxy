//! ERRATA §O1 — rewriter emission matrix.
//!
//! `scratch.rs` prints emitted code for manual inspection; this file pins the
//! **invariants** so a regression fails loudly. Each case asserts on the
//! mediation helper that must appear (or must NOT appear for the negative
//! controls), and — where the emitted goal is still classic-parseable — that
//! the output itself re-parses (a second `rewrite_script` call is the cheapest
//! parser we have; it must not error).

use zp_rewriter::{rewrite_script, RewriteOpts, ScriptKind};

fn opts() -> RewriteOpts {
    RewriteOpts {
        kind: ScriptKind::Classic,
        target_url: "https://example.com/".into(),
        strict: true,
        proxy_origin: "http://proxy.localhost:18080".into(),
    }
}

fn out(src: &str) -> String {
    rewrite_script(src, &opts())
        .unwrap_or_else(|e| panic!("rewrite failed for {src:?}: {e:?}"))
        .code
}

/// Emitted code must contain every `needle`.
fn emits(src: &str, needles: &[&str]) {
    let code = out(src);
    for n in needles {
        assert!(code.contains(n), "expected {n:?} in output of {src:?}\nOUT: {code}");
    }
}

/// Emitted code must contain none of `needles`.
fn not_emits(src: &str, needles: &[&str]) {
    let code = out(src);
    for n in needles {
        assert!(!code.contains(n), "unexpected {n:?} in output of {src:?}\nOUT: {code}");
    }
}

/// The emitted code must itself parse (round-trip through the rewriter).
/// Cases that emit module-goal syntax (import/export) are exempt — the
/// parser is goal-sensitive and the test opts are Classic.
fn reparses(src: &str) {
    let code = out(src);
    rewrite_script(&code, &opts())
        .unwrap_or_else(|e| panic!("emitted code does not re-parse for {src:?}: {e:?}\nOUT: {code}"));
}

// ---------------------------------------------------------------------------
// Assignment-target matrix: every writable position must route through the
// `__zp_get.d` write facade so the sink sees a real reference, not a copy.
// ---------------------------------------------------------------------------

#[test]
fn assignment_targets_route_through_write_facade() {
    for src in [
        "for (location of a) {}",
        "for (location in a) {}",
        "for ([location] of xs) {}",
        "for ({a: location} of xs) {}",
        "[location] = arr;",
        "({a: location} = obj);",
    ] {
        emits(src, &["__zp_get.d.location"]);
        reparses(src);
    }
}

/// Declaration-position dangerous names get a temp binding + a `__zp_set`
/// sync — never a raw `var location` that would shadow the virtual location.
#[test]
fn declaration_targets_sync_via_temp() {
    for src in [
        "for (var location of xs) {}",
        "for (var location in xs) {}",
        "for (var {location} of xs) {}",
        "var {location} = o;",
        "var [location] = a;",
        "var {a: location} = o;",
    ] {
        emits(src, &["__zp_dp_", "__zp_set(globalThis,\"location\""]);
        reparses(src);
    }
}

// ---------------------------------------------------------------------------
// Computed-member matrix: `x[k]` and `x["literal"]` must both mediate.
// ---------------------------------------------------------------------------

#[test]
fn computed_member_reads() {
    for src in ["x[k];", "x['location'];", "this['location'];"] {
        emits(src, &["__zp_get("]);
        reparses(src);
    }
    for src in ["x?.[k];", "x?.['location'];", "location?.['href'];"] {
        emits(src, &["__zp_oget("]);
        reparses(src);
    }
    emits("frames[0];", &["__zp_get(globalThis,\"frames\")", "__zp_get("]);
    emits(
        "frames[i].location;",
        &["__zp_get(globalThis,\"frames\")", "__zp_get(", "\"location\""],
    );
}

#[test]
fn computed_member_writes_and_calls() {
    emits("x[k] = v;", &["__zp_set((x),(k),(v))"]);
    emits("x['location'] = v;", &["__zp_set((x),('location'),(v))"]);
    emits("x[k]++;", &["__zp_get(this.b,this.k)", "__zp_set(this.b,this.k,v)"]);
    emits(
        "x['location'] += y;",
        &["__zp_get(this.b,this.k)", "__zp_set(this.b,this.k,v)", ".v+=(y)"],
    );
    emits("x[k](1,2);", &["__zp_call((x),(k),[1,2])"]);
    emits("x['location']();", &["__zp_call((x),('location'),[])"]);
    emits("x?.[k](a);", &["__zp_ocall((x),(k),[a],2)"]);
    emits("x?.[k]?.();", &["__zp_ocall((x),(k),[],3)"]);
    for src in [
        "x[k] = v;",
        "x['location'] = v;",
        "x[k]++;",
        "x[k](1,2);",
        "x?.[k](a);",
    ] {
        reparses(src);
    }
}

/// `obj.location.assign/replace/reload` style calls must keep `this` bound —
/// mediated call, never an unbound function rip.
#[test]
fn dangerous_method_calls_stay_bound() {
    emits(
        "obj.location.assign('u');",
        &["__zp_call(__zp_get(obj,\"location\"),\"assign\""],
    );
    emits(
        "history.pushState({},'','/p');",
        &["__zp_call(__zp_get(globalThis,\"history\"),\"pushState\""],
    );
    reparses("obj.location.assign('u');");
    reparses("history.pushState({},'','/p');");
}

// ---------------------------------------------------------------------------
// Operator matrix.
// ---------------------------------------------------------------------------

#[test]
fn optional_chain_flags_distinguish_base_and_call_nullish() {
    // `x?.location?.()` — BOTH sides nullish → flag 3.
    emits("x?.location?.();", &["__zp_ocall((x),\"location\",[],3)"]);
    // `x?.m()` — safe name, native optional preserved (negative control).
    emits("x?.m();", &["x?.m()"]);
    emits("x?.location;", &["__zp_oget((x),\"location\")"]);
    emits(
        "x?.location.href;",
        &["__zp_get(__zp_oget((x),\"location\"),\"href\")"],
    );
    emits("location?.reload();", &["__zp_get(globalThis,\"location\")?.reload()"]);
    reparses("x?.location?.();");
    reparses("x?.location.href;");
}

#[test]
fn update_and_logical_assign_mediate() {
    // Logical identifier assign: inline get ?? set — RHS stays in the
    // enclosing scope (await/yield survive).
    emits(
        "location ??= u;",
        &["(__zp_get(globalThis,\"location\")??__zp_set(globalThis,\"location\",(u)))"],
    );
    // Member assigns go through the accessor-adapter Reference — the engine
    // owns get→RHS→set order and logical short-circuiting.
    emits(
        "obj.location ??= u;",
        &["get v(){return __zp_get(this.b,\"location\")}", "set v(v){__zp_set(this.b,\"location\",v)", ".v??=(u)"],
    );
    emits("++location;", &["__zp_update(globalThis,\"location\",\"++\",true)"]);
    emits("x.location++;", &["__zp_get(this.b,\"location\")", "__zp_set(this.b,\"location\",v)"]);
    emits(
        "x.location -= y;",
        &["get v(){return __zp_get(this.b,\"location\")}", ".v-=(y)"],
    );
    // Negative: non-dangerous names stay native.
    emits("x ||= y;", &["x ||= y;"]);
    emits("loc ||= y;", &["loc ||= y;"]);
    reparses("++location;");
    reparses("x.location -= y;");
    reparses("location ??= u;");
    reparses("obj.location ??= u;");
}

#[test]
fn delete_routes_member_and_optional() {
    emits("delete location.href;", &["__zp_delete((__zp_get(globalThis,\"location\")),\"href\")"]);
    emits("delete obj.location;", &["__zp_delete((obj),\"location\")"]);
    emits("delete obj[k];", &["__zp_delete((obj),(k))"]);
    emits("delete obj?.location;", &["__zp_odelete((obj),\"location\")"]);
    reparses("delete obj?.location;");
}

#[test]
fn reads_mediate_in_expression_positions() {
    emits("switch(location){}", &["switch(__zp_get(globalThis,\"location\"))"]);
    emits("function* g(){ yield location; }", &["yield __zp_get(globalThis,\"location\")"]);
    emits("async function f(){ await location; }", &["await __zp_get(globalThis,\"location\")"]);
    emits("f`${location}`;", &["`${__zp_get(globalThis,\"location\")}`"]);
    emits("void location;", &["void __zp_get(globalThis,\"location\")"]);
    emits("typeof location;", &["typeof __zp_get(globalThis,\"location\")"]);
    emits("location instanceof Location;", &["__zp_get(globalThis,\"location\") instanceof Location"]);
    emits("let l = -location;", &["-__zp_get(globalThis,\"location\")"]);
    emits("location = u, x = 1;", &["__zp_set(globalThis,\"location\",(u)), x = 1"]);
}

// ---------------------------------------------------------------------------
// `with` matrix — section D. Innermost with-object must be consulted first.
// ---------------------------------------------------------------------------

#[test]
fn with_body_dangerous_names_chain_innermost_first() {
    let code = out("with(a){ with(b){ location = u; } }");
    // __zp_w_2 (inner, bound to b) must appear in the chain BEFORE __zp_w_1.
    let i2 = code.find("__zp_with_set(__zp_w_2").expect("inner with missing");
    let i1 = code.find("(v)=>(__zp_with_set(__zp_w_1").expect("outer fallback missing");
    assert!(i2 < i1, "innermost with-object must be consulted first\nOUT: {code}");
    emits(
        "with(o){ location.href = 'x'; }",
        &["__zp_with_get(__zp_w_1,\"location\"", "__zp_set("],
    );
    emits(
        "with(o){ f(location); }",
        &["f(__zp_with_get(__zp_w_1,\"location\""],
    );
    emits(
        "with(o){ ({location} = y); }",
        &["{location: __zp_with_d(__zp_w_1,\"location\""],
    );
    emits(
        "with(o){ delete location; }",
        &["__zp_with_delete(__zp_w_1,\"location\""],
    );
    // Negative: non-dangerous names in `with` stay native.
    emits("with(o){ x = 1; }", &["with(__zp_w_1=(o)){ x = 1; }"]);
    emits("with(o){ delete x.p; }", &["delete x.p;"]);
    reparses("with(a){ with(b){ location = u; } }");
    reparses("with(o){ ({location} = y); }");
}

// ---------------------------------------------------------------------------
// Reflect / Object routing matrix.
// ---------------------------------------------------------------------------

#[test]
fn reflect_object_routing() {
    emits("Reflect.get(doc, k);", &["__zp_rget((doc),(k))"]);
    emits("Reflect.get(doc, 'location');", &["__zp_get(doc,\"location\")"]);
    // Safe literal — pass through, no mediation tax.
    emits("Reflect.get(obj, 'foo');", &["Reflect.get(obj, 'foo')"]);
    emits("Reflect.set(doc, k, v);", &["__zp_rset((doc),(k),(v))"]);
    emits("Reflect.set(doc, k, v, r);", &["__zp_rset((doc),(k),(v),(r))"]);
    emits("Reflect.deleteProperty(d, 'location');", &["__zp_delete((d),('location'))"]);
    emits("Reflect.has(d, 'location');", &["__zp_has((d),('location'))"]);
    emits("Reflect.ownKeys(d);", &["__zp_ownKeys((d))"]);
    emits("Object.getOwnPropertyDescriptors(doc);", &["__zp_getOwnPropertyDescriptors((doc))"]);
    emits("Object.getOwnPropertyNames(doc);", &["__zp_getOwnPropertyNames((doc))"]);
    emits("Object.keys(d);", &["__zp_okeys((d))"]);
    reparses("Reflect.set(doc, k, v, r);");
}

// ---------------------------------------------------------------------------
// eval / dynamic-code matrix.
// ---------------------------------------------------------------------------

#[test]
fn eval_literal_nested_rewrite() {
    // R2: every unshadowed direct `eval(...)` — literal or not — is routed
    // through `__zp_eval.call(this, [args][0], desc, strict)`, which turns
    // it back into a real direct eval with caller-scope descriptors.
    emits(
        "eval('location.href');",
        &["__zp_eval.call(this,__zp_get(globalThis,\"eval\"),['location.href'],{},0)"],
    );
    emits("eval(x);", &["__zp_eval.call(this,__zp_get(globalThis,\"eval\"),[x],{},0)"]);
    // Eager multi-arg evaluation preserved: the args array evaluates all.
    emits("eval(a,b());", &["[a,b()]"]);
    // Indirect / aliased / optional / shadowed forms stay mediated-indirect.
    emits("(0,eval)('location');", &["(0,__zp_get(globalThis,\"eval\"))('location')"]);
    emits("eval?.('location');", &["__zp_get(globalThis,\"eval\")?.('location')"]);
    emits("e=eval; e('location');", &["e=__zp_get(globalThis,\"eval\");"]);
    // `var eval = f` still emits the DEVAL wrapper — the runtime reads the
    // rebound callee via __zp_get and applies it as an ordinary call.
    emits("var eval=function(){}; eval('x');", &["__zp_eval.call(this,__zp_get(globalThis,\"eval\"),['x']"]);
    emits("new Function('return this')();", &["new (__zp_get(globalThis,\"Function\"))('return this')()"]);
    emits("var Function; Function('x')();", &["__zp_get(globalThis,\"Function\")('x')()"]);
    reparses("eval('location.href');");
    reparses("eval(x);");
    reparses("new Function('return this')();");
}

#[test]
fn eval_caller_scope_descriptor() {
    // Function-scope bindings become desc accessors so eval'd identifiers
    // resolve caller locals before the virtual global.
    emits(
        "function f(){ let k=1; var v=2; eval('k+v'); }",
        &[
            "__zp_eval.call(this,__zp_get(globalThis,\"eval\"),['k+v'],{",
            "get k(){return k},set k(v){k=v}",
            "get v(){return v},set v(v){v=v}",
            "arguments",
        ],
    );
    // Function-local `var eval` shadows the intrinsic — call stays a plain
    // local call, no DEVAL wrapper.
    not_emits("function g(){ var eval=function(){}; eval('x'); }", &["__zp_eval"]);
    // Strict call-site (module) marks the strict bit.
    let module_out = rewrite_script(
        "function f(){ eval(x); }",
        &RewriteOpts {
            kind: ScriptKind::Module,
            target_url: "https://example.com/".into(),
            strict: true,
            proxy_origin: "http://proxy.localhost:18080".into(),
        },
    )
    .expect("module rewrite");
    assert!(
        module_out.code.contains("},1)"),
        "expected strict bit in module eval: {}",
        module_out.code
    );
    reparses("function f(){ let k=1; eval('k'); }");
}

#[test]
fn eval_var_decl_hoists_to_caller_varenv() {
    // R3: sloppy 리터럴 eval 의 var 선언은 호출자 varEnv 에 삽입되고,
    // desc 접근자가 그 바인딩을 노출한다 — eval'd `__zp_set` 이 도달.
    emits(
        "function f(){ eval('var z=1'); return z; }",
        &["var z;", "get z(){return z},set z(v){z=v}"],
    );
    // strict 호출자(모듈)는 호이스트 없음 — strict eval 은 var 를 새지 않는다.
    let module_out = rewrite_script(
        "function f(){ eval('var z=1'); return z; }",
        &RewriteOpts {
            kind: ScriptKind::Module,
            target_url: "https://example.com/".into(),
            strict: true,
            proxy_origin: "http://proxy.localhost:18080".into(),
        },
    )
    .expect("module rewrite");
    assert!(
        !module_out.code.contains("var z;"),
        "strict eval must not hoist var: {}",
        module_out.code
    );
    reparses("function f(){ eval('var z=1'); return z; }");
    // 함수 선언도 동일하게 호이스트된다.
    emits(
        "function f(){ eval('function z(){}'); return z; }",
        &["var z;", "get z(){return z},set z(v){z=v}"],
    );
    // directive prologue 앞에 삽입되면 'use strict' 가 무효화된다 — 삽입은
    // directive 뒤에 와야 한다. strict eval 이므로 호이스트는 없어야 한다.
    let strict_fn = rewrite_script(
        "function f(){ 'use strict'; eval('var z=1'); return z; }",
        &RewriteOpts {
            kind: ScriptKind::Classic,
            target_url: "https://example.com/".into(),
            strict: false,
            proxy_origin: "http://proxy.localhost:18080".into(),
        },
    )
    .expect("strict-fn rewrite");
    assert!(
        !strict_fn.code.contains("var z;"),
        "inner strict eval must not hoist: {}",
        strict_fn.code
    );
    // 이미 선언된 이름은 중복 삽입하지 않는다.
    let out = rewrite_script(
        "function f(){ var z=0; eval('var z=1'); return z; }",
        &RewriteOpts {
            kind: ScriptKind::Classic,
            target_url: "https://example.com/".into(),
            strict: false,
            proxy_origin: "http://proxy.localhost:18080".into(),
        },
    )
    .expect("rewrite");
    // 'var z=1' 리터럴이 문자열로 남아 있으므로 삽입 패치('var z;') 유무로 판별.
    assert_eq!(out.code.matches("var z;").count(), 0, "dup var: {}", out.code);
    // 중첩 함수 — eval 의 var 는 가장 가까운 함수 varEnv 에만 간다.
    let nested = rewrite_script(
        "function outer(){ function inner(){ eval('var w=1'); } }",
        &RewriteOpts {
            kind: ScriptKind::Classic,
            target_url: "https://example.com/".into(),
            strict: false,
            proxy_origin: "http://proxy.localhost:18080".into(),
        },
    )
    .expect("nested rewrite");
    let inner_pos = nested.code.find("function inner").unwrap();
    let w_pos = nested.code.find("var w;").unwrap();
    assert!(w_pos > inner_pos, "hoist landed outside inner fn: {}", nested.code);
    // sloppy 함수의 directive 는 유지되며 삽입은 그 뒤에 온다.
    let dir = rewrite_script(
        "function f(){ 'use asm'; eval('var z=1'); return z; }",
        &RewriteOpts {
            kind: ScriptKind::Classic,
            target_url: "https://example.com/".into(),
            strict: false,
            proxy_origin: "http://proxy.localhost:18080".into(),
        },
    )
    .expect("directive rewrite");
    assert!(
        dir.code.find("'use asm'").unwrap() < dir.code.find("var z;").unwrap(),
        "insert must land after directives: {}",
        dir.code
    );
    // 최상위 프로그램(함수 없음)의 eval 은 삽입 대상 없음 — 파손 없이 통과.
    reparses("eval('var z=1')");
}

// ---------------------------------------------------------------------------
// R1: classic top-level let/const/class → __zp_lex 레지스트리 등록 +
// per-decl accessor 바인딩. 스크립트 간 공유 전역 렉시컬 환경 에뮬레이션.
// ---------------------------------------------------------------------------

#[test]
fn lex_registry_for_classic_toplevel() {
    emits(
        "let x=1; const c=2; class K{} var v=3; function fn(){}",
        &[
            "__zp_lex_decl(",
            "\"x\":\"let\"",
            "\"c\":\"const\"",
            "\"K\":\"class\"",
            "__zp_lex_bind(\"x\",()=>x,v=>{x=v});",
            "__zp_lex_bind(\"c\",()=>c,v=>{throw new TypeError('Assignment to constant variable.')});",
            "__zp_lex_bind(\"K\",()=>K,v=>{K=v});",
            "[\"v\",\"fn\"]",
        ],
    );
    reparses("let x=1; const c=2; class K{} var v=3; function fn(){}");
    // 선언 없는 스크립트는 접두 없음.
    emits("foo();", &[]);
    let clean = rewrite_script("foo();", &RewriteOpts {
        kind: ScriptKind::Classic,
        target_url: "https://example.com/".into(),
        strict: false,
        proxy_origin: "http://proxy.localhost:18080".into(),
    })
    .expect("rewrite");
    assert!(!clean.code.contains("__zp_lex"), "no decls: {}", clean.code);
    // module 은 모듈 자체 환경이라 레지스트리 대상이 아니다.
    let m = rewrite_script("let x=1;", &RewriteOpts {
        kind: ScriptKind::Module,
        target_url: "https://example.com/".into(),
        strict: true,
        proxy_origin: "http://proxy.localhost:18080".into(),
    })
    .expect("module rewrite");
    assert!(!m.code.contains("__zp_lex"), "module must not emit: {}", m.code);
    // directive 는 decl 접두보다 앞에 남아 'use strict' 가 유지된다.
    let s = rewrite_script("'use strict'; let y=1;", &RewriteOpts {
        kind: ScriptKind::Classic,
        target_url: "https://example.com/".into(),
        strict: false,
        proxy_origin: "http://proxy.localhost:18080".into(),
    })
    .expect("strict rewrite");
    assert!(
        s.code.find("'use strict'").unwrap() < s.code.find("__zp_lex_decl").unwrap(),
        "directive must precede decl: {}",
        s.code
    );
    // 함수 내부의 let 은 대상 아님 — top-level 만 (함수명 자체는 var-like
    // 라 checkvar 배열에만 들어간다).
    let f = rewrite_script("function g(){ let inner=1; }", &RewriteOpts {
        kind: ScriptKind::Classic,
        target_url: "https://example.com/".into(),
        strict: false,
        proxy_origin: "http://proxy.localhost:18080".into(),
    })
    .expect("fn rewrite");
    assert!(f.code.contains("__zp_lex_decl({},"), "empty lexmap: {}", f.code);
    assert!(!f.code.contains("\"inner\""), "fn-local let must not register: {}", f.code);
    // 블록/초기화식 안의 let 도 제외.
    let b = rewrite_script("{ let blk=1; } for(let i=0;;i++){}", &RewriteOpts {
        kind: ScriptKind::Classic,
        target_url: "https://example.com/".into(),
        strict: false,
        proxy_origin: "http://proxy.localhost:18080".into(),
    })
    .expect("block rewrite");
    assert!(!b.code.contains("\"blk\""), "block let: {}", b.code);
    assert!(!b.code.contains("__zp_lex_bind"), "for-let bind: {}", b.code);
}

// ---------------------------------------------------------------------------
// Loop-cap matrix: constant-true loops get a counter; position must stay
// syntactically legal (bare bodies get braced, labels get renamed when the
// loop is wrapped in a block).
// ---------------------------------------------------------------------------

#[test]
fn loop_cap_constant_true() {
    emits("for(;;){}", &["for(let __zp_lc_1=0;__zp_lc_1++<10000000||"]);
    emits("for(i=0;;i++){}", &["let __zp_lc_1=0;for(i=0;__zp_lc_1++<10000000||"]);
    emits("for(i=0;true;i++){}", &["__zp_lc_1++<10000000"]);
    emits("for(const x=0;;x++){}", &["__zp_lc_1++<10000000"]);
    emits("while(true){}", &["for(let __zp_lc_1=0;__zp_lc_1++<10000000||"]);
    emits("do{}while(true);", &["do{}while(__zp_lc_1++<10000000||"]);
    // Cap-trip is observable — warn once, then exit.
    emits("while(true){}", &["console.warn('", "infinite-loop cap"]);
    // R7: `await`/`yield` bodies can suspend — infinite async polls are a
    // legitimate pattern, not a wedge vector. Uncapped (native parity).
    not_emits(
        "async function f(){ while(true){ await x(); } }",
        &["__zp_lc_"],
    );
    not_emits(
        "async function f(){ for(;;){ await x(); } }",
        &["__zp_lc_"],
    );
    not_emits(
        "async function f(){ do{ await x(); }while(true); }",
        &["__zp_lc_"],
    );
    not_emits(
        "function* g(){ while(true){ yield 1; } }",
        &["__zp_lc_"],
    );
    // Nested-function await is a different async context — still capped.
    emits(
        "async function f(){ while(true){ const g = async()=>{ await x(); }; g(); } }",
        &["__zp_lc_1++<10000000"],
    );
    // `for await` suspends at THIS async level — the outer loop yields.
    not_emits(
        "async function f(){ while(true){ for await (const x of y){} } }",
        &["__zp_lc_"],
    );
    // Negative: real condition — no cap.
    emits("for(i=0;i<n;i++){}", &["for(i=0;i<n;i++){}"]);
    not_emits("for(i=0;i<n;i++){}", &["__zp_lc_"]);
    for src in [
        "for(;;){}",
        "for(i=0;;i++){}",
        "while(true){}",
        "do{}while(true);",
    ] {
        reparses(src);
    }
}

#[test]
fn loop_cap_bare_and_labeled_positions() {
    // Bare-body positions must be braced so the `let` counter is legal.
    emits("if(c) for(i=0;;i++) x();", &["if(c) {let __zp_lc_1=0;for(i=0;"]);
    emits(
        "if(c) for(i=0;;i++) x(); else y();",
        &["if(c) {let __zp_lc_1=0;for(i=0;", "} else y();"],
    );
    emits("while(c) do{}while(true);", &["while(c) {let __zp_lc_1=0;do{}"]);
    emits(
        "with(o){ if(q) for(i=0;;i++) x(); }",
        &["if(q) {let __zp_lc_1=0;for(i=0;"],
    );
    // When the capped loop must move inside a block, its label is renamed
    // and all break/continue references follow.
    emits(
        "outer: for(i=0;;i++){ if(q) continue outer; if(r) break outer; }",
        &["outer: {let __zp_lc_1=0;__zp_lbl_1:for(", "continue __zp_lbl_1", "break __zp_lbl_1"],
    );
    emits(
        "outer: do{ if(q) continue outer; }while(true);",
        &["__zp_lbl_1:do{", "continue __zp_lbl_1"],
    );
    emits(
        "a: b: for(i=0;;i++){ continue a; break b; }",
        &["a: b: {let __zp_lc_1=0;__zp_lbl_1:for(", "continue __zp_lbl_1; break __zp_lbl_1;"],
    );
    // No block-wrap needed when the cap lands inside the for-init —
    // the label stays usable.
    emits("outer: for(;;){ continue outer; }", &["outer: for(let __zp_lc_1=0;", "continue outer"]);
    for src in [
        "if(c) for(i=0;;i++) x();",
        "if(c) for(i=0;;i++) x(); else y();",
        "while(c) do{}while(true);",
        "outer: for(i=0;;i++){ if(q) continue outer; if(r) break outer; }",
        "outer: do{ if(q) continue outer; }while(true);",
        "a: b: for(i=0;;i++){ continue a; break b; }",
        "if(c) while(true) x();",
        "with(o){ if(q) for(i=0;;i++) x(); }",
    ] {
        reparses(src);
    }
}

// ---------------------------------------------------------------------------
// var/function shadowing matrix — section A1/B.
// ---------------------------------------------------------------------------

#[test]
fn var_function_shadowing_neutralized() {
    // Initialised `var` on a dangerous name is rewritten as a sync-through.
    emits(
        "var location = {href: 1};",
        &["var __zp_vdcl_1=(__zp_set(globalThis,\"location\""],
    );
    emits(
        "var a = 1, location = 2, b = 3;",
        &["var a = 1, __zp_vdcl_1=(__zp_set(globalThis,\"location\",(2)),void 0), b = 3;"],
    );
    // Top-level `function location(){}` would throw on the real Location —
    // renamed to a temp, references still mediated.
    emits(
        "function location(){} location.href = 'https://t/';",
        &["function __zp_vdcl_1(){}", "__zp_set(__zp_get(globalThis,\"location\"),\"href\""],
    );
    emits("if (x) function location(){}", &["if (x) function __zp_vdcl_1(){}"]);
    // Bare `var location;` is a native no-op — kept, references mediated.
    emits(
        "var location; location.href = 'https://t/';",
        &["var location;", "__zp_set(__zp_get(globalThis,\"location\"),\"href\""],
    );
    reparses("var a = 1, location = 2, b = 3;");
    reparses("function location(){} location.href = 'https://t/';");
}

// ---------------------------------------------------------------------------
// Scope matrix: local bindings must NOT be mediated — a `var location`
// inside a function is a real local.
// ---------------------------------------------------------------------------

#[test]
fn local_scope_bindings_not_mediated() {
    emits("function f(){ location.x; var location; }", &["location.x; var location;"]);
    emits("function f(){ location.x; function location(){} }", &["location.x; function location(){}"]);
    emits("{ location.x; let location; }", &["location.x; let location;"]);
    emits("const {location} = x;", &["const {location} = x;"]);
    emits("let [location] = y;", &["let [location] = y;"]);
    emits("try{}catch({message: location}){}", &["catch({message: location})"]);
    emits("function g(location){ location.href; }", &["function g(location){ location.href; }"]);
    // Arrow bodies are function scopes too.
    emits("(() => { var location = 1; location; })();", &["var location = 1; location;"]);
    not_emits("(() => { var location = 1; location; })();", &["__zp_set(globalThis"]);
    not_emits("function g(location){ location.href; }", &["__zp_get(globalThis"]);
    reparses("(() => { var location = 1; location; })();");
}

// ---------------------------------------------------------------------------
// Misc: meta properties, global reads through computed base, export-goal.
// ---------------------------------------------------------------------------

#[test]
fn misc_invariants() {
    emits("import.meta.url;", &["\"https://example.com/\""]);
    emits("new.target;", &["new.target;"]);
    emits(
        "document['location'].href = 'https://t/';",
        &["__zp_set(__zp_get((__zp_get(globalThis,\"document\")),('location')),\"href\""],
    );
    emits(
        "var document; document['location'].href = 'https://t/';",
        &["__zp_set(__zp_get((__zp_get(globalThis,\"document\")),('location')),\"href\""],
    );
    emits(
        "var window; window['location'].href = 'https://t/';",
        &["__zp_set(__zp_get((__zp_get(globalThis,\"window\")),('location')),\"href\""],
    );
    // `open` is NOT a dangerous name — a user-declared `var open` is local.
    emits("var open; open('u');", &["var open; open('u');"]);
    reparses("document['location'].href = 'https://t/';");
}
