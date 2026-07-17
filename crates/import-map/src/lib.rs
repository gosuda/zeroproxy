use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use thiserror::Error;
use url::Url;

pub const IMPORT_MAP_API_VERSION: u16 = 1;

#[derive(Debug, Error, Eq, PartialEq)]
pub enum Error {
    #[error("invalid import map JSON")]
    Json,
    #[error("invalid base URL")]
    Base,
    #[error("invalid address")]
    Address,
    #[error("unmapped bare specifier")]
    Unmapped,
    #[error("specifier is blocked by the import map")]
    Blocked,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Wire {
    #[serde(default)]
    imports: BTreeMap<String, Option<String>>,
    #[serde(default)]
    scopes: BTreeMap<String, BTreeMap<String, Option<String>>>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub struct Diagnostic {
    pub code: &'static str,
    pub key: String,
}

#[derive(Clone, Debug)]
pub struct ImportMap {
    base: Url,
    imports: BTreeMap<String, Option<Url>>,
    scopes: BTreeMap<Url, BTreeMap<String, Option<Url>>>,
    diagnostics: Vec<Diagnostic>,
}

fn is_url_like(value: &str) -> bool {
    Url::parse(value).is_ok() || matches!(value.as_bytes().first(), Some(b'/' | b'.' | b'?' | b'#'))
}

fn normalize(
    table: BTreeMap<String, Option<String>>,
    base: &Url,
    diagnostics: &mut Vec<Diagnostic>,
) -> BTreeMap<String, Option<Url>> {
    let mut out = BTreeMap::new();
    for (key, value) in table {
        let normalized_key = if is_url_like(&key) {
            match base.join(&key) {
                Ok(url) => url.to_string(),
                Err(_) => {
                    diagnostics.push(Diagnostic {
                        code: "INVALID_SPECIFIER_KEY",
                        key,
                    });
                    continue;
                }
            }
        } else {
            key
        };
        let address = match value {
            Some(address) => match base.join(&address) {
                Ok(resolved)
                    if !normalized_key.ends_with('/') || resolved.as_str().ends_with('/') =>
                {
                    Some(resolved)
                }
                _ => {
                    diagnostics.push(Diagnostic {
                        code: "INVALID_ADDRESS",
                        key: normalized_key.clone(),
                    });
                    None
                }
            },
            None => None,
        };
        out.insert(normalized_key, address);
    }
    out
}

impl ImportMap {
    pub fn parse(source: &str, base: &str) -> Result<Self, Error> {
        let base = Url::parse(base).map_err(|_| Error::Base)?;
        let wire: Wire = serde_json::from_str(source).map_err(|_| Error::Json)?;
        let mut diagnostics = Vec::new();
        let imports = normalize(wire.imports, &base, &mut diagnostics);
        let mut scopes = BTreeMap::new();
        for (scope, table) in wire.scopes {
            match base.join(&scope) {
                Ok(scope) => {
                    scopes.insert(scope, normalize(table, &base, &mut diagnostics));
                }
                Err(_) => diagnostics.push(Diagnostic {
                    code: "INVALID_SCOPE",
                    key: scope,
                }),
            }
        }
        Ok(Self {
            base,
            imports,
            scopes,
            diagnostics,
        })
    }

    pub fn resolve(&self, specifier: &str, referrer: &str) -> Result<Url, Error> {
        let referrer = Url::parse(referrer).map_err(|_| Error::Address)?;
        let is_url = is_url_like(specifier);
        let normalized = if is_url {
            referrer
                .join(specifier)
                .map_err(|_| Error::Address)?
                .to_string()
        } else {
            specifier.to_owned()
        };
        let mut scopes: Vec<_> = self
            .scopes
            .iter()
            .filter(|(scope, _)| scope_matches(scope, &referrer))
            .collect();
        scopes.sort_by_key(|(scope, _)| std::cmp::Reverse(scope.as_str().len()));
        for (_, table) in scopes {
            if let Some(value) = resolve_table(table, &normalized) {
                return value;
            }
        }
        if let Some(value) = resolve_table(&self.imports, &normalized) {
            return value;
        }
        if is_url {
            return referrer.join(specifier).map_err(|_| Error::Address);
        }
        Err(Error::Unmapped)
    }

    pub fn base(&self) -> &Url {
        &self.base
    }

    pub fn diagnostics(&self) -> &[Diagnostic] {
        &self.diagnostics
    }
}

#[derive(Default)]
pub struct ImportMapRegistry {
    map: Option<ImportMap>,
    module_graph_started: bool,
}

impl ImportMapRegistry {
    pub fn register(&mut self, source: &str, base: &str) -> Result<bool, Error> {
        if self.module_graph_started || self.map.is_some() {
            return Ok(false);
        }
        self.map = Some(ImportMap::parse(source, base)?);
        Ok(true)
    }

    pub fn mark_module_graph_started(&mut self) {
        self.module_graph_started = true;
    }

    pub fn resolve(&self, specifier: &str, referrer: &str) -> Result<Url, Error> {
        self.map
            .as_ref()
            .ok_or(Error::Unmapped)?
            .resolve(specifier, referrer)
    }
}

fn scope_matches(scope: &Url, referrer: &Url) -> bool {
    let scope = scope.as_str();
    let referrer = referrer.as_str();
    let Some(remainder) = referrer.strip_prefix(scope) else {
        return false;
    };
    scope.ends_with('/') || remainder.is_empty() || remainder.starts_with('/')
}

fn resolve_table(
    table: &BTreeMap<String, Option<Url>>,
    specifier: &str,
) -> Option<Result<Url, Error>> {
    if let Some(exact) = table.get(specifier) {
        return Some(exact.clone().ok_or(Error::Blocked));
    }
    let mut best: Option<(usize, &Option<Url>)> = None;
    for (key, value) in table {
        if key.ends_with('/')
            && specifier.starts_with(key)
            && best.as_ref().is_none_or(|(length, _)| key.len() > *length)
        {
            best = Some((key.len(), value));
        }
    }
    best.map(|(length, value)| {
        value
            .as_ref()
            .ok_or(Error::Blocked)
            .and_then(|base| base.join(&specifier[length..]).map_err(|_| Error::Address))
    })
}

#[cfg(target_arch = "wasm32")]
fn wasm_error(error: Error) -> wasm_bindgen::JsValue {
    wasm_bindgen::JsValue::from_str(&error.to_string())
}

#[cfg(target_arch = "wasm32")]
fn map_handle(source: &str, base: &str) -> Result<String, wasm_bindgen::JsValue> {
    let map = ImportMap::parse(source, base).map_err(wasm_error)?;
    Ok(serde_json::json!({
        "version": IMPORT_MAP_API_VERSION,
        "source": source,
        "base": map.base().as_str(),
        "diagnostics": map.diagnostics(),
    })
    .to_string())
}

#[cfg(target_arch = "wasm32")]
fn map_from_handle(handle: &str) -> Result<ImportMap, wasm_bindgen::JsValue> {
    #[derive(Deserialize)]
    #[serde(deny_unknown_fields)]
    struct HandleDiagnostic {
        #[serde(rename = "code")]
        _code: String,
        #[serde(rename = "key")]
        _key: String,
    }
    #[derive(Deserialize)]
    #[serde(deny_unknown_fields)]
    struct Handle {
        version: u16,
        source: String,
        base: String,
        #[serde(rename = "diagnostics")]
        _diagnostics: Vec<HandleDiagnostic>,
    }
    let handle: Handle = serde_json::from_str(handle)
        .map_err(|_| wasm_bindgen::JsValue::from_str("invalid import map handle"))?;
    if handle.version != IMPORT_MAP_API_VERSION {
        return Err(wasm_bindgen::JsValue::from_str(
            "unsupported import map handle",
        ));
    }
    ImportMap::parse(&handle.source, &handle.base).map_err(wasm_error)
}

#[cfg(target_arch = "wasm32")]
#[wasm_bindgen::prelude::wasm_bindgen]
pub fn import_map_parse_json(source: &str, base: &str) -> Result<String, wasm_bindgen::JsValue> {
    map_handle(source, base)
}

#[cfg(target_arch = "wasm32")]
#[wasm_bindgen::prelude::wasm_bindgen]
pub fn import_map_register_json(
    existing_handle: &str,
    source: &str,
    base: &str,
    module_graph_started: bool,
) -> Result<String, wasm_bindgen::JsValue> {
    let registered = existing_handle.is_empty() && !module_graph_started;
    let handle = if registered {
        map_handle(source, base)?
    } else {
        existing_handle.to_owned()
    };
    Ok(serde_json::json!({
        "version": IMPORT_MAP_API_VERSION,
        "registered": registered,
        "handle": handle,
    })
    .to_string())
}

#[cfg(target_arch = "wasm32")]
#[wasm_bindgen::prelude::wasm_bindgen]
pub fn import_map_resolve_json(
    handle: &str,
    specifier: &str,
    referrer: &str,
) -> Result<String, wasm_bindgen::JsValue> {
    let resolved = map_from_handle(handle)?
        .resolve(specifier, referrer)
        .map_err(wasm_error)?;
    Ok(serde_json::json!({
        "version": IMPORT_MAP_API_VERSION,
        "resolved_url": resolved.as_str(),
    })
    .to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn scopes_and_prefixes() {
        let map = ImportMap::parse(
            r#"{"imports":{"pkg/":"/v1/"},"scopes":{"/app/":{"pkg/":"/v2/"}}}"#,
            "https://example.test/",
        )
        .unwrap();
        assert_eq!(
            map.resolve("pkg/a.js", "https://example.test/app/main.js")
                .unwrap()
                .as_str(),
            "https://example.test/v2/a.js"
        );
        assert_eq!(
            map.resolve("pkg/a.js", "https://example.test/other.js")
                .unwrap()
                .as_str(),
            "https://example.test/v1/a.js"
        );
    }

    #[test]
    fn scope_matching_does_not_cross_a_path_segment_boundary() {
        let map = ImportMap::parse(
            r#"{"imports":{"pkg":"/fallback.js"},"scopes":{"/app":{"pkg":"/scoped.js"}}}"#,
            "https://example.test/",
        )
        .unwrap();
        assert_eq!(
            map.resolve("pkg", "https://example.test/application/main.js")
                .unwrap()
                .as_str(),
            "https://example.test/fallback.js"
        );
        assert_eq!(
            map.resolve("pkg", "https://example.test/app/main.js")
                .unwrap()
                .as_str(),
            "https://example.test/scoped.js"
        );
    }

    #[test]
    fn null_mappings_block_exact_and_prefix_specifiers() {
        let map = ImportMap::parse(
            r#"{"imports":{"blocked":null,"private/":null}}"#,
            "https://example.test/",
        )
        .unwrap();
        assert_eq!(
            map.resolve("blocked", "https://example.test/main.js"),
            Err(Error::Blocked)
        );
        assert_eq!(
            map.resolve("private/module.js", "https://example.test/main.js"),
            Err(Error::Blocked)
        );
    }

    #[test]
    fn invalid_entries_are_diagnosed_without_discarding_the_map() {
        let map = ImportMap::parse(
            r#"{"imports":{"pkg/":"/not-a-prefix.js","ok":"/ok.js"}}"#,
            "https://example.test/",
        )
        .unwrap();
        assert_eq!(
            map.resolve("ok", "https://example.test/main.js")
                .unwrap()
                .as_str(),
            "https://example.test/ok.js"
        );
        assert_eq!(
            map.resolve("pkg/item.js", "https://example.test/main.js"),
            Err(Error::Blocked)
        );
        assert_eq!(map.diagnostics()[0].code, "INVALID_ADDRESS");
        assert_eq!(map.diagnostics()[0].key, "pkg/");
    }

    #[test]
    fn invalid_scoped_mapping_blocks_instead_of_falling_back_to_global() {
        let map = ImportMap::parse(
            r#"{"imports":{"pkg/":"/global/"},"scopes":{"/app/":{"pkg/":"/not-a-prefix.js"}}}"#,
            "https://example.test/",
        )
        .unwrap();
        assert_eq!(
            map.resolve("pkg/item.js", "https://example.test/app/main.js"),
            Err(Error::Blocked)
        );
    }

    #[test]
    fn registry_uses_only_the_first_map_before_module_resolution() {
        let mut registry = ImportMapRegistry::default();
        assert!(
            registry
                .register(
                    r#"{"imports":{"pkg":"/first.js"}}"#,
                    "https://example.test/"
                )
                .unwrap()
        );
        assert!(
            !registry
                .register(
                    r#"{"imports":{"pkg":"/second.js"}}"#,
                    "https://example.test/"
                )
                .unwrap()
        );
        registry.mark_module_graph_started();
        assert!(
            !registry
                .register(
                    r#"{"imports":{"other":"/late.js"}}"#,
                    "https://example.test/"
                )
                .unwrap()
        );
        assert_eq!(
            registry
                .resolve("pkg", "https://example.test/main.js")
                .unwrap()
                .as_str(),
            "https://example.test/first.js"
        );
    }

    #[test]
    fn registries_do_not_share_maps_or_module_graph_state() {
        let mut first = ImportMapRegistry::default();
        let mut second = ImportMapRegistry::default();
        assert!(
            first
                .register(
                    r#"{"imports":{"pkg":"/first.js"}}"#,
                    "https://example.test/"
                )
                .unwrap()
        );
        first.mark_module_graph_started();
        assert!(
            second
                .register(
                    r#"{"imports":{"pkg":"/second.js"}}"#,
                    "https://example.test/"
                )
                .unwrap()
        );
        assert_eq!(
            first
                .resolve("pkg", "https://example.test/main.js")
                .unwrap()
                .as_str(),
            "https://example.test/first.js"
        );
        assert_eq!(
            second
                .resolve("pkg", "https://example.test/main.js")
                .unwrap()
                .as_str(),
            "https://example.test/second.js"
        );
    }
}
