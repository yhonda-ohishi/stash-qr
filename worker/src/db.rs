//! D1 まわりの小さな共通部品。

use worker::wasm_bindgen::JsValue;
use worker::*;

/// SQL 内で現在時刻を埋める式。時刻は Worker ではなく D1 で打つ。
pub const NOW: &str = "strftime('%Y-%m-%dT%H:%M:%fZ','now')";

pub fn db(ctx: &RouteContext<()>) -> Result<D1Database> {
    ctx.env.d1("DB")
}

pub fn text(s: &str) -> JsValue {
    JsValue::from_str(s)
}

pub fn opt_text(s: Option<&str>) -> JsValue {
    s.map_or(JsValue::NULL, JsValue::from_str)
}

pub fn int(n: i64) -> JsValue {
    JsValue::from_f64(n as f64)
}

/// 書き込み文が実際に何行変えたか。条件付き INSERT/UPDATE の成否判定に使う。
pub fn changes(r: &D1Result) -> Result<usize> {
    Ok(r.meta()?.and_then(|m| m.changes).unwrap_or(0))
}

/// 1 行だけ返す SELECT の結果を取り出す。
pub fn first_row<T: serde::de::DeserializeOwned>(r: &D1Result) -> Result<Option<T>> {
    Ok(r.results::<T>()?.into_iter().next())
}

/// `SELECT 1 ... WHERE id = ?1` の存在確認。
pub async fn exists(d1: &D1Database, table: &str, id: &str) -> Result<bool> {
    // table は呼び出し側の定数だけを渡す (利用者の入力は入らない)。
    let sql = format!("SELECT 1 AS x FROM {table} WHERE id = ?1");
    Ok(d1
        .prepare(sql)
        .bind(&[text(id)])?
        .first::<serde_json::Value>(None)
        .await?
        .is_some())
}
