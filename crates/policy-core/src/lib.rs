use std::collections::{BTreeMap, BTreeSet};

use base64::{Engine as _, engine::general_purpose::STANDARD};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256, Sha384, Sha512};
use thiserror::Error;
use url::Url;

pub const POLICY_VERSION: u32 = 2;

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Context {
    pub profile_id: String,
    pub tab_id: String,
    pub document_id: String,
    pub virtual_origin: String,
    pub virtual_site: String,
    pub target_url: String,
    pub effective_base_url: String,
    pub referrer_url: Option<String>,
    pub referrer_policy: String,
    pub document_charset: String,
    pub target_csp: Vec<String>,
    #[serde(default)]
    pub target_csp_report_only: Vec<String>,
    pub relay_profile: String,
    pub approved_target_ports: Vec<u16>,
    pub policy_version: u32,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub struct TrustedTypesPolicy {
    pub directive_present: bool,
    pub allow_any: bool,
    pub allowed_policy_names: Vec<String>,
    pub allow_duplicates: bool,
    pub require_for_script: bool,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub struct CspDocumentPolicy {
    pub version: u16,
    pub trusted_types: TrustedTypesPolicy,
    pub enforced_report_endpoint_count: usize,
    pub report_only_endpoint_count: usize,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub enum ResourceKind {
    Document,
    Script,
    Module,
    Style,
    Image,
    Font,
    Media,
    Frame,
    Worker,
    Manifest,
    Download,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ResourceDescriptor {
    pub source_boundary: String,
    pub element_namespace: Option<String>,
    pub element_name: Option<String>,
    pub attribute_name: Option<String>,
    pub resource_kind: ResourceKind,
    pub raw_value: String,
    pub parser_inserted: bool,
    #[serde(default)]
    pub request_destination: Option<String>,
    #[serde(default)]
    pub script_kind: Option<String>,
    #[serde(default)]
    pub worker_kind: Option<String>,
    #[serde(default)]
    pub integrity: Option<String>,
    #[serde(default)]
    pub nonce: Option<String>,
    #[serde(default)]
    pub credentials_mode: Option<String>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub enum Decision {
    Pass,
    Fetch {
        canonical_target: String,
        network_target: String,
        fragment: Option<String>,
        route_kind: ResourceKind,
        cache_partition: String,
    },
    Script {
        canonical_target: String,
        module: bool,
        source_kind: String,
        fetch_context: String,
        integrity_policy: Option<String>,
    },
    Navigate {
        canonical_target: String,
        // Opaque synthetic IDs are coordinator-owned and cannot be inferred
        // from a URL origin by static policy.
        destination_origin_id: Option<String>,
        handoff_kind: String,
    },
    VirtualBase {
        canonical_target: String,
    },
    InlineCompile {
        source_kind: String,
        metadata: String,
    },
    Block {
        code: String,
        native_failure_shape: String,
    },
    Remove,
    DataBlock,
}

#[derive(Debug, Error, Eq, PartialEq)]
pub enum PolicyError {
    #[error("policy version mismatch")]
    VersionMismatch,
    #[error("invalid base URL")]
    InvalidBase,
    #[error("invalid target URL")]
    InvalidTarget,
    #[error("unsupported target scheme")]
    UnsupportedScheme,
    #[error("target URL userinfo is forbidden")]
    UserInfo,
    #[error("invalid route")]
    InvalidRoute,
}

pub const ROUTE_SPEC_VERSION: u16 = 2;

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum RouteKind {
    Document,
    Navigation,
    Resource,
    Script,
    Module,
    Style,
    Worker,
    Worklet,
    Download,
    Api,
    EventSource,
    TargetWorker,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum RouteFamily {
    Target,
    ApiPlan,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum WorkerGatewayKind {
    Classic,
    Module,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ExecutableRouteKind {
    WorkerClassic,
    WorkerModule,
    DocumentModule,
    WorkletModule,
    TargetWorker,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum SealedRouteKind {
    Navigation,
    Form,
    Beacon,
    Ping,
    Download,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RouteRequest {
    pub version: u16,
    pub kind: RouteKind,
    pub id: String,
}

pub struct RouteBuilder;

impl RouteBuilder {
    pub fn build(request: &RouteRequest) -> Result<String, PolicyError> {
        if request.version != ROUTE_SPEC_VERSION || !valid_opaque_route_id(&request.id) {
            return Err(PolicyError::InvalidRoute);
        }
        match route_segment(request.kind) {
            Some(segment) => Ok(format!("/_zp/p/{segment}/{}", request.id)),
            None => Ok(format!("/_zp/api/{}", request.id)),
        }
    }

    pub fn worker_gateway(
        kind: WorkerGatewayKind,
        gateway_id: &str,
        token: &str,
    ) -> Result<String, PolicyError> {
        if !valid_opaque_route_id(gateway_id) || !valid_sealed_route_token(token) {
            return Err(PolicyError::InvalidRoute);
        }
        let segment = match kind {
            WorkerGatewayKind::Classic => "wi",
            WorkerGatewayKind::Module => "wmi",
        };
        Ok(format!("/_zp/{segment}/{gateway_id}/{token}"))
    }

    pub fn executable(
        kind: ExecutableRouteKind,
        route_id: &str,
        content_id: Option<&str>,
    ) -> Result<String, PolicyError> {
        match kind {
            ExecutableRouteKind::WorkerClassic
                if valid_opaque_route_id(route_id) && content_id.is_none() =>
            {
                Ok(format!("/_zp/w/{route_id}.js"))
            }
            ExecutableRouteKind::WorkerModule
                if valid_opaque_route_id(route_id) && content_id.is_some_and(valid_content_id) =>
            {
                Ok(format!("/_zp/wm/{route_id}/{}.mjs", content_id.unwrap()))
            }
            ExecutableRouteKind::DocumentModule
                if valid_opaque_route_id(route_id) && content_id.is_some_and(valid_content_id) =>
            {
                Ok(format!("/_zp/dm/{route_id}/{}.mjs", content_id.unwrap()))
            }
            ExecutableRouteKind::WorkletModule
                if valid_opaque_route_id(route_id) && content_id.is_none() =>
            {
                Ok(format!("/_zp/worklet/{route_id}.mjs"))
            }
            ExecutableRouteKind::TargetWorker
                if valid_content_id(route_id) && content_id.is_none() =>
            {
                Ok(format!("/_zp/target-worker-exec/{route_id}.mjs"))
            }
            _ => Err(PolicyError::InvalidRoute),
        }
    }

    pub fn sealed(
        kind: SealedRouteKind,
        operation_id: &str,
        token: &str,
    ) -> Result<String, PolicyError> {
        if !valid_operation_id(operation_id) || !valid_sealed_route_token(token) {
            return Err(PolicyError::InvalidRoute);
        }
        let segment = match kind {
            SealedRouteKind::Navigation => "navigation",
            SealedRouteKind::Form => "form",
            SealedRouteKind::Beacon => "beacon",
            SealedRouteKind::Ping => "ping",
            SealedRouteKind::Download => "download",
        };
        Ok(format!("/_zp/{segment}/{operation_id}/{token}"))
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ParsedRoute {
    pub version: u16,
    pub family: RouteFamily,
    pub kind: Option<RouteKind>,
    pub id: String,
}

fn valid_opaque_route_id(id: &str) -> bool {
    id.len() == 32
        && id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
}

fn valid_content_id(id: &str) -> bool {
    id.len() == 64
        && id
            .bytes()
            .all(|byte| byte.is_ascii_digit() || matches!(byte, b'a'..=b'f'))
}

fn valid_operation_id(id: &str) -> bool {
    id.len() == 48
        && id
            .bytes()
            .all(|byte| byte.is_ascii_digit() || matches!(byte, b'a'..=b'f'))
}

fn valid_sealed_route_token(token: &str) -> bool {
    !token.is_empty()
        && token.len() <= 16_384
        && token
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(transparent)]
pub struct OpaqueOriginId(String);

impl OpaqueOriginId {
    pub fn parse(value: impl Into<String>) -> Result<Self, PolicyError> {
        let value = value.into();
        if value.len() != 32
            || !value
                .bytes()
                .all(|byte| matches!(byte, b'a'..=b'z' | b'2'..=b'7'))
        {
            return Err(PolicyError::InvalidRoute);
        }
        Ok(Self(value))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl<'de> Deserialize<'de> for OpaqueOriginId {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        Self::parse(String::deserialize(deserializer)?).map_err(serde::de::Error::custom)
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct VerifiedOriginMapping {
    pub canonical_origin: String,
    pub origin_id: OpaqueOriginId,
}

fn route_segment(kind: RouteKind) -> Option<&'static str> {
    match kind {
        RouteKind::Api | RouteKind::EventSource => None,
        RouteKind::Document => Some("document"),
        RouteKind::Navigation => Some("navigation"),
        RouteKind::Resource => Some("resource"),
        RouteKind::Script => Some("script"),
        RouteKind::Module => Some("module"),
        RouteKind::Style => Some("style"),
        RouteKind::Worker => Some("worker"),
        RouteKind::Worklet => Some("worklet"),
        RouteKind::Download => Some("download"),
        RouteKind::TargetWorker => Some("target-worker"),
    }
}

pub fn build_route(request: &RouteRequest) -> Result<String, PolicyError> {
    RouteBuilder::build(request)
}

pub fn parse_route(path: &str) -> Result<ParsedRoute, PolicyError> {
    let mut parts = path.split('/');
    if parts.next() != Some("") || parts.next() != Some("_zp") {
        return Err(PolicyError::InvalidRoute);
    }
    let route = match (parts.next(), parts.next(), parts.next(), parts.next()) {
        (Some("api"), Some(id), None, None) if valid_opaque_route_id(id) => ParsedRoute {
            version: ROUTE_SPEC_VERSION,
            family: RouteFamily::ApiPlan,
            kind: None,
            id: id.into(),
        },
        (Some("p"), Some(segment), Some(id), None) if valid_opaque_route_id(id) => {
            let kind = [
                RouteKind::Document,
                RouteKind::Navigation,
                RouteKind::Resource,
                RouteKind::Script,
                RouteKind::Module,
                RouteKind::Style,
                RouteKind::Worker,
                RouteKind::Worklet,
                RouteKind::Download,
                RouteKind::TargetWorker,
            ]
            .into_iter()
            .find(|kind| route_segment(*kind) == Some(segment))
            .ok_or(PolicyError::InvalidRoute)?;
            ParsedRoute {
                version: ROUTE_SPEC_VERSION,
                family: RouteFamily::Target,
                kind: Some(kind),
                id: id.into(),
            }
        }
        _ => return Err(PolicyError::InvalidRoute),
    };
    Ok(route)
}

pub fn route_path(kind: RouteKind, id: &str) -> Result<String, PolicyError> {
    build_route(&RouteRequest {
        version: ROUTE_SPEC_VERSION,
        kind,
        id: id.into(),
    })
}

pub fn worker_gateway_path(
    kind: WorkerGatewayKind,
    gateway_id: &str,
    token: &str,
) -> Result<String, PolicyError> {
    RouteBuilder::worker_gateway(kind, gateway_id, token)
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CanonicalTarget {
    pub visible: String,
    pub network: String,
    pub fragment: Option<String>,
    pub origin: String,
    pub site: String,
    pub scheme: String,
    pub host: String,
    pub port: u16,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum InventoryParsing {
    SingleUrl,
    Srcset,
    Refresh,
    Style,
    Srcdoc,
    EventHandler,
    RelTokenDependent,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum InventoryDisposition {
    VirtualBase,
    ControlledNavigation,
    ControlledFetch,
    ControlledExecutable,
    RemoveHint,
    RecursiveDocument,
    CompileEventHandler,
    Block,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct InventoryEntry {
    pub parsing: InventoryParsing,
    pub disposition: InventoryDisposition,
    pub resource_kind: Option<ResourceKind>,
}

include!("generated_inventory.rs");

pub fn html_attribute_inventory(
    namespace: &str,
    element: &str,
    attribute: &str,
    link_rel: Option<&str>,
    http_equiv: Option<&str>,
    type_essence: Option<&str>,
) -> Option<InventoryEntry> {
    html_inventory_entry(
        namespace,
        element,
        attribute,
        link_rel,
        http_equiv,
        type_essence,
    )
}

pub fn html_attribute_kind(
    element: &str,
    attribute: &str,
    link_rel: Option<&str>,
) -> Option<ResourceKind> {
    html_attribute_inventory("html", element, attribute, link_rel, None, None)
        .and_then(|entry| entry.resource_kind)
}

pub fn canonicalize(raw: &str, base: Option<&str>) -> Result<CanonicalTarget, PolicyError> {
    let mut url = match base {
        Some(base) => Url::parse(base)
            .map_err(|_| PolicyError::InvalidBase)?
            .join(raw)
            .map_err(|_| PolicyError::InvalidTarget)?,
        None => Url::parse(raw).map_err(|_| PolicyError::InvalidTarget)?,
    };
    if !matches!(url.scheme(), "http" | "https") {
        return Err(PolicyError::UnsupportedScheme);
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err(PolicyError::UserInfo);
    }
    let fragment = url.fragment().map(ToOwned::to_owned);
    let visible = url.to_string();
    url.set_fragment(None);
    let network = url.to_string();
    let scheme = url.scheme().to_owned();
    let host = url
        .host_str()
        .ok_or(PolicyError::InvalidTarget)?
        .to_ascii_lowercase();
    let port = url
        .port_or_known_default()
        .ok_or(PolicyError::InvalidTarget)?;
    let authority_host = if host.contains(':') && !host.starts_with('[') {
        format!("[{host}]")
    } else {
        host.clone()
    };
    let origin = format!("{scheme}://{authority_host}:{port}");
    let registrable = psl::domain(host.as_bytes())
        .map(|domain| String::from_utf8_lossy(domain.as_bytes()).into_owned())
        .unwrap_or_else(|| authority_host.clone());
    let site = format!("{scheme}://{registrable}");
    Ok(CanonicalTarget {
        visible,
        network,
        fragment,
        origin,
        site,
        scheme,
        host,
        port,
    })
}

const MAX_CSP_BYTES: usize = 64 << 10;
const MAX_CSP_POLICIES: usize = 16;
const MAX_CSP_DIRECTIVES: usize = 128;
const MAX_CSP_SOURCES: usize = 256;

type CspPolicy = BTreeMap<String, Vec<String>>;

fn parse_csp_policy(value: &str) -> Option<CspPolicy> {
    if value.len() > MAX_CSP_BYTES {
        return None;
    }
    let mut policy = CspPolicy::new();
    for directive in value.split(';') {
        let mut tokens = directive.split_ascii_whitespace();
        let Some(raw_name) = tokens.next() else {
            continue;
        };
        let name = raw_name.to_ascii_lowercase();
        if name.is_empty()
            || !name
                .bytes()
                .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
        {
            continue;
        }
        if policy.contains_key(&name) {
            continue;
        }
        let sources = tokens
            .take(MAX_CSP_SOURCES + 1)
            .map(ToOwned::to_owned)
            .collect::<Vec<_>>();
        if sources.len() > MAX_CSP_SOURCES || policy.len() >= MAX_CSP_DIRECTIVES {
            return None;
        }
        policy.insert(name, sources);
    }
    Some(policy)
}

fn csp_policies(values: &[String]) -> Option<Vec<CspPolicy>> {
    let mut policies = Vec::new();
    for value in values {
        for policy in value.split(',') {
            if policies.len() >= MAX_CSP_POLICIES {
                return None;
            }
            policies.push(parse_csp_policy(policy)?);
        }
    }
    Some(policies)
}

fn valid_trusted_types_policy_name(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value.bytes().all(|byte| {
            byte.is_ascii_alphanumeric()
                || matches!(byte, b'-' | b'#' | b'=' | b'_' | b'/' | b'@' | b'.' | b'%')
        })
}

fn report_endpoint_count(policies: &[CspPolicy]) -> usize {
    policies
        .iter()
        .map(|policy| {
            policy.get("report-uri").map_or(0, Vec::len)
                + usize::from(
                    policy
                        .get("report-to")
                        .is_some_and(|values| !values.is_empty()),
                )
        })
        .sum()
}

fn trusted_types_policy(policies: &[CspPolicy]) -> TrustedTypesPolicy {
    let mut directive_present = false;
    let mut allowed_names: Option<BTreeSet<String>> = None;
    let mut allow_duplicates = true;
    let mut require_for_script = false;
    for policy in policies {
        require_for_script |= policy
            .get("require-trusted-types-for")
            .is_some_and(|values| {
                values
                    .iter()
                    .any(|value| value.eq_ignore_ascii_case("'script'"))
            });
        let Some(values) = policy.get("trusted-types") else {
            continue;
        };
        directive_present = true;
        allow_duplicates &= values
            .iter()
            .any(|value| value.eq_ignore_ascii_case("'allow-duplicates'"));
        let allow_any = values.iter().any(|value| value == "*");
        if allow_any {
            continue;
        }
        let names = values
            .iter()
            .filter(|value| valid_trusted_types_policy_name(value))
            .cloned()
            .collect::<BTreeSet<_>>();
        allowed_names = Some(match allowed_names {
            Some(existing) => existing.intersection(&names).cloned().collect(),
            None => names,
        });
    }
    let allow_any = allowed_names.is_none();
    TrustedTypesPolicy {
        directive_present,
        allow_any,
        allowed_policy_names: allowed_names.unwrap_or_default().into_iter().collect(),
        allow_duplicates: directive_present && allow_duplicates,
        require_for_script,
    }
}

pub fn csp_document_policy(context: &Context) -> Option<CspDocumentPolicy> {
    let enforced = csp_policies(&context.target_csp)?;
    let report_only = csp_policies(&context.target_csp_report_only)?;
    Some(CspDocumentPolicy {
        version: 1,
        trusted_types: trusted_types_policy(&enforced),
        enforced_report_endpoint_count: report_endpoint_count(&enforced),
        report_only_endpoint_count: report_endpoint_count(&report_only),
    })
}

fn directive_sources<'a>(policy: &'a CspPolicy, directives: &[&str]) -> Option<&'a [String]> {
    directives
        .iter()
        .find_map(|directive| policy.get(*directive).map(Vec::as_slice))
}

fn csp_directives(descriptor: &ResourceDescriptor) -> &'static [&'static str] {
    match descriptor.resource_kind {
        ResourceKind::Script | ResourceKind::Module => {
            if descriptor.element_name.as_deref() == Some("script") {
                &["script-src-elem", "script-src", "default-src"]
            } else {
                &["script-src", "default-src"]
            }
        }
        ResourceKind::Style => {
            if matches!(descriptor.element_name.as_deref(), Some("link" | "style")) {
                &["style-src-elem", "style-src", "default-src"]
            } else {
                &["style-src", "default-src"]
            }
        }
        ResourceKind::Image => &["img-src", "default-src"],
        ResourceKind::Font => &["font-src", "default-src"],
        ResourceKind::Media => &["media-src", "default-src"],
        ResourceKind::Frame => &["frame-src", "child-src", "default-src"],
        ResourceKind::Worker => &["worker-src", "child-src", "script-src", "default-src"],
        ResourceKind::Manifest => &["manifest-src", "default-src"],
        ResourceKind::Document => {
            if matches!(
                (
                    descriptor.element_name.as_deref(),
                    descriptor.attribute_name.as_deref()
                ),
                (Some("form"), Some("action")) | (Some("input" | "button"), Some("formaction"))
            ) {
                &["form-action"]
            } else if matches!(
                (
                    descriptor.element_name.as_deref(),
                    descriptor.attribute_name.as_deref()
                ),
                (Some("base"), Some("href"))
            ) {
                &["base-uri"]
            } else {
                &[]
            }
        }
        ResourceKind::Download => &[],
    }
}

fn source_scheme(source: &str) -> Option<&str> {
    let scheme = source.strip_suffix(':')?;
    if scheme
        .bytes()
        .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'+' | b'-' | b'.'))
    {
        Some(scheme)
    } else {
        None
    }
}

fn target_origin(url: &Url) -> Option<String> {
    let host = url.host_str()?;
    let port = url.port_or_known_default()?;
    let authority = if host.contains(':') {
        format!("[{host}]")
    } else {
        host.to_ascii_lowercase()
    };
    Some(format!("{}://{}:{}", url.scheme(), authority, port))
}

fn host_source_matches(source: &str, target: &Url, document: &Url) -> bool {
    let (scheme, remainder) = if let Some((scheme, remainder)) = source.split_once("://") {
        (scheme.to_ascii_lowercase(), remainder)
    } else {
        (document.scheme().to_owned(), source)
    };
    if scheme != target.scheme() {
        return false;
    }
    let (authority, path) = remainder
        .split_once('/')
        .map_or((remainder, ""), |(authority, path)| (authority, path));
    let (raw_host, raw_port) = if authority.starts_with('[') {
        let Some(end) = authority.find(']') else {
            return false;
        };
        (
            &authority[..=end],
            authority
                .get(end + 1..)
                .and_then(|value| value.strip_prefix(':')),
        )
    } else {
        authority
            .rsplit_once(':')
            .filter(|(_, port)| *port == "*" || port.bytes().all(|byte| byte.is_ascii_digit()))
            .map_or((authority, None), |(host, port)| (host, Some(port)))
    };
    let target_host = target.host_str().unwrap_or_default().to_ascii_lowercase();
    let normalized_host = raw_host
        .trim_matches(['[', ']'])
        .trim_end_matches('.')
        .to_ascii_lowercase();
    let host_matches = if let Some(suffix) = normalized_host.strip_prefix("*.") {
        target_host.ends_with(&format!(".{suffix}")) && target_host.len() > suffix.len() + 1
    } else if normalized_host == "*" {
        true
    } else {
        target_host == normalized_host
    };
    if !host_matches {
        return false;
    }
    if let Some(port) = raw_port {
        if port != "*" && port.parse::<u16>().ok() != target.port_or_known_default() {
            return false;
        }
    } else if target.port_or_known_default()
        != Url::parse(&format!("{scheme}://example.invalid"))
            .ok()
            .and_then(|url| url.port_or_known_default())
    {
        return false;
    }
    path.is_empty() || target.path().starts_with(&format!("/{path}"))
}

fn source_matches(source: &str, target: &Url, document: &Url) -> bool {
    let normalized = source.to_ascii_lowercase();
    if normalized == "*" {
        return matches!(target.scheme(), "http" | "https" | "ws" | "wss");
    }
    if normalized == "'self'" {
        return target_origin(target) == target_origin(document);
    }
    if normalized == "'none'"
        || normalized.starts_with("'nonce-")
        || normalized.starts_with("'sha256-")
        || normalized.starts_with("'sha384-")
        || normalized.starts_with("'sha512-")
        || matches!(
            normalized.as_str(),
            "'unsafe-inline'" | "'unsafe-eval'" | "'unsafe-hashes'" | "'strict-dynamic'"
        )
    {
        return false;
    }
    if let Some(scheme) = source_scheme(&normalized) {
        return target.scheme() == scheme;
    }
    host_source_matches(&normalized, target, document)
}

fn source_list_allows(sources: &[String], target: &Url, document: &Url) -> bool {
    if sources.is_empty() || (sources.len() == 1 && sources[0].eq_ignore_ascii_case("'none'")) {
        return false;
    }
    sources
        .iter()
        .any(|source| source_matches(source, target, document))
}

fn csp_nonce_matches(sources: &[String], nonce: Option<&str>) -> bool {
    nonce.is_some_and(|nonce| {
        sources
            .iter()
            .any(|source| source == &format!("'nonce-{nonce}'"))
    })
}

fn csp_integrity_matches(sources: &[String], integrity: Option<&str>) -> bool {
    let Some(integrity) = integrity else {
        return false;
    };
    let integrity_tokens = integrity.split_ascii_whitespace().collect::<Vec<_>>();
    !integrity_tokens.is_empty()
        && integrity_tokens.iter().all(|token| {
            sources.iter().any(|source| {
                source
                    .strip_prefix('\'')
                    .and_then(|value| value.strip_suffix('\''))
                    .is_some_and(|value| value == *token)
            })
        })
}

fn script_source_list_allows(
    sources: &[String],
    descriptor: &ResourceDescriptor,
    target: &Url,
    document: &Url,
) -> bool {
    let contains_trust_source = sources.iter().any(|source| {
        let normalized = source.to_ascii_lowercase();
        normalized.starts_with("'nonce-")
            || normalized.starts_with("'sha256-")
            || normalized.starts_with("'sha384-")
            || normalized.starts_with("'sha512-")
    });
    let trusted = csp_nonce_matches(sources, descriptor.nonce.as_deref())
        || csp_integrity_matches(sources, descriptor.integrity.as_deref());
    let strict_dynamic = contains_trust_source
        && sources
            .iter()
            .any(|source| source.eq_ignore_ascii_case("'strict-dynamic'"));
    if strict_dynamic {
        return trusted || !descriptor.parser_inserted;
    }
    trusted || source_list_allows(sources, target, document)
}

pub fn csp_allows_frame_ancestors(
    policies: &[String],
    target_url: &str,
    ancestor_urls: &[String],
) -> bool {
    if ancestor_urls.len() > 32 {
        return false;
    }
    let Ok(document) = Url::parse(target_url) else {
        return false;
    };
    let Some(policies) = csp_policies(policies) else {
        return false;
    };
    policies.iter().all(|policy| {
        policy.get("frame-ancestors").is_none_or(|sources| {
            ancestor_urls.iter().all(|ancestor| {
                Url::parse(ancestor)
                    .ok()
                    .is_some_and(|ancestor| source_list_allows(sources, &ancestor, &document))
            })
        })
    })
}

fn csp_allows_url(context: &Context, descriptor: &ResourceDescriptor, target: &Url) -> bool {
    let directives = csp_directives(descriptor);
    if directives.is_empty() {
        return true;
    }
    let Ok(document) = Url::parse(&context.target_url) else {
        return false;
    };
    let Some(policies) = csp_policies(&context.target_csp) else {
        return false;
    };
    let script = matches!(
        descriptor.resource_kind,
        ResourceKind::Script | ResourceKind::Module
    );
    policies.iter().all(|policy| {
        directive_sources(policy, directives).is_none_or(|sources| {
            if script {
                script_source_list_allows(sources, descriptor, target, &document)
            } else {
                source_list_allows(sources, target, &document)
            }
        })
    })
}

fn has_csp_directive(context: &Context, directive: &str) -> bool {
    csp_policies(&context.target_csp)
        .is_some_and(|policies| policies.iter().any(|policy| policy.contains_key(directive)))
}

fn upgrade_insecure_target(context: &Context, raw: &str) -> String {
    if !has_csp_directive(context, "upgrade-insecure-requests") {
        return raw.to_owned();
    }
    let Ok(mut target) = Url::options()
        .base_url(Url::parse(&context.effective_base_url).ok().as_ref())
        .parse(raw)
    else {
        return raw.to_owned();
    };
    if target.scheme() == "http" && target.set_scheme("https").is_ok() {
        if target.port() == Some(80) {
            let _ = target.set_port(None);
        }
        return target.to_string();
    }
    raw.to_owned()
}

fn mixed_content_blocked(context: &Context, descriptor: &ResourceDescriptor, target: &Url) -> bool {
    let Ok(document) = Url::parse(&context.target_url) else {
        return true;
    };
    document.scheme() == "https"
        && target.scheme() == "http"
        && (has_csp_directive(context, "block-all-mixed-content")
            || !matches!(
                descriptor.resource_kind,
                ResourceKind::Document | ResourceKind::Download
            ))
}

fn csp_block() -> Decision {
    Decision::Block {
        code: "TARGET_CSP_BLOCKED".into(),
        native_failure_shape: "network-error".into(),
    }
}

fn digest_source_matches(source: &str, input: &[u8]) -> bool {
    let Some((algorithm, expected)) = source
        .strip_prefix('\'')
        .and_then(|value| value.strip_suffix('\''))
        .and_then(|value| value.split_once('-'))
    else {
        return false;
    };
    let actual = match algorithm.to_ascii_lowercase().as_str() {
        "sha256" => STANDARD.encode(Sha256::digest(input)),
        "sha384" => STANDARD.encode(Sha384::digest(input)),
        "sha512" => STANDARD.encode(Sha512::digest(input)),
        _ => return false,
    };
    actual == expected
}

pub fn csp_allows_inline(
    context: &Context,
    directive: &str,
    source: &str,
    nonce: Option<&str>,
    attribute: bool,
) -> bool {
    let fallback = match directive {
        "style-src-elem" => ["style-src-elem", "style-src", "default-src"],
        "style-src-attr" => ["style-src-attr", "style-src", "default-src"],
        "script-src-attr" => ["script-src-attr", "script-src", "default-src"],
        _ => ["script-src-elem", "script-src", "default-src"],
    };
    let Some(policies) = csp_policies(&context.target_csp) else {
        return false;
    };
    policies.iter().all(|policy| {
        let Some(sources) = directive_sources(policy, &fallback) else {
            return true;
        };
        let has_nonce_or_hash = sources.iter().any(|value| {
            let normalized = value.to_ascii_lowercase();
            normalized.starts_with("'nonce-")
                || normalized.starts_with("'sha256-")
                || normalized.starts_with("'sha384-")
                || normalized.starts_with("'sha512-")
        });
        if sources
            .iter()
            .any(|value| value.eq_ignore_ascii_case("'unsafe-inline'"))
            && !has_nonce_or_hash
        {
            return true;
        }
        if !attribute
            && nonce.is_some_and(|nonce| {
                sources
                    .iter()
                    .any(|value| value == &format!("'nonce-{nonce}'"))
            })
        {
            return true;
        }
        let hashes_allowed = !attribute
            || sources
                .iter()
                .any(|value| value.eq_ignore_ascii_case("'unsafe-hashes'"));
        hashes_allowed
            && sources
                .iter()
                .any(|value| digest_source_matches(value, source.as_bytes()))
    })
}

pub fn csp_allows_eval(context: &Context) -> bool {
    let Some(policies) = csp_policies(&context.target_csp) else {
        return false;
    };
    policies.iter().all(|policy| {
        directive_sources(policy, &["script-src", "default-src"]).is_none_or(|sources| {
            sources
                .iter()
                .any(|source| source.eq_ignore_ascii_case("'unsafe-eval'"))
        })
    })
}

pub fn csp_allows_connect(context: &Context, raw_target: &str) -> bool {
    let Ok(document) = Url::parse(&context.target_url) else {
        return false;
    };
    let Ok(target_url) = Url::parse(raw_target).or_else(|_| {
        Url::parse(&context.effective_base_url).and_then(|base| base.join(raw_target))
    }) else {
        return false;
    };
    if !matches!(target_url.scheme(), "http" | "https" | "ws" | "wss")
        || !target_url.username().is_empty()
        || target_url.password().is_some()
    {
        return false;
    }
    let Some(policies) = csp_policies(&context.target_csp) else {
        return false;
    };
    policies.iter().all(|policy| {
        directive_sources(policy, &["connect-src", "default-src"])
            .is_none_or(|sources| source_list_allows(sources, &target_url, &document))
    })
}

pub fn decide(context: &Context, descriptor: &ResourceDescriptor) -> Result<Decision, PolicyError> {
    if context.policy_version != POLICY_VERSION {
        return Err(PolicyError::VersionMismatch);
    }
    if descriptor.raw_value.starts_with('#')
        && matches!(
            descriptor.resource_kind,
            ResourceKind::Document | ResourceKind::Frame
        )
    {
        return Ok(Decision::Pass);
    }
    let raw_target = upgrade_insecure_target(context, &descriptor.raw_value);
    if let Ok(absolute) = Url::parse(&raw_target) {
        let passive = matches!(
            descriptor.resource_kind,
            ResourceKind::Image | ResourceKind::Font | ResourceKind::Media
        );
        if matches!(absolute.scheme(), "data" | "blob") {
            return Ok(
                if passive && csp_allows_url(context, descriptor, &absolute) {
                    Decision::Pass
                } else {
                    csp_block()
                },
            );
        }
        if absolute.scheme() == "about"
            && absolute.as_str() == "about:blank"
            && matches!(
                descriptor.resource_kind,
                ResourceKind::Document | ResourceKind::Frame
            )
        {
            return Ok(Decision::Pass);
        }
    }
    let target = canonicalize(&raw_target, Some(&context.effective_base_url))?;
    let target_url = Url::parse(&target.visible).map_err(|_| PolicyError::InvalidTarget)?;
    if mixed_content_blocked(context, descriptor, &target_url)
        || !csp_allows_url(context, descriptor, &target_url)
    {
        return Ok(csp_block());
    }
    if !context.approved_target_ports.contains(&target.port) {
        return Ok(Decision::Block {
            code: "TARGET_PORT_BLOCKED".into(),
            native_failure_shape: "network-error".into(),
        });
    }
    if descriptor.element_name.as_deref() == Some("base")
        && descriptor.attribute_name.as_deref() == Some("href")
    {
        return Ok(Decision::VirtualBase {
            canonical_target: target.visible,
        });
    }
    Ok(match descriptor.resource_kind {
        ResourceKind::Document | ResourceKind::Frame => Decision::Navigate {
            canonical_target: target.visible,
            destination_origin_id: None,
            handoff_kind: if descriptor.resource_kind == ResourceKind::Frame {
                "frame"
            } else {
                "document"
            }
            .into(),
        },
        ResourceKind::Script => Decision::Script {
            canonical_target: target.visible,
            module: false,
            source_kind: match descriptor.script_kind.as_deref() {
                None | Some("ClassicScriptExternal") => "ClassicScriptExternal".into(),
                _ => {
                    return Ok(Decision::Block {
                        code: "SCRIPT_KIND_INVALID".into(),
                        native_failure_shape: "network-error".into(),
                    });
                }
            },
            fetch_context: descriptor
                .request_destination
                .clone()
                .unwrap_or_else(|| "script".into()),
            integrity_policy: descriptor.integrity.clone(),
        },
        ResourceKind::Module => Decision::Script {
            canonical_target: target.visible,
            module: true,
            source_kind: match descriptor.script_kind.as_deref() {
                None | Some("ModuleScript") => "ModuleScript".into(),
                _ => {
                    return Ok(Decision::Block {
                        code: "SCRIPT_KIND_INVALID".into(),
                        native_failure_shape: "network-error".into(),
                    });
                }
            },
            fetch_context: descriptor
                .request_destination
                .clone()
                .unwrap_or_else(|| "script".into()),
            integrity_policy: descriptor.integrity.clone(),
        },
        kind => {
            let credentials = match descriptor.credentials_mode.as_deref() {
                None | Some("same-origin") => "same-origin",
                Some("omit") => "omit",
                Some("include") => "include",
                _ => {
                    return Ok(Decision::Block {
                        code: "CREDENTIALS_MODE_INVALID".into(),
                        native_failure_shape: "network-error".into(),
                    });
                }
            };
            Decision::Fetch {
                canonical_target: target.visible,
                network_target: target.network,
                fragment: target.fragment,
                route_kind: kind,
                cache_partition: format!(
                    "p{}:{}o{}:{}c{}:{}",
                    context.profile_id.len(),
                    context.profile_id,
                    context.virtual_origin.len(),
                    context.virtual_origin,
                    credentials.len(),
                    credentials,
                ),
            }
        }
    })
}

#[cfg(target_arch = "wasm32")]
#[wasm_bindgen::prelude::wasm_bindgen]
pub fn canonicalize_json(raw: &str, base: Option<String>) -> Result<String, wasm_bindgen::JsValue> {
    canonicalize(raw, base.as_deref())
        .and_then(|target| serde_json::to_string(&target).map_err(|_| PolicyError::InvalidTarget))
        .map_err(|error| wasm_bindgen::JsValue::from_str(&error.to_string()))
}

#[cfg(target_arch = "wasm32")]
#[wasm_bindgen::prelude::wasm_bindgen]
pub fn canonicalize_result_json(raw: &str, base: Option<String>) -> String {
    match canonicalize(raw, base.as_deref()) {
        Ok(target) => serde_json::json!({"ok": true, "target": target}).to_string(),
        Err(error) => {
            let code = match error {
                PolicyError::VersionMismatch => "VERSION_MISMATCH",
                PolicyError::InvalidBase => "INVALID_BASE",
                PolicyError::InvalidTarget => "INVALID_TARGET",
                PolicyError::UnsupportedScheme => "UNSUPPORTED_SCHEME",
                PolicyError::UserInfo => "USERINFO_FORBIDDEN",
                PolicyError::InvalidRoute => "INVALID_ROUTE",
            };
            serde_json::json!({"ok": false, "error": {"code": code}}).to_string()
        }
    }
}

#[cfg(target_arch = "wasm32")]
#[wasm_bindgen::prelude::wasm_bindgen]
pub fn route_path_result_json(kind: &str, id: &str) -> String {
    let result = serde_json::from_str::<RouteKind>(&format!("\"{kind}\""))
        .map_err(|_| PolicyError::InvalidRoute)
        .and_then(|kind| route_path(kind, id));
    match result {
        Ok(path) => serde_json::json!({"ok": true, "path": path}).to_string(),
        Err(_) => serde_json::json!({"ok": false, "error": {"code": "INVALID_ROUTE"}}).to_string(),
    }
}

#[cfg(target_arch = "wasm32")]
#[wasm_bindgen::prelude::wasm_bindgen]
pub fn worker_gateway_path_result_json(kind: &str, gateway_id: &str, token: &str) -> String {
    let result = serde_json::from_str::<WorkerGatewayKind>(&format!("\"{kind}\""))
        .map_err(|_| PolicyError::InvalidRoute)
        .and_then(|kind| worker_gateway_path(kind, gateway_id, token));
    match result {
        Ok(path) => serde_json::json!({"ok": true, "path": path}).to_string(),
        Err(_) => serde_json::json!({"ok": false, "error": {"code": "INVALID_ROUTE"}}).to_string(),
    }
}

#[cfg(target_arch = "wasm32")]
#[wasm_bindgen::prelude::wasm_bindgen]
pub fn executable_route_path_result_json(
    kind: &str,
    route_id: &str,
    content_id: Option<String>,
) -> String {
    let result = serde_json::from_str::<ExecutableRouteKind>(&format!("\"{kind}\""))
        .map_err(|_| PolicyError::InvalidRoute)
        .and_then(|kind| RouteBuilder::executable(kind, route_id, content_id.as_deref()));
    match result {
        Ok(path) => serde_json::json!({"ok": true, "path": path}).to_string(),
        Err(_) => serde_json::json!({"ok": false, "error": {"code": "INVALID_ROUTE"}}).to_string(),
    }
}

#[cfg(target_arch = "wasm32")]
#[wasm_bindgen::prelude::wasm_bindgen]
pub fn sealed_route_path_result_json(kind: &str, operation_id: &str, token: &str) -> String {
    let result = serde_json::from_str::<SealedRouteKind>(&format!("\"{kind}\""))
        .map_err(|_| PolicyError::InvalidRoute)
        .and_then(|kind| RouteBuilder::sealed(kind, operation_id, token));
    match result {
        Ok(path) => serde_json::json!({"ok": true, "path": path}).to_string(),
        Err(_) => serde_json::json!({"ok": false, "error": {"code": "INVALID_ROUTE"}}).to_string(),
    }
}
#[cfg(target_arch = "wasm32")]
#[wasm_bindgen::prelude::wasm_bindgen]
pub fn route_spec_version() -> u16 {
    ROUTE_SPEC_VERSION
}

#[cfg(target_arch = "wasm32")]
#[wasm_bindgen::prelude::wasm_bindgen]
pub fn parse_route_result_json(path: &str) -> String {
    match parse_route(path) {
        Ok(route) => serde_json::json!({"ok": true, "route": route}).to_string(),
        Err(_) => serde_json::json!({"ok": false, "error": {"code": "INVALID_ROUTE"}}).to_string(),
    }
}

#[cfg(target_arch = "wasm32")]
#[wasm_bindgen::prelude::wasm_bindgen]
pub fn decide_json(context: &str, descriptor: &str) -> Result<String, wasm_bindgen::JsValue> {
    let context: Context = serde_json::from_str(context)
        .map_err(|_| wasm_bindgen::JsValue::from_str("invalid context"))?;
    let descriptor: ResourceDescriptor = serde_json::from_str(descriptor)
        .map_err(|_| wasm_bindgen::JsValue::from_str("invalid descriptor"))?;
    decide(&context, &descriptor)
        .and_then(|decision| {
            serde_json::to_string(&decision).map_err(|_| PolicyError::InvalidTarget)
        })
        .map_err(|error| wasm_bindgen::JsValue::from_str(&error.to_string()))
}

#[cfg(target_arch = "wasm32")]
#[wasm_bindgen::prelude::wasm_bindgen]
pub fn csp_allows_eval_json(context: &str) -> Result<bool, wasm_bindgen::JsValue> {
    let context: Context = serde_json::from_str(context)
        .map_err(|_| wasm_bindgen::JsValue::from_str("invalid context"))?;
    Ok(csp_allows_eval(&context))
}

#[cfg(target_arch = "wasm32")]
#[wasm_bindgen::prelude::wasm_bindgen]
pub fn csp_allows_connect_json(context: &str, target: &str) -> Result<bool, wasm_bindgen::JsValue> {
    let context: Context = serde_json::from_str(context)
        .map_err(|_| wasm_bindgen::JsValue::from_str("invalid context"))?;
    Ok(csp_allows_connect(&context, target))
}

#[cfg(target_arch = "wasm32")]
#[wasm_bindgen::prelude::wasm_bindgen]
pub fn csp_document_policy_json(context: &str) -> Result<String, wasm_bindgen::JsValue> {
    let context: Context = serde_json::from_str(context)
        .map_err(|_| wasm_bindgen::JsValue::from_str("invalid context"))?;
    serde_json::to_string(
        &csp_document_policy(&context)
            .ok_or_else(|| wasm_bindgen::JsValue::from_str("invalid target CSP"))?,
    )
    .map_err(|_| wasm_bindgen::JsValue::from_str("document CSP serialization failed"))
}

#[cfg(target_arch = "wasm32")]
#[wasm_bindgen::prelude::wasm_bindgen]
pub fn csp_allows_frame_ancestors_json(
    policies: &str,
    target_url: &str,
    ancestor_urls: &str,
) -> Result<bool, wasm_bindgen::JsValue> {
    let policies: Vec<String> = serde_json::from_str(policies)
        .map_err(|_| wasm_bindgen::JsValue::from_str("invalid target CSP"))?;
    let ancestor_urls: Vec<String> = serde_json::from_str(ancestor_urls)
        .map_err(|_| wasm_bindgen::JsValue::from_str("invalid ancestor URLs"))?;
    Ok(csp_allows_frame_ancestors(
        &policies,
        target_url,
        &ancestor_urls,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    fn test_context() -> Context {
        Context {
            profile_id: "p".into(),
            tab_id: "t".into(),
            document_id: "d".into(),
            virtual_origin: "https://example.test:443".into(),
            virtual_site: "https://example.test".into(),
            target_url: "https://example.test/".into(),
            effective_base_url: "https://example.test/".into(),
            referrer_url: None,
            referrer_policy: "strict-origin-when-cross-origin".into(),
            document_charset: "utf-8".into(),
            target_csp: vec![],
            target_csp_report_only: vec![],
            relay_profile: "test-relay-profile".into(),
            approved_target_ports: vec![80, 443],
            policy_version: 2,
        }
    }

    fn descriptor(kind: ResourceKind, raw_value: &str) -> ResourceDescriptor {
        ResourceDescriptor {
            source_boundary: "test".into(),
            element_namespace: None,
            element_name: None,
            attribute_name: None,
            resource_kind: kind,
            raw_value: raw_value.into(),
            parser_inserted: false,
            request_destination: None,
            script_kind: None,
            worker_kind: None,
            integrity: None,
            nonce: None,
            credentials_mode: None,
        }
    }

    #[test]
    fn base_and_fragment_are_authoritative() {
        let got = canonicalize("../x?q=1#f", Some("https://EXAMPLE.test/a/b")).unwrap();
        assert_eq!(got.network, "https://example.test/x?q=1");
        assert_eq!(got.fragment.as_deref(), Some("f"));
    }
    #[test]
    fn canonical_origin_and_site_cover_idna_custom_ports_and_ipv6() {
        let idna = canonicalize("HTTPS://BÜCHER.example:8443/a#fragment", None).unwrap();
        assert_eq!(idna.host, "xn--bcher-kva.example");
        assert_eq!(idna.origin, "https://xn--bcher-kva.example:8443");
        assert_eq!(idna.site, "https://xn--bcher-kva.example");
        let ipv6 = canonicalize("http://[2001:db8::1]/", None).unwrap();
        assert_eq!(ipv6.origin, "http://[2001:db8::1]:80");
        assert_eq!(ipv6.site, "http://[2001:db8::1]");
    }
    #[test]
    fn rejects_unsafe_targets() {
        assert_eq!(
            canonicalize("https://u:p@example.test", None),
            Err(PolicyError::UserInfo)
        );
        assert_eq!(
            canonicalize("ftp://example.test", None),
            Err(PolicyError::UnsupportedScheme)
        );
    }
    #[test]
    fn transport_ports_are_policy_controlled_after_canonicalization() {
        let context = test_context();
        let mut descriptor = ResourceDescriptor {
            source_boundary: "test".into(),
            element_namespace: None,
            element_name: None,
            attribute_name: None,
            resource_kind: ResourceKind::Image,
            raw_value: "https://example.test:8443/x".into(),
            parser_inserted: false,
            request_destination: None,
            script_kind: None,
            worker_kind: None,
            integrity: None,
            nonce: None,
            credentials_mode: None,
        };
        assert!(matches!(
            decide(&context, &descriptor).unwrap(),
            Decision::Block { .. }
        ));
        descriptor.raw_value = "https://example.test/x".into();
        assert!(matches!(
            decide(&context, &descriptor).unwrap(),
            Decision::Fetch { .. }
        ));
        assert_eq!(
            canonicalize("https://example.test:8443", None)
                .unwrap()
                .port,
            8443
        );
    }
    #[test]
    fn local_schemes_are_resource_kind_specific() {
        let context = test_context();
        let mut descriptor = ResourceDescriptor {
            source_boundary: "test".into(),
            element_namespace: None,
            element_name: None,
            attribute_name: None,
            resource_kind: ResourceKind::Image,
            raw_value: "data:image/png;base64,AA==".into(),
            parser_inserted: false,
            request_destination: None,
            script_kind: None,
            worker_kind: None,
            integrity: None,
            nonce: None,
            credentials_mode: None,
        };
        assert_eq!(decide(&context, &descriptor).unwrap(), Decision::Pass);
        descriptor.resource_kind = ResourceKind::Script;
        assert!(matches!(
            decide(&context, &descriptor).unwrap(),
            Decision::Block { .. }
        ));
        descriptor.resource_kind = ResourceKind::Document;
        descriptor.raw_value = "#section".into();
        assert_eq!(decide(&context, &descriptor).unwrap(), Decision::Pass);
    }
    #[test]
    fn link_relation_inventory_is_typed() {
        assert_eq!(
            html_attribute_kind("link", "href", Some("alternate stylesheet")),
            Some(ResourceKind::Style)
        );
        assert_eq!(
            html_attribute_kind("link", "href", Some("modulepreload")),
            Some(ResourceKind::Module)
        );
        assert_eq!(
            html_attribute_kind("link", "href", Some("manifest")),
            Some(ResourceKind::Manifest)
        );
        assert_eq!(
            html_attribute_kind("link", "href", Some("canonical")),
            Some(ResourceKind::Style)
        );
    }

    #[test]
    fn generated_network_inventory_covers_typed_surface_behavior() {
        let entry = |namespace, element, attribute, rel| {
            html_attribute_inventory(namespace, element, attribute, rel, None, None).unwrap()
        };
        assert_eq!(
            entry("html", "img", "srcset", None).parsing,
            InventoryParsing::Srcset
        );
        assert_eq!(
            entry("html", "iframe", "srcdoc", None).disposition,
            InventoryDisposition::RecursiveDocument
        );
        assert_eq!(
            entry("svg", "use", "xlink:href", None).resource_kind,
            Some(ResourceKind::Image)
        );
        assert_eq!(
            entry("html", "link", "href", Some("preconnect")).disposition,
            InventoryDisposition::RemoveHint
        );
        assert_eq!(
            entry("html", "link", "href", Some("modulepreload")).resource_kind,
            Some(ResourceKind::Module)
        );
        assert_eq!(
            html_attribute_inventory("html", "script", "src", None, None, Some("module"))
                .unwrap()
                .resource_kind,
            Some(ResourceKind::Module)
        );
        assert_eq!(
            html_attribute_inventory("mathml", "annotation-xml", "src", None, None, None)
                .unwrap()
                .disposition,
            InventoryDisposition::Block
        );
        assert!(html_attribute_inventory("html", "meta", "content", None, None, None).is_none());
        assert_eq!(
            html_attribute_inventory("html", "meta", "content", None, Some("refresh"), None)
                .unwrap()
                .parsing,
            InventoryParsing::Refresh
        );
    }

    #[test]
    fn route_spec_round_trips_every_target_route_kind() {
        const ID: &str = "aBcDeFgHiJkLmNoPqRsTuVwXyZ_-0123";
        for kind in [
            RouteKind::Document,
            RouteKind::Navigation,
            RouteKind::Resource,
            RouteKind::Script,
            RouteKind::Module,
            RouteKind::Style,
            RouteKind::Worker,
            RouteKind::Worklet,
            RouteKind::Download,
            RouteKind::TargetWorker,
            RouteKind::Api,
            RouteKind::EventSource,
        ] {
            let path = build_route(&RouteRequest {
                version: ROUTE_SPEC_VERSION,
                kind,
                id: ID.into(),
            })
            .unwrap();
            let parsed = parse_route(&path).unwrap();
            assert_eq!(parsed.version, ROUTE_SPEC_VERSION);
            assert_eq!(parsed.id, ID);
            assert_eq!(
                parsed.family,
                if matches!(kind, RouteKind::Api | RouteKind::EventSource) {
                    RouteFamily::ApiPlan
                } else {
                    RouteFamily::Target
                }
            );
            assert_eq!(
                parsed.kind,
                if matches!(kind, RouteKind::Api | RouteKind::EventSource) {
                    None
                } else {
                    Some(kind)
                }
            );
        }
    }

    #[test]
    fn route_spec_rejects_wrong_version_and_noncanonical_paths() {
        let request = RouteRequest {
            version: ROUTE_SPEC_VERSION + 1,
            kind: RouteKind::Document,
            id: "aBcDeFgHiJkLmNoPqRsTuVwXyZ_-0123".into(),
        };
        assert_eq!(build_route(&request), Err(PolicyError::InvalidRoute));
        assert_eq!(
            parse_route("/_zp/p/document/aBcDeFgHiJkLmNoPqRsTuVwXyZ_-0123/"),
            Err(PolicyError::InvalidRoute)
        );
        assert_eq!(
            parse_route("/_zp/p/unknown/aBcDeFgHiJkLmNoPqRsTuVwXyZ_-0123"),
            Err(PolicyError::InvalidRoute)
        );
    }

    #[test]
    fn opaque_origin_ids_are_not_urls_or_arbitrary_strings() {
        let id = "a".repeat(32);
        assert_eq!(OpaqueOriginId::parse(id.clone()).unwrap().as_str(), id);
        assert_eq!(
            OpaqueOriginId::parse("https://target.example"),
            Err(PolicyError::InvalidRoute)
        );
        assert!(
            serde_json::from_str::<OpaqueOriginId>("\"A234567abcdefghijklmnopqrstuvwxyz\"")
                .is_err()
        );
    }

    #[test]
    fn worker_gateway_routes_require_closed_capability_grammar() {
        let id = "aBcDeFgHiJkLmNoPqRsTuVwXyZ_-0123";
        assert_eq!(
            worker_gateway_path(WorkerGatewayKind::Classic, id, "sealed_token"),
            Ok(format!("/_zp/wi/{id}/sealed_token"))
        );
        assert_eq!(
            worker_gateway_path(WorkerGatewayKind::Module, id, "bad/token"),
            Err(PolicyError::InvalidRoute)
        );
    }

    #[test]
    fn executable_routes_have_closed_distinct_grammars() {
        let id = "aBcDeFgHiJkLmNoPqRsTuVwXyZ_-0123";
        let digest = "a".repeat(64);
        assert_eq!(
            RouteBuilder::executable(ExecutableRouteKind::WorkerClassic, id, None),
            Ok(format!("/_zp/w/{id}.js"))
        );
        assert_eq!(
            RouteBuilder::executable(ExecutableRouteKind::WorkerModule, id, Some(&digest)),
            Ok(format!("/_zp/wm/{id}/{digest}.mjs"))
        );
        assert_eq!(
            RouteBuilder::executable(ExecutableRouteKind::DocumentModule, id, Some(&digest)),
            Ok(format!("/_zp/dm/{id}/{digest}.mjs"))
        );
        assert_eq!(
            RouteBuilder::executable(ExecutableRouteKind::WorkletModule, id, None),
            Ok(format!("/_zp/worklet/{id}.mjs"))
        );
        assert_eq!(
            RouteBuilder::executable(ExecutableRouteKind::TargetWorker, &digest, None),
            Ok(format!("/_zp/target-worker-exec/{digest}.mjs"))
        );
        assert_eq!(
            RouteBuilder::executable(ExecutableRouteKind::WorkerModule, id, None),
            Err(PolicyError::InvalidRoute)
        );
    }

    #[test]
    fn sealed_routes_have_fixed_kind_operation_and_token_order() {
        let operation = "a".repeat(48);
        assert_eq!(
            RouteBuilder::sealed(SealedRouteKind::Navigation, &operation, "sealed_token"),
            Ok(format!("/_zp/navigation/{operation}/sealed_token"))
        );
        assert_eq!(
            RouteBuilder::sealed(SealedRouteKind::Ping, &operation, "sealed_token"),
            Ok(format!("/_zp/ping/{operation}/sealed_token"))
        );
        assert_eq!(
            RouteBuilder::sealed(SealedRouteKind::Beacon, "A", "sealed_token"),
            Err(PolicyError::InvalidRoute)
        );
    }
    #[test]
    fn target_csp_enforces_resources_inline_eval_connect_and_mixed_content() {
        let mut context = test_context();
        context.target_csp = vec![
            "default-src 'none'; script-src 'self' https://cdn.example.test 'unsafe-eval'; \
             script-src-elem 'self' https://scripts.example.test; img-src data: https://images.example.test; \
             connect-src 'self' wss://socket.example.test; style-src 'nonce-style-token'; \
             upgrade-insecure-requests"
                .into(),
        ];
        context.target_csp_report_only = vec!["default-src 'none'".into()];

        let mut script = descriptor(ResourceKind::Script, "https://scripts.example.test/app.js");
        script.element_name = Some("script".into());
        assert!(matches!(
            decide(&context, &script).unwrap(),
            Decision::Script { .. }
        ));
        script.raw_value = "https://cdn.example.test/app.js".into();
        assert!(
            matches!(decide(&context, &script).unwrap(), Decision::Block { code, .. } if code == "TARGET_CSP_BLOCKED")
        );

        let image = descriptor(ResourceKind::Image, "data:image/png;base64,AA==");
        assert_eq!(decide(&context, &image).unwrap(), Decision::Pass);
        assert!(csp_allows_eval(&context));
        assert!(csp_allows_connect(
            &context,
            "wss://socket.example.test/live"
        ));
        assert!(!csp_allows_connect(
            &context,
            "https://other.example.test/live"
        ));
        assert!(csp_allows_inline(
            &context,
            "style-src-elem",
            "body{color:red}",
            Some("style-token"),
            false,
        ));

        let upgraded = descriptor(ResourceKind::Image, "http://images.example.test/pixel.png");
        assert!(
            matches!(decide(&context, &upgraded).unwrap(), Decision::Fetch { canonical_target, .. } if canonical_target == "https://images.example.test/pixel.png")
        );
    }

    #[test]
    fn target_csp_inline_hashes_and_report_only_policies_preserve_native_boundaries() {
        let mut context = test_context();
        let source = "globalThis.allowed = true";
        let hash = STANDARD.encode(Sha256::digest(source.as_bytes()));
        context.target_csp = vec![format!("script-src 'sha256-{hash}'")];
        context.target_csp_report_only = vec!["script-src 'none'".into()];
        assert!(csp_allows_inline(
            &context,
            "script-src-elem",
            source,
            None,
            false,
        ));
        assert!(!csp_allows_inline(
            &context,
            "script-src-elem",
            "globalThis.blocked = true",
            None,
            false,
        ));
        assert!(!csp_allows_eval(&context));
    }

    #[test]
    fn strict_dynamic_uses_nonce_hash_and_dynamic_trust_instead_of_host_sources() {
        let mut context = test_context();
        context.target_csp =
            vec!["script-src 'nonce-trusted' 'strict-dynamic' https://ignored.example.test".into()];
        let mut parser_script =
            descriptor(ResourceKind::Script, "https://ignored.example.test/app.js");
        parser_script.element_name = Some("script".into());
        parser_script.parser_inserted = true;
        assert!(matches!(
            decide(&context, &parser_script).unwrap(),
            Decision::Block { .. }
        ));
        parser_script.nonce = Some("trusted".into());
        assert!(matches!(
            decide(&context, &parser_script).unwrap(),
            Decision::Script { .. }
        ));
        parser_script.nonce = None;
        parser_script.parser_inserted = false;
        parser_script.raw_value = "https://dynamic.example.test/app.js".into();
        assert!(matches!(
            decide(&context, &parser_script).unwrap(),
            Decision::Script { .. }
        ));
    }

    #[test]
    fn document_policy_intersects_trusted_types_and_counts_redacted_reporting() {
        let mut context = test_context();
        context.target_csp = vec![
            "trusted-types alpha beta 'allow-duplicates'; require-trusted-types-for 'script'; report-to primary".into(),
            "trusted-types beta gamma 'allow-duplicates'; report-uri https://reports.example.test/a https://reports.example.test/b".into(),
        ];
        context.target_csp_report_only = vec!["default-src 'none'; report-to audit".into()];
        let policy = csp_document_policy(&context).unwrap();
        assert_eq!(
            policy.trusted_types,
            TrustedTypesPolicy {
                directive_present: true,
                allow_any: false,
                allowed_policy_names: vec!["beta".into()],
                allow_duplicates: true,
                require_for_script: true,
            }
        );
        assert_eq!(policy.enforced_report_endpoint_count, 3);
        assert_eq!(policy.report_only_endpoint_count, 1);
    }

    #[test]
    fn frame_ancestors_intersects_headers_against_every_target_ancestor() {
        let policies = vec![
            "default-src *; frame-ancestors 'self' https://parent.example.test".into(),
            "frame-ancestors https://parent.example.test".into(),
        ];
        assert!(csp_allows_frame_ancestors(
            &policies,
            "https://child.example.test/page",
            &["https://parent.example.test/frame".into()],
        ));
        assert!(!csp_allows_frame_ancestors(
            &policies,
            "https://child.example.test/page",
            &["https://other.example.test/frame".into()],
        ));
        assert!(csp_allows_frame_ancestors(
            &policies,
            "https://child.example.test/page",
            &[],
        ));
    }
}
