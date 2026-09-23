//! Cloudflare Access の JWT (`Cf-Access-Jwt-Assertion`) を検証する。
//!
//! Worker は Access の後ろに置くが、**ヘッダを信用しない**。Access の設定漏れや
//! workers.dev 等の別経路からの素通りを止める二段目の壁として、team の JWKS で
//! RS256 署名・`iss`・`aud`・`exp`/`nbf` を毎回検証する。
//! 形は ippoan/ref-files-worker の `lib/cf-access-jwt.ts` と同じ (WebCrypto で検証)。
//!
//! - JWKS  … `<ACCESS_ISSUER>/cdn-cgi/access/certs`
//! - iss   … `ACCESS_ISSUER` (`https://<team>.cloudflareaccess.com`)
//! - aud   … `ACCESS_AUD` (Access アプリの AUD タグ。JWT 側は配列で入る)
//! - 持ち主 … 利用者は `email`、サービストークン (Android) は `common_name`
//!
//! 署名検証 (WebCrypto) と JWKS 取得だけが I/O。トークンの分解と claim の検査は
//! 純粋関数にしてあり、`cargo test` でそのまま試せる。

use std::cell::RefCell;

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use serde::Deserialize;
use serde_json::Value;
use worker::wasm_bindgen::{JsCast, JsValue};
use worker::*;

/// 時計のずれとして許す秒数。
const SKEW_SECS: f64 = 30.0;
/// JWKS を使い回す時間。Access の鍵は定期的に入れ替わる。
const JWKS_TTL_MS: f64 = 10.0 * 60.0 * 1000.0;
/// 知らない kid が来たときに取り直してよい最短間隔 (連打で certs を叩かせない)。
const JWKS_REFETCH_MIN_MS: f64 = 30.0 * 1000.0;

pub struct Config {
    issuer: String,
    aud: String,
}

impl Config {
    /// `ACCESS_ISSUER` / `ACCESS_AUD` を読む。どちらかが空なら `None` (= 全リクエスト拒否)。
    pub fn from_env(env: &Env) -> Option<Self> {
        let get = |k: &str| env.var(k).ok().map(|v| v.to_string()).unwrap_or_default();
        Self::new(&get("ACCESS_ISSUER"), &get("ACCESS_AUD"))
    }

    fn new(issuer: &str, aud: &str) -> Option<Self> {
        let issuer = issuer.trim().trim_end_matches('/');
        let aud = aud.trim();
        if aud.is_empty() || !valid_issuer(issuer) {
            return None;
        }
        Some(Self {
            issuer: issuer.to_string(),
            aud: aud.to_string(),
        })
    }

    fn certs_url(&self) -> String {
        format!("{}/cdn-cgi/access/certs", self.issuer)
    }
}

/// issuer は https のみ。ループバックだけは結合テストの偽 JWKS のために http を許す。
fn valid_issuer(issuer: &str) -> bool {
    let Some(rest) = issuer
        .strip_prefix("https://")
        .or_else(|| issuer.strip_prefix("http://").filter(|r| is_loopback(r)))
    else {
        return false;
    };
    !rest.is_empty() && !rest.contains('/')
}

fn is_loopback(host_port: &str) -> bool {
    let host = host_port.rsplit_once(':').map_or(host_port, |(h, _)| h);
    host == "127.0.0.1" || host == "localhost"
}

#[derive(Debug, PartialEq)]
pub enum AuthError {
    Missing,
    Malformed,
    Alg,
    Issuer,
    Audience,
    Expired,
    NotYetValid,
    NoIdentity,
    UnknownKey,
    Signature,
}

#[derive(Deserialize)]
struct Header {
    alg: String,
    kid: Option<String>,
}

#[derive(Deserialize, Default)]
struct Claims {
    iss: Option<String>,
    aud: Option<Value>,
    exp: Option<f64>,
    nbf: Option<f64>,
    email: Option<String>,
    common_name: Option<String>,
}

struct Parsed {
    header: Header,
    claims: Claims,
    signing_input: String,
    signature: Vec<u8>,
}

fn b64(s: &str) -> Result<Vec<u8>, AuthError> {
    URL_SAFE_NO_PAD.decode(s).map_err(|_| AuthError::Malformed)
}

fn parse_token(token: &str) -> Result<Parsed, AuthError> {
    let mut parts = token.split('.');
    let (Some(h), Some(p), Some(s), None) =
        (parts.next(), parts.next(), parts.next(), parts.next())
    else {
        return Err(AuthError::Malformed);
    };
    let header: Header = serde_json::from_slice(&b64(h)?).map_err(|_| AuthError::Malformed)?;
    let claims: Claims = serde_json::from_slice(&b64(p)?).map_err(|_| AuthError::Malformed)?;
    Ok(Parsed {
        header,
        claims,
        signing_input: format!("{h}.{p}"),
        signature: b64(s)?,
    })
}

/// claim を検査し、movements.actor に残す持ち主を返す。
fn check_claims(c: &Claims, cfg: &Config, now_secs: f64) -> Result<String, AuthError> {
    if c.iss.as_deref().map(|s| s.trim_end_matches('/')) != Some(cfg.issuer.as_str()) {
        return Err(AuthError::Issuer);
    }
    let aud_ok = match &c.aud {
        Some(Value::String(a)) => *a == cfg.aud,
        Some(Value::Array(v)) => v.iter().any(|a| a.as_str() == Some(cfg.aud.as_str())),
        _ => false,
    };
    if !aud_ok {
        return Err(AuthError::Audience);
    }
    match c.exp {
        Some(exp) if exp + SKEW_SECS > now_secs => {}
        _ => return Err(AuthError::Expired),
    }
    if c.nbf.is_some_and(|nbf| nbf - SKEW_SECS > now_secs) {
        return Err(AuthError::NotYetValid);
    }
    [&c.email, &c.common_name]
        .into_iter()
        .flatten()
        .find(|s| !s.is_empty())
        .cloned()
        .ok_or(AuthError::NoIdentity)
}

/// リクエストを検証して持ち主を返す。外側の `Err` は JWKS 取得などの I/O の失敗 (502)。
pub async fn authenticate(
    req: &Request,
    cfg: &Config,
) -> Result<std::result::Result<String, AuthError>> {
    let Some(token) = req.headers().get("Cf-Access-Jwt-Assertion")? else {
        return Ok(Err(AuthError::Missing));
    };
    let parsed = match parse_token(&token) {
        Ok(p) => p,
        Err(e) => return Ok(Err(e)),
    };
    if parsed.header.alg != "RS256" {
        return Ok(Err(AuthError::Alg));
    }
    let actor = match check_claims(&parsed.claims, cfg, Date::now().as_millis() as f64 / 1000.0) {
        Ok(a) => a,
        Err(e) => return Ok(Err(e)),
    };
    let Some(kid) = parsed.header.kid.as_deref() else {
        return Ok(Err(AuthError::UnknownKey));
    };
    let Some(jwk) = find_key(cfg, kid).await? else {
        return Ok(Err(AuthError::UnknownKey));
    };
    if verify_rs256(&jwk, &parsed.signing_input, &parsed.signature).await? {
        Ok(Ok(actor))
    } else {
        Ok(Err(AuthError::Signature))
    }
}

// ---------------------------------------------------------------------------
// JWKS (isolate 内でキャッシュ)
// ---------------------------------------------------------------------------

struct JwksCache {
    url: String,
    fetched_ms: f64,
    keys: Vec<Value>,
}

thread_local! {
    static JWKS: RefCell<Option<JwksCache>> = const { RefCell::new(None) };
}

fn cached_key(url: &str, kid: &str, now: f64) -> (Option<Value>, Option<f64>) {
    JWKS.with_borrow(|c| match c {
        Some(c) if c.url == url => {
            let key = (now - c.fetched_ms < JWKS_TTL_MS)
                .then(|| c.keys.iter().find(|k| k["kid"] == kid).cloned())
                .flatten();
            (key, Some(c.fetched_ms))
        }
        _ => (None, None),
    })
}

async fn find_key(cfg: &Config, kid: &str) -> Result<Option<Value>> {
    let url = cfg.certs_url();
    let now = Date::now().as_millis() as f64;
    let (hit, fetched_ms) = cached_key(&url, kid, now);
    if hit.is_some() {
        return Ok(hit);
    }
    // TTL 内なのに kid が無い = 鍵の入れ替わり直後か偽物。取り直しは間隔を空ける。
    if fetched_ms.is_some_and(|t| now - t < JWKS_REFETCH_MIN_MS) {
        return Ok(None);
    }
    #[derive(Deserialize)]
    struct Jwks {
        keys: Vec<Value>,
    }
    let mut res = Fetch::Url(Url::parse(&url)?).send().await?;
    if res.status_code() != 200 {
        return Err(Error::RustError(format!(
            "JWKS fetch failed: {}",
            res.status_code()
        )));
    }
    let keys = res.json::<Jwks>().await?.keys;
    let key = keys.iter().find(|k| k["kid"] == kid).cloned();
    JWKS.set(Some(JwksCache {
        url,
        fetched_ms: now,
        keys,
    }));
    Ok(key)
}

async fn verify_rs256(jwk: &Value, signing_input: &str, signature: &[u8]) -> Result<bool> {
    let subtle = js_sys::Reflect::get(&js_sys::global(), &"crypto".into())
        .and_then(|c| js_sys::Reflect::get(&c, &"subtle".into()))
        .map_err(|_| Error::RustError("WebCrypto unavailable".into()))?
        .unchecked_into::<web_sys::SubtleCrypto>();
    let algorithm = js_sys::JSON::parse(r#"{"name":"RSASSA-PKCS1-v1_5","hash":"SHA-256"}"#)
        .map_err(js_err)?
        .unchecked_into::<js_sys::Object>();
    let key_data = js_sys::JSON::parse(&jwk.to_string())
        .map_err(js_err)?
        .unchecked_into::<js_sys::Object>();
    let usages = js_sys::Array::of1(&"verify".into());

    let key = match subtle.import_key_with_object("jwk", &key_data, &algorithm, false, &usages) {
        Ok(p) => wasm_bindgen_futures::JsFuture::from(p).await,
        Err(e) => Err(e),
    };
    // 形の壊れた JWK は「その鍵では検証できない」= 署名不一致として扱う。
    let Ok(key) = key else {
        return Ok(false);
    };
    let key = key.unchecked_into::<web_sys::CryptoKey>();
    let ok = subtle
        .verify_with_object_and_u8_array_and_u8_array(
            &algorithm,
            &key,
            signature,
            signing_input.as_bytes(),
        )
        .map_err(js_err)?;
    let ok = wasm_bindgen_futures::JsFuture::from(ok)
        .await
        .map_err(js_err)?;
    Ok(ok.as_bool() == Some(true))
}

fn js_err(e: JsValue) -> Error {
    Error::RustError(format!("{e:?}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn cfg() -> Config {
        Config::new("https://team.cloudflareaccess.com/", "aud-1").unwrap()
    }

    fn claims(v: Value) -> Claims {
        serde_json::from_value(v).unwrap()
    }

    fn good() -> Value {
        json!({
            "iss": "https://team.cloudflareaccess.com",
            "aud": ["aud-1"],
            "exp": 2000.0,
            "email": "me@example.com",
        })
    }

    #[test]
    fn config_requires_https_or_loopback() {
        assert!(Config::new("https://team.cloudflareaccess.com", "a").is_some());
        assert!(Config::new("http://127.0.0.1:8787", "a").is_some());
        assert!(Config::new("http://localhost:1", "a").is_some());
        assert!(Config::new("http://team.cloudflareaccess.com", "a").is_none());
        assert!(Config::new("http://127.0.0.1.evil.com", "a").is_none());
        assert!(Config::new("https://team.cloudflareaccess.com/x", "a").is_none());
        assert!(Config::new("", "a").is_none());
        assert!(Config::new("https://team.cloudflareaccess.com", " ").is_none());
    }

    #[test]
    fn accepts_valid_claims() {
        assert_eq!(
            check_claims(&claims(good()), &cfg(), 1000.0),
            Ok("me@example.com".into())
        );
        let mut v = good();
        v["aud"] = json!("aud-1");
        assert!(
            check_claims(&claims(v), &cfg(), 1000.0).is_ok(),
            "aud は文字列でもよい"
        );
    }

    #[test]
    fn service_token_uses_common_name() {
        let mut v = good();
        v["email"] = json!("");
        v["common_name"] = json!("abc.access");
        assert_eq!(
            check_claims(&claims(v), &cfg(), 1000.0),
            Ok("abc.access".into())
        );
    }

    #[test]
    fn rejects_bad_claims() {
        let case = |f: fn(&mut Value), now: f64| {
            let mut v = good();
            f(&mut v);
            check_claims(&claims(v), &cfg(), now).unwrap_err()
        };
        assert_eq!(
            case(
                |v| v["iss"] = json!("https://other.cloudflareaccess.com"),
                1000.0
            ),
            AuthError::Issuer
        );
        assert_eq!(
            case(|v| v["aud"] = json!(["aud-2"]), 1000.0),
            AuthError::Audience
        );
        assert_eq!(
            case(|v| v["aud"] = json!(null), 1000.0),
            AuthError::Audience
        );
        assert_eq!(case(|_| {}, 2031.0), AuthError::Expired);
        assert_eq!(case(|v| v["exp"] = json!(null), 1000.0), AuthError::Expired);
        assert_eq!(
            case(|v| v["nbf"] = json!(1100.0), 1000.0),
            AuthError::NotYetValid
        );
        assert_eq!(
            case(|v| v["email"] = json!(null), 1000.0),
            AuthError::NoIdentity
        );
        // 時計のずれ (30 秒) の内側は通す
        assert!(check_claims(&claims(good()), &cfg(), 2029.0).is_ok());
    }

    #[test]
    fn parse_rejects_malformed_tokens() {
        assert!(matches!(parse_token("a.b"), Err(AuthError::Malformed)));
        assert!(matches!(parse_token("a.b.c.d"), Err(AuthError::Malformed)));
        assert!(matches!(parse_token("!!.!!.!!"), Err(AuthError::Malformed)));
        let h = URL_SAFE_NO_PAD.encode(r#"{"alg":"RS256","kid":"k"}"#);
        let p = URL_SAFE_NO_PAD.encode(r#"{"iss":"x"}"#);
        let t = parse_token(&format!("{h}.{p}.AAAA"))
            .map_err(|_| ())
            .unwrap();
        assert_eq!(t.header.kid.as_deref(), Some("k"));
        assert_eq!(t.signing_input, format!("{h}.{p}"));
        assert_eq!(t.signature, vec![0, 0, 0]);
    }
}
