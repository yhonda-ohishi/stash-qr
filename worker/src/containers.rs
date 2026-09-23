//! コンテナ (場所) の CRUD・移動・本数の出し入れ。
//!
//! 書き込みは「条件付き INSERT/UPDATE を batch (= 1 トランザクション) で流し、
//! 変わった行数で成否を見る」形に揃えている。事前に SELECT で確かめてから書くと、
//! その間に別リクエストが割り込んで循環や負の在庫を作れてしまうため。
//! 失敗したときだけ、理由 (404 / 409 / 422) を後から調べて返す。

use serde::{Deserialize, Serialize};
use serde_json::Value;
use worker::*;

use crate::db::{self, NOW, int, opt_text, text};
use crate::id::{CONTAINER_ID_LEN, ROW_ID_LEN, new_id, normalize_container_id};
use crate::{Ctx, error, json, read_object};

/// 親をたどる深さの上限。壊れたデータで CTE が止まらなくなるのを防ぐ保険。
const MAX_DEPTH: i64 = 64;

#[derive(Deserialize, Serialize)]
struct Container {
    id: String,
    parent_id: Option<String>,
    kind: String,
    name: Option<String>,
    memo: Option<String>,
    created_at: String,
    updated_at: String,
}

const COLS: &str = "id, parent_id, kind, name, memo, created_at, updated_at";

/// パスの `:id` を正規化する。形が違う ID は存在しないのと同じ扱い (404)。
fn path_id(ctx: &Ctx) -> Option<String> {
    ctx.param("id").and_then(|s| normalize_container_id(s))
}

/// 本文の `parent_id` を読む。キーが無い = `Missing`、null = 最上位。
enum ParentField {
    Missing,
    Root,
    Id(String),
    Invalid,
}

fn parent_field(body: &serde_json::Map<String, Value>) -> ParentField {
    match body.get("parent_id") {
        None => ParentField::Missing,
        Some(Value::Null) => ParentField::Root,
        Some(Value::String(s)) => {
            normalize_container_id(s).map_or(ParentField::Invalid, ParentField::Id)
        }
        Some(_) => ParentField::Invalid,
    }
}

fn opt_str_field<'a>(
    body: &'a serde_json::Map<String, Value>,
    key: &str,
) -> std::result::Result<Option<&'a str>, ()> {
    match body.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(s)) => Ok(Some(s.as_str())),
        Some(_) => Err(()),
    }
}

async fn load(d1: &D1Database, id: &str) -> Result<Option<Container>> {
    d1.prepare(format!("SELECT {COLS} FROM containers WHERE id = ?1"))
        .bind(&[text(id)])?
        .first::<Container>(None)
        .await
}

// ---------------------------------------------------------------------------
// POST /api/containers
// ---------------------------------------------------------------------------

pub async fn create(mut req: Request, ctx: Ctx) -> Result<Response> {
    let body = match read_object(&mut req).await {
        Ok(b) => b,
        Err(r) => return r,
    };
    let parent = match parent_field(&body) {
        ParentField::Missing | ParentField::Root => None,
        ParentField::Id(p) => Some(p),
        ParentField::Invalid => return error(400, "parent_id must be a container id or null"),
    };
    let kind = match body.get("kind").and_then(Value::as_str).map(str::trim) {
        Some(k) if !k.is_empty() => k,
        _ => return error(400, "kind is required"),
    };
    let (Ok(name), Ok(memo)) = (opt_str_field(&body, "name"), opt_str_field(&body, "memo")) else {
        return error(400, "name and memo must be strings or null");
    };

    let d1 = db::db(&ctx)?;
    // 6 桁 (約 10 億通り) なので衝突はまず起きないが、起きたら引き直す。
    for _ in 0..5 {
        let id = new_id(CONTAINER_ID_LEN);
        let res = d1
            .prepare(format!(
                "INSERT INTO containers ({COLS})
                 SELECT ?1, ?2, ?3, ?4, ?5, {NOW}, {NOW}
                 WHERE NOT EXISTS (SELECT 1 FROM containers WHERE id = ?1)
                   AND (?2 IS NULL OR EXISTS (SELECT 1 FROM containers WHERE id = ?2))"
            ))
            .bind(&[
                text(&id),
                opt_text(parent.as_deref()),
                text(kind),
                opt_text(name),
                opt_text(memo),
            ])?
            .run()
            .await?;
        if db::changes(&res)? == 1 {
            let Some(c) = load(&d1, &id).await? else {
                return error(500, "container vanished after insert");
            };
            return json(201, &c);
        }
        if let Some(p) = &parent
            && !db::exists(&d1, "containers", p).await?
        {
            return error(404, "parent container not found");
        }
    }
    error(500, "could not allocate a container id")
}

// ---------------------------------------------------------------------------
// GET /api/containers/:id
// ---------------------------------------------------------------------------

#[derive(Deserialize, Serialize)]
struct Crumb {
    id: String,
    kind: String,
    name: Option<String>,
}

#[derive(Deserialize, Serialize)]
struct Child {
    id: String,
    kind: String,
    name: Option<String>,
}

#[derive(Deserialize, Serialize)]
struct StockLine {
    item_type_id: String,
    category: String,
    name: String,
    qty: i64,
}

#[derive(Deserialize, Serialize)]
struct AssetLine {
    id: String,
    item_type_id: String,
    item_name: String,
    maker: Option<String>,
    model: Option<String>,
    serial: Option<String>,
    status: String,
}

#[derive(Deserialize)]
struct Count {
    n: i64,
}

pub async fn get(_req: Request, ctx: Ctx) -> Result<Response> {
    let Some(id) = path_id(&ctx) else {
        return error(404, "container not found");
    };
    let d1 = db::db(&ctx)?;
    let descendants = format!(
        "WITH RECURSIVE d(id, depth) AS (
           SELECT ?1, 0
           UNION ALL
           SELECT c.id, d.depth + 1 FROM containers c JOIN d ON c.parent_id = d.id
           WHERE d.depth < {MAX_DEPTH}
         )"
    );
    let stmts = vec![
        d1.prepare(format!("SELECT {COLS} FROM containers WHERE id = ?1")),
        // パンくず: 自分から親へたどり、最上位 → 自分の順に並べる。
        d1.prepare(format!(
            "WITH RECURSIVE a(id, parent_id, kind, name, depth) AS (
               SELECT id, parent_id, kind, name, 0 FROM containers WHERE id = ?1
               UNION ALL
               SELECT c.id, c.parent_id, c.kind, c.name, a.depth + 1
               FROM containers c JOIN a ON c.id = a.parent_id
               WHERE a.depth < {MAX_DEPTH}
             )
             SELECT id, kind, name FROM a ORDER BY depth DESC"
        )),
        d1.prepare(
            "SELECT id, kind, name FROM containers WHERE parent_id = ?1 ORDER BY kind, name, id",
        ),
        d1.prepare(
            "SELECT s.item_type_id, t.category, t.name, s.qty
             FROM stock s JOIN item_types t ON t.id = s.item_type_id
             WHERE s.container_id = ?1 ORDER BY t.category, t.name",
        ),
        d1.prepare(
            "SELECT a.id, a.item_type_id, t.name AS item_name, a.maker, a.model, a.serial, a.status
             FROM assets a JOIN item_types t ON t.id = a.item_type_id
             WHERE a.container_id = ?1 ORDER BY t.name, a.maker, a.model, a.serial",
        ),
        d1.prepare(format!(
            "{descendants}
             SELECT s.item_type_id, t.category, t.name, SUM(s.qty) AS qty
             FROM stock s JOIN d ON s.container_id = d.id
             JOIN item_types t ON t.id = s.item_type_id
             GROUP BY s.item_type_id ORDER BY t.category, t.name"
        )),
        d1.prepare(format!(
            "{descendants}
             SELECT COUNT(*) AS n FROM assets a JOIN d ON a.container_id = d.id"
        )),
    ]
    .into_iter()
    .map(|s| s.bind(&[text(&id)]))
    .collect::<Result<Vec<_>>>()?;

    let r = d1.batch(stmts).await?;
    let Some(container) = db::first_row::<Container>(&r[0])? else {
        return error(404, "container not found");
    };
    let asset_count = db::first_row::<Count>(&r[6])?.map_or(0, |c| c.n);
    json(
        200,
        &serde_json::json!({
            "container": container,
            "breadcrumb": r[1].results::<Crumb>()?,
            "children": r[2].results::<Child>()?,
            "stock": r[3].results::<StockLine>()?,
            "assets": r[4].results::<AssetLine>()?,
            "totals": {
                "stock": r[5].results::<StockLine>()?,
                "asset_count": asset_count,
            },
        }),
    )
}

// ---------------------------------------------------------------------------
// PATCH /api/containers/:id
// ---------------------------------------------------------------------------

pub async fn patch(mut req: Request, ctx: Ctx) -> Result<Response> {
    let Some(id) = path_id(&ctx) else {
        return error(404, "container not found");
    };
    let body = match read_object(&mut req).await {
        Ok(b) => b,
        Err(r) => return r,
    };
    if let Some(k) = body
        .keys()
        .find(|k| !matches!(k.as_str(), "name" | "kind" | "memo"))
    {
        return error(
            400,
            &format!("unknown field: {k} (parent は /move で変える)"),
        );
    }

    let mut sets = Vec::new();
    let mut binds = vec![text(&id)];
    if let Some(v) = body.get("kind") {
        match v.as_str().map(str::trim) {
            Some(k) if !k.is_empty() => {
                binds.push(text(k));
                sets.push(format!("kind = ?{}", binds.len()));
            }
            _ => return error(400, "kind must be a non-empty string"),
        }
    }
    for key in ["name", "memo"] {
        if body.contains_key(key) {
            let Ok(v) = opt_str_field(&body, key) else {
                return error(400, &format!("{key} must be a string or null"));
            };
            binds.push(opt_text(v));
            sets.push(format!("{key} = ?{}", binds.len()));
        }
    }
    if sets.is_empty() {
        return error(400, "nothing to update");
    }

    let d1 = db::db(&ctx)?;
    let res = d1
        .prepare(format!(
            "UPDATE containers SET {}, updated_at = {NOW} WHERE id = ?1",
            sets.join(", ")
        ))
        .bind(&binds)?
        .run()
        .await?;
    if db::changes(&res)? == 0 {
        return error(404, "container not found");
    }
    match load(&d1, &id).await? {
        Some(c) => json(200, &c),
        None => error(404, "container not found"),
    }
}

// ---------------------------------------------------------------------------
// POST /api/containers/:id/move   { parent_id }
// ---------------------------------------------------------------------------

pub async fn move_to(mut req: Request, ctx: Ctx) -> Result<Response> {
    let Some(id) = path_id(&ctx) else {
        return error(404, "container not found");
    };
    let body = match read_object(&mut req).await {
        Ok(b) => b,
        Err(r) => return r,
    };
    let to = match parent_field(&body) {
        ParentField::Missing => return error(400, "parent_id is required (null で最上位へ)"),
        ParentField::Root => None,
        ParentField::Id(p) => Some(p),
        ParentField::Invalid => return error(400, "parent_id must be a container id or null"),
    };

    let d1 = db::db(&ctx)?;
    let movement_id = new_id(ROW_ID_LEN);
    // 1 文目: 移動先が存在し、かつ移動先の祖先 (移動先自身を含む) に自分が居ないときだけ
    //         movements を 1 行書く。from_id には移動前の親を残す。
    // 2 文目: その movements 行が書けたときだけ親を付け替える。
    // batch は 1 トランザクションなので、判定と更新の間に割り込まれない。
    let record = d1
        .prepare(format!(
            "INSERT INTO movements (id, at, actor, kind, container_id, from_id, to_id)
             SELECT ?1, {NOW}, ?4, 'container_move', c.id, c.parent_id, ?3
             FROM containers c
             WHERE c.id = ?2
               AND (?3 IS NULL OR EXISTS (SELECT 1 FROM containers WHERE id = ?3))
               AND NOT EXISTS (
                 WITH RECURSIVE a(id, depth) AS (
                   SELECT ?3, 0
                   UNION ALL
                   SELECT p.parent_id, a.depth + 1 FROM containers p JOIN a ON p.id = a.id
                   WHERE p.parent_id IS NOT NULL AND a.depth < {MAX_DEPTH}
                 )
                 SELECT 1 FROM a WHERE a.id = ?2
               )"
        ))
        .bind(&[
            text(&movement_id),
            text(&id),
            opt_text(to.as_deref()),
            text(&ctx.data.0),
        ])?;
    let apply = d1
        .prepare(format!(
            "UPDATE containers SET parent_id = ?3, updated_at = {NOW}
             WHERE id = ?2 AND EXISTS (SELECT 1 FROM movements WHERE id = ?1)"
        ))
        .bind(&[text(&movement_id), text(&id), opt_text(to.as_deref())])?;
    let r = d1.batch(vec![record, apply]).await?;

    if db::changes(&r[1])? == 1 {
        return match load(&d1, &id).await? {
            Some(c) => json(200, &c),
            None => error(404, "container not found"),
        };
    }
    if !db::exists(&d1, "containers", &id).await? {
        return error(404, "container not found");
    }
    if let Some(p) = &to
        && !db::exists(&d1, "containers", p).await?
    {
        return error(404, "parent container not found");
    }
    error(409, "cannot move a container into itself or its descendant")
}

// ---------------------------------------------------------------------------
// DELETE /api/containers/:id
// ---------------------------------------------------------------------------

pub async fn delete(_req: Request, ctx: Ctx) -> Result<Response> {
    let Some(id) = path_id(&ctx) else {
        return error(404, "container not found");
    };
    let d1 = db::db(&ctx)?;
    let res = d1
        .prepare(
            "DELETE FROM containers WHERE id = ?1
               AND NOT EXISTS (SELECT 1 FROM containers WHERE parent_id = ?1)
               AND NOT EXISTS (SELECT 1 FROM stock WHERE container_id = ?1)
               AND NOT EXISTS (SELECT 1 FROM assets WHERE container_id = ?1)",
        )
        .bind(&[text(&id)])?
        .run()
        .await?;
    if db::changes(&res)? == 1 {
        return Ok(Response::empty()?.with_status(204));
    }
    if db::exists(&d1, "containers", &id).await? {
        error(
            409,
            "container is not empty (children, stock or assets remain)",
        )
    } else {
        error(404, "container not found")
    }
}

// ---------------------------------------------------------------------------
// POST /api/containers/:id/stock   { item_type_id, delta, note }
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
struct Qty {
    qty: i64,
}

pub async fn stock_delta(mut req: Request, ctx: Ctx) -> Result<Response> {
    let Some(id) = path_id(&ctx) else {
        return error(404, "container not found");
    };
    let body = match read_object(&mut req).await {
        Ok(b) => b,
        Err(r) => return r,
    };
    let Some(item_type_id) = body.get("item_type_id").and_then(Value::as_str) else {
        return error(400, "item_type_id is required");
    };
    // D1 の整数は JS の number を通るので i32 の範囲に収める。
    let delta = match body.get("delta").and_then(Value::as_i64) {
        Some(d) if d != 0 && d.abs() <= i32::MAX as i64 => d,
        _ => return error(400, "delta must be a non-zero integer"),
    };
    let Ok(note) = opt_str_field(&body, "note") else {
        return error(400, "note must be a string or null");
    };
    let kind = if delta > 0 { "stock_in" } else { "stock_out" };

    let d1 = db::db(&ctx)?;
    let movement_id = new_id(ROW_ID_LEN);
    // SQLite は「最大の番号」ぶんの値を要求するので、文ごとに必要な先頭部分だけ渡す。
    let binds = [
        text(&movement_id),
        text(kind),
        text(&id),
        text(item_type_id),
        int(delta),
        opt_text(note),
        text(&ctx.data.0),
    ];
    // 1 文目: コンテナと数量管理の品目が存在し、出した後も 0 以上になるときだけ記録する。
    // 2 文目: 記録できたときだけ本数を足す (行が無ければ作る)。
    // 3 文目: 0 本になった行は消す (中身一覧に 0 本を並べない)。
    let record = d1
        .prepare(format!(
            "INSERT INTO movements (id, at, actor, kind, container_id, item_type_id, qty_delta, note)
             SELECT ?1, {NOW}, ?7, ?2, ?3, ?4, ?5, ?6
             WHERE EXISTS (SELECT 1 FROM containers WHERE id = ?3)
               AND EXISTS (SELECT 1 FROM item_types WHERE id = ?4 AND tracking = 'quantity')
               AND COALESCE((SELECT qty FROM stock WHERE container_id = ?3 AND item_type_id = ?4), 0) + ?5 >= 0"
        ))
        .bind(&binds)?;
    // SQLite は UPSERT でも一意制約より先に CHECK (qty >= 0) を見る。負の delta を
    // そのまま挿入値にすると衝突更新まで届かず落ちるので、挿入値は 0 で下を切り、
    // 既存行への加算は delta (?5) を直接使う。
    let apply = d1
        .prepare(
            "INSERT INTO stock (container_id, item_type_id, qty)
             SELECT ?3, ?4, MAX(?5, 0) WHERE EXISTS (SELECT 1 FROM movements WHERE id = ?1)
             ON CONFLICT (container_id, item_type_id) DO UPDATE SET qty = qty + ?5",
        )
        .bind(&binds[..5])?;
    let prune = d1
        .prepare("DELETE FROM stock WHERE container_id = ?1 AND item_type_id = ?2 AND qty = 0")
        .bind(&binds[2..4])?;
    let after = d1
        .prepare(
            "SELECT COALESCE((SELECT qty FROM stock WHERE container_id = ?1 AND item_type_id = ?2), 0) AS qty",
        )
        .bind(&binds[2..4])?;
    let r = d1.batch(vec![record, apply, prune, after]).await?;

    if db::changes(&r[0])? == 1 {
        let qty = db::first_row::<Qty>(&r[3])?.map_or(0, |q| q.qty);
        return json(
            200,
            &serde_json::json!({
                "container_id": id,
                "item_type_id": item_type_id,
                "qty": qty,
                "movement_id": movement_id,
            }),
        );
    }
    if !db::exists(&d1, "containers", &id).await? {
        return error(404, "container not found");
    }
    #[derive(Deserialize)]
    struct Tracking {
        tracking: String,
    }
    let tracking = d1
        .prepare("SELECT tracking FROM item_types WHERE id = ?1")
        .bind(&[text(item_type_id)])?
        .first::<Tracking>(None)
        .await?;
    match tracking {
        None => error(404, "item type not found"),
        Some(t) if t.tracking != "quantity" => {
            error(422, "item type is individually tracked; use assets instead")
        }
        Some(_) => error(409, "not enough stock"),
    }
}
