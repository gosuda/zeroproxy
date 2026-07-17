use serde_json::Value;
use std::{env, fs, path::PathBuf};

#[derive(Debug, Eq, PartialEq)]
struct BrowserGrammarTuple {
    family: String,
    exact_build: String,
    platform: String,
}

fn string(value: &Value, key: &str) -> String {
    value
        .get(key)
        .and_then(Value::as_str)
        .unwrap_or_else(|| panic!("missing string field {key}"))
        .to_owned()
}

fn browser_string(value: &Value, lane_index: usize, key: &str) -> String {
    let field = value
        .get(key)
        .and_then(Value::as_str)
        .unwrap_or_else(|| panic!("browser lane {lane_index} field `{key}` must be a string"));
    if field.is_empty() {
        panic!("browser lane {lane_index} field `{key}` must not be empty");
    }
    field.to_owned()
}

fn browser_tuple(value: &Value, lane_index: usize) -> BrowserGrammarTuple {
    BrowserGrammarTuple {
        family: browser_string(value, lane_index, "family"),
        exact_build: browser_string(value, lane_index, "exact_build"),
        platform: browser_string(value, lane_index, "platform"),
    }
}

fn main() {
    let root = PathBuf::from(env::var("CARGO_MANIFEST_DIR").expect("manifest dir")).join("../..");
    let standards_path = root.join("protocol/standards-lock.json");
    let boundaries_path = root.join("protocol/browser-boundaries.json");
    println!("cargo:rerun-if-changed={}", standards_path.display());
    println!("cargo:rerun-if-changed={}", boundaries_path.display());

    let standards: Value =
        serde_json::from_slice(&fs::read(&standards_path).expect("standards lock"))
            .expect("valid standards lock");
    let ecmascript = standards
        .get("standards")
        .and_then(Value::as_array)
        .and_then(|standards| {
            standards.iter().find_map(|standard| {
                (standard.get("name").and_then(Value::as_str) == Some("ecmascript"))
                    .then(|| string(standard, "revision"))
            })
        })
        .expect("ecmascript standards revision");

    let boundaries: Value =
        serde_json::from_slice(&fs::read(&boundaries_path).expect("browser boundaries"))
            .expect("valid browser boundaries");
    let lanes = boundaries
        .get("browser_lanes")
        .and_then(Value::as_array)
        .unwrap_or_else(|| panic!("browser-boundaries `browser_lanes` must be an array"));
    if lanes.len() != 2 {
        panic!(
            "browser boundaries must contain exactly two browser lanes; found {}",
            lanes.len()
        );
    }

    let mut browser_tuples = lanes
        .iter()
        .enumerate()
        .map(|(lane_index, lane)| browser_tuple(lane, lane_index))
        .collect::<Vec<_>>();
    for lane in &browser_tuples {
        if lane.family != "chromium" && lane.family != "firefox" {
            panic!(
                "browser lane family `{}` is unsupported; exactly one chromium and one firefox lane are required",
                lane.family
            );
        }
    }

    browser_tuples.sort_by(|left, right| {
        left.family
            .cmp(&right.family)
            .then_with(|| left.exact_build.cmp(&right.exact_build))
            .then_with(|| left.platform.cmp(&right.platform))
    });

    for pair in browser_tuples.windows(2) {
        if pair[0] == pair[1] {
            panic!(
                "duplicate canonical browser lane: family=`{}` exact_build=`{}` platform=`{}`",
                pair[0].family, pair[0].exact_build, pair[0].platform
            );
        }
    }

    let chromium_count = browser_tuples
        .iter()
        .filter(|lane| lane.family == "chromium")
        .count();
    let firefox_count = browser_tuples
        .iter()
        .filter(|lane| lane.family == "firefox")
        .count();
    if chromium_count != 1 || firefox_count != 1 {
        panic!(
            "browser boundaries must contain exactly one chromium and one firefox lane; found chromium={chromium_count}, firefox={firefox_count}"
        );
    }
    let reviewed_profile = ecmascript == "ECMA-262-2026"
        && browser_tuples.iter().any(|lane| {
            lane.family == "chromium"
                && lane.exact_build == "150.0.7871.124"
                && lane.platform == "darwin-arm64"
        })
        && browser_tuples.iter().any(|lane| {
            lane.family == "firefox"
                && lane.exact_build == "152.0.6"
                && lane.platform == "darwin-arm64"
        });
    if !reviewed_profile {
        panic!(
            "no reviewed ECMAScript grammar profile for revision `{ecmascript}` and the selected exact browser tuples"
        );
    }

    let browser_records = browser_tuples
        .iter()
        .map(|lane| {
            format!(
                "    BrowserGrammarTuple {{ family: {:?}, exact_build: {:?}, platform: {:?} }},\n",
                lane.family, lane.exact_build, lane.platform
            )
        })
        .collect::<String>();
    let output = format!(
        "#[derive(Clone, Copy, Debug, Eq, PartialEq)]\n\
pub struct BrowserGrammarTuple {{\n\
    pub family: &'static str,\n\
    pub exact_build: &'static str,\n\
    pub platform: &'static str,\n\
}}\n\
\n\
pub const ECMASCRIPT_GRAMMAR_VERSION: &str = {ecmascript:?};\n\
pub const ECMASCRIPT_BROWSER_TUPLES: &[BrowserGrammarTuple] = &[\n\
{browser_records}\
];\n\
pub const ECMASCRIPT_SWC_TARGET: swc_ecma_ast::EsVersion = swc_ecma_ast::EsVersion::EsNext;\n\
pub const ECMASCRIPT_SWC_SYNTAX: swc_ecma_parser::EsSyntax = swc_ecma_parser::EsSyntax {{\n\
    jsx: false,\n\
    fn_bind: false,\n\
    decorators: false,\n\
    decorators_before_export: false,\n\
    export_default_from: false,\n\
    import_attributes: true,\n\
    allow_super_outside_method: false,\n\
    allow_return_outside_function: false,\n\
    auto_accessors: false,\n\
    explicit_resource_management: false,\n\
}};\n"
    );
    fs::write(
        PathBuf::from(env::var("OUT_DIR").expect("out dir")).join("grammar_profile.rs"),
        output,
    )
    .expect("generated grammar profile");
}
