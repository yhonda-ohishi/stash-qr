//! OAuth 1.0a (HMAC-SHA1) の署名。I/O を持たない純粋関数だけ。
//!
//! ippoan/rust-flickr の `src/oauth1.rs` と同じ形 (hmac + sha1 は pure Rust なので
//! wasm でもそのまま動く)。検証は RFC 5849 の例として広く使われる Twitter の
//! 参照値 (ippoan/cf-flickr-cam-worker の `test/oauth1.test.ts` と同じ値)。

use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use hmac::{Hmac, Mac};
use sha1::Sha1;

/// RFC 5849 §3.6 のパーセントエンコード (英数字と `-._~` 以外はすべて %XX)。
pub fn percent_encode(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        if b.is_ascii_alphanumeric() || matches!(b, b'-' | b'.' | b'_' | b'~') {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

/// 署名を返す。`params` は oauth_* と API パラメータの全部 (写真のバイナリは含めない)。
pub fn sign(
    method: &str,
    url: &str,
    params: &[(String, String)],
    consumer_secret: &str,
    token_secret: &str,
) -> String {
    let mut encoded: Vec<(String, String)> = params
        .iter()
        .map(|(k, v)| (percent_encode(k), percent_encode(v)))
        .collect();
    encoded.sort();
    let param_string = encoded
        .iter()
        .map(|(k, v)| format!("{k}={v}"))
        .collect::<Vec<_>>()
        .join("&");
    let base = format!(
        "{}&{}&{}",
        method.to_ascii_uppercase(),
        percent_encode(url),
        percent_encode(&param_string)
    );
    let key = format!(
        "{}&{}",
        percent_encode(consumer_secret),
        percent_encode(token_secret)
    );
    let mut mac =
        Hmac::<Sha1>::new_from_slice(key.as_bytes()).expect("HMAC accepts any key length");
    mac.update(base.as_bytes());
    STANDARD.encode(mac.finalize().into_bytes())
}

/// oauth_* だけを `Authorization: OAuth ...` の値にする。
pub fn auth_header(params: &[(String, String)]) -> String {
    let mut oauth: Vec<_> = params
        .iter()
        .filter(|(k, _)| k.starts_with("oauth_"))
        .map(|(k, v)| format!("{}=\"{}\"", percent_encode(k), percent_encode(v)))
        .collect();
    oauth.sort();
    format!("OAuth {}", oauth.join(", "))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn p(pairs: &[(&str, &str)]) -> Vec<(String, String)> {
        pairs
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect()
    }

    #[test]
    fn matches_reference_signature() {
        let params = p(&[
            (
                "status",
                "Hello Ladies + Gentlemen, a signed OAuth request!",
            ),
            ("include_entities", "true"),
            ("oauth_consumer_key", "xvz1evFS4wEEPTGEFPHBog"),
            ("oauth_nonce", "kYjzVBB8Y0ZFabxSWbWovY3uYSQ2pTgmZeNu2VS4cg"),
            ("oauth_signature_method", "HMAC-SHA1"),
            ("oauth_timestamp", "1318622958"),
            (
                "oauth_token",
                "370773112-GmHxMAgYyLbNEtIKZeRNFsMKPR9EyMZeS9weJAEb",
            ),
            ("oauth_version", "1.0"),
        ]);
        let sig = sign(
            "post",
            "https://api.twitter.com/1.1/statuses/update.json",
            &params,
            "kAcSOqF21Fu85e7zjz7ZN2U4ZRhfV3WpwPAoE3Z7kBw",
            "LswwdoUaIvS8ltyTt5jkRh4J50vUPVVHtR2YPi5kE",
        );
        assert_eq!(sig, "hCtSmYh+iHYCEqBWrE7C7hYmtUk=");
    }

    #[test]
    fn percent_encode_follows_rfc5849() {
        assert_eq!(percent_encode("a b+c/~"), "a%20b%2Bc%2F~");
        assert_eq!(
            percent_encode("stashqr:kind=label"),
            "stashqr%3Akind%3Dlabel"
        );
        assert_eq!(percent_encode("棚"), "%E6%A3%9A");
    }

    #[test]
    fn auth_header_keeps_only_oauth_params() {
        let h = auth_header(&p(&[
            ("oauth_token", "t k"),
            ("title", "x"),
            ("oauth_nonce", "n"),
        ]));
        assert_eq!(h, r#"OAuth oauth_nonce="n", oauth_token="t%20k""#);
    }
}
