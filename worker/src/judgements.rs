//! AI 判定の共通部分と、コンテナ写真の判定・確定。
//!
//! - `POST /api/containers/:id/judge` 本文はコンテナの写真。Gemini の判定と Flickr 保存を
//!   並行で走らせ、提案 (数量物・個体候補) と既存の品目・個体との照合、今の中身を返す
//! - `GET /api/judgements/:id` 確定していないコンテナ判定を、上と同じ形で返す (保存済みの提案から再開)
//! - `POST /api/judgements/:id/confirm` `{ final: { stock, assets, new_assets? } }` ユーザーが直した一覧で
//!   コンテナ直下の本数と個体の置き場所を書き換え、final_json を残す。new_assets は未登録の個体を
//!   このコンテナに新しく登録する (品目は category・name で探し、無ければ個体管理で作る)
//!
//! 確定は 1 回の batch で流す。1 文目 (final_json の保存) が成り立ったときだけ後続が効くよう、
//! 後続は「final_json に今回の confirm_id が入っていること」で守る (二重確定・途中失敗を防ぐ)。
//! 可変長の一覧は `json_each(?)` で渡し、SQL を動的に組み立てない。

use std::collections::HashSet;

use serde::Deserialize;
use serde_json::{Map, Value, json};
use worker::*;

use crate::assets::{self, Asset};
use crate::containers;
use crate::db::{self, NOW, opt_text, text};
use crate::gemini::{self, Gemini};
use crate::id::{ROW_ID_LEN, new_id, normalize_container_id};
use crate::photos::{self, NewPhoto, PhotoView};
use crate::{Ctx, error, json, read_object};

// ---------------------------------------------------------------------------
// 判定の共通部分 (ラベル判定からも使う)
// ---------------------------------------------------------------------------

pub(crate) struct Judged {
    pub judgement_id: String,
    pub model: String,
    pub proposal: Value,
    pub photo: PhotoView,
}

/// 本文の画像を Gemini に判定させつつ Flickr に保存し、提案を ai_judgements に残す。
/// ai_judgements の kind・container_id・asset_id は写真の meta と同じ値にする。
/// 途中で返す応答 (503 / 415 / 502 など) は `Ok(Err(応答))`。
pub(crate) async fn judge_and_store(
    req: &mut Request,
    ctx: &Ctx,
    prompt: &str,
    schema: &Value,
    meta: NewPhoto<'_>,
) -> Result<std::result::Result<Judged, Result<Response>>> {
    let Some(ai) = Gemini::from_env(&ctx.env) else {
        return Ok(Err(error(
            503,
            "GEMINI_API_KEY / GEMINI_MODEL is not configured",
        )));
    };
    let (bytes, ct) = match photos::read_image(req).await {
        Ok(v) => v,
        Err(r) => return Ok(Err(r)),
    };
    let d1 = db::db(ctx)?;
    // 判定を Flickr のアップロード待ちにしない (docs/design.md「Flickr 連携」)。
    let (proposal, photo) = futures_util::future::join(
        ai.judge(&bytes, &ct, prompt, schema),
        photos::store(&ctx.env, &d1, &meta, &bytes, &ct),
    )
    .await;
    let photo = photo?;
    let proposal = match proposal {
        Ok(p) => p,
        Err(msg) => {
            console_error!("{} judge failed: {msg}", meta.kind);
            // 写真は残っているので、撮り直さずに手入力で登録できる。
            return Ok(Err(json(
                502,
                &json!({ "error": "AI judge failed", "photo": photo }),
            )));
        }
    };

    let judgement_id = new_id(ROW_ID_LEN);
    d1.prepare(format!(
        "INSERT INTO ai_judgements (id, kind, container_id, asset_id, at, model, proposal_json)
         VALUES (?1, ?2, ?3, ?4, {NOW}, ?5, ?6)"
    ))
    .bind(&[
        text(&judgement_id),
        text(meta.kind),
        opt_text(meta.container_id),
        opt_text(meta.asset_id),
        text(&ai.model),
        text(&proposal.to_string()),
    ])?
    .run()
    .await?;
    photos::link_judgement(&d1, &photo.id, &judgement_id).await?;
    Ok(Ok(Judged {
        judgement_id,
        model: ai.model,
        proposal,
        photo,
    }))
}

/// 確定の前後に判定の状態を調べる。確定してよければ `None`、だめなら (status, 理由)。
/// 確定の書き込みそのものは条件付き文で守り、これは失敗の理由の切り分けに使う。
pub(crate) async fn judgement_state(
    d1: &D1Database,
    id: &str,
    expected_kind: &str,
) -> Result<Option<(u16, String)>> {
    #[derive(Deserialize)]
    struct J {
        kind: String,
        final_json: Option<String>,
    }
    let row = d1
        .prepare("SELECT kind, final_json FROM ai_judgements WHERE id = ?1")
        .bind(&[text(id)])?
        .first::<J>(None)
        .await?;
    Ok(match row {
        None => Some((404, "judgement not found".into())),
        Some(r) if r.kind != expected_kind => {
            Some((422, format!("judgement is not a {expected_kind} judgement")))
        }
        Some(r) if r.final_json.is_some() => Some((409, "judgement is already confirmed".into())),
        Some(_) => None,
    })
}

// ---------------------------------------------------------------------------
// POST /api/containers/:id/judge
// ---------------------------------------------------------------------------

/// 登録済みの数量品目のうち、指示文に添える件数。
const KNOWN_LIMIT: i64 = 100;

pub async fn judge_container(mut req: Request, ctx: Ctx) -> Result<Response> {
    let Some(id) = ctx.param("id").and_then(|s| normalize_container_id(s)) else {
        return error(404, "container not found");
    };
    let d1 = db::db(&ctx)?;
    // AI を呼ぶ前に確かめる (無いコンテナの写真に Gemini の費用を払わない)。
    if !db::exists(&d1, "containers", &id).await? {
        return error(404, "container not found");
    }
    #[derive(Deserialize)]
    struct Known {
        category: String,
        name: String,
    }
    let known: Vec<(String, String)> = d1
        .prepare(
            "SELECT category, name FROM item_types WHERE tracking = 'quantity'
             ORDER BY category, name LIMIT ?1",
        )
        .bind(&[db::int(KNOWN_LIMIT)])?
        .all()
        .await?
        .results::<Known>()?
        .into_iter()
        .map(|k| (k.category, k.name))
        .collect();
    let meta = NewPhoto {
        kind: "container",
        container_id: Some(&id),
        asset_id: None,
        taken_at: None,
    };
    let j = match judge_and_store(
        &mut req,
        &ctx,
        &gemini::container_prompt(&known),
        &gemini::container_schema(),
        meta,
    )
    .await?
    {
        Ok(j) => j,
        Err(r) => return r,
    };

    let photo = json!(j.photo);
    match build_result(&d1, &id, &j.judgement_id, &j.model, j.proposal, photo).await? {
        Some(v) => json(200, &v),
        None => error(404, "container not found"),
    }
}

/// 提案を既存の品目・個体と照合し、今の中身を添えて判定の応答 (JudgeResult) を組む。
/// `POST /api/containers/:id/judge` と `GET /api/judgements/:id` (提案から再開) が共用する。
/// コンテナが無ければ `None`。
async fn build_result(
    d1: &D1Database,
    id: &str,
    judgement_id: &str,
    model: &str,
    proposal: Value,
    photo: Value,
) -> Result<Option<Value>> {
    let empty = vec![];
    let stock_lines = proposal
        .get("stock")
        .and_then(Value::as_array)
        .unwrap_or(&empty);
    let asset_lines = proposal
        .get("assets")
        .and_then(Value::as_array)
        .unwrap_or(&empty);

    // 数量物: 登録済みの数量品目と category・name (大文字小文字は無視) で照合する。
    #[derive(Deserialize)]
    struct Hit {
        idx: i64,
        item_type_id: Option<String>,
    }
    let wanted: Vec<Value> = stock_lines
        .iter()
        .map(|l| json!({ "category": str_of(l, "category"), "name": str_of(l, "name") }))
        .collect();
    let hits = d1
        .prepare(
            "SELECT CAST(j.key AS INTEGER) AS idx, MIN(t.id) AS item_type_id
             FROM json_each(?1) j
             LEFT JOIN item_types t
               ON t.tracking = 'quantity'
              AND lower(t.category) = lower(json_extract(j.value, '$.category'))
              AND lower(t.name) = lower(json_extract(j.value, '$.name'))
             GROUP BY j.key ORDER BY j.key",
        )
        .bind(&[text(&Value::Array(wanted).to_string())])?
        .all()
        .await?
        .results::<Hit>()?;
    let stock: Vec<Value> = stock_lines
        .iter()
        .enumerate()
        .map(|(i, l)| {
            let mut l = l.clone();
            let hit = hits
                .iter()
                .find(|h| h.idx == i as i64)
                .and_then(|h| h.item_type_id.clone());
            if let Some(o) = l.as_object_mut() {
                o.insert("item_type_id".into(), json!(hit));
            }
            l
        })
        .collect();

    // 個体: シリアル一致 = high、型番一致 1 件 = medium、複数 = choose、無し = new。
    let mut asset_out = Vec::with_capacity(asset_lines.len());
    for l in asset_lines {
        let m = assets::find_matches(
            d1,
            assets::clean(l.get("model")).as_deref(),
            assets::clean(l.get("serial")).as_deref(),
        )
        .await?;
        let (level, candidates): (&str, Vec<Asset>) = if !m.serial.is_empty() {
            ("high", m.serial)
        } else {
            match m.model.len() {
                0 => ("new", vec![]),
                1 => ("medium", m.model),
                _ => ("choose", m.model),
            }
        };
        let mut l = l.clone();
        if let Some(o) = l.as_object_mut() {
            o.insert("match".into(), json!(level));
            o.insert("candidates".into(), json!(candidates));
        }
        asset_out.push(l);
    }

    let Some(view) = containers::load_view(d1, id).await? else {
        return Ok(None);
    };
    Ok(Some(json!({
        "judgement_id": judgement_id,
        "model": model,
        "container_id": id,
        "proposal": proposal,
        "stock": stock,
        "assets": asset_out,
        "current": { "stock": view.stock, "assets": view.assets },
        "photo": photo,
    })))
}

// ---------------------------------------------------------------------------
// GET /api/judgements/:id   確定していないコンテナ判定を、判定の応答と同じ形で返す
// ---------------------------------------------------------------------------

/// 保存済みの提案から編集を再開する (撮り直し・AI の待ちが要らない)。
/// 照合と今の中身は読んだ時点のもの。写真はその判定に結ばれた最新の 1 枚 (無ければ null)。
pub async fn get(_req: Request, ctx: Ctx) -> Result<Response> {
    let Some(jid) = ctx.param("id").cloned() else {
        return error(404, "judgement not found");
    };
    let d1 = db::db(&ctx)?;
    if let Some((status, msg)) = judgement_state(&d1, &jid, "container").await? {
        return error(status, &msg);
    }
    #[derive(Deserialize)]
    struct J {
        container_id: Option<String>,
        model: String,
        proposal_json: String,
    }
    let Some(row) = d1
        .prepare("SELECT container_id, model, proposal_json FROM ai_judgements WHERE id = ?1")
        .bind(&[text(&jid)])?
        .first::<J>(None)
        .await?
    else {
        return error(404, "judgement not found");
    };
    let Some(cid) = row.container_id else {
        return error(404, "container not found");
    };
    let proposal: Value = serde_json::from_str(&row.proposal_json).unwrap_or(Value::Null);
    let photo = json!(photos::latest_for_judgement(&d1, &jid).await?);
    match build_result(&d1, &cid, &jid, &row.model, proposal, photo).await? {
        Some(v) => json(200, &v),
        None => error(404, "container not found"),
    }
}

fn str_of(v: &Value, key: &str) -> Option<String> {
    v.get(key)
        .and_then(Value::as_str)
        .map(|s| s.trim().to_string())
}

// ---------------------------------------------------------------------------
// POST /api/judgements/:id/confirm
// ---------------------------------------------------------------------------

/// コンテナ自体の種別・名前 (final.container、任意)。kind は空不可、name は trim して空なら無し。
type ContainerFinal = (String, Option<String>);
/// parse_final() の戻り値: stock の行 (json_each 用)・個体 ID の一覧・コンテナ自体の種別/名前・
/// 新しく登録する個体 (json_each 用)。
type ParsedFinal = (Vec<Value>, Vec<String>, Option<ContainerFinal>, Vec<Value>);

/// 本文の final を検査し、SQL に渡す stock の行 (json_each 用) と個体 ID の一覧にする。
/// stock の各行: `{ id, category, name, qty, attrs, new_id }`。id が無い行は名前で照合し、
/// 無ければ new_id で数量品目を作る。new_assets の各行: `{ id, type_id, category, name, maker, model, serial }`。
/// id は作る個体の ID、type_id は品目が無いときに作る品目の ID。
fn parse_final(body: &Map<String, Value>) -> std::result::Result<ParsedFinal, String> {
    let Some(Value::Object(fin)) = body.get("final") else {
        return Err("final must be an object".into());
    };
    let Some(Value::Array(stock)) = fin.get("stock") else {
        return Err("final.stock must be an array".into());
    };
    let Some(Value::Array(assets)) = fin.get("assets") else {
        return Err("final.assets must be an array".into());
    };
    let container: Option<ContainerFinal> = match fin.get("container") {
        None | Some(Value::Null) => None,
        Some(Value::Object(c)) => {
            let Some(kind) = c
                .get("kind")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|s| !s.is_empty())
            else {
                return Err("final.container.kind must be a non-empty string".into());
            };
            let name = c
                .get("name")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(str::to_string);
            Some((kind.to_string(), name))
        }
        Some(_) => return Err("final.container must be an object".into()),
    };

    let mut lines = Vec::with_capacity(stock.len());
    let mut ids = HashSet::new();
    let mut names = HashSet::new();
    for (i, l) in stock.iter().enumerate() {
        let Value::Object(l) = l else {
            return Err(format!("final.stock[{i}] must be an object"));
        };
        // D1 の整数は JS の number を通るので i32 の範囲に収める。
        let qty = match l.get("qty").and_then(Value::as_i64) {
            Some(q) if (0..=i32::MAX as i64).contains(&q) => q,
            _ => {
                return Err(format!(
                    "final.stock[{i}].qty must be a non-negative integer"
                ));
            }
        };
        let nonempty = |k: &str| {
            l.get(k)
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(str::to_string)
        };
        if let Some(id) = nonempty("item_type_id") {
            if !ids.insert(id.clone()) {
                return Err(format!("final.stock: item_type_id {id} appears twice"));
            }
            lines.push(json!({ "id": id, "qty": qty }));
            continue;
        }
        let (Some(category), Some(name)) = (nonempty("category"), nonempty("name")) else {
            return Err(format!(
                "final.stock[{i}] needs item_type_id or category and name"
            ));
        };
        // SQLite の lower() と同じく ASCII だけを畳む。
        if !names.insert((category.to_ascii_lowercase(), name.to_ascii_lowercase())) {
            return Err(format!("final.stock: {category} / {name} appears twice"));
        }
        let attrs = match l.get("attrs") {
            None | Some(Value::Null) => Value::Null,
            Some(v @ Value::Object(_)) => v.clone(),
            Some(_) => return Err(format!("final.stock[{i}].attrs must be an object")),
        };
        lines.push(json!({
            "id": null, "category": category, "name": name, "qty": qty,
            "attrs": attrs, "new_id": new_id(ROW_ID_LEN),
        }));
    }

    let mut asset_ids = Vec::with_capacity(assets.len());
    let mut seen = HashSet::new();
    for (i, a) in assets.iter().enumerate() {
        let Some(id) = a.as_str().map(str::trim).filter(|s| !s.is_empty()) else {
            return Err(format!("final.assets[{i}] must be an asset id"));
        };
        if !seen.insert(id) {
            return Err(format!("final.assets: {id} appears twice"));
        }
        asset_ids.push(id.to_string());
    }

    let new_assets = match fin.get("new_assets") {
        None | Some(Value::Null) => &[][..],
        Some(Value::Array(v)) => v.as_slice(),
        Some(_) => return Err("final.new_assets must be an array".into()),
    };
    let mut new_lines = Vec::with_capacity(new_assets.len());
    for (i, a) in new_assets.iter().enumerate() {
        let Value::Object(a) = a else {
            return Err(format!("final.new_assets[{i}] must be an object"));
        };
        let (Some(category), Some(name)) = (
            assets::clean(a.get("category")),
            assets::clean(a.get("name")),
        ) else {
            return Err(format!(
                "final.new_assets[{i}] needs a non-empty category and name"
            ));
        };
        new_lines.push(json!({
            "id": new_id(ROW_ID_LEN), "type_id": new_id(ROW_ID_LEN),
            "category": category, "name": name,
            "maker": assets::clean(a.get("maker")),
            "model": assets::clean(a.get("model")),
            "serial": assets::clean(a.get("serial")),
        }));
    }
    Ok((lines, asset_ids, container, new_lines))
}

/// json_each の 1 行 (`{col}.value`) を品目 ID に解決する式。id 指定ならそのまま、
/// 名前指定なら category・name を大文字小文字を無視して照合する。
fn resolve(col: &str) -> String {
    format!(
        "COALESCE(json_extract({col}.value, '$.id'),
                  (SELECT t.id FROM item_types t
                   WHERE lower(t.category) = lower(json_extract({col}.value, '$.category'))
                     AND lower(t.name) = lower(json_extract({col}.value, '$.name'))
                   ORDER BY t.id LIMIT 1))"
    )
}

/// 後続の文の守り: 1 文目で今回の confirm_id が保存されたときだけ効く。
const GUARD: &str = "EXISTS (SELECT 1 FROM ai_judgements
                             WHERE id = ?1 AND json_extract(final_json, '$.confirm_id') = ?5)";
/// 判定のコンテナ (URL に無いので判定の行から引く)。
const CONTAINER: &str = "(SELECT container_id FROM ai_judgements WHERE id = ?1)";

pub async fn confirm(mut req: Request, ctx: Ctx) -> Result<Response> {
    let Some(jid) = ctx.param("id").cloned() else {
        return error(404, "judgement not found");
    };
    let body = match read_object(&mut req).await {
        Ok(b) => b,
        Err(r) => return r,
    };
    let (lines, asset_ids, container, new_assets) = match parse_final(&body) {
        Ok(v) => v,
        Err(msg) => return error(400, &msg),
    };
    let confirm_id = new_id(ROW_ID_LEN);
    let stock_json = json!(lines).to_string();
    let assets_json = json!(asset_ids).to_string();
    let container_json = match &container {
        Some((kind, name)) => json!({ "kind": kind, "name": name }),
        None => Value::Null,
    };
    let new_assets_json = json!(new_assets).to_string();
    let final_json = json!({
        "confirm_id": confirm_id, "stock": lines, "assets": asset_ids, "container": container_json,
        "new_assets": new_assets,
    })
    .to_string();
    let note = format!("judgement {jid}");
    let (kind_ref, name_ref) = match &container {
        Some((kind, name)) => (Some(kind.as_str()), name.as_deref()),
        None => (None, None),
    };

    let d1 = db::db(&ctx)?;
    // 文ごとに使う最大の番号までを渡す (SQLite は番号の最大値ぶんの値を要求する)。
    // 8・9 番目 (kind・name) は final.container が無ければ NULL のまま束ねておき、
    // container を更新する文だけがそれを使う (無ければその文自体を batch に足さない)。
    // 10 番目 (new_assets) は 1 文目のガードと、個体を作る文 (無ければ足さない) が使う。
    let binds = [
        text(&jid),
        text(&final_json),
        text(&stock_json),
        text(&assets_json),
        text(&confirm_id),
        text(&ctx.data.0),
        text(&note),
        opt_text(kind_ref),
        opt_text(name_ref),
        text(&new_assets_json),
    ];
    let (ra, rb) = (resolve("a"), resolve("b"));
    let rs = resolve("s");
    // new_assets の 1 行 (`{col}.value`) の値。
    let nv = |col: &str, key: &str| format!("json_extract({col}.value, '$.{key}')");
    let same_unit = |a: &str, b: &str| {
        format!(
            "{} = {} AND {} = {} AND {} = {}",
            nv(a, "maker"),
            nv(b, "maker"),
            nv(a, "model"),
            nv(b, "model"),
            nv(a, "serial"),
            nv(b, "serial")
        )
    };
    let same_type = |t: &str, n: &str| {
        format!(
            "lower({t}.category) = lower({}) AND lower({t}.name) = lower({})",
            nv(n, "category"),
            nv(n, "name")
        )
    };

    // 1. final_json を保存する。品目・個体がすべて有効なときだけ。
    //    new_assets は: 既存の個体・同じ確定の他の行と (maker, model, serial) が `=` で重ならない
    //    (UNIQUE と同じく NULL は重ならない)、同名の既存品目は個体管理、stock の名前だけの行と
    //    同名でない (2 番の文がその名前で数量品目を先に作ってしまうため)。
    // 既存の個体 a と new_assets の行 n が同じ (maker, model, serial)。
    let unit_na = format!(
        "a.maker = {} AND a.model = {} AND a.serial = {}",
        nv("n", "maker"),
        nv("n", "model"),
        nv("n", "serial")
    );
    let unit_ab = same_unit("a", "b");
    let type_tn = same_type("t", "n");
    let (sc, sn) = (nv("s", "category"), nv("s", "name"));
    let save = d1
        .prepare(format!(
            "UPDATE ai_judgements SET final_json = ?2
             WHERE id = ?1 AND final_json IS NULL AND kind = 'container'
               AND EXISTS (SELECT 1 FROM containers WHERE id = ai_judgements.container_id)
               AND NOT EXISTS (SELECT 1 FROM json_each(?3) s
                               WHERE json_extract(s.value, '$.id') IS NOT NULL
                                 AND NOT EXISTS (SELECT 1 FROM item_types t
                                                 WHERE t.id = json_extract(s.value, '$.id')))
               AND NOT EXISTS (SELECT 1 FROM json_each(?3) s JOIN item_types t ON t.id = {rs}
                               WHERE t.tracking <> 'quantity')
               AND NOT EXISTS (SELECT 1 FROM json_each(?3) a JOIN json_each(?3) b
                               ON a.key < b.key AND {ra} = {rb})
               AND NOT EXISTS (SELECT 1 FROM json_each(?4) x
                               WHERE NOT EXISTS (SELECT 1 FROM assets WHERE id = x.value))
               AND NOT EXISTS (SELECT 1 FROM json_each(?10) n JOIN assets a ON {unit_na})
               AND NOT EXISTS (SELECT 1 FROM json_each(?10) a JOIN json_each(?10) b
                               ON a.key < b.key AND {unit_ab})
               AND NOT EXISTS (SELECT 1 FROM json_each(?10) n JOIN item_types t ON {type_tn}
                               WHERE t.tracking <> 'individual')
               AND NOT EXISTS (SELECT 1 FROM json_each(?3) s JOIN json_each(?10) n
                               ON json_extract(s.value, '$.id') IS NULL
                              AND lower({sc}) = lower({ncat}) AND lower({sn}) = lower({nname}))",
            ncat = nv("n", "category"),
            nname = nv("n", "name"),
        ))
        .bind(&binds[..10])?;
    // 2. 名前だけの行で、まだ無い品目を数量管理で作る。
    let new_types = d1
        .prepare(format!(
            "INSERT INTO item_types (id, category, name, tracking, attrs_json, created_at)
             SELECT json_extract(s.value, '$.new_id'), json_extract(s.value, '$.category'),
                    json_extract(s.value, '$.name'), 'quantity', json_extract(s.value, '$.attrs'), {NOW}
             FROM json_each(?3) s
             WHERE json_extract(s.value, '$.id') IS NULL
               AND NOT EXISTS (SELECT 1 FROM item_types t
                               WHERE lower(t.category) = lower(json_extract(s.value, '$.category'))
                                 AND lower(t.name) = lower(json_extract(s.value, '$.name')))
               AND {GUARD}"
        ))
        .bind(&binds[..5])?;
    // 3. 本数の差分を記録する (旧本数が要るので stock を書き換える前)。一覧から消えた品目は 0 本。
    let adjust = d1
        .prepare(format!(
            "WITH f AS (SELECT {rs} AS item, json_extract(s.value, '$.qty') AS qty FROM json_each(?3) s),
                  d AS (
                    SELECT f.item, f.qty AS qty_new,
                           COALESCE((SELECT qty FROM stock
                                     WHERE container_id = {CONTAINER} AND item_type_id = f.item), 0) AS qty_old
                    FROM f
                    UNION ALL
                    SELECT st.item_type_id, 0, st.qty FROM stock st
                    WHERE st.container_id = {CONTAINER} AND st.item_type_id NOT IN (SELECT item FROM f)
                  )
             INSERT INTO movements (id, at, actor, kind, container_id, item_type_id, qty_delta, note)
             SELECT lower(hex(randomblob(8))), {NOW}, ?6, 'stock_adjust', {CONTAINER}, d.item,
                    d.qty_new - d.qty_old, ?7
             FROM d WHERE d.qty_new <> d.qty_old AND {GUARD}"
        ))
        .bind(&binds[..7])?;
    // 4. 本数を final.stock と同じにする。
    let upsert = d1
        .prepare(format!(
            "INSERT INTO stock (container_id, item_type_id, qty)
             SELECT {CONTAINER}, {rs}, json_extract(s.value, '$.qty') FROM json_each(?3) s
             WHERE json_extract(s.value, '$.qty') > 0 AND {GUARD}
             ON CONFLICT (container_id, item_type_id) DO UPDATE SET qty = excluded.qty"
        ))
        .bind(&binds[..5])?;
    // 5. 一覧から消えた品目・0 本の品目の行を消す。
    let prune = d1
        .prepare(format!(
            "DELETE FROM stock
             WHERE container_id = {CONTAINER} AND {GUARD}
               AND item_type_id NOT IN (SELECT {rs} FROM json_each(?3) s
                                        WHERE json_extract(s.value, '$.qty') > 0)"
        ))
        .bind(&binds[..5])?;
    // 6. 挙がった個体の移動を記録する (既にこのコンテナにある個体は記録しない)。
    let asset_moves = d1
        .prepare(format!(
            "INSERT INTO movements (id, at, actor, kind, asset_id, item_type_id, from_id, to_id, note)
             SELECT lower(hex(randomblob(8))), {NOW}, ?6, 'asset_move', a.id, a.item_type_id,
                    a.container_id, {CONTAINER}, ?7
             FROM json_each(?4) x JOIN assets a ON a.id = x.value
             WHERE a.container_id IS NOT {CONTAINER} AND {GUARD}"
        ))
        .bind(&binds[..7])?;
    // 7. 個体をこのコンテナへ移す。
    let place = d1
        .prepare(format!(
            "UPDATE assets SET container_id = {CONTAINER}, updated_at = {NOW}
             WHERE id IN (SELECT value FROM json_each(?4))
               AND container_id IS NOT {CONTAINER} AND {GUARD}"
        ))
        .bind(&binds[..5])?;
    let mut stmts = vec![save, new_types, adjust, upsert, prune, asset_moves, place];
    if !new_assets.is_empty() {
        // 8. new_assets の品目で、まだ無いものを個体管理で作る (同じ名前の行は 1 品目にまとめる)。
        let (ncat, nname) = (nv("n", "category"), nv("n", "name"));
        let individual_types = d1
            .prepare(format!(
                "INSERT INTO item_types (id, category, name, tracking, created_at)
                 SELECT MIN({tid}), {ncat}, {nname}, 'individual', {NOW}
                 FROM json_each(?10) n
                 WHERE NOT EXISTS (SELECT 1 FROM item_types t WHERE {type_tn}) AND {GUARD}
                 GROUP BY lower({ncat}), lower({nname})
                 ON CONFLICT (category, name) DO NOTHING",
                tid = nv("n", "type_id"),
            ))
            .bind(&binds[..10])?;
        // 9. 個体を作ってこのコンテナに入れる。
        let create_assets = d1
            .prepare(format!(
                "INSERT INTO assets (id, item_type_id, container_id, maker, model, serial, status, created_at, updated_at)
                 SELECT {nid},
                        (SELECT t.id FROM item_types t WHERE t.tracking = 'individual' AND {type_tn}
                         ORDER BY t.id LIMIT 1),
                        {CONTAINER}, {nm}, {nmo}, {ns}, 'in_stock', {NOW}, {NOW}
                 FROM json_each(?10) n WHERE {GUARD}",
                nid = nv("n", "id"),
                nm = nv("n", "maker"),
                nmo = nv("n", "model"),
                ns = nv("n", "serial"),
            ))
            .bind(&binds[..10])?;
        // 10. 登録を記録する (POST /api/assets と同じく asset_move / 'registered')。
        let registered = d1
            .prepare(format!(
                "INSERT INTO movements (id, at, actor, kind, asset_id, item_type_id, to_id, note)
                 SELECT lower(hex(randomblob(8))), {NOW}, ?6, 'asset_move', a.id, a.item_type_id,
                        {CONTAINER}, 'registered'
                 FROM json_each(?10) n JOIN assets a ON a.id = {nid}
                 WHERE {GUARD}",
                nid = nv("n", "id"),
            ))
            .bind(&binds[..10])?;
        stmts.extend([individual_types, create_assets, registered]);
    }
    // 11. final.container があれば、このコンテナ自体の種別・名前も書き換える。
    if container.is_some() {
        let rename = d1
            .prepare(format!(
                "UPDATE containers SET kind = ?8, name = ?9, updated_at = {NOW}
                 WHERE id = {CONTAINER} AND {GUARD}"
            ))
            .bind(&binds[..9])?;
        stmts.push(rename);
    }
    let r = d1.batch(stmts).await?;

    if db::changes(&r[0])? == 1 {
        #[derive(Deserialize)]
        struct C {
            container_id: String,
        }
        let container_id = d1
            .prepare("SELECT container_id FROM ai_judgements WHERE id = ?1")
            .bind(&binds[..1])?
            .first::<C>(None)
            .await?
            .map(|c| c.container_id);
        // 書き込みは上の batch で済んでいる。結果は GET /api/containers/:id と同じ取得部で読み直す。
        let Some(view) = (match &container_id {
            Some(c) => containers::load_view(&d1, c).await?,
            None => None,
        }) else {
            return error(404, "container not found");
        };
        return json(
            200,
            &json!({
                "judgement_id": jid,
                "container_id": container_id,
                "stock": view.stock,
                "assets": view.assets,
            }),
        );
    }
    if let Some((status, msg)) = judgement_state(&d1, &jid, "container").await? {
        return error(status, &msg);
    }
    #[derive(Deserialize)]
    struct Alive {
        alive: i64,
    }
    let alive = d1
        .prepare(format!(
            "SELECT EXISTS (SELECT 1 FROM containers WHERE id = {CONTAINER}) AS alive"
        ))
        .bind(&binds[..1])?
        .first::<Alive>(None)
        .await?
        .is_some_and(|a| a.alive == 1);
    if !alive {
        return error(404, "container not found");
    }
    if !new_assets.is_empty() {
        // 失敗の理由の切り分け: new_assets のどれかが既存の個体と同じ (maker, model, serial) か。
        #[derive(Deserialize)]
        struct Dup {
            dup: i64,
        }
        let dup = d1
            .prepare(format!(
                "SELECT EXISTS (SELECT 1 FROM json_each(?1) n JOIN assets a ON {unit_na}) AS dup"
            ))
            .bind(&[text(&new_assets_json)])?
            .first::<Dup>(None)
            .await?
            .is_some_and(|d| d.dup == 1);
        if dup {
            return error(409, "an asset with the same maker, model and serial exists");
        }
    }
    error(
        422,
        "final has an unknown item type or asset, an individually tracked item type, \
         the same item type twice, or a new asset whose item type is tracked by quantity \
         or appears twice",
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(v: Value) -> std::result::Result<ParsedFinal, String> {
        parse_final(v.as_object().unwrap())
    }

    #[test]
    fn parse_final_accepts_ids_and_names() {
        let (lines, assets, container, new_assets) = parse(json!({ "final": {
            "stock": [
                { "item_type_id": "T1", "qty": 3 },
                { "category": " cable ", "name": "A-C", "qty": 0, "attrs": { "end1": "A" } },
            ],
            "assets": ["A1", "A2"],
        }}))
        .unwrap();
        assert_eq!(lines[0], json!({ "id": "T1", "qty": 3 }));
        assert_eq!(lines[1]["id"], Value::Null);
        assert_eq!(lines[1]["category"], "cable");
        assert_eq!(lines[1]["attrs"]["end1"], "A");
        assert_eq!(lines[1]["new_id"].as_str().unwrap().len(), ROW_ID_LEN);
        assert_eq!(assets, vec!["A1", "A2"]);
        assert_eq!(container, None);
        assert!(new_assets.is_empty());
    }

    #[test]
    fn parse_final_accepts_new_assets() {
        let (_, _, _, new_assets) = parse(json!({ "final": {
            "stock": [], "assets": [],
            "new_assets": [
                { "category": " device ", "name": " 変換アダプタ ", "maker": " Apple ", "model": "", "serial": null },
                { "category": "device", "name": "変換アダプタ" },
            ],
        }}))
        .unwrap();
        assert_eq!(new_assets.len(), 2);
        let a = &new_assets[0];
        assert_eq!(a["category"], "device");
        assert_eq!(a["name"], "変換アダプタ");
        assert_eq!(a["maker"], "Apple");
        assert_eq!(a["model"], Value::Null);
        assert_eq!(a["serial"], Value::Null);
        assert_eq!(a["id"].as_str().unwrap().len(), ROW_ID_LEN);
        assert_eq!(a["type_id"].as_str().unwrap().len(), ROW_ID_LEN);
        assert_ne!(a["id"], new_assets[1]["id"]);
        assert_eq!(new_assets[1]["maker"], Value::Null);

        // null は無しと同じ
        let (_, _, _, none) = parse(json!({ "final": {
            "stock": [], "assets": [], "new_assets": null,
        }}))
        .unwrap();
        assert!(none.is_empty());
    }

    #[test]
    fn parse_final_rejects_bad_new_assets() {
        let bad = |new_assets: Value| {
            parse(json!({ "final": { "stock": [], "assets": [], "new_assets": new_assets } }))
                .is_err()
        };
        assert!(bad(json!({})));
        assert!(bad(json!(["A1"])));
        assert!(bad(json!([{ "category": "device" }])));
        assert!(bad(json!([{ "category": "device", "name": "  " }])));
        assert!(bad(json!([{ "category": " ", "name": "X" }])));
        assert!(bad(json!([{ "name": "X" }])));
    }

    #[test]
    fn parse_final_accepts_container() {
        let (_, _, container, _) = parse(json!({ "final": {
            "stock": [], "assets": [],
            "container": { "kind": " box ", "name": " USB ケーブルの袋 " },
        }}))
        .unwrap();
        assert_eq!(
            container,
            Some(("box".to_string(), Some("USB ケーブルの袋".to_string())))
        );

        // name は無くてもよい (trim して空も無しと同じ扱い)
        let (_, _, only_kind, _) = parse(json!({ "final": {
            "stock": [], "assets": [], "container": { "kind": "bag", "name": "  " },
        }}))
        .unwrap();
        assert_eq!(only_kind, Some(("bag".to_string(), None)));

        assert!(
            parse(json!({ "final": {
                "stock": [], "assets": [], "container": { "name": "no kind" },
            }}))
            .is_err()
        );
        assert!(
            parse(json!({ "final": {
                "stock": [], "assets": [], "container": { "kind": "" },
            }}))
            .is_err()
        );
    }

    #[test]
    fn parse_final_rejects_bad_input() {
        let bad = |stock: Value, assets: Value| {
            parse(json!({ "final": { "stock": stock, "assets": assets } })).is_err()
        };
        assert!(parse(json!({})).is_err());
        assert!(parse(json!({ "final": { "stock": [] } })).is_err());
        assert!(bad(json!([{ "item_type_id": "T", "qty": -1 }]), json!([])));
        assert!(bad(json!([{ "item_type_id": "T", "qty": 1.5 }]), json!([])));
        assert!(bad(json!([{ "item_type_id": "T" }]), json!([])));
        assert!(bad(json!([{ "category": "cable", "qty": 1 }]), json!([])));
        assert!(bad(
            json!([{ "item_type_id": "T", "qty": 1 }, { "item_type_id": "T", "qty": 2 }]),
            json!([])
        ));
        assert!(bad(
            json!([{ "category": "cable", "name": "A-C", "qty": 1 },
                   { "category": "Cable", "name": "a-c", "qty": 2 }]),
            json!([])
        ));
        assert!(bad(json!([]), json!(["A1", "A1"])));
        assert!(bad(json!([]), json!([1])));
    }
}
