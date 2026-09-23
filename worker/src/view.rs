//! `GET /c/:id` `GET /a/:id` の閲覧ページ (HTML) と `GET /api/search` (検索)。
//!
//! QR を読んだスマホがログイン済みブラウザで開くページ。データは JSON API
//! (`containers::get` / `assets::get`) と同じ `load_view` を共用する。
//! DB 由来の文字列はすべて `html_escape` を通してから組み立てる。

use std::collections::HashMap;

use serde::Deserialize;
use worker::*;

use crate::containers::{self, Crumb};
use crate::db::{self, text};
use crate::id::normalize_container_id;
use crate::item_types::escape_like;
use crate::photos::{self, Owner};
use crate::{Ctx, assets, error, json};

/// `&` `<` `>` `"` `'` の 5 文字だけをエスケープする。DB 由来の文字列を
/// HTML に埋め込む前に必ずこれを通す (品目名・コンテナ名などは利用者入力)。
fn html_escape(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&#39;"),
            c => out.push(c),
        }
    }
    out
}

fn html_response(status: u16, body: String) -> Result<Response> {
    let headers = Headers::new();
    headers.set("Content-Type", "text/html; charset=utf-8")?;
    Ok(Response::ok(body)?
        .with_status(status)
        .with_headers(headers))
}

const STYLE: &str = "body{font-family:sans-serif;margin:0;padding:16px;max-width:480px;\
    line-height:1.5}a{color:#06c}.crumb{color:#555;font-size:0.9em;margin-bottom:8px}\
    .crumb a{margin-right:2px}ul{padding-left:20px;margin:4px 0}\
    h2{font-size:1em;margin:16px 0 4px}img{width:72px;height:72px;object-fit:cover;\
    margin:4px 4px 4px 0;border-radius:4px;vertical-align:top}";

fn page(title: &str, body: &str) -> String {
    format!(
        "<!doctype html><html><head><meta charset=\"utf-8\">\
         <meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">\
         <title>{title}</title><style>{STYLE}</style></head><body>{body}</body></html>",
        title = html_escape(title),
    )
}

fn not_found(what: &str) -> Result<Response> {
    html_response(
        404,
        page(
            "見つかりません",
            &format!("<p>{} が見つかりません。</p>", html_escape(what)),
        ),
    )
}

fn breadcrumb_html(crumbs: &[Crumb]) -> String {
    let mut out = String::new();
    for c in crumbs {
        out.push_str(&format!(
            "<a href=\"/c/{}\">{}</a> / ",
            html_escape(&c.id),
            html_escape(c.name.as_deref().unwrap_or(&c.kind)),
        ));
    }
    out
}

fn photos_html(photos: &[photos::PhotoRef]) -> String {
    let mut out = String::new();
    for p in photos {
        out.push_str(&format!(
            "<img src=\"/api/photos/{}?size=t\" alt=\"\">",
            html_escape(&p.id)
        ));
    }
    out
}

// ---------------------------------------------------------------------------
// GET /c/:id
// ---------------------------------------------------------------------------

pub async fn container_page(_req: Request, ctx: Ctx) -> Result<Response> {
    let Some(id) = ctx.param("id").and_then(|s| normalize_container_id(s)) else {
        return not_found("コンテナ");
    };
    let d1 = db::db(&ctx)?;
    let Some(view) = containers::load_view(&d1, &id).await? else {
        return not_found("コンテナ");
    };
    let photo_list = photos::list_for(&d1, Owner::Container(&id)).await?;

    let mut children_html = String::new();
    for c in &view.children {
        children_html.push_str(&format!(
            "<li><a href=\"/c/{}\">{}</a> ({})</li>",
            html_escape(&c.id),
            html_escape(c.name.as_deref().unwrap_or("-")),
            html_escape(&c.kind),
        ));
    }
    let children_html = if children_html.is_empty() {
        "<p>(なし)</p>".to_string()
    } else {
        format!("<ul>{children_html}</ul>")
    };

    let mut stock_html = String::new();
    for s in &view.stock {
        stock_html.push_str(&format!("<li>{} × {}</li>", html_escape(&s.name), s.qty));
    }
    let stock_html = if stock_html.is_empty() {
        "<p>(なし)</p>".to_string()
    } else {
        format!("<ul>{stock_html}</ul>")
    };

    let mut assets_html = String::new();
    for a in &view.assets {
        let label = [a.maker.as_deref(), a.model.as_deref(), a.serial.as_deref()]
            .into_iter()
            .flatten()
            .collect::<Vec<_>>()
            .join(" / ");
        let label = if label.is_empty() {
            &a.item_name
        } else {
            &label
        };
        assets_html.push_str(&format!(
            "<li><a href=\"/a/{}\">{}</a></li>",
            html_escape(&a.id),
            html_escape(label),
        ));
    }
    let assets_html = if assets_html.is_empty() {
        "<p>(なし)</p>".to_string()
    } else {
        format!("<ul>{assets_html}</ul>")
    };

    let title = view
        .container
        .name
        .clone()
        .unwrap_or_else(|| view.container.kind.clone());
    let memo_html = view
        .container
        .memo
        .as_deref()
        .map(|m| format!("<p>{}</p>", html_escape(m)))
        .unwrap_or_default();
    let body = format!(
        "<p class=\"crumb\">{crumb}<strong>{name}</strong> ({kind})</p>\
         {memo}\
         <div>{photos}</div>\
         <h2>中身</h2>{children}\
         <h2>在庫</h2>{stock}\
         <h2>個体</h2>{assets}",
        crumb = breadcrumb_html(&view.breadcrumb),
        name = html_escape(&title),
        kind = html_escape(&view.container.kind),
        memo = memo_html,
        photos = photos_html(&photo_list),
        children = children_html,
        stock = stock_html,
        assets = assets_html,
    );
    html_response(200, page(&title, &body))
}

// ---------------------------------------------------------------------------
// GET /a/:id
// ---------------------------------------------------------------------------

pub async fn asset_page(_req: Request, ctx: Ctx) -> Result<Response> {
    let Some(id) = ctx.param("id").cloned() else {
        return not_found("個体");
    };
    let d1 = db::db(&ctx)?;
    let Some(view) = assets::load_view(&d1, &id).await? else {
        return not_found("個体");
    };
    let crumb = if view.breadcrumb.is_empty() {
        "<span>持ち出し中</span>".to_string()
    } else {
        breadcrumb_html(&view.breadcrumb)
    };
    let a = &view.asset;
    let memo_html = a
        .memo
        .as_deref()
        .map(|m| format!("<p>メモ: {}</p>", html_escape(m)))
        .unwrap_or_default();
    let body = format!(
        "<p class=\"crumb\">{crumb}</p>\
         <h1>{item_name}</h1>\
         <p>メーカー: {maker}</p><p>型番: {model}</p><p>シリアル: {serial}</p>\
         <p>状態: {status}</p>{memo}\
         <div>{photos}</div>",
        crumb = crumb,
        item_name = html_escape(&a.item_name),
        maker = html_escape(a.maker.as_deref().unwrap_or("-")),
        model = html_escape(a.model.as_deref().unwrap_or("-")),
        serial = html_escape(a.serial.as_deref().unwrap_or("-")),
        status = html_escape(&a.status),
        memo = memo_html,
        photos = photos_html(&view.photos),
    );
    html_response(200, page(&a.item_name, &body))
}

// ---------------------------------------------------------------------------
// GET /api/search?q=
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
struct SearchQuery {
    q: Option<String>,
}

#[derive(Deserialize)]
struct StockHit {
    item_type_id: String,
    category: String,
    item_type_name: String,
    container_id: String,
    qty: i64,
}

#[derive(Deserialize)]
struct AssetHit {
    id: String,
    maker: Option<String>,
    model: Option<String>,
    serial: Option<String>,
    container_id: Option<String>,
}

const SEARCH_LIMIT: &str = "50";

pub async fn search(req: Request, ctx: Ctx) -> Result<Response> {
    let q = req.query::<SearchQuery>()?.q.unwrap_or_default();
    let q = q.trim();
    if q.is_empty() {
        return error(400, "q is required");
    }
    let pattern = format!("%{}%", escape_like(q));
    let d1 = db::db(&ctx)?;

    let stock_rows = d1
        .prepare(format!(
            "SELECT s.item_type_id, t.category, t.name AS item_type_name, s.container_id, s.qty
             FROM stock s JOIN item_types t ON t.id = s.item_type_id
             WHERE t.name LIKE ?1 ESCAPE '\\'
             ORDER BY t.name, s.container_id LIMIT {SEARCH_LIMIT}"
        ))
        .bind(&[text(&pattern)])?
        .all()
        .await?
        .results::<StockHit>()?;

    let asset_rows = d1
        .prepare(format!(
            "SELECT id, maker, model, serial, container_id FROM assets
             WHERE model LIKE ?1 ESCAPE '\\' OR serial LIKE ?1 ESCAPE '\\'
             ORDER BY updated_at DESC LIMIT {SEARCH_LIMIT}"
        ))
        .bind(&[text(&pattern)])?
        .all()
        .await?
        .results::<AssetHit>()?;

    // ヒットしたコンテナごとに 1 回だけパンくずを引く (同じコンテナが複数回
    // 出てくることがあるため)。1 件ずつ往復せず、1 回の d1.batch にまとめる。
    let mut container_ids: Vec<String> =
        stock_rows.iter().map(|r| r.container_id.clone()).collect();
    container_ids.extend(asset_rows.iter().filter_map(|r| r.container_id.clone()));
    container_ids.sort_unstable();
    container_ids.dedup();

    let crumbs: HashMap<String, Vec<Crumb>> = if container_ids.is_empty() {
        HashMap::new()
    } else {
        let stmts = container_ids
            .iter()
            .map(|id| d1.prepare(containers::breadcrumb_sql()).bind(&[text(id)]))
            .collect::<Result<Vec<_>>>()?;
        let batch = d1.batch(stmts).await?;
        let mut map = HashMap::with_capacity(container_ids.len());
        for (id, r) in container_ids.into_iter().zip(batch) {
            map.insert(id, r.results::<Crumb>()?);
        }
        map
    };

    let stock: Vec<_> = stock_rows
        .into_iter()
        .map(|r| {
            let breadcrumb = crumbs.get(&r.container_id).cloned().unwrap_or_default();
            serde_json::json!({
                "item_type_id": r.item_type_id,
                "category": r.category,
                "item_type_name": r.item_type_name,
                "container_id": r.container_id,
                "qty": r.qty,
                "breadcrumb": breadcrumb,
            })
        })
        .collect();
    let assets: Vec<_> = asset_rows
        .into_iter()
        .map(|r| {
            let breadcrumb = r
                .container_id
                .as_ref()
                .and_then(|c| crumbs.get(c))
                .cloned()
                .unwrap_or_default();
            serde_json::json!({
                "id": r.id,
                "maker": r.maker,
                "model": r.model,
                "serial": r.serial,
                "container_id": r.container_id,
                "breadcrumb": breadcrumb,
            })
        })
        .collect();

    json(
        200,
        &serde_json::json!({ "stock": stock, "assets": assets }),
    )
}
