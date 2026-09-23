//! Gemini (generateContent) で写真を判定する。
//!
//! 先行実装は ippoan/rust-alc-api の `crates/alc-notify/src/extract.rs`。同じ形にしている:
//! - `responseSchema` で出力の形を固定する (`responseMimeType` だけだと markdown で
//!   包まれて JSON として読めないことがある)
//! - `temperature` は 0 (同じ写真には同じ答え)
//! - リクエストの組み立てと応答の取り出しは純粋関数にして、中身を単体テストする
//!
//! 違うのはキーの渡し方だけ: URL の `?key=` ではなく `x-goog-api-key` ヘッダに載せる
//! (URL はログに残りやすいため)。モデル名は `GEMINI_MODEL` (wrangler.toml) で、
//! 判定のたびに ai_judgements.model に残す。

use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use serde_json::{Value, json};
use worker::*;

const ENDPOINT: &str = "https://generativelanguage.googleapis.com/v1beta";

pub struct Gemini {
    api_key: String,
    pub model: String,
    endpoint: String,
}

impl Gemini {
    /// キーかモデル名が無ければ `None` (判定は 503 になる)。
    pub fn from_env(env: &Env) -> Option<Self> {
        let api_key = env.secret("GEMINI_API_KEY").ok()?.to_string();
        let model = env.var("GEMINI_MODEL").ok()?.to_string();
        if api_key.is_empty() || model.is_empty() {
            return None;
        }
        // 送り先の上書きは結合テストの偽 Gemini 用。https 以外はループバックだけ。
        let endpoint = env
            .var("GEMINI_ENDPOINT")
            .map(|v| v.to_string())
            .ok()
            .filter(|v| {
                v.starts_with("https://")
                    || v.starts_with("http://127.0.0.1:")
                    || v.starts_with("http://localhost:")
            })
            .unwrap_or_else(|| ENDPOINT.to_string());
        Some(Self {
            api_key,
            model,
            endpoint,
        })
    }

    /// 画像 1 枚と指示を送り、schema どおりの JSON を返す。失敗は理由の文字列。
    pub async fn judge(
        &self,
        image: &[u8],
        mime: &str,
        prompt: &str,
        schema: &Value,
    ) -> std::result::Result<Value, String> {
        let body = request_body(image, mime, prompt, schema);
        let url = format!("{}/models/{}:generateContent", self.endpoint, self.model);
        let headers = Headers::new();
        let set = |k: &str, v: &str| headers.set(k, v).map_err(|e| e.to_string());
        set("Content-Type", "application/json")?;
        set("x-goog-api-key", &self.api_key)?;
        let mut init = RequestInit::new();
        init.with_method(Method::Post)
            .with_headers(headers.clone())
            .with_body(Some(body.to_string().into()));
        let req = Request::new_with_init(&url, &init).map_err(|e| e.to_string())?;
        let mut res = Fetch::Request(req)
            .send()
            .await
            .map_err(|e| e.to_string())?;
        let text = res.text().await.map_err(|e| e.to_string())?;
        if res.status_code() != 200 {
            let head: String = text.chars().take(300).collect();
            return Err(format!("gemini HTTP {}: {head}", res.status_code()));
        }
        let parsed: Value =
            serde_json::from_str(&text).map_err(|_| "gemini: response is not JSON".to_string())?;
        extract_json(&parsed)
    }
}

fn request_body(image: &[u8], mime: &str, prompt: &str, schema: &Value) -> Value {
    json!({
        "contents": [{
            "role": "user",
            "parts": [
                { "inlineData": { "mimeType": mime, "data": STANDARD.encode(image) } },
                { "text": prompt }
            ]
        }],
        "generationConfig": {
            "temperature": 0.0,
            "responseMimeType": "application/json",
            "responseSchema": schema,
            "maxOutputTokens": 2048
        }
    })
}

/// `candidates[0].content.parts[0].text` に入っている JSON 文字列を取り出して読む。
fn extract_json(parsed: &Value) -> std::result::Result<Value, String> {
    let text = parsed
        .pointer("/candidates/0/content/parts/0/text")
        .and_then(Value::as_str)
        .ok_or_else(|| {
            let reason = parsed
                .pointer("/candidates/0/finishReason")
                .or_else(|| parsed.pointer("/promptFeedback/blockReason"))
                .and_then(Value::as_str)
                .unwrap_or("no candidates");
            format!("gemini returned no text ({reason})")
        })?;
    serde_json::from_str(text).map_err(|_| {
        let head: String = text.chars().take(200).collect();
        format!("gemini output is not JSON: {head}")
    })
}

// ---------------------------------------------------------------------------
// 製品ラベル
// ---------------------------------------------------------------------------

pub const LABEL_PROMPT: &str = "\
この写真は機器の製品ラベル (銘板・シール) です。ラベルに印字されている文字だけを読み取ってください。
- maker: メーカー名 (ロゴや社名。例: EPSON, Apple, Anker)
- model: 型番・モデル名 (例: TM-L100, A2338)。「Model」「型番」「MODEL NO.」の近くにあることが多い
- serial: シリアル番号 (例: X4ZL012345)。「S/N」「Serial」「製造番号」の近くにあることが多い
- other_text: 上記以外で読めた文字 (定格・製造年月など) を短く
- confidence: 読み取り全体の確からしさ (0〜1)
読めない項目は推測せず null にしてください。似た文字 (0/O, 1/I, 5/S, 8/B) は印字どおりに書いてください。";

pub fn label_schema() -> Value {
    let s = json!({ "type": "STRING", "nullable": true });
    json!({
        "type": "OBJECT",
        "properties": {
            "maker": s, "model": s, "serial": s, "other_text": s,
            "confidence": { "type": "NUMBER" }
        },
        "required": ["confidence"]
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn request_body_carries_image_prompt_and_schema() {
        let b = request_body(&[1, 2, 3], "image/jpeg", "読んで", &label_schema());
        assert_eq!(
            b["contents"][0]["parts"][0]["inlineData"]["mimeType"],
            "image/jpeg"
        );
        assert_eq!(b["contents"][0]["parts"][0]["inlineData"]["data"], "AQID");
        assert_eq!(b["contents"][0]["parts"][1]["text"], "読んで");
        assert_eq!(b["generationConfig"]["temperature"], 0.0);
        assert_eq!(
            b["generationConfig"]["responseMimeType"],
            "application/json"
        );
        assert_eq!(
            b["generationConfig"]["responseSchema"]["properties"]["serial"]["nullable"],
            true
        );
    }

    #[test]
    fn extracts_json_text() {
        let ok = json!({ "candidates": [{ "content": { "parts": [{ "text": "{\"model\":\"TM-L100\",\"confidence\":0.9}" }] } }] });
        assert_eq!(extract_json(&ok).unwrap()["model"], "TM-L100");

        let blocked = json!({ "promptFeedback": { "blockReason": "SAFETY" } });
        assert_eq!(
            extract_json(&blocked).unwrap_err(),
            "gemini returned no text (SAFETY)"
        );

        let prose =
            json!({ "candidates": [{ "content": { "parts": [{ "text": "```json\n{}\n```" }] } }] });
        assert!(
            extract_json(&prose)
                .unwrap_err()
                .starts_with("gemini output is not JSON")
        );
    }
}
