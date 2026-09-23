// 製品ラベル撮影 → 判定 → 編集 → 個体登録 (/app/label?container=<id>)。
// container が無ければ「場所なし」で登録する (docs/design.md「個体の扱い」「PWA」)。
import { useState } from "preact/hooks";
import {
  type Asset,
  type AssetMatches,
  ApiError,
  createAsset,
  getContainer,
  type JudgeLabelResult,
  judgeLabel,
  moveAsset,
  type PhotoView,
} from "../api";
import { shrinkImage } from "../image";
import { buildCreateAssetBody, emptyLabelForm, type LabelForm } from "../label";
import { add as pendingAdd, discard as pendingDiscard, settle as pendingSettle } from "../pending";
import { navigate, type ScreenProps } from "../router";
import { Crumbs, errorText, useLoad } from "../ui";

type Stage =
  | { kind: "idle" }
  | { kind: "sending"; localId: string; blob: Blob }
  | { kind: "failed"; localId: string; blob: Blob; message: string }
  | { kind: "judged"; localId: string; blob: Blob; result: JudgeLabelResult }
  // AI 判定は失敗したが写真は保存済み (502)。手入力で登録できる。
  | { kind: "manual"; localId: string; blob: Blob; photoId: string };

export function LabelScreen({ query }: ScreenProps) {
  const containerId = query.container || undefined;
  const containerLoad = useLoad(
    () => (containerId ? getContainer(containerId) : Promise.resolve(null)),
    containerId ?? "",
  );
  const [stage, setStage] = useState<Stage>({ kind: "idle" });
  const [pickError, setPickError] = useState<string | null>(null);

  const submit = async (localId: string, blob: Blob) => {
    setStage({ kind: "sending", localId, blob });
    try {
      const result = await judgeLabel(blob, "image/jpeg");
      await pendingSettle(localId, result.photo);
      setStage({ kind: "judged", localId, blob, result });
    } catch (err) {
      if (err instanceof ApiError && err.status === 502) {
        const photo = (err.body as { photo?: PhotoView } | undefined)?.photo;
        if (photo) {
          await pendingSettle(localId, photo);
          setStage({ kind: "manual", localId, blob, photoId: photo.id });
          return;
        }
      }
      setStage({ kind: "failed", localId, blob, message: errorText(err) });
    }
  };

  const onFile = async (e: Event) => {
    const input = e.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    input.value = "";
    if (!file) return;
    setPickError(null);
    let blob: Blob;
    try {
      blob = await shrinkImage(file);
    } catch (err) {
      setPickError(errorText(err));
      return;
    }
    const localId = await pendingAdd({ blob, contentType: "image/jpeg", kind: "label", containerId });
    await submit(localId, blob);
  };

  const discard = async () => {
    if (stage.kind === "failed" || stage.kind === "sending") {
      await pendingDiscard(stage.localId);
    }
    setStage({ kind: "idle" });
  };

  return (
    <main>
      {containerId ? (
        containerLoad.data ? (
          <Crumbs items={containerLoad.data.breadcrumb} />
        ) : (
          <p class="crumb">読み込み中…</p>
        )
      ) : (
        <p class="crumb">場所なし</p>
      )}
      <h1>ラベルを撮って個体登録</h1>

      {stage.kind === "idle" && (
        <section>
          <label class="button primary" style="display:block;text-align:center">
            製品ラベルを撮影
            <input
              type="file"
              accept="image/*"
              capture="environment"
              onChange={onFile}
              style="display:none"
            />
          </label>
          {pickError && <p class="error">{pickError}</p>}
        </section>
      )}

      {stage.kind === "sending" && <p>判定中…</p>}

      {stage.kind === "failed" && (
        <section>
          <p class="error">{stage.message}</p>
          <div class="row">
            <button onClick={() => submit(stage.localId, stage.blob)}>再試行</button>
            <button onClick={discard}>やめる</button>
          </div>
        </section>
      )}

      {stage.kind === "judged" && (
        <JudgedView
          result={stage.result}
          containerId={containerId}
          containerBreadcrumb={containerLoad.data?.breadcrumb}
        />
      )}

      {stage.kind === "manual" && (
        <>
          <p class="muted">AI の判定に失敗しました。手入力で登録できます。</p>
          <RegisterForm
            initial={emptyLabelForm}
            confidence={undefined}
            otherText={undefined}
            containerId={containerId}
            containerBreadcrumb={containerLoad.data?.breadcrumb}
            photoId={stage.photoId}
          />
        </>
      )}
    </main>
  );
}

function JudgedView({
  result,
  containerId,
  containerBreadcrumb,
}: {
  result: JudgeLabelResult;
  containerId: string | undefined;
  containerBreadcrumb: { id: string; kind: string; name: string | null }[] | undefined;
}) {
  const { matches, proposal } = result;
  if (matches.serial.length > 0) {
    return (
      <section>
        <h2>登録済み (シリアル一致)</h2>
        <MatchList assets={matches.serial} containerId={containerId} />
      </section>
    );
  }
  return (
    <>
      {matches.model.length > 0 && (
        <section>
          <h2>同じ型番の個体があります</h2>
          <MatchList assets={matches.model} containerId={containerId} />
        </section>
      )}
      <RegisterForm
        initial={{
          maker: proposal.maker ?? "",
          model: proposal.model ?? "",
          serial: proposal.serial ?? "",
          name: "",
          category: "",
          memo: "",
        }}
        confidence={proposal.confidence}
        otherText={proposal.other_text}
        containerId={containerId}
        containerBreadcrumb={containerBreadcrumb}
        judgementId={result.judgement_id}
        photoId={result.photo.id}
      />
    </>
  );
}

function MatchList({ assets, containerId }: { assets: Asset[]; containerId: string | undefined }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const moveHere = async (id: string) => {
    if (!containerId) return;
    setBusy(id);
    setError(null);
    try {
      await moveAsset(id, containerId);
      navigate(`/app/a/${encodeURIComponent(id)}`);
    } catch (err) {
      setError(errorText(err));
      setBusy(null);
    }
  };

  return (
    <>
      {error && <p class="error">{error}</p>}
      <ul class="list">
        {assets.map((a) => (
          <li key={a.id} class="row">
            <span class="grow">{[a.maker, a.model, a.serial].filter(Boolean).join(" / ") || a.item_name}</span>
            {containerId && (
              <button disabled={busy === a.id} onClick={() => moveHere(a.id)}>
                この場所へ移動
              </button>
            )}
            <a class="button" href={`/app/a/${encodeURIComponent(a.id)}`}>
              個体を開く
            </a>
          </li>
        ))}
      </ul>
    </>
  );
}

function RegisterForm({
  initial,
  confidence,
  otherText,
  containerId,
  containerBreadcrumb,
  judgementId,
  photoId,
}: {
  initial: LabelForm;
  confidence: number | undefined;
  otherText: string | null | undefined;
  containerId: string | undefined;
  containerBreadcrumb: { id: string; kind: string; name: string | null }[] | undefined;
  judgementId?: string;
  photoId?: string;
}) {
  const [form, setForm] = useState<LabelForm>(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dup, setDup] = useState<Asset | null>(null);

  const set = <K extends keyof LabelForm>(key: K) => (e: Event) =>
    setForm((f) => ({ ...f, [key]: (e.currentTarget as HTMLInputElement).value }));

  const register = async (e: Event) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setDup(null);
    try {
      const body = buildCreateAssetBody(form, { containerId, judgementId, photoId });
      const asset = await createAsset(body);
      navigate(`/app/a/${encodeURIComponent(asset.id)}`);
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        const body = err.body as { asset?: Asset } | undefined;
        if (body?.asset) {
          setDup(body.asset);
          setBusy(false);
          return;
        }
      }
      setError(errorText(err));
      setBusy(false);
    }
  };

  const moveDupHere = async () => {
    if (!dup || !containerId) return;
    setBusy(true);
    try {
      await moveAsset(dup.id, containerId);
      navigate(`/app/a/${encodeURIComponent(dup.id)}`);
    } catch (err) {
      setError(errorText(err));
      setBusy(false);
    }
  };

  if (dup) {
    return (
      <section>
        <p class="error">同じ個体が既に登録されています</p>
        <p>{[dup.maker, dup.model, dup.serial].filter(Boolean).join(" / ") || dup.item_name}</p>
        <div class="row">
          {containerId && (
            <button disabled={busy} onClick={moveDupHere}>
              この場所へ移動
            </button>
          )}
          <a class="button" href={`/app/a/${encodeURIComponent(dup.id)}`}>
            個体を開く
          </a>
        </div>
      </section>
    );
  }

  return (
    <form onSubmit={register} class="fields-form">
      <h2>個体登録</h2>
      <label>
        メーカー
        {confidence !== undefined && <small class="muted"> (確度 {Math.round(confidence * 100)}%)</small>}
        <input value={form.maker} onInput={set("maker")} />
      </label>
      <label>
        型番
        <input value={form.model} onInput={set("model")} />
      </label>
      <label>
        シリアル
        <input value={form.serial} onInput={set("serial")} />
      </label>
      <label>
        品目名 <small class="muted">(空なら型番)</small>
        <input value={form.name} onInput={set("name")} placeholder={form.model || undefined} />
      </label>
      <label>
        区分 <small class="muted">(空なら device)</small>
        <input value={form.category} onInput={set("category")} placeholder="device" />
      </label>
      <label>
        メモ
        <input value={form.memo} onInput={set("memo")} />
      </label>
      {otherText && (
        <p class="muted">
          読み取れたその他の文字: {otherText}
        </p>
      )}
      <p class="crumb">登録先: {containerId ? <Crumbs items={containerBreadcrumb ?? []} current /> : "場所なし"}</p>
      {error && <p class="error">{error}</p>}
      <button class="primary" type="submit" disabled={busy}>
        登録する
      </button>
    </form>
  );
}
