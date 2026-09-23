//! 品目種類 (item_types)。`GET /api/item-types?q=` と `POST /api/item-types`。

use serde::{Deserialize, Serialize};
use serde_json::Value;
use worker::*;

use crate::db::{self, NOW, opt_text, text};
use crate::id::{ROW_ID_LEN, new_id};
use crate::{error, json, read_object};

#[derive(Deserialize)]
struct Row {
    id: String,
    category: String,
    name: String,
    tracking: String,
    attrs_json: Option<String>,
    created_at: String,
}

#[derive(Serialize)]
pub struct ItemType {
    id: String,
    category: String,
    name: String,
    tracking: String,
    attrs: Value,
    created_at: String,
}

impl From<Row> for ItemType {
    fn from(r: Row) -> Self {
        let attrs = r
            .attrs_json
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or(Value::Null);
        Self {
            id: r.id,
            category: r.category,
            name: r.name,
            tracking: r.tracking,
            attrs,
            created_at: r.created_at,
        }
    }
}

const COLS: &str = "id, category, name, tracking, attrs_json, created_at";

#[derive(Deserialize)]
struct ListQuery {
    q: Option<String>,
}

pub async fn list(req: Request, ctx: RouteContext<()>) -> Result<Response> {
    let q = req.query::<ListQuery>()?.q.unwrap_or_default();
    let d1 = db::db(&ctx)?;
    let rows = if q.trim().is_empty() {
        d1.prepare(format!(
            "SELECT {COLS} FROM item_types ORDER BY category, name LIMIT 200"
        ))
        .all()
        .await?
    } else {
        let pattern = format!("%{}%", escape_like(q.trim()));
        d1.prepare(format!(
            "SELECT {COLS} FROM item_types
             WHERE name LIKE ?1 ESCAPE '\\' OR category LIKE ?1 ESCAPE '\\'
             ORDER BY category, name LIMIT 50"
        ))
        .bind(&[text(&pattern)])?
        .all()
        .await?
    };
    let items: Vec<ItemType> = rows.results::<Row>()?.into_iter().map(Into::into).collect();
    json(200, &serde_json::json!({ "item_types": items }))
}

fn escape_like(s: &str) -> String {
    s.replace('\\', "\\\\")
        .replace('%', "\\%")
        .replace('_', "\\_")
}

pub async fn create(mut req: Request, ctx: RouteContext<()>) -> Result<Response> {
    let body = match read_object(&mut req).await {
        Ok(b) => b,
        Err(r) => return r,
    };
    let str_field = |k: &str| body.get(k).and_then(Value::as_str).map(str::trim);
    let (Some(category), Some(name), Some(tracking)) = (
        str_field("category"),
        str_field("name"),
        str_field("tracking"),
    ) else {
        return error(400, "category, name, tracking are required strings");
    };
    if category.is_empty() || name.is_empty() {
        return error(400, "category and name must not be empty");
    }
    if !matches!(tracking, "quantity" | "individual") {
        return error(400, "tracking must be quantity or individual");
    }
    let attrs_json = match body.get("attrs") {
        None | Some(Value::Null) => None,
        Some(v @ Value::Object(_)) => Some(v.to_string()),
        Some(_) => return error(400, "attrs must be an object"),
    };

    let d1 = db::db(&ctx)?;
    let id = new_id(ROW_ID_LEN);
    let res = d1
        .prepare(format!(
            "INSERT INTO item_types ({COLS}) VALUES (?1, ?2, ?3, ?4, ?5, {NOW})
             ON CONFLICT (category, name) DO NOTHING"
        ))
        .bind(&[
            text(&id),
            text(category),
            text(name),
            text(tracking),
            opt_text(attrs_json.as_deref()),
        ])?
        .run()
        .await?;
    let inserted = db::changes(&res)? == 1;

    // 既存と重なった場合もその行を返す (呼び出し側が id を拾えるように)。
    let row = d1
        .prepare(format!(
            "SELECT {COLS} FROM item_types WHERE category = ?1 AND name = ?2"
        ))
        .bind(&[text(category), text(name)])?
        .first::<Row>(None)
        .await?;
    let Some(row) = row else {
        return error(500, "item type vanished after insert");
    };
    let item = ItemType::from(row);
    if inserted {
        json(201, &item)
    } else {
        json(
            409,
            &serde_json::json!({ "error": "item type already exists", "item_type": item }),
        )
    }
}
