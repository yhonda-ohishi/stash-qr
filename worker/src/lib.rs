//! stash-qr の Worker。API の一覧と方針は docs/design.md。

use serde::Serialize;
use worker::*;

mod assets;
mod auth;
mod containers;
mod db;
mod flickr;
mod gemini;
mod id;
mod item_types;
mod oauth1;
mod photos;
mod view;

#[event(fetch)]
async fn fetch(req: Request, env: Env, _ctx: Context) -> Result<Response> {
    // 全ルートが Access の後ろ。設定が無ければ開けずに閉じる (fail closed)。
    let Some(cfg) = auth::Config::from_env(&env) else {
        console_error!("ACCESS_ISSUER / ACCESS_AUD is not configured");
        return error(503, "auth not configured");
    };
    let actor = match auth::authenticate(&req, &cfg).await {
        Ok(Ok(a)) => a,
        Ok(Err(e)) => {
            console_warn!("access denied: {e:?}");
            return error(401, "unauthorized");
        }
        Err(e) => {
            console_error!("auth failed: {e}");
            return error(502, "could not verify access token");
        }
    };
    let res = Router::with_data(Actor(actor))
        .post_async("/api/containers", containers::create)
        .get_async("/api/containers/:id", containers::get)
        .patch_async("/api/containers/:id", containers::patch)
        .delete_async("/api/containers/:id", containers::delete)
        .post_async("/api/containers/:id/move", containers::move_to)
        .post_async("/api/containers/:id/stock", containers::stock_delta)
        .get_async("/api/item-types", item_types::list)
        .post_async("/api/item-types", item_types::create)
        .post_async("/api/assets/judge-label", assets::judge_label)
        .post_async("/api/assets", assets::create)
        .get_async("/api/assets/:id", assets::get)
        .patch_async("/api/assets/:id", assets::patch)
        .post_async("/api/assets/:id/move", assets::move_to)
        .post_async("/api/photos", photos::create)
        .get_async("/api/photos", photos::list)
        .get_async("/api/photos/:id", photos::image)
        .put_async("/api/photos/:id/image", photos::retry)
        .get_async("/api/search", view::search)
        .get_async("/c/:id", view::container_page)
        .get_async("/a/:id", view::asset_page)
        // catch-all (末尾)。/c/:id・/a/:id は #c9-1 がこれより前に足したので衝突しない。
        // /api/* の未一致はここに落ちる (Router 既定の "Not Found" テキストではなく JSON にする — 振る舞いの変更)。
        // それ以外は静的アセット (web/dist、[assets] binding = "ASSETS")。GET 以外の未一致は今まで通り Router 既定。
        .get_async("/", assets_or_not_found)
        .get_async("/*path", assets_or_not_found)
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

/// GET の catch-all。/api/ 配下は 404 JSON、それ以外は web/dist (Workers static assets) を返す。
async fn assets_or_not_found(req: Request, ctx: Ctx) -> Result<Response> {
    if req.path().starts_with("/api/") {
        return error(404, "not found");
    }
    ctx.env.assets("ASSETS")?.fetch_request(req).await
}

/// Access で確かめた持ち主 (利用者の email かサービストークンの common_name)。
/// movements.actor に残す。
pub(crate) struct Actor(pub String);

pub(crate) type Ctx = RouteContext<Actor>;

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
