use super::*;

pub(super) fn blocked_ipv4(ip: Ipv4Addr) -> bool {
    let [a, b, c, _] = ip.octets();
    ip.is_private()
        || ip.is_loopback()
        || ip.is_link_local()
        || ip.is_unspecified()
        || ip.is_multicast()
        || a == 0
        || a >= 240
        || (a == 100 && (64..=127).contains(&b))
        || (a == 198 && (18..=19).contains(&b))
        || (a == 192 && b == 0 && (c == 0 || c == 2))
        || (a == 198 && b == 51 && c == 100)
        || (a == 203 && b == 0 && c == 113)
}

pub(super) fn blocked_ipv6(ip: Ipv6Addr) -> bool {
    let first = ip.segments()[0];
    let unique_local = (first & 0xfe00) == 0xfc00;
    let link_local = (first & 0xffc0) == 0xfe80;
    let site_local = (first & 0xffc0) == 0xfec0;
    ip.is_loopback()
        || ip.is_unspecified()
        || ip.is_multicast()
        || unique_local
        || link_local
        || site_local
        || ip.to_ipv4().is_some_and(blocked_ipv4)
}

pub(super) fn blocked_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => blocked_ipv4(v4),
        IpAddr::V6(v6) => blocked_ipv6(v6),
    }
}

pub(super) fn validate_plugin_http_url(raw_url: &str) -> Result<Url, String> {
    let trimmed = raw_url.trim();
    if trimmed.is_empty() {
        return Err("URL is required".to_string());
    }

    let url = Url::parse(trimmed).map_err(|_| "Invalid URL".to_string())?;
    if url.scheme() != "https" {
        return Err("Only https:// URLs are allowed".to_string());
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err("URL credentials are not allowed".to_string());
    }

    let Some(host) = url.host() else {
        return Err("URL host is required".to_string());
    };
    match host {
        url::Host::Domain(domain) => {
            let lower = domain.trim_end_matches('.').to_ascii_lowercase();
            if lower == "localhost" || lower.ends_with(".localhost") {
                return Err("Localhost URLs are not allowed".to_string());
            }
        }
        url::Host::Ipv4(ip) => {
            if blocked_ip(IpAddr::V4(ip)) {
                return Err("Local/private IP URLs are not allowed".to_string());
            }
        }
        url::Host::Ipv6(ip) => {
            if blocked_ip(IpAddr::V6(ip)) {
                return Err("Local/private IP URLs are not allowed".to_string());
            }
        }
    }

    Ok(url)
}

pub(super) fn plugin_http_timeout(timeout_ms: Option<u64>) -> Result<u64, String> {
    let timeout = timeout_ms.unwrap_or(PLUGIN_HTTP_DEFAULT_TIMEOUT_MS);
    if timeout == 0 {
        return Ok(PLUGIN_HTTP_DEFAULT_TIMEOUT_MS);
    }
    if timeout > PLUGIN_HTTP_MAX_TIMEOUT_MS {
        return Err(format!(
            "Timeout exceeds maximum of {}ms",
            PLUGIN_HTTP_MAX_TIMEOUT_MS
        ));
    }
    Ok(timeout)
}

pub(super) fn read_plugin_http_response(
    response: ureq::Response,
) -> Result<PluginHttpResponse, String> {
    use std::io::Read;

    let status = response.status();
    let mut reader = response
        .into_reader()
        .take((PLUGIN_HTTP_MAX_RESPONSE_BYTES + 1) as u64);
    let mut bytes = Vec::new();
    reader.read_to_end(&mut bytes).map_err(|e| e.to_string())?;
    if bytes.len() > PLUGIN_HTTP_MAX_RESPONSE_BYTES {
        return Err("HTTP response is too large".to_string());
    }

    let body_text = String::from_utf8_lossy(&bytes).to_string();
    let json = serde_json::from_str::<serde_json::Value>(&body_text).ok();
    Ok(PluginHttpResponse {
        status,
        ok: (200..300).contains(&status),
        body_text,
        json,
    })
}

pub(super) fn plugin_http_post_json_blocking(
    url: String,
    body: serde_json::Value,
    timeout_ms: Option<u64>,
) -> Result<PluginHttpResponse, String> {
    #[cfg(feature = "perf-audit")]
    if crate::perf_audit::network_is_offline() {
        return Err("Network disabled by the local performance audit".to_string());
    }
    let url = validate_plugin_http_url(&url)?;
    let timeout = plugin_http_timeout(timeout_ms)?;
    let body_text = serde_json::to_string(&body).map_err(|e| e.to_string())?;
    if body_text.len() > PLUGIN_HTTP_MAX_REQUEST_BYTES {
        return Err("HTTP request body is too large".to_string());
    }

    let agent = ureq::AgentBuilder::new()
        .timeout(Duration::from_millis(timeout))
        .redirects(0)
        .resolver(|host: &str| {
            let addresses: Vec<_> = host.to_socket_addrs()?.collect();
            if addresses.is_empty() || addresses.iter().any(|addr| blocked_ip(addr.ip())) {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::PermissionDenied,
                    "Local/private IP URLs are not allowed",
                ));
            }
            Ok(addresses)
        })
        .build();
    let request = agent
        .post(url.as_str())
        .set("Content-Type", "application/json")
        .set("Accept", "application/json, text/plain, */*");

    match request.send_string(&body_text) {
        Ok(response) => read_plugin_http_response(response),
        Err(ureq::Error::Status(_, response)) => read_plugin_http_response(response),
        Err(error) => Err(error.to_string()),
    }
}
