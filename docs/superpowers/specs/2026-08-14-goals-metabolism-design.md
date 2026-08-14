# 目標設定と実測代謝推定 設計

## 目的

体組成改善の運用に「目標」と「実測ベースの代謝推定」を追加する。

- 目標: 体重・脂肪量の2指標を任意設定（片方のみ可）。グラフの目標線・カードの残量表示・AI講評の評価軸に使う
- 実測代謝: ネット収支の理論値と実際の体重変化のズレから、個人の実効消費カロリーを推定する

## 目標設定

- 保存先: 既存 `settings` テーブル（`goal_weight_kg` / `goal_fat_mass_kg`。文字列で保存、未設定=行なし）
- 設定手段: **MCPツール `set_goal`** のみ（ダッシュボードに編集UIは作らない）
  - 引数: `weight_kg?: number|null`, `fat_mass_kg?: number|null`。少なくとも一方が必要。`null` でその指標の目標を解除
  - 検証: weight_kg は 20〜300、fat_mass_kg は 1〜150 の正の有限数
  - 返り値: 設定後の goal
- 読み取り: `/api/summary` と MCP `get_weight_summary` のレスポンスに `goal: { weight_kg: number|null, fat_mass_kg: number|null }` を追加

## 実測代謝推定（GET /api/metabolism）

直近28日窓で以下を計算して返す。

- `estimated_tdee_kcal` = 平均摂取kcal − (体重変化ペースkg/日 × 7700)
  - 体重変化は窓の先頭側・末尾側それぞれ「最初/最後に7日移動平均が存在する日」の値を使い、その実日数で日割り
- `model_tdee_kcal` = 窓内の (bmr + 運動消費) の平均（bmrが算出できる日のみ）
- `correction_kcal_per_day` = estimated − model（正なら「モデルより消費が少ない/摂取記録が過少」、負なら「NEAT等でモデルより消費が多い」）
- **成立条件**: 窓内の摂取記録がある日が8割（23日）以上、かつ体重7日平均が両端で取得でき、体重変化の実日数が14日以上。満たさない場合は `status: "insufficient_data"` と理由を返す
- レスポンス例:

```json
{
  "status": "ok",
  "window_days": 28,
  "span_days": 27,
  "intake_days": 26,
  "avg_intake_kcal": 2450,
  "weight_change_kg": -0.9,
  "estimated_tdee_kcal": 2707,
  "model_tdee_kcal": 2520,
  "correction_kcal_per_day": 187
}
```

- 7700kcal/kg は脂肪換算の近似。筋肉増を含む体組成変化ではブレるため、表示・講評とも参考値として扱う
- READ_ROUTES / openapi.json / llms.txt に追加（既存driftテストの対象）

## ダッシュボード

- **目標線**: 設定済み指標のみ、グラフに水平破線を追加（体重=体重系列と同色、脂肪量=脂肪量系列と同色、細い破線・薄め）。凡例に「目標体重」「目標脂肪量」で表示、クリックで切替（永続化なし）。kg軸のmin/max計算に目標値を含める
- **カード**: 体重・脂肪量カードに「目標まで <goal−現在値> kg」のサブ行（目標未設定なら非表示）。現在値はカードの最新値と同じ系（実測の最新）
- **実効消費カード**: AIコーチカードと同様の横長カードで「実効消費（推定・28日）: 2,707 kcal/日（モデル比 +187）」を表示。`insufficient_data` の間は非表示
- 取得は loadData の Promise.all に `/api/summary` と `/api/metabolism` を tolerant で追加（失敗しても体重表示を壊さない）

## AIコーチング連携

- `coaching/generate.mjs` の取得データに `goal`（/api/summaryから）と `metabolism` を追加
- プロンプト更新: 目標が設定されていれば「目標との差と到達ペース」を講評の軸にする。`metabolism.status === "ok"` なら実効消費の補正値を摂取アドバイスに反映させる（断定は避ける）

## やらないこと

- 期日・ペース設定、達成予測の数値表示（AI講評に言わせる）
- 目標編集UI、Slackダイジェストの変更
- 脂肪量ベースのTDEE推定（体重ベースのみ）

## テスト

- set_goal: 検証（範囲外・両方欠如）、設定・解除、get_weight_summary への反映
- /api/summary の goal フィールド
- /api/metabolism: 正常系の数値検証（seedデータで期待値一致）、摂取記録不足・体重欠損時の insufficient_data
- ダッシュボードHTMLに目標サブ行・実効消費カードの要素
- openapi drift（自動）
