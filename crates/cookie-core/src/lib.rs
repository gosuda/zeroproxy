use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::time::{SystemTime, UNIX_EPOCH};
use thiserror::Error;
use url::Url;

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum SameSite {
    Strict,
    Lax,
    None,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct Cookie {
    pub name: String,
    pub value: String,
    pub domain: String,
    pub host_only: bool,
    pub path: String,
    pub secure: bool,
    pub http_only: bool,
    pub same_site: SameSite,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expires_at: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub partition_key: Option<String>,
    pub creation_seq: u64,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum Source {
    HttpResponse,
    Document,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct TargetContext {
    pub request_url: String,
    pub top_level_site: String,
    pub is_top_level_navigation: bool,
    pub method: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct CookieMutation {
    pub op_id: String,
    pub source_kind: Source,
    pub base_seq: u64,
    pub causal_after_seq: u64,
    pub canonical_target_context: TargetContext,
    pub raw_set_cookie_or_document_cookie: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub response_chain_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub header_index: Option<u32>,
}

#[derive(Clone, Debug, Eq, PartialEq, Ord, PartialOrd, Serialize, Deserialize)]
pub struct CookieKey {
    pub name: String,
    pub domain: String,
    pub path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub partition_key: Option<String>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "SCREAMING_SNAKE_CASE")]
pub enum CookieChange {
    Upsert { cookie: Cookie },
    Delete { key: CookieKey },
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct CookieDelta {
    pub from_seq: u64,
    pub cookie_seq: u64,
    pub changes: Vec<CookieChange>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct CookieSnapshot {
    pub cookie_seq: u64,
    pub cookies: Vec<Cookie>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum CookieRejection {
    InvalidCookie,
    StaleSequence,
    HttpOnlyDocument,
    DuplicatePayload,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct CookieCommit {
    pub op_id: String,
    pub cookie_seq: u64,
    pub accepted: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<CookieRejection>,
    pub delta: CookieDelta,
    pub visible_delta: Vec<CookieChange>,
    pub http_only_delta: Vec<CookieChange>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct JournalEntry {
    pub mutation: CookieMutation,
    pub commit: CookieCommit,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct CookieAuthorityState {
    pub version: u8,
    pub cookie_seq: u64,
    pub cookies: Vec<Cookie>,
    #[serde(default)]
    pub journal: BTreeMap<String, JournalEntry>,
}

impl Default for CookieAuthorityState {
    fn default() -> Self {
        Self {
            version: 1,
            cookie_seq: 0,
            cookies: Vec::new(),
            journal: BTreeMap::new(),
        }
    }
}

#[derive(Clone, Debug, Default, Eq, PartialEq, Serialize, Deserialize)]
pub struct CookieReplica {
    pub cookie_seq: u64,
    pub cookies: Vec<Cookie>,
}

#[derive(Debug, Error, Eq, PartialEq)]
pub enum CookieError {
    #[error("invalid URL")]
    InvalidUrl,
    #[error("invalid cookie")]
    Invalid,
    #[error("public suffix domain")]
    PublicSuffix,
    #[error("HttpOnly forbidden from document")]
    HttpOnlyDocument,
    #[error("secure cookie from insecure context")]
    Insecure,
    #[error("invalid sequence")]
    Sequence,
    #[error("duplicate operation with different payload")]
    DuplicatePayload,
    #[error("cookie sequence exhausted")]
    SequenceExhausted,
}

fn unix_seconds() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs().min(i64::MAX as u64) as i64)
        .unwrap_or(0)
}

fn checked_target_url(value: &str) -> Result<Url, CookieError> {
    let url = Url::parse(value).map_err(|_| CookieError::InvalidUrl)?;
    if !matches!(url.scheme(), "http" | "https") || url.host_str().is_none() {
        return Err(CookieError::InvalidUrl);
    }
    Ok(url)
}

fn default_path(path: &str) -> String {
    if !path.starts_with('/') || path == "/" {
        return "/".into();
    }
    match path.rfind('/') {
        Some(0) | None => "/".into(),
        Some(index) => path[..index].to_owned(),
    }
}

fn domain_match(host: &str, domain: &str) -> bool {
    host == domain
        || host
            .strip_suffix(domain)
            .is_some_and(|prefix| prefix.ends_with('.'))
}

fn cookie_key(cookie: &Cookie) -> CookieKey {
    CookieKey {
        name: cookie.name.clone(),
        domain: cookie.domain.clone(),
        path: cookie.path.clone(),
        partition_key: cookie.partition_key.clone(),
    }
}
fn valid_cookie_value(value: &str) -> bool {
    let value = value
        .strip_prefix('"')
        .and_then(|inner| inner.strip_suffix('"'))
        .unwrap_or(value);
    value.bytes().all(|byte| {
        matches!(
            byte,
            0x21 | 0x23..=0x2b | 0x2d..=0x3a | 0x3c..=0x5b | 0x5d..=0x7e
        )
    })
}

fn is_public_suffix(domain: &str) -> bool {
    psl::suffix(domain.as_bytes()).is_some_and(|suffix| suffix.as_bytes() == domain.as_bytes())
}

fn canonical_site(value: &str) -> Result<String, CookieError> {
    let url = checked_target_url(value)?;
    let host = url
        .host_str()
        .ok_or(CookieError::InvalidUrl)?
        .to_ascii_lowercase();
    let registrable = psl::domain(host.as_bytes())
        .map(|domain| String::from_utf8_lossy(domain.as_bytes()).into_owned())
        .unwrap_or(host);
    Ok(format!("{}://{}", url.scheme(), registrable))
}

fn parse_max_age(value: &str, now_unix_seconds: i64) -> Option<i64> {
    let value = value.trim();
    if value.is_empty()
        || !value
            .bytes()
            .enumerate()
            .all(|(index, byte)| byte.is_ascii_digit() || (index == 0 && byte == b'-'))
    {
        return None;
    }
    let seconds = value.parse::<i64>().unwrap_or_else(|_| {
        if value.starts_with('-') {
            i64::MIN
        } else {
            i64::MAX
        }
    });
    if seconds <= 0 {
        Some(now_unix_seconds)
    } else {
        Some(now_unix_seconds.saturating_add(seconds))
    }
}

fn month_number(token: &str) -> Option<u32> {
    match token.to_ascii_lowercase().as_str() {
        "jan" => Some(1),
        "feb" => Some(2),
        "mar" => Some(3),
        "apr" => Some(4),
        "may" => Some(5),
        "jun" => Some(6),
        "jul" => Some(7),
        "aug" => Some(8),
        "sep" => Some(9),
        "oct" => Some(10),
        "nov" => Some(11),
        "dec" => Some(12),
        _ => None,
    }
}

fn days_in_month(year: i64, month: u32) -> u32 {
    match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 if year % 4 == 0 && (year % 100 != 0 || year % 400 == 0) => 29,
        2 => 28,
        _ => 0,
    }
}

fn days_from_civil(year: i64, month: u32, day: u32) -> i64 {
    let year = year - i64::from(month <= 2);
    let era = if year >= 0 { year } else { year - 399 } / 400;
    let year_of_era = year - era * 400;
    let month_from_march = i64::from(month) + if month > 2 { -3 } else { 9 };
    let day_of_year = (153 * month_from_march + 2) / 5 + i64::from(day) - 1;
    let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
    era * 146_097 + day_of_era - 719_468
}

fn parse_http_date(value: &str) -> Option<i64> {
    let tokens: Vec<_> = value
        .split(|character: char| !(character.is_ascii_alphanumeric() || character == ':'))
        .filter(|token| !token.is_empty())
        .collect();
    let time = tokens.iter().find_map(|token| {
        let mut parts = token.split(':');
        let hour = parts.next()?.parse::<u32>().ok()?;
        let minute = parts.next()?.parse::<u32>().ok()?;
        let second = parts.next()?.parse::<u32>().ok()?;
        if parts.next().is_none() && hour <= 23 && minute <= 59 && second <= 59 {
            Some((hour, minute, second))
        } else {
            None
        }
    })?;
    let month = tokens.iter().find_map(|token| month_number(token))?;
    let day = tokens.iter().find_map(|token| {
        (token.len() <= 2)
            .then(|| token.parse::<u32>().ok())
            .flatten()
            .filter(|day| (1..=31).contains(day))
    })?;
    let mut year = tokens
        .iter()
        .find_map(|token| {
            (token.len() == 4)
                .then(|| token.parse::<i64>().ok())
                .flatten()
        })
        .or_else(|| {
            tokens.iter().find_map(|token| {
                (token.len() == 2)
                    .then(|| token.parse::<i64>().ok())
                    .flatten()
            })
        })?;
    if year <= 69 {
        year += 2000;
    } else if year <= 99 {
        year += 1900;
    }
    if year < 1601 || day > days_in_month(year, month) {
        return None;
    }
    let (hour, minute, second) = time;
    Some(
        days_from_civil(year, month, day)
            .saturating_mul(86_400)
            .saturating_add(i64::from(hour) * 3_600 + i64::from(minute) * 60 + i64::from(second)),
    )
}

pub fn parse_set_cookie_at(
    raw: &str,
    context: &TargetContext,
    source: Source,
    creation_seq: u64,
    now_unix_seconds: i64,
) -> Result<Cookie, CookieError> {
    let url = checked_target_url(&context.request_url)?;
    let host = url
        .host_str()
        .ok_or(CookieError::InvalidUrl)?
        .to_ascii_lowercase();
    let mut pieces = raw.split(';');
    let pair = pieces.next().ok_or(CookieError::Invalid)?.trim();
    let (name, value) = pair.split_once('=').ok_or(CookieError::Invalid)?;
    if name.is_empty()
        || name
            .bytes()
            .any(|byte| byte <= 0x20 || byte >= 0x7f || matches!(byte, b';' | b',' | b'='))
        || !valid_cookie_value(value)
    {
        return Err(CookieError::Invalid);
    }
    let mut cookie = Cookie {
        name: name.into(),
        value: value.into(),
        domain: host.clone(),
        host_only: true,
        path: default_path(url.path()),
        secure: false,
        http_only: false,
        same_site: SameSite::Lax,
        expires_at: None,
        partition_key: None,
        creation_seq,
    };
    let mut max_age = None;
    let mut expires = None;
    let mut partitioned = false;
    for attribute in pieces {
        let attribute = attribute.trim();
        let (name, value) = attribute
            .split_once('=')
            .map_or((attribute, ""), |(name, value)| (name.trim(), value.trim()));
        match name.to_ascii_lowercase().as_str() {
            "domain" => {
                let domain = value.trim_start_matches('.').to_ascii_lowercase();
                if domain.is_empty() || !domain_match(&host, &domain) {
                    return Err(CookieError::Invalid);
                }
                if is_public_suffix(&domain) {
                    return Err(CookieError::PublicSuffix);
                }
                cookie.domain = domain;
                cookie.host_only = false;
            }
            "path" if value.starts_with('/') => cookie.path = value.into(),
            "secure" => cookie.secure = true,
            "httponly" => cookie.http_only = true,
            "samesite" => {
                cookie.same_site = match value.to_ascii_lowercase().as_str() {
                    "strict" => SameSite::Strict,
                    "lax" | "" => SameSite::Lax,
                    "none" => SameSite::None,
                    _ => SameSite::Lax,
                }
            }
            "max-age" => max_age = parse_max_age(value, now_unix_seconds),
            "expires" => expires = parse_http_date(value),
            "partitioned" => partitioned = true,
            _ => {}
        }
    }
    cookie.expires_at = max_age.or(expires);
    if source == Source::Document && cookie.http_only {
        return Err(CookieError::HttpOnlyDocument);
    }
    if cookie.secure && url.scheme() != "https" {
        return Err(CookieError::Insecure);
    }
    if cookie.name.starts_with("__Host-Http-")
        && (source != Source::HttpResponse
            || !cookie.secure
            || !cookie.http_only
            || !cookie.host_only
            || cookie.path != "/")
    {
        return Err(CookieError::Invalid);
    }
    if cookie.name.starts_with("__Host-")
        && (!cookie.secure || !cookie.host_only || cookie.path != "/")
    {
        return Err(CookieError::Invalid);
    }
    if cookie.name.starts_with("__Secure-") && !cookie.secure {
        return Err(CookieError::Invalid);
    }
    if cookie.name.starts_with("__Http-")
        && (source != Source::HttpResponse || !cookie.secure || !cookie.http_only)
    {
        return Err(CookieError::Invalid);
    }
    if cookie.same_site == SameSite::None && !cookie.secure {
        return Err(CookieError::Invalid);
    }
    if partitioned {
        if !cookie.secure {
            return Err(CookieError::Invalid);
        }
        cookie.partition_key = Some(canonical_site(&context.top_level_site)?);
    }
    Ok(cookie)
}

pub fn parse_set_cookie(
    raw: &str,
    request_url: &str,
    source: Source,
    creation_seq: u64,
) -> Result<Cookie, CookieError> {
    parse_set_cookie_at(
        raw,
        &TargetContext {
            request_url: request_url.into(),
            top_level_site: request_url.into(),
            is_top_level_navigation: false,
            method: "GET".into(),
        },
        source,
        creation_seq,
        unix_seconds(),
    )
}

pub fn path_match(request: &str, cookie: &str) -> bool {
    request == cookie
        || request.starts_with(cookie) && cookie.ends_with('/')
        || request
            .strip_prefix(cookie)
            .is_some_and(|rest| rest.starts_with('/'))
}

fn cookie_matches_context(
    cookie: &Cookie,
    context: &TargetContext,
    include_http_only: bool,
    now: i64,
) -> Result<bool, CookieError> {
    let target = checked_target_url(&context.request_url)?;
    let host = target
        .host_str()
        .ok_or(CookieError::InvalidUrl)?
        .to_ascii_lowercase();
    if cookie
        .expires_at
        .is_some_and(|expires_at| expires_at <= now)
        || !domain_match(&host, &cookie.domain)
        || (cookie.host_only && host != cookie.domain)
        || !path_match(target.path(), &cookie.path)
        || (cookie.secure && target.scheme() != "https")
        || (!include_http_only && cookie.http_only)
    {
        return Ok(false);
    }
    if cookie.partition_key.as_ref().is_some_and(|key| {
        canonical_site(&context.top_level_site)
            .map(|site| site != *key)
            .unwrap_or(true)
    }) {
        return Ok(false);
    }
    let same_site =
        canonical_site(&context.request_url)? == canonical_site(&context.top_level_site)?;
    let safe_top_level_navigation = context.is_top_level_navigation
        && matches!(
            context.method.to_ascii_uppercase().as_str(),
            "GET" | "HEAD" | "OPTIONS" | "TRACE"
        );
    Ok(match cookie.same_site {
        SameSite::None => true,
        SameSite::Strict => same_site,
        SameSite::Lax => same_site || safe_top_level_navigation,
    })
}

pub fn select_cookies_at<'a>(
    cookies: impl IntoIterator<Item = &'a Cookie>,
    context: &TargetContext,
    include_http_only: bool,
    now_unix_seconds: i64,
) -> Result<Vec<&'a Cookie>, CookieError> {
    let mut selected = Vec::new();
    for cookie in cookies {
        if cookie_matches_context(cookie, context, include_http_only, now_unix_seconds)? {
            selected.push(cookie);
        }
    }
    selected.sort_by_key(|cookie| {
        (
            std::cmp::Reverse(cookie.path.len()),
            cookie.creation_seq,
            &cookie.name,
            &cookie.domain,
            &cookie.path,
        )
    });
    Ok(selected)
}

pub fn cookie_header_at<'a>(
    cookies: impl IntoIterator<Item = &'a Cookie>,
    context: &TargetContext,
    include_http_only: bool,
    now_unix_seconds: i64,
) -> Result<String, CookieError> {
    Ok(
        select_cookies_at(cookies, context, include_http_only, now_unix_seconds)?
            .into_iter()
            .map(|cookie| format!("{}={}", cookie.name, cookie.value))
            .collect::<Vec<_>>()
            .join("; "),
    )
}

pub fn cookie_header<'a>(
    cookies: impl IntoIterator<Item = &'a Cookie>,
    url: &str,
    include_http_only: bool,
) -> Result<String, CookieError> {
    cookie_header_at(
        cookies,
        &TargetContext {
            request_url: url.into(),
            top_level_site: url.into(),
            is_top_level_navigation: false,
            method: "GET".into(),
        },
        include_http_only,
        unix_seconds(),
    )
}

fn split_changes(
    changes: &[CookieChange],
    existing: Option<&Cookie>,
) -> (Vec<CookieChange>, Vec<CookieChange>) {
    let http_only = match changes.first() {
        Some(CookieChange::Upsert { cookie }) => cookie.http_only,
        Some(CookieChange::Delete { .. }) => existing.is_some_and(|cookie| cookie.http_only),
        None => false,
    };
    if http_only {
        (Vec::new(), changes.to_vec())
    } else {
        (changes.to_vec(), Vec::new())
    }
}

impl CookieAuthorityState {
    pub fn snapshot_at(&self, now_unix_seconds: i64) -> CookieSnapshot {
        CookieSnapshot {
            cookie_seq: self.cookie_seq,
            cookies: self
                .cookies
                .iter()
                .filter(|cookie| {
                    cookie
                        .expires_at
                        .is_none_or(|expires_at| expires_at > now_unix_seconds)
                })
                .cloned()
                .collect(),
        }
    }

    pub fn document_projection_at(
        &self,
        context: &TargetContext,
        now_unix_seconds: i64,
    ) -> Result<Vec<Cookie>, CookieError> {
        Ok(
            select_cookies_at(&self.cookies, context, false, now_unix_seconds)?
                .into_iter()
                .cloned()
                .collect(),
        )
    }

    pub fn cookie_header_at(
        &self,
        context: &TargetContext,
        now_unix_seconds: i64,
    ) -> Result<String, CookieError> {
        cookie_header_at(&self.cookies, context, true, now_unix_seconds)
    }

    pub fn commit(
        &mut self,
        mutation: CookieMutation,
        now_unix_seconds: i64,
    ) -> Result<CookieCommit, CookieError> {
        if mutation.op_id.is_empty()
            || mutation
                .op_id
                .bytes()
                .any(|byte| byte <= 0x20 || byte == 0x7f)
        {
            return Err(CookieError::Invalid);
        }
        if let Some(entry) = self.journal.get(&mutation.op_id) {
            return if entry.mutation == mutation {
                Ok(entry.commit.clone())
            } else {
                Err(CookieError::DuplicatePayload)
            };
        }
        let from_seq = self.cookie_seq;
        let cookie_seq = from_seq
            .checked_add(1)
            .ok_or(CookieError::SequenceExhausted)?;
        self.cookies.retain(|cookie| {
            cookie
                .expires_at
                .is_none_or(|expires_at| expires_at > now_unix_seconds)
        });
        let outcome = if mutation.base_seq > from_seq || mutation.causal_after_seq > from_seq {
            Err(CookieRejection::StaleSequence)
        } else {
            let parsed = parse_set_cookie_at(
                &mutation.raw_set_cookie_or_document_cookie,
                &mutation.canonical_target_context,
                mutation.source_kind.clone(),
                cookie_seq,
                now_unix_seconds,
            )
            .map_err(|error| match error {
                CookieError::HttpOnlyDocument => CookieRejection::HttpOnlyDocument,
                _ => CookieRejection::InvalidCookie,
            });
            parsed.and_then(|mut cookie| {
                let key = cookie_key(&cookie);
                let prior_index = self
                    .cookies
                    .iter()
                    .position(|existing| cookie_key(existing) == key);
                let prior = prior_index.map(|index| self.cookies[index].clone());
                if mutation.source_kind == Source::Document
                    && prior.as_ref().is_some_and(|existing| existing.http_only)
                {
                    return Err(CookieRejection::HttpOnlyDocument);
                }
                if let Some(existing) = prior.as_ref() {
                    cookie.creation_seq = existing.creation_seq;
                }
                let changes = if cookie
                    .expires_at
                    .is_some_and(|expires_at| expires_at <= now_unix_seconds)
                {
                    if let Some(index) = prior_index {
                        self.cookies.remove(index);
                        vec![CookieChange::Delete { key }]
                    } else {
                        Vec::new()
                    }
                } else {
                    if let Some(index) = prior_index {
                        self.cookies[index] = cookie.clone();
                    } else {
                        self.cookies.push(cookie.clone());
                    }
                    vec![CookieChange::Upsert { cookie }]
                };
                Ok((changes, prior))
            })
        };
        let (accepted, reason, changes, prior) = match outcome {
            Ok((changes, prior)) => (true, None, changes, prior),
            Err(reason) => (false, Some(reason), Vec::new(), None),
        };
        let delta = CookieDelta {
            from_seq,
            cookie_seq,
            changes,
        };
        let (visible_delta, http_only_delta) = split_changes(&delta.changes, prior.as_ref());
        let commit = CookieCommit {
            op_id: mutation.op_id.clone(),
            cookie_seq,
            accepted,
            reason,
            delta,
            visible_delta,
            http_only_delta,
        };
        self.cookie_seq = cookie_seq;
        self.journal.insert(
            mutation.op_id.clone(),
            JournalEntry {
                mutation,
                commit: commit.clone(),
            },
        );
        Ok(commit)
    }
}

impl CookieReplica {
    pub fn apply_snapshot(
        &mut self,
        snapshot: CookieSnapshot,
        now_unix_seconds: i64,
    ) -> Result<(), CookieError> {
        if snapshot.cookie_seq < self.cookie_seq {
            return Err(CookieError::Sequence);
        }
        let mut keys = BTreeMap::new();
        for cookie in &snapshot.cookies {
            if cookie
                .expires_at
                .is_some_and(|expires_at| expires_at <= now_unix_seconds)
                || keys.insert(cookie_key(cookie), ()).is_some()
            {
                return Err(CookieError::Invalid);
            }
        }
        self.cookie_seq = snapshot.cookie_seq;
        self.cookies = snapshot.cookies;
        Ok(())
    }

    pub fn apply_delta(&mut self, delta: CookieDelta) -> Result<(), CookieError> {
        if delta.from_seq != self.cookie_seq
            || delta.cookie_seq
                != self
                    .cookie_seq
                    .checked_add(1)
                    .ok_or(CookieError::SequenceExhausted)?
        {
            return Err(CookieError::Sequence);
        }
        for change in delta.changes {
            match change {
                CookieChange::Upsert { cookie } => {
                    let key = cookie_key(&cookie);
                    if let Some(index) = self
                        .cookies
                        .iter()
                        .position(|existing| cookie_key(existing) == key)
                    {
                        self.cookies[index] = cookie;
                    } else {
                        self.cookies.push(cookie);
                    }
                }
                CookieChange::Delete { key } => {
                    self.cookies.retain(|cookie| cookie_key(cookie) != key);
                }
            }
        }
        self.cookie_seq = delta.cookie_seq;
        Ok(())
    }
}

#[cfg(target_arch = "wasm32")]
fn wasm_error(error: impl ToString) -> wasm_bindgen::JsValue {
    wasm_bindgen::JsValue::from_str(&error.to_string())
}

#[cfg(target_arch = "wasm32")]
fn wasm_json<T: Serialize>(value: &T) -> Result<String, wasm_bindgen::JsValue> {
    serde_json::to_string(value).map_err(wasm_error)
}

#[cfg(target_arch = "wasm32")]
fn wasm_timestamp(value: f64) -> Result<i64, wasm_bindgen::JsValue> {
    if !value.is_finite() || value < 0.0 || value > i64::MAX as f64 {
        return Err(wasm_error("invalid cookie clock"));
    }
    Ok(value.trunc() as i64)
}

#[cfg(target_arch = "wasm32")]
#[derive(Serialize)]
struct MutationResult {
    state: CookieAuthorityState,
    commit: CookieCommit,
}

#[cfg(target_arch = "wasm32")]
#[wasm_bindgen::prelude::wasm_bindgen]
pub fn empty_cookie_state_json() -> Result<String, wasm_bindgen::JsValue> {
    wasm_json(&CookieAuthorityState::default())
}

#[cfg(target_arch = "wasm32")]
#[wasm_bindgen::prelude::wasm_bindgen]
pub fn apply_cookie_mutation_json(
    state_json: &str,
    mutation_json: &str,
    now_unix_seconds: f64,
) -> Result<String, wasm_bindgen::JsValue> {
    let mut state: CookieAuthorityState = serde_json::from_str(state_json).map_err(wasm_error)?;
    let mutation: CookieMutation = serde_json::from_str(mutation_json).map_err(wasm_error)?;
    if state.version != 1 {
        return Err(wasm_error("unsupported cookie state version"));
    }
    let commit = state
        .commit(mutation, wasm_timestamp(now_unix_seconds)?)
        .map_err(wasm_error)?;
    wasm_json(&MutationResult { state, commit })
}

#[cfg(target_arch = "wasm32")]
#[wasm_bindgen::prelude::wasm_bindgen]
pub fn snapshot_cookie_state_json(
    state_json: &str,
    now_unix_seconds: f64,
) -> Result<String, wasm_bindgen::JsValue> {
    let state: CookieAuthorityState = serde_json::from_str(state_json).map_err(wasm_error)?;
    if state.version != 1 {
        return Err(wasm_error("unsupported cookie state version"));
    }
    wasm_json(&state.snapshot_at(wasm_timestamp(now_unix_seconds)?))
}

#[cfg(target_arch = "wasm32")]
#[wasm_bindgen::prelude::wasm_bindgen]
pub fn document_cookie_projection_json(
    state_json: &str,
    context_json: &str,
    now_unix_seconds: f64,
) -> Result<String, wasm_bindgen::JsValue> {
    let state: CookieAuthorityState = serde_json::from_str(state_json).map_err(wasm_error)?;
    let context: TargetContext = serde_json::from_str(context_json).map_err(wasm_error)?;
    if state.version != 1 {
        return Err(wasm_error("unsupported cookie state version"));
    }
    state
        .document_projection_at(&context, wasm_timestamp(now_unix_seconds)?)
        .and_then(|projection| serde_json::to_string(&projection).map_err(|_| CookieError::Invalid))
        .map_err(wasm_error)
}

#[cfg(target_arch = "wasm32")]
#[wasm_bindgen::prelude::wasm_bindgen]
pub fn cookie_header_for_context_json(
    state_json: &str,
    context_json: &str,
    now_unix_seconds: f64,
) -> Result<String, wasm_bindgen::JsValue> {
    let state: CookieAuthorityState = serde_json::from_str(state_json).map_err(wasm_error)?;
    let context: TargetContext = serde_json::from_str(context_json).map_err(wasm_error)?;
    if state.version != 1 {
        return Err(wasm_error("unsupported cookie state version"));
    }
    state
        .cookie_header_at(&context, wasm_timestamp(now_unix_seconds)?)
        .map_err(wasm_error)
}

#[cfg(target_arch = "wasm32")]
#[wasm_bindgen::prelude::wasm_bindgen]
pub fn apply_cookie_snapshot_json(
    replica_json: &str,
    snapshot_json: &str,
    now_unix_seconds: f64,
) -> Result<String, wasm_bindgen::JsValue> {
    let mut replica: CookieReplica = serde_json::from_str(replica_json).map_err(wasm_error)?;
    let snapshot: CookieSnapshot = serde_json::from_str(snapshot_json).map_err(wasm_error)?;
    replica
        .apply_snapshot(snapshot, wasm_timestamp(now_unix_seconds)?)
        .map_err(wasm_error)?;
    wasm_json(&replica)
}

#[cfg(target_arch = "wasm32")]
#[wasm_bindgen::prelude::wasm_bindgen]
pub fn apply_cookie_delta_json(
    replica_json: &str,
    delta_json: &str,
) -> Result<String, wasm_bindgen::JsValue> {
    let mut replica: CookieReplica = serde_json::from_str(replica_json).map_err(wasm_error)?;
    let delta: CookieDelta = serde_json::from_str(delta_json).map_err(wasm_error)?;
    replica.apply_delta(delta).map_err(wasm_error)?;
    wasm_json(&replica)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn context(url: &str) -> TargetContext {
        TargetContext {
            request_url: url.into(),
            top_level_site: "https://example.com/".into(),
            is_top_level_navigation: false,
            method: "GET".into(),
        }
    }

    fn mutation(id: &str, raw: &str, source_kind: Source, base_seq: u64) -> CookieMutation {
        CookieMutation {
            op_id: id.into(),
            source_kind,
            base_seq,
            causal_after_seq: base_seq,
            canonical_target_context: context("https://example.com/account/index"),
            raw_set_cookie_or_document_cookie: raw.into(),
            response_chain_id: None,
            header_index: None,
        }
    }

    #[test]
    fn rejects_public_suffix_and_document_httponly() {
        assert_eq!(
            parse_set_cookie_at(
                "a=b; Domain=com",
                &context("https://example.com/"),
                Source::HttpResponse,
                1,
                1,
            ),
            Err(CookieError::PublicSuffix)
        );
        assert_eq!(
            parse_set_cookie_at(
                "a=b; HttpOnly",
                &context("https://example.com/"),
                Source::Document,
                1,
                1,
            ),
            Err(CookieError::HttpOnlyDocument)
        );
    }

    #[test]
    fn rejects_invalid_cookie_octets() {
        assert_eq!(
            parse_set_cookie_at(
                "a=contains space",
                &context("https://example.com/"),
                Source::HttpResponse,
                1,
                1,
            ),
            Err(CookieError::Invalid)
        );
        assert_eq!(
            parse_set_cookie_at(
                "a=contains,comma",
                &context("https://example.com/"),
                Source::HttpResponse,
                1,
                1,
            ),
            Err(CookieError::Invalid)
        );
    }

    #[test]
    fn enforces_prefix_secure_and_partition_rules() {
        assert_eq!(
            parse_set_cookie_at(
                "__Host-a=1; Secure; Path=/; Domain=example.com",
                &context("https://example.com/"),
                Source::HttpResponse,
                1,
                1,
            ),
            Err(CookieError::Invalid)
        );
        assert_eq!(
            parse_set_cookie_at(
                "__Http-a=1; Secure; HttpOnly",
                &context("https://example.com/"),
                Source::Document,
                1,
                1,
            ),
            Err(CookieError::HttpOnlyDocument)
        );
        assert_eq!(
            parse_set_cookie_at(
                "__Host-Http-a=1; Secure; Path=/",
                &context("https://example.com/"),
                Source::HttpResponse,
                1,
                1,
            ),
            Err(CookieError::Invalid)
        );
        assert!(
            parse_set_cookie_at(
                "__Host-Http-a=1; Secure; HttpOnly; Path=/",
                &context("https://example.com/"),
                Source::HttpResponse,
                1,
                1,
            )
            .is_ok()
        );
        let partitioned = parse_set_cookie_at(
            "p=1; Secure; Partitioned",
            &context("https://example.com/"),
            Source::HttpResponse,
            1,
            1,
        )
        .unwrap();
        assert_eq!(
            partitioned.partition_key.as_deref(),
            Some("https://example.com")
        );
    }

    #[test]
    fn expires_and_max_age_delete_matching_cookie() {
        let mut state = CookieAuthorityState::default();
        assert!(
            state
                .commit(mutation("set", "a=1; Path=/", Source::HttpResponse, 0), 100)
                .unwrap()
                .accepted
        );
        let removal = state
            .commit(
                mutation(
                    "delete",
                    "a=ignored; Path=/; Max-Age=0",
                    Source::HttpResponse,
                    1,
                ),
                100,
            )
            .unwrap();
        assert!(removal.accepted);
        assert!(state.cookies.is_empty());
        assert_eq!(removal.delta.changes.len(), 1);
        let expiration = state
            .commit(
                mutation(
                    "expires",
                    "b=1; Expires=Wed, 21 Oct 2015 07:28:00 GMT",
                    Source::HttpResponse,
                    2,
                ),
                1_500_000_000,
            )
            .unwrap();
        assert!(expiration.accepted);
        assert!(state.cookies.is_empty());
    }

    #[test]
    fn orders_paths_and_excludes_http_only_from_document_projection() {
        let mut state = CookieAuthorityState::default();
        state
            .commit(mutation("root", "a=1; Path=/", Source::HttpResponse, 0), 1)
            .unwrap();
        state
            .commit(
                mutation("deep", "b=2; Path=/account", Source::HttpResponse, 1),
                1,
            )
            .unwrap();
        state
            .commit(
                mutation("secret", "s=3; Path=/; HttpOnly", Source::HttpResponse, 2),
                1,
            )
            .unwrap();
        let request = context("https://example.com/account/settings");
        assert_eq!(
            state.cookie_header_at(&request, 1).unwrap(),
            "b=2; a=1; s=3"
        );
        assert_eq!(
            state
                .document_projection_at(&request, 1)
                .unwrap()
                .into_iter()
                .map(|cookie| cookie.name)
                .collect::<Vec<_>>(),
            ["b", "a"]
        );
    }

    #[test]
    fn header_ties_have_a_stable_key_order() {
        let second = parse_set_cookie_at(
            "b=1; Path=/",
            &context("https://example.com/"),
            Source::HttpResponse,
            7,
            1,
        )
        .unwrap();
        let first = parse_set_cookie_at(
            "a=2; Path=/",
            &context("https://example.com/"),
            Source::HttpResponse,
            7,
            1,
        )
        .unwrap();
        assert_eq!(
            cookie_header_at([&second, &first], &context("https://example.com/"), true, 1).unwrap(),
            "a=2; b=1"
        );
    }

    #[test]
    fn same_site_and_secure_selection_are_context_bound() {
        let mut state = CookieAuthorityState::default();
        state
            .commit(
                mutation(
                    "strict",
                    "a=1; SameSite=Strict; Secure",
                    Source::HttpResponse,
                    0,
                ),
                1,
            )
            .unwrap();
        let mut cross_site = context("https://example.com/");
        cross_site.top_level_site = "https://other.test/".into();
        assert_eq!(state.cookie_header_at(&cross_site, 1).unwrap(), "");
        cross_site.is_top_level_navigation = true;
        assert_eq!(state.cookie_header_at(&cross_site, 1).unwrap(), "");
        let mut lax = mutation("lax", "b=2; SameSite=Lax; Secure", Source::HttpResponse, 1);
        lax.canonical_target_context = context("https://example.com/");
        state.commit(lax, 1).unwrap();
        assert_eq!(state.cookie_header_at(&cross_site, 1).unwrap(), "b=2");
    }

    #[test]
    fn document_cannot_overwrite_or_delete_http_only_cookie() {
        let mut state = CookieAuthorityState::default();
        state
            .commit(
                mutation(
                    "http",
                    "a=secret; Path=/; HttpOnly",
                    Source::HttpResponse,
                    0,
                ),
                1,
            )
            .unwrap();
        let rejected = state
            .commit(
                mutation("document", "a=visible; Path=/", Source::Document, 1),
                1,
            )
            .unwrap();
        assert!(!rejected.accepted);
        assert_eq!(rejected.reason, Some(CookieRejection::HttpOnlyDocument));
        assert_eq!(
            state
                .cookie_header_at(&context("https://example.com/"), 1)
                .unwrap(),
            "a=secret"
        );
    }

    #[test]
    fn duplicate_replay_is_idempotent_and_conflicts_fail_closed() {
        let mut state = CookieAuthorityState::default();
        let first = state
            .commit(mutation("one", "a=1", Source::HttpResponse, 0), 1)
            .unwrap();
        let replay = state
            .commit(mutation("one", "a=1", Source::HttpResponse, 0), 2)
            .unwrap();
        assert_eq!(first, replay);
        assert_eq!(state.cookie_seq, 1);
        assert_eq!(
            state.commit(mutation("one", "a=2", Source::HttpResponse, 0), 2),
            Err(CookieError::DuplicatePayload)
        );
    }

    #[test]
    fn stale_causal_sequence_is_journaled_and_rejected() {
        let mut state = CookieAuthorityState::default();
        let rejected = state
            .commit(mutation("stale", "a=1", Source::HttpResponse, 1), 1)
            .unwrap();
        assert!(!rejected.accepted);
        assert_eq!(rejected.reason, Some(CookieRejection::StaleSequence));
        assert_eq!(rejected.cookie_seq, 1);
        assert!(state.cookies.is_empty());
    }

    #[test]
    fn snapshots_and_deltas_require_contiguous_sequences() {
        let mut state = CookieAuthorityState::default();
        let first = state
            .commit(mutation("one", "a=1", Source::HttpResponse, 0), 1)
            .unwrap();
        let snapshot = state.snapshot_at(1);
        let mut replica = CookieReplica::default();
        replica.apply_snapshot(snapshot, 1).unwrap();
        let second = state
            .commit(mutation("two", "b=2", Source::HttpResponse, 1), 1)
            .unwrap();
        replica.apply_delta(second.delta.clone()).unwrap();
        assert_eq!(replica.cookie_seq, 2);
        assert_eq!(replica.cookies.len(), 2);
        assert_eq!(replica.apply_delta(first.delta), Err(CookieError::Sequence));
    }

    #[test]
    fn domain_cookies_share_across_subdomains() {
        let mut state = CookieAuthorityState::default();
        let mut set = mutation(
            "domain",
            "shared=1; Domain=example.com; Path=/",
            Source::HttpResponse,
            0,
        );
        set.canonical_target_context = context("https://a.example.com/");
        state.commit(set, 1).unwrap();
        assert_eq!(
            state
                .cookie_header_at(&context("https://b.example.com/"), 1)
                .unwrap(),
            "shared=1"
        );
    }

    #[test]
    fn partition_key_is_part_of_cookie_identity() {
        let mut state = CookieAuthorityState::default();
        let mut first = mutation(
            "partition-a",
            "p=one; Secure; SameSite=None; Partitioned; Path=/",
            Source::HttpResponse,
            0,
        );
        first.canonical_target_context = context("https://cdn.example.com/");
        first.canonical_target_context.top_level_site = "https://site-a.test/".into();
        state.commit(first, 1).unwrap();

        let mut second = mutation(
            "partition-b",
            "p=two; Secure; SameSite=None; Partitioned; Path=/",
            Source::HttpResponse,
            1,
        );
        second.canonical_target_context = context("https://cdn.example.com/");
        second.canonical_target_context.top_level_site = "https://site-b.test/".into();
        state.commit(second, 1).unwrap();

        assert_eq!(state.cookies.len(), 2);
        let mut site_a = context("https://cdn.example.com/");
        site_a.top_level_site = "https://site-a.test/".into();
        let mut site_b = context("https://cdn.example.com/");
        site_b.top_level_site = "https://site-b.test/".into();
        assert_eq!(state.cookie_header_at(&site_a, 1).unwrap(), "p=one");
        assert_eq!(state.cookie_header_at(&site_b, 1).unwrap(), "p=two");
    }

    #[test]
    fn expiry_and_interleaving_use_commit_arrival_order() {
        let mut state = CookieAuthorityState::default();
        state
            .commit(
                mutation(
                    "short-http-only",
                    "race=secret; Path=/; HttpOnly; Max-Age=1",
                    Source::HttpResponse,
                    0,
                ),
                100,
            )
            .unwrap();
        let visible = state
            .commit(
                mutation(
                    "document-after-expiry",
                    "race=visible; Path=/",
                    Source::Document,
                    0,
                ),
                101,
            )
            .unwrap();
        assert!(visible.accepted);
        assert_eq!(
            state
                .cookie_header_at(&context("https://example.com/"), 101)
                .unwrap(),
            "race=visible"
        );

        let delayed_delete = state
            .commit(
                mutation(
                    "delayed-http-delete",
                    "race=gone; Path=/; Max-Age=0",
                    Source::HttpResponse,
                    1,
                ),
                101,
            )
            .unwrap();
        assert!(delayed_delete.accepted);
        assert!(state.cookies.is_empty());
    }

    #[test]
    fn malformed_request_context_fails_closed() {
        let cookie = parse_set_cookie_at(
            "a=1",
            &context("https://example.com/"),
            Source::HttpResponse,
            1,
            1,
        )
        .unwrap();
        let invalid = TargetContext {
            request_url: "not a URL".into(),
            top_level_site: "https://example.com/".into(),
            is_top_level_navigation: false,
            method: "GET".into(),
        };
        assert_eq!(
            cookie_header_at([&cookie], &invalid, true, 1),
            Err(CookieError::InvalidUrl)
        );
    }
}
