//! stash-qr の Worker。API の一覧と方針は docs/design.md。

use serde::Serialize;
use worker::*;

mod containers;
mod db;
mod id;
mod item_types;

#[event(fetch)]
async fn fetch(req: Request, env: Env, _ctx: Context) -> Result<Response> {
    let res = Router::new()
        .post_async("/api/containers", containers::create)
        .get_async("/api/containers/:id", containers::get)
        .patch_async("/api/containers/:id", containers::patch)
        .delete_async("/api/containers/:id", containers::delete)
        .post_async("/api/containers/:id/move", containers::move_to)
        .post_async("/api/containers/:id/stock", containers::stock_delta)
        .get_async("/api/item-types", item_types::list)
        .post_async("/api/item-types", item_types::create)
        .run(req, env)
        .await;
    match res {
        Ok(r) => Ok(r),
        Err(e) => {
            console_error!("unhandled: {e}");
            error(500, "internal error")
        }
    }
}

/// エラー応答は常に `{ "error": "..." }`。
pub(crate) fn error(status: u16, msg: &str) -> Result<Response> {
    Ok(Response::from_json(&serde_json::json!({ "error": msg }))?.with_status(status))
}

pub(crate) fn json<T: Serialize>(status: u16, body: &T) -> Result<Response> {
    Ok(Response::from_json(body)?.with_status(status))
}

/// リクエスト本文を JSON オブジェクトとして読む。形が違えば `Err(応答)`。
pub(crate) async fn read_object(
    req: &mut Request,
) -> std::result::Result<serde_json::Map<String, serde_json::Value>, Result<Response>> {
    match req.json::<serde_json::Value>().await {
        Ok(serde_json::Value::Object(m)) => Ok(m),
        _ => Err(error(400, "body must be a JSON object")),
    }
}
