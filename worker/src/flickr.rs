//! Flickr API クライアント (アップロード・getInfo・静的画像の取得)。
//!
//! 先行実装は ippoan/rust-flickr (`src/flickr.rs`) と ippoan/cf-flickr-cam-worker
//! (`src/flickr.ts`)。違いは次の 3 点で、どれも stash-qr の「絶対のルール」由来:
//! - アップロードで `is_public` / `is_friend` / `is_family` = 0 を明示する (先行実装は
//!   送っておらず、アカウントの既定の公開範囲に従っていた)。`hidden=2` で検索からも外す
//! - マシンタグ `stashqr:*` を付けて Flickr 側から逆引きできるようにする
//! - 静的画像 URL はクライアントに返さない (先行実装は 302 で渡していた)。
//!   取得は Worker が行い、中身だけを返す (`photos.rs`)
//!
//! 資格情報は Worker secret (`wrangler secret put`) の
//! `FLICKR_CONSUMER_KEY` / `FLICKR_CONSUMER_SECRET` / `FLICKR_ACCESS_TOKEN_JSON`。

use serde::Deserialize;
use worker::wasm_bindgen::JsValue;
use worker::*;

use crate::oauth1;

const UPLOAD_URL: &str = "https://up.flickr.com/services/upload/";
const REST_URL: &str = "https://api.flickr.com/services/rest/";
const STATIC_BASE: &str = "https://live.staticflickr.com";

/// 表示に使ってよい大きさ (Flickr のサイズ接尾辞)。t=100 m=240 z=640 c=800 b=1024 px。
pub const SIZES: [&str; 5] = ["t", "m", "z", "c", "b"];

pub struct Flickr {
    consumer_key: String,
    consumer_secret: String,
    token: String,
    token_secret: String,
    upload_url: String,
    rest_url: String,
    static_base: String,
}

#[derive(Deserialize)]
struct AccessToken {
    token: String,
    secret: String,
}

fn secret(env: &Env, name: &str) -> Option<String> {
    env.secret(name)
        .ok()
        .map(|s| s.to_string())
        .filter(|v| !v.is_empty())
}

/// 送り先の上書き (結合テストの偽 Flickr 用)。https 以外はループバックだけ許す。
fn endpoint(env: &Env, key: &str, default: &str) -> String {
    let v = env.var(key).map(|v| v.to_string()).unwrap_or_default();
    let ok = v.starts_with("https://")
        || v.starts_with("http://127.0.0.1:")
        || v.starts_with("http://localhost:");
    if ok { v } else { default.to_string() }
}

impl Flickr {
    /// 資格情報が 1 つでも欠けていれば `None` (= アップロードは送信待ちのまま残る)。
    pub async fn from_env(env: &Env) -> Option<Self> {
        let consumer_key = secret(env, "FLICKR_CONSUMER_KEY")?;
        let consumer_secret = secret(env, "FLICKR_CONSUMER_SECRET")?;
        let token_json = secret(env, "FLICKR_ACCESS_TOKEN_JSON")?;
        let AccessToken { token, secret } = serde_json::from_str(&token_json).ok()?;
        Some(Self {
            consumer_key,
            consumer_secret,
            token,
            token_secret: secret,
            upload_url: endpoint(env, "FLICKR_UPLOAD_URL", UPLOAD_URL),
            rest_url: endpoint(env, "FLICKR_REST_URL", REST_URL),
            static_base: endpoint(env, "FLICKR_STATIC_BASE", STATIC_BASE),
        })
    }

    fn oauth_params(&self) -> Vec<(String, String)> {
        let mut nonce = [0u8; 16];
        getrandom::getrandom(&mut nonce).expect("getrandom");
        let nonce: String = nonce.iter().map(|b| format!("{b:02x}")).collect();
        let ts = (Date::now().as_millis() / 1000).to_string();
        [
            ("oauth_consumer_key", self.consumer_key.as_str()),
            ("oauth_nonce", nonce.as_str()),
            ("oauth_signature_method", "HMAC-SHA1"),
            ("oauth_timestamp", ts.as_str()),
            ("oauth_token", self.token.as_str()),
            ("oauth_version", "1.0"),
        ]
        .into_iter()
        .map(|(k, v)| (k.to_string(), v.to_string()))
        .collect()
    }

    /// 非公開でアップロードして Flickr の photo id を返す。失敗は理由の文字列。
    pub async fn upload(
        &self,
        bytes: &[u8],
        content_type: &str,
        title: &str,
        tags: &[String],
    ) -> std::result::Result<String, String> {
        let mut params = self.oauth_params();
        params.extend(upload_params(title, tags));
        let sig = oauth1::sign(
            "POST",
            &self.upload_url,
            &params,
            &self.consumer_secret,
            &self.token_secret,
        );
        params.push(("oauth_signature".into(), sig));

        let body = multipart(&params, bytes, content_type, title).map_err(|e| format!("{e:?}"))?;
        let mut init = RequestInit::new();
        init.with_method(Method::Post).with_body(Some(body));
        let req = Request::new_with_init(&self.upload_url, &init).map_err(|e| e.to_string())?;
        let mut res = Fetch::Request(req)
            .send()
            .await
            .map_err(|e| e.to_string())?;
        let text = res.text().await.map_err(|e| e.to_string())?;
        if res.status_code() != 200 {
            return Err(format!("upload HTTP {}", res.status_code()));
        }
        parse_upload_response(&text)
    }

    /// 静的画像 URL を組むための (server, secret) を得る。
    pub async fn server_and_secret(
        &self,
        photo_id: &str,
    ) -> std::result::Result<(String, String), String> {
        let mut params = self.oauth_params();
        let api: Vec<(String, String)> = [
            ("method", "flickr.photos.getInfo"),
            ("photo_id", photo_id),
            ("format", "json"),
            ("nojsoncallback", "1"),
        ]
        .into_iter()
        .map(|(k, v)| (k.to_string(), v.to_string()))
        .collect();
        params.extend(api.iter().cloned());
        let sig = oauth1::sign(
            "GET",
            &self.rest_url,
            &params,
            &self.consumer_secret,
            &self.token_secret,
        );
        params.push(("oauth_signature".into(), sig));

        let mut url = Url::parse(&self.rest_url).map_err(|e| e.to_string())?;
        url.query_pairs_mut().extend_pairs(api.iter());
        let headers = Headers::new();
        headers
            .set("Authorization", &oauth1::auth_header(&params))
            .map_err(|e| e.to_string())?;
        let mut init = RequestInit::new();
        init.with_headers(headers);
        let req = Request::new_with_init(url.as_str(), &init).map_err(|e| e.to_string())?;
        let mut res = Fetch::Request(req)
            .send()
            .await
            .map_err(|e| e.to_string())?;
        let text = res.text().await.map_err(|e| e.to_string())?;
        parse_get_info(&text)
    }

    pub async fn fetch_image(
        &self,
        server: &str,
        photo_id: &str,
        secret: &str,
        size: &str,
    ) -> Result<Response> {
        let url = format!(
            "{}/{server}/{photo_id}_{secret}_{size}.jpg",
            self.static_base
        );
        Fetch::Url(Url::parse(&url)?).send().await
    }
}

/// アップロードで送る API パラメータ (署名対象)。公開範囲は必ず 0 を明示する。
fn upload_params(title: &str, tags: &[String]) -> Vec<(String, String)> {
    [
        ("title", title.to_string()),
        ("tags", tags.join(" ")),
        ("is_public", "0".into()),
        ("is_friend", "0".into()),
        ("is_family", "0".into()),
        ("hidden", "2".into()),
        ("safety_level", "1".into()),
        ("content_type", "1".into()),
    ]
    .into_iter()
    .map(|(k, v)| (k.to_string(), v))
    .collect()
}

fn multipart(
    params: &[(String, String)],
    bytes: &[u8],
    content_type: &str,
    title: &str,
) -> std::result::Result<JsValue, JsValue> {
    let form = web_sys::FormData::new()?;
    for (k, v) in params {
        form.append_with_str(k, v)?;
    }
    let parts = js_sys::Array::of1(&js_sys::Uint8Array::from(bytes));
    let opts = web_sys::BlobPropertyBag::new();
    opts.set_type(content_type);
    let blob = web_sys::Blob::new_with_u8_array_sequence_and_options(&parts, &opts)?;
    form.append_with_blob_and_filename("photo", &blob, title)?;
    Ok(form.into())
}

/// `<rsp stat="ok"><photoid>123</photoid></rsp>` から photo id を抜く。
/// 形が固定の応答なので XML パーサーは入れない (cf-flickr-cam-worker と同じ判断)。
fn parse_upload_response(xml: &str) -> std::result::Result<String, String> {
    let between = |open: &str, close: &str| {
        let start = xml.find(open)? + open.len();
        let end = xml[start..].find(close)? + start;
        Some(xml[start..end].to_string())
    };
    if !xml.contains(r#"stat="ok""#) {
        let msg = between(r#"msg=""#, r#"""#).unwrap_or_else(|| "unknown error".into());
        return Err(format!("upload rejected: {msg}"));
    }
    match between("<photoid>", "</photoid>") {
        Some(id) if !id.is_empty() && id.bytes().all(|b| b.is_ascii_digit()) => Ok(id),
        _ => Err("upload: photoid not found".into()),
    }
}

fn parse_get_info(json: &str) -> std::result::Result<(String, String), String> {
    #[derive(Deserialize)]
    struct Photo {
        server: String,
        secret: String,
    }
    #[derive(Deserialize)]
    struct Rsp {
        stat: String,
        photo: Option<Photo>,
        message: Option<String>,
    }
    let rsp: Rsp = serde_json::from_str(json).map_err(|_| "getInfo: bad response".to_string())?;
    match (rsp.stat.as_str(), rsp.photo) {
        ("ok", Some(p)) if is_safe_segment(&p.server) && is_safe_segment(&p.secret) => {
            Ok((p.server, p.secret))
        }
        ("ok", _) => Err("getInfo: unexpected photo fields".into()),
        _ => Err(format!(
            "getInfo failed: {}",
            rsp.message.unwrap_or_default()
        )),
    }
}

/// URL のパスに埋める値は英数字だけ (`/` や `..` で別の場所を取らせない)。
fn is_safe_segment(s: &str) -> bool {
    !s.is_empty() && s.bytes().all(|b| b.is_ascii_alphanumeric())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn upload_params_are_always_private() {
        let p = upload_params(
            "t",
            &["stashqr:kind=label".into(), "stashqr:photo=X".into()],
        );
        let get = |k: &str| p.iter().find(|(key, _)| key == k).map(|(_, v)| v.as_str());
        assert_eq!(get("is_public"), Some("0"));
        assert_eq!(get("is_friend"), Some("0"));
        assert_eq!(get("is_family"), Some("0"));
        assert_eq!(get("hidden"), Some("2"));
        assert_eq!(get("tags"), Some("stashqr:kind=label stashqr:photo=X"));
    }

    #[test]
    fn parses_upload_response() {
        assert_eq!(
            parse_upload_response(
                r#"<?xml version="1.0"?><rsp stat="ok"><photoid>5550001</photoid></rsp>"#
            ),
            Ok("5550001".into())
        );
        assert_eq!(
            parse_upload_response(
                r#"<rsp stat="fail"><err code="98" msg="Invalid auth token" /></rsp>"#
            ),
            Err("upload rejected: Invalid auth token".into())
        );
        assert!(parse_upload_response(r#"<rsp stat="ok"><photoid>12a</photoid></rsp>"#).is_err());
    }

    #[test]
    fn parses_get_info() {
        assert_eq!(
            parse_get_info(
                r#"{"stat":"ok","photo":{"id":"1","server":"65535","secret":"abc123"}}"#
            ),
            Ok(("65535".into(), "abc123".into()))
        );
        assert!(parse_get_info(r#"{"stat":"fail","code":1,"message":"Photo not found"}"#).is_err());
        assert!(
            parse_get_info(r#"{"stat":"ok","photo":{"server":"../x","secret":"a"}}"#).is_err(),
            "パスに使う値は英数字のみ"
        );
    }
}
