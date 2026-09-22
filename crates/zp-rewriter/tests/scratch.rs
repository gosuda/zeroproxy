use zp_rewriter::{rewrite_script, RewriteOpts, ScriptKind};

fn opts() -> RewriteOpts {
    RewriteOpts {
        kind: ScriptKind::Classic,
        target_url: "https://example.com/".into(),
        strict: true,
        proxy_origin: "http://proxy.localhost:18080".into(),
    }
}

fn show(src: &str) {
    match rewrite_script(src, &opts()) {
        Ok(r) => println!("IN : {src}\nOUT: {}", r.code),
        Err(e) => println!("IN : {src}\nERR: {e:?}"),
    }
    println!("---");
}

#[test]
fn scratch_probe() {
    for src in [
        "for (location of a) {}",
        "for (location in a) {}",
        "for (let location of a) {}",
        "[location] = arr;",
        "({a: location} = obj);",
        "import location from './x.js';",
        "import {location as loc} from './x.js';",
        "class location {}",
        "function f(){ location.x; var location; }",
        "function f(){ location.x; function location(){} }",
        "{ location.x; let location; }",
        "x?.location;",
        "x?.location.href;",
        "delete location.href;",
        "delete obj.location;",
        "this['location'];",
        "document['location'].href = 'https://t/';",
        "with(o){ location.href = 'x'; }",
        "with(o){ f(location); }",
        "eval('x');",
        "location ??= u;",
        "obj.location ??= u;",
        "x ||= y;",
        "loc ||= y;",
        "location?.reload();",
        "switch(location){}",
        "function* g(){ yield location; }",
        "async function f(){ await location; }",
        "label: for(;;){}",
        "for(let i=0;;i++){}",
        "async function f(){ while(true){ await x(); } }",
        "var location;",
        "var location; location.href = 'https://t/';",
        "var document; document['location'].href = 'https://t/';",
        "var location = {href: 1};",
        "function location(){} location.href = 'https://t/';",
        "var eval; eval('x');",
        "var Function; Function('x')();",
        "var window; window['location'].href = 'https://t/';",
        "x?.m();",
        "x?.location?.();",
        "const {location} = x;",
        "let [location] = y;",
        "try{}catch({message: location}){}",
        "new Function('return this')();",
        "f`${location}`;",
        "void location;",
        "typeof location;",
        "location instanceof Location;",
        "location?.['href'];",
    ] {
        show(src);
    }
}
