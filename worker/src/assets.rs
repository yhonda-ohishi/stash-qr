//! 個体 (assets): 製品ラベルで 1 台ずつ追う物品。
//!
//! - `POST /api/assets/judge-label` 本文はラベルの写真。Gemini の読み取りと Flickr 保存を
//!   並行で走らせ、提案 (メーカー・型番・シリアル) と既存個体との一致を返す
//! - `POST /api/assets` 個体を作る (ラベル判定の確定)。`judgement_id` があれば final_json を残す
//! - `GET /api/assets/:id` / `PATCH /api/assets/:id` (状態・メモ・ラベルの値)
//! - `POST /api/assets/:id/move` `{ container_id }` (null = 持ち出し中など)
//!
//! AI の読み取りは提案で、確定はユーザー (`POST /api/assets` に編集後の値が来る)。

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use worker::*;

use crate::containers::{Crumb, breadcrumb_sql};
use crate::db::{self, NOW, opt_text, text};
use crate::gemini::{self, Gemini};
use crate::id::{ROW_ID_LEN, new_id, normalize_container_id};
use crate::photos::{self, NewPhoto};
use crate::{Ctx, error, json, read_object};

const STATUSES: [&str; 4] = ["in_stock", "lent", "broken", "disposed"];

#[derive(Deserialize, Serialize, Clone)]
pub(crate) struct Asset {
    pub id: String,
    pub item_type_id: String,
    pub item_name: String,
    pub container_id: Option<String>,
    pub maker: Option<String>,
    pub model: Option<String>,
    pub serial: Option<String>,
    pub status: String,
    pub memo: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

const SELECT: &str = "SELECT a.id, a.item_type_id, t.name AS item_name, a.container_id, a.maker,
                             a.model, a.serial, a.status, a.memo, a.created_at, a.updated_at
                      FROM assets a JOIN item_types t ON t.id = a.item_type_id";

async fn load(d1: &D1Database, id: &str) -> Result<Option<Asset>> {
    d1.prepare(format!("{SELECT} WHERE a.id = ?1"))
        .bind(&[text(id)])?
        .first::<Asset>(None)
        .await
}

/// 前後の空白を落とし、空なら `None`。ラベルの値は大文字小文字を保つ。
fn clean(v: Option<&Value>) -> Option<String> {
    v.and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

// ---------------------------------------------------------------------------
// 既存個体との照合 (フェーズ 3b のコンテナ判定でも使う)
// ---------------------------------------------------------------------------

#[derive(Serialize)]
pub(crate) struct Matches {
    /// シリアルが一致した個体 (確度 高)。
    pub serial: Vec<Asset>,
    /// 型番が一致した個体。1 件なら確度 中、複数ならユーザーに選ばせる。
    pub model: Vec<Asset>,
}

pub(crate) async fn find_matches(
    d1: &D1Database,
    model: Option<&str>,
    serial: Option<&str>,
) -> Result<Matches> {
    let by = |col: &str, v: &str| {
        d1.prepare(format!(
            "{SELECT} WHERE UPPER(TRIM(a.{col})) = UPPER(TRIM(?1)) AND a.status != 'disposed'
             ORDER BY a.updated_at DESC LIMIT 20"
        ))
        .bind(&[text(v)])
    };
    let serial = match serial {
        Some(s) => by("serial", s)?.all().await?.results::<Asset>()?,
        None => vec![],
    };
    let model = match model {
        Some(m) => by("model", m)?.all().await?.results::<Asset>()?,
        None => vec![],
    };
    Ok(Matches { serial, model })
}

// ---------------------------------------------------------------------------
// POST /api/assets/judge-label
// ---------------------------------------------------------------------------

pub async fn judge_label(mut req: Request, ctx: Ctx) -> Result<Response> {
    let Some(ai) = Gemini::from_env(&ctx.env) else {
        return error(503, "GEMINI_API_KEY / GEMINI_MODEL is not configured");
    };
    let (bytes, ct) = match photos::read_image(&mut req).await {
        Ok(v) => v,
        Err(r) => return r,
    };
    let d1 = db::db(&ctx)?;
    let meta = NewPhoto {
        kind: "label",
        container_id: None,
        asset_id: None,
        taken_at: None,
    };
    // 判定を Flickr のアップロード待ちにしない (docs/design.md「Flickr 連携」)。
    let (proposal, photo) = futures_util::future::join(
        ai.judge(&bytes, &ct, gemini::LABEL_PROMPT, &gemini::label_schema()),
        photos::store(&ctx.env, &d1, &meta, &bytes, &ct),
    )
    .await;
    let photo = photo?;
    let proposal = match proposal {
        Ok(p) => p,
        Err(msg) => {
            console_error!("label judge failed: {msg}");
            // 写真は残っているので、撮り直さずに手入力で登録できる。
            return json(502, &json!({ "error": "AI judge failed", "photo": photo }));
        }
    };

    let judgement_id = new_id(ROW_ID_LEN);
    d1.prepare(format!(
        "INSERT INTO ai_judgements (id, kind, at, model, proposal_json) VALUES (?1, 'label', {NOW}, ?2, ?3)"
    ))
    .bind(&[text(&judgement_id), text(&ai.model), text(&proposal.to_string())])?
    .run()
    .await?;
    photos::link_judgement(&d1, &photo.id, &judgement_id).await?;

    let matches = find_matches(
        &d1,
        clean(proposal.get("model")).as_deref(),
        clean(proposal.get("serial")).as_deref(),
    )
    .await?;
    json(
        200,
        &json!({
            "judgement_id": judgement_id,
            "model": ai.model,
            "proposal": proposal,
            "matches": matches,
            "photo": photo,
        }),
    )
}

// ---------------------------------------------------------------------------
// POST /api/assets
// ---------------------------------------------------------------------------

pub async fn create(mut req: Request, ctx: Ctx) -> Result<Response> {
    let body = match read_object(&mut req).await {
        Ok(b) => b,
        Err(r) => return r,
    };
    let maker = clean(body.get("maker"));
    let model = clean(body.get("model"));
    let serial = clean(body.get("serial"));
    let memo = clean(body.get("memo"));
    let status = clean(body.get("status")).unwrap_or_else(|| "in_stock".into());
    if !STATUSES.contains(&status.as_str()) {
        return error(400, "status must be in_stock, lent, broken or disposed");
    }
    let container_id = match body.get("container_id") {
        None | Some(Value::Null) => None,
        Some(Value::String(s)) => match normalize_container_id(s) {
            Some(c) => Some(c),
            None => return error(404, "container not found"),
        },
        Some(_) => return error(400, "container_id must be a string or null"),
    };
    let judgement_id = clean(body.get("judgement_id"));
    let photo_id = clean(body.get("photo_id"));

    let d1 = db::db(&ctx)?;
    if let Some(c) = &container_id
        && !db::exists(&d1, "containers", c).await?
    {
        return error(404, "container not found");
    }
    if let Some(p) = &photo_id
        && !db::exists(&d1, "photos", p).await?
    {
        return error(404, "photo not found");
    }
    if let Some(j) = &judgement_id {
        #[derive(Deserialize)]
        struct J {
            kind: String,
            final_json: Option<String>,
        }
        let row = d1
            .prepare("SELECT kind, final_json FROM ai_judgements WHERE id = ?1")
            .bind(&[text(j)])?
            .first::<J>(None)
            .await?;
        match row {
            None => return error(404, "judgement not found"),
            Some(r) if r.kind != "label" => {
                return error(422, "judgement is not a label judgement");
            }
            Some(r) if r.final_json.is_some() => {
                return error(409, "judgement is already confirmed");
            }
            Some(_) => {}
        }
    }

    // 品目: 指定が無ければ「category (既定 device) × 名前 (既定 = 型番)」で探し、無ければ作る。
    let item_type_id = match clean(body.get("item_type_id")) {
        Some(id) => id,
        None => {
            let Some(name) = clean(body.get("name")).or_else(|| model.clone()) else {
                return error(400, "item_type_id, name or model is required");
            };
            let category = clean(body.get("category")).unwrap_or_else(|| "device".into());
            d1.prepare(format!(
                "INSERT INTO item_types (id, category, name, tracking, created_at)
                 VALUES (?1, ?2, ?3, 'individual', {NOW}) ON CONFLICT (category, name) DO NOTHING"
            ))
            .bind(&[text(&new_id(ROW_ID_LEN)), text(&category), text(&name)])?
            .run()
            .await?;
            #[derive(Deserialize)]
            struct Id {
                id: String,
            }
            match d1
                .prepare("SELECT id FROM item_types WHERE category = ?1 AND name = ?2")
                .bind(&[text(&category), text(&name)])?
                .first::<Id>(None)
                .await?
            {
                Some(r) => r.id,
                None => return error(500, "item type vanished after insert"),
            }
        }
    };
    #[derive(Deserialize)]
    struct Tracking {
        tracking: String,
    }
    match d1
        .prepare("SELECT tracking FROM item_types WHERE id = ?1")
        .bind(&[text(&item_type_id)])?
        .first::<Tracking>(None)
        .await?
    {
        None => return error(404, "item type not found"),
        Some(t) if t.tracking != "individual" => {
            return error(422, "item type is tracked by quantity; use stock instead");
        }
        Some(_) => {}
    }

    let id = new_id(ROW_ID_LEN);
    let final_json = json!({
        "item_type_id": item_type_id, "maker": maker, "model": model, "serial": serial,
        "container_id": container_id, "status": status, "memo": memo,
    })
    .to_string();
    let actor = ctx.data.0.clone();
    // 1 文目で個体を作る。同じ (maker, model, serial) が既にあれば何もしない (→ 409)。
    // 以降は個体が作れたときだけ効く (id は今作ったものなので EXISTS で判定できる)。
    let insert = d1
        .prepare(format!(
            "INSERT INTO assets (id, item_type_id, container_id, maker, model, serial, status, memo, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, {NOW}, {NOW})
             ON CONFLICT (maker, model, serial) DO NOTHING"
        ))
        .bind(&[
            text(&id),
            text(&item_type_id),
            opt_text(container_id.as_deref()),
            opt_text(maker.as_deref()),
            opt_text(model.as_deref()),
            opt_text(serial.as_deref()),
            text(&status),
            opt_text(memo.as_deref()),
        ])?;
    let movement = d1
        .prepare(format!(
            "INSERT INTO movements (id, at, actor, kind, asset_id, item_type_id, to_id, note)
             SELECT ?1, {NOW}, ?2, 'asset_move', ?3, ?4, ?5, 'registered'
             WHERE ?5 IS NOT NULL AND EXISTS (SELECT 1 FROM assets WHERE id = ?3)"
        ))
        .bind(&[
            text(&new_id(ROW_ID_LEN)),
            text(&actor),
            text(&id),
            text(&item_type_id),
            opt_text(container_id.as_deref()),
        ])?;
    let confirm = d1
        .prepare(
            "UPDATE ai_judgements SET final_json = ?2, asset_id = ?3
             WHERE id = ?1 AND final_json IS NULL AND EXISTS (SELECT 1 FROM assets WHERE id = ?3)",
        )
        .bind(&[
            opt_text(judgement_id.as_deref()),
            text(&final_json),
            text(&id),
        ])?;
    let link_photo = d1
        .prepare(
            "UPDATE photos SET asset_id = ?2
             WHERE id = ?1 AND asset_id IS NULL AND EXISTS (SELECT 1 FROM assets WHERE id = ?2)",
        )
        .bind(&[opt_text(photo_id.as_deref()), text(&id)])?;
    let r = d1
        .batch(vec![insert, movement, confirm, link_photo])
        .await?;

    if db::changes(&r[0])? == 1 {
        return match load(&d1, &id).await? {
            Some(a) => json(201, &json!({ "asset": a })),
            None => error(500, "asset vanished after insert"),
        };
    }
    let existing = d1
        .prepare(format!(
            "{SELECT} WHERE a.maker IS ?1 AND a.model IS ?2 AND a.serial IS ?3"
        ))
        .bind(&[
            opt_text(maker.as_deref()),
            opt_text(model.as_deref()),
            opt_text(serial.as_deref()),
        ])?
        .first::<Asset>(None)
        .await?;
    json(
        409,
        &json!({ "error": "an asset with the same maker, model and serial exists", "asset": existing }),
    )
}

// ---------------------------------------------------------------------------
// GET /api/assets/:id
// ---------------------------------------------------------------------------

/// `GET /api/assets/:id` と `GET /a/:id` (HTML) が共用する取得部。
pub(crate) struct AssetView {
    pub(crate) asset: Asset,
    pub(crate) breadcrumb: Vec<Crumb>,
    pub(crate) photos: Vec<photos::PhotoRef>,
}

pub(crate) async fn load_view(d1: &D1Database, id: &str) -> Result<Option<AssetView>> {
    let Some(asset) = load(d1, id).await? else {
        return Ok(None);
    };
    let breadcrumb = match &asset.container_id {
        Some(c) => d1
            .prepare(breadcrumb_sql())
            .bind(&[text(c)])?
            .all()
            .await?
            .results::<Crumb>()?,
        None => vec![],
    };
    let photos = photos::list_for(d1, photos::Owner::Asset(id)).await?;
    Ok(Some(AssetView {
        asset,
        breadcrumb,
        photos,
    }))
}

pub async fn get(_req: Request, ctx: Ctx) -> Result<Response> {
    let Some(id) = ctx.param("id").cloned() else {
        return error(404, "asset not found");
    };
    let d1 = db::db(&ctx)?;
    let Some(view) = load_view(&d1, &id).await? else {
        return error(404, "asset not found");
    };
    json(
        200,
        &json!({ "asset": view.asset, "breadcrumb": view.breadcrumb, "photos": view.photos }),
    )
}

// ---------------------------------------------------------------------------
// PATCH /api/assets/:id
// ---------------------------------------------------------------------------

pub async fn patch(mut req: Request, ctx: Ctx) -> Result<Response> {
    let Some(id) = ctx.param("id").cloned() else {
        return error(404, "asset not found");
    };
    let body = match read_object(&mut req).await {
        Ok(b) => b,
        Err(r) => return r,
    };
    const FIELDS: [&str; 5] = ["status", "memo", "maker", "model", "serial"];
    if let Some(k) = body.keys().find(|k| !FIELDS.contains(&k.as_str())) {
        return error(400, &format!("unknown field: {k} (場所は /move で変える)"));
    }
    if body.is_empty() {
        return error(400, "nothing to update");
    }
    let d1 = db::db(&ctx)?;
    let Some(before) = load(&d1, &id).await? else {
        return error(404, "asset not found");
    };

    let mut sets = Vec::new();
    let mut binds = vec![text(&id)];
    for key in FIELDS {
        let Some(v) = body.get(key) else { continue };
        let value = match (key, v) {
            ("status", Value::String(s)) if STATUSES.contains(&s.as_str()) => Some(s.clone()),
            ("status", _) => {
                return error(400, "status must be in_stock, lent, broken or disposed");
            }
            (_, Value::Null) => None,
            (_, Value::String(_)) => clean(Some(v)),
            _ => return error(400, &format!("{key} must be a string or null")),
        };
        binds.push(opt_text(value.as_deref()));
        sets.push(format!("{key} = ?{}", binds.len()));
    }
    let update = d1
        .prepare(format!(
            "UPDATE assets SET {}, updated_at = {NOW} WHERE id = ?1",
            sets.join(", ")
        ))
        .bind(&binds)?;
    let mut stmts = vec![update];
    if let Some(Value::String(new_status)) = body.get("status")
        && *new_status != before.status
    {
        stmts.push(
            d1.prepare(format!(
                "INSERT INTO movements (id, at, actor, kind, asset_id, item_type_id, note)
                 VALUES (?1, {NOW}, ?2, 'asset_status', ?3, ?4, ?5)"
            ))
            .bind(&[
                text(&new_id(ROW_ID_LEN)),
                text(&ctx.data.0),
                text(&id),
                text(&before.item_type_id),
                text(&format!("{} -> {new_status}", before.status)),
            ])?,
        );
    }
    // (maker, model, serial) が他の個体と重なると UNIQUE で落ちる。先に確かめて 409 にする。
    let after = |k: &str, old: &Option<String>| match body.get(k) {
        Some(v) => clean(Some(v)),
        None => old.clone(),
    };
    let (m, mo, s) = (
        after("maker", &before.maker),
        after("model", &before.model),
        after("serial", &before.serial),
    );
    if s.is_some() {
        let clash = d1
            .prepare(format!(
                "{SELECT} WHERE a.maker IS ?1 AND a.model IS ?2 AND a.serial IS ?3 AND a.id != ?4"
            ))
            .bind(&[
                opt_text(m.as_deref()),
                opt_text(mo.as_deref()),
                opt_text(s.as_deref()),
                text(&id),
            ])?
            .first::<Asset>(None)
            .await?;
        if let Some(other) = clash {
            return json(
                409,
                &json!({ "error": "an asset with the same maker, model and serial exists", "asset": other }),
            );
        }
    }
    d1.batch(stmts).await?;
    match load(&d1, &id).await? {
        Some(a) => json(200, &json!({ "asset": a })),
        None => error(404, "asset not found"),
    }
}

// ---------------------------------------------------------------------------
// POST /api/assets/:id/move   { container_id }
// ---------------------------------------------------------------------------

pub async fn move_to(mut req: Request, ctx: Ctx) -> Result<Response> {
    let Some(id) = ctx.param("id").cloned() else {
        return error(404, "asset not found");
    };
    let body = match read_object(&mut req).await {
        Ok(b) => b,
        Err(r) => return r,
    };
    let to = match body.get("container_id") {
        None => return error(400, "container_id is required (null で持ち出し中)"),
        Some(Value::Null) => None,
        Some(Value::String(s)) => match normalize_container_id(s) {
            Some(c) => Some(c),
            None => return error(404, "container not found"),
        },
        Some(_) => return error(400, "container_id must be a string or null"),
    };
    let d1 = db::db(&ctx)?;
    let movement_id = new_id(ROW_ID_LEN);
    let binds = [
        text(&movement_id),
        text(&id),
        opt_text(to.as_deref()),
        text(&ctx.data.0),
    ];
    // コンテナの移動と同じ形: 記録できたときだけ場所を変える (1 トランザクション)。
    let record = d1
        .prepare(format!(
            "INSERT INTO movements (id, at, actor, kind, asset_id, item_type_id, from_id, to_id)
             SELECT ?1, {NOW}, ?4, 'asset_move', a.id, a.item_type_id, a.container_id, ?3
             FROM assets a
             WHERE a.id = ?2 AND (?3 IS NULL OR EXISTS (SELECT 1 FROM containers WHERE id = ?3))"
        ))
        .bind(&binds)?;
    let apply = d1
        .prepare(format!(
            "UPDATE assets SET container_id = ?3, updated_at = {NOW}
             WHERE id = ?2 AND EXISTS (SELECT 1 FROM movements WHERE id = ?1)"
        ))
        .bind(&binds[..3])?;
    let r = d1.batch(vec![record, apply]).await?;
    if db::changes(&r[1])? == 1 {
        return match load(&d1, &id).await? {
            Some(a) => json(200, &json!({ "asset": a })),
            None => error(404, "asset not found"),
        };
    }
    if !db::exists(&d1, "assets", &id).await? {
        return error(404, "asset not found");
    }
    error(404, "container not found")
}
