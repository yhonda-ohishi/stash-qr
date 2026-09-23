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

/// generationConfig.maxOutputTokens。コンテナ写真は品目ごとに attrs を返すため長く、
/// 2048 だと JSON が途中で切れて `gemini output is not JSON` になっていた
/// (2026-09-23 本番。finishReason は MAX_TOKENS)。ラベル判定は短いので今まで気づかなかった。
const MAX_OUTPUT_TOKENS: u32 = 8192;

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
            "maxOutputTokens": MAX_OUTPUT_TOKENS
        }
    })
}

/// `candidates[0].content.parts[0].text` に入っている JSON 文字列を取り出して読む。
fn extract_json(parsed: &Value) -> std::result::Result<Value, String> {
    let finish_reason = parsed
        .pointer("/candidates/0/finishReason")
        .and_then(Value::as_str);
    let text = parsed
        .pointer("/candidates/0/content/parts/0/text")
        .and_then(Value::as_str)
        .ok_or_else(|| {
            let reason = finish_reason
                .or_else(|| {
                    parsed
                        .pointer("/promptFeedback/blockReason")
                        .and_then(Value::as_str)
                })
                .unwrap_or("no candidates");
            format!("gemini returned no text ({reason})")
        })?;
    serde_json::from_str(text).map_err(|_| {
        // MAX_TOKENS で切れた JSON はここで parse に失敗する (`text` 自体は取れている)。
        // JSON の構文エラーと区別できるよう finishReason を先に見る。
        if finish_reason == Some("MAX_TOKENS") {
            "gemini output was truncated (MAX_TOKENS)".to_string()
        } else {
            let head: String = text.chars().take(200).collect();
            format!("gemini output is not JSON: {head}")
        }
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

// ---------------------------------------------------------------------------
// コンテナの中身
// ---------------------------------------------------------------------------

pub const CONTAINER_PROMPT: &str = "\
この写真は袋・箱・棚など (コンテナ) の中身です。写っている物を一覧にしてください。
- stock: 本数で数える物 (ケーブル・電源アダプタ・電池など)。同じ物は 1 行にまとめ、qty に本数を入れる
  - category: cable / power / battery / other のどれか
  - name: ケーブルは両端の端子を「端子1-端子2」の形で書く (例: A-C, C-C, A-micro-B, A-Lightning, 3.5mm-3.5mm)
  - attrs: end1 / end2 は端子 (A / C / micro-B / mini-B / Lightning / 3.5mm / DC など)、length は長さ (例: 1m)、
    color は色、braided は編み込みなら true。分からない項目は null
  - 判断できない物は category を other、name を「不明」にする
  - confidence: その行の確からしさ (0〜1)
- assets: 型番やシリアルで 1 台ずつ管理する機器 (プリンタ・ルーター・モバイルバッテリーなど)
  - maker / model / serial: 本体に読める文字だけ。読めなければ推測せず null
  - description: 見た目の短い説明 (例: 黒い小型のレシートプリンタ)
  - confidence: その行の確からしさ (0〜1)
- container: 写っている袋・箱・棚など入れ物自体について、種別 (kind) と、中身が分かる短い日本語の名前
  (name。例: USB ケーブルの袋) を付けてください
ケーブルは 1 本ずつ束ねて両端を同じ辺に揃えてあります。端子の形を見て数えてください。";

/// 指示文に登録済みの数量品目を添える。同じ物に同じ名前を付けさせ、表記揺れで品目が増えるのを防ぐ。
pub fn container_prompt(known: &[(String, String)]) -> String {
    if known.is_empty() {
        return CONTAINER_PROMPT.to_string();
    }
    let mut p = format!(
        "{CONTAINER_PROMPT}\n登録済みの品目です。同じ物にはこの category と name をそのまま使ってください:\n"
    );
    for (category, name) in known {
        p.push_str(&format!("- {category} / {name}\n"));
    }
    p
}

pub fn container_schema() -> Value {
    let s = json!({ "type": "STRING", "nullable": true });
    json!({
        "type": "OBJECT",
        "properties": {
            "stock": {
                "type": "ARRAY",
                "items": {
                    "type": "OBJECT",
                    "properties": {
                        "category": { "type": "STRING", "enum": ["cable", "power", "battery", "other"] },
                        "name": { "type": "STRING" },
                        "qty": { "type": "INTEGER" },
                        "attrs": {
                            "type": "OBJECT",
                            "nullable": true,
                            "properties": {
                                "end1": s, "end2": s, "length": s, "color": s,
                                "braided": { "type": "BOOLEAN", "nullable": true }
                            }
                        },
                        "confidence": { "type": "NUMBER" }
                    },
                    "required": ["category", "name", "qty", "confidence"]
                }
            },
            "assets": {
                "type": "ARRAY",
                "items": {
                    "type": "OBJECT",
                    "properties": {
                        "maker": s, "model": s, "serial": s,
                        "description": { "type": "STRING" },
                        "confidence": { "type": "NUMBER" }
                    },
                    "required": ["description", "confidence"]
                }
            },
            "container": {
                "type": "OBJECT",
                "nullable": true,
                "properties": {
                    "kind": { "type": "STRING", "enum": ["bag", "box", "shelf", "case", "drawer", "other"] },
                    "name": { "type": "STRING" }
                },
                "required": ["kind"]
            }
        },
        "required": ["stock", "assets"]
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn container_prompt_lists_known_item_types() {
        assert_eq!(container_prompt(&[]), CONTAINER_PROMPT);
        let p = container_prompt(&[("cable".into(), "A-C".into())]);
        assert!(p.starts_with(CONTAINER_PROMPT));
        assert!(p.ends_with("- cable / A-C\n"));
        let s = container_schema();
        assert_eq!(
            s["properties"]["stock"]["items"]["properties"]["qty"]["type"],
            "INTEGER"
        );
        assert_eq!(
            s["properties"]["assets"]["items"]["properties"]["serial"]["nullable"],
            true
        );
    }

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
        assert_eq!(b["generationConfig"]["maxOutputTokens"], MAX_OUTPUT_TOKENS);
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

        // 本番 (2026-09-23) で見えた形: finishReason=MAX_TOKENS で JSON が途中で切れている。
        let truncated = json!({
            "candidates": [{
                "content": { "parts": [{ "text": "{\"stock\":[{\"category\":\"cable\"" }] },
                "finishReason": "MAX_TOKENS"
            }]
        });
        assert_eq!(
            extract_json(&truncated).unwrap_err(),
            "gemini output was truncated (MAX_TOKENS)"
        );

        // text が無く finishReason だけ MAX_TOKENS の場合も区別したメッセージになる。
        let no_text = json!({ "candidates": [{ "finishReason": "MAX_TOKENS" }] });
        assert_eq!(
            extract_json(&no_text).unwrap_err(),
            "gemini returned no text (MAX_TOKENS)"
        );
    }
}
