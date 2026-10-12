//! The wire order of a request's headers.
//!
//! The SW names the order Chrome would use (`X-ZP-Header-Order`, lowercase, comma-separated): Chrome orders a
//! navigation and a sub-request differently, client hints sit between the browser's own headers, and `cookie` precedes
//! `priority` on HTTP/2 (measured 2026-10-13). The kernel adds Referer / Origin / Accept-Encoding / Cookie after the SW
//! is done, then sorts with this.

/// Sort `headers` (stable) by their position in `sw_order`; a name the list does not carry goes last, keeping its
/// place among such. Without a list — a caller that sends none — a fixed navigation rank applies (2026-08-16: the
/// kernel's promotions only append, and the referer / accept-encoding they add used to trail `priority` on the wire).
pub fn order_request_headers(headers: &mut [(String, String)], sw_order: Option<&[String]>) {
    match sw_order {
        Some(order) => {
            let rank = |name: &str| {
                let n = name.to_ascii_lowercase();
                order.iter().position(|o| *o == n).unwrap_or(order.len())
            };
            headers.sort_by_key(|(k, _)| rank(k));
        }
        None => headers.sort_by_key(|(k, _)| navigation_rank(k)),
    }
}

/// Parse the SW's `X-ZP-Header-Order` value.
pub fn parse_header_order(value: &str) -> Vec<String> {
    value.split(',').map(|s| s.trim().to_ascii_lowercase()).filter(|s| !s.is_empty()).collect()
}

fn navigation_rank(name: &str) -> u16 {
    match name.to_ascii_lowercase().as_str() {
        "sec-ch-ua" => 0,
        "sec-ch-ua-mobile" => 1,
        "sec-ch-ua-platform" => 2,
        "upgrade-insecure-requests" => 3,
        "user-agent" => 4,
        "accept" => 5,
        "origin" => 6,
        "sec-fetch-site" => 7,
        "sec-fetch-mode" => 8,
        "sec-fetch-user" => 9,
        "sec-fetch-dest" => 10,
        "sec-fetch-storage-access" => 11,
        "referer" => 12,
        "accept-encoding" => 13,
        "accept-language" => 14,
        "priority" => 15,
        "cookie" => 900,
        _ => 800,
    }
}

#[cfg(test)]
mod tests {
    use super::{order_request_headers, parse_header_order};

    fn names(h: &[(String, String)]) -> Vec<String> {
        h.iter().map(|(k, _)| k.to_ascii_lowercase()).collect()
    }
    fn headers(list: &[&str]) -> Vec<(String, String)> {
        list.iter().map(|k| (k.to_string(), "v".to_string())).collect()
    }

    #[test]
    fn the_sws_order_places_the_promoted_headers_and_the_hints() {
        // a sub-request with Cloudflare's hints as the kernel holds it: Referer / Origin / Accept-Encoding / Cookie were
        // appended by its promotions, the content type and a page header sit in the renderer's map
        let mut h = headers(&[
            "sec-ch-ua-full-version-list", "sec-ch-ua-platform", "sec-ch-ua", "user-agent", "content-type", "cf-chl",
            "sec-ch-ua-platform-version", "accept", "sec-fetch-site", "sec-fetch-mode", "sec-fetch-dest", "accept-language",
            "priority", "Referer", "Origin", "Accept-Encoding", "Cookie",
        ]);
        let order = parse_header_order(
            "sec-ch-ua-full-version-list, sec-ch-ua-platform,sec-ch-ua,user-agent,content-type,cf-chl,sec-ch-ua-platform-version,\
             accept,origin,sec-fetch-site,sec-fetch-mode,sec-fetch-dest,sec-fetch-storage-access,referer,accept-encoding,\
             accept-language,cookie,priority,",
        );
        order_request_headers(&mut h, Some(&order));
        assert_eq!(names(&h), vec![
            "sec-ch-ua-full-version-list", "sec-ch-ua-platform", "sec-ch-ua", "user-agent", "content-type", "cf-chl",
            "sec-ch-ua-platform-version", "accept", "origin", "sec-fetch-site", "sec-fetch-mode", "sec-fetch-dest",
            "referer", "accept-encoding", "accept-language", "cookie", "priority",
        ]);
    }

    #[test]
    fn a_name_the_order_does_not_carry_goes_last_and_keeps_its_place_among_such() {
        let mut h = headers(&["x-b", "accept", "x-a", "user-agent"]);
        order_request_headers(&mut h, Some(&parse_header_order("user-agent,accept")));
        assert_eq!(names(&h), vec!["user-agent", "accept", "x-b", "x-a"]);
    }

    #[test]
    fn without_an_order_the_navigation_rank_applies_with_cookie_last() {
        let mut h = headers(&["Cookie", "accept-language", "x-other", "Referer", "accept", "sec-ch-ua"]);
        order_request_headers(&mut h, None);
        assert_eq!(names(&h), vec!["sec-ch-ua", "accept", "referer", "accept-language", "x-other", "cookie"]);
    }
}
