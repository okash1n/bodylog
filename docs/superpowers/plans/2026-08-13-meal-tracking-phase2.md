# 食事記録 Phase 2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans or subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** 体重×摂取カロリーの統合ビュー（既存体重グラフの拡張）と、Slack日次ダイジェストへの当日摂取行を追加する。

**Architecture:** 既存の単一 Chart.js line チャート（app.js）に右軸 `yKcal` と総カロリー棒を1データセット足し、期間/テーマ/表機構は再利用。Slackは `buildDailyDigestMessage` で `getIntakeForDay(env, date)` を取り、`buildDigestBlocks` に intake 行を追加。目標設定は無し。

**Tech Stack:** Cloudflare Workers / Hono / D1 / Chart.js(vendored) / vitest

**Spec:** `docs/superpowers/specs/2026-08-12-meal-tracking-phase2-design.md`

## Global Constraints

- パブリックリポジトリ: 実環境値を書かない。URL例は `weight.example.com`
- コミットは Conventional Commits、`Co-Authored-By` なし
- テストの日付seedは固定時刻 `${ymd}T03:00:00Z`
- Slack mrkdwn制約: 全角括弧「（」直後のバッククォートはコード開始と認識されない → コードスパン前後は半角括弧+空白
- 日次PFCは栄養素入力済みの記録のみの部分合計（Phase 1仕様）。caloriesは全記録合計
- 各タスク完了時 `npm run typecheck` と `npx vitest run` が通ること
- アセット変更時は `src/dashboard.ts` の `ASSET_VERSION` を更新

## File Structure

| ファイル | 変更 |
|---|---|
| `src/slack.ts` | buildDigestBlocks に intake 行、buildDailyDigestMessage で getIntakeForDay 取得 |
| `test/digest.test.ts` | intake 整形・0件省略・PFC欠損のテスト |
| `src/dashboard/app.js` | カロリー日次の取得・整列、右軸 yKcal、カロリー棒、ツールチップ、重ねるトグル、日次表カロリー列 |
| `src/dashboard/index.html` | 「カロリーを重ねる」トグル、日次表ヘッダにカロリー列 |
| `src/dashboard/styles.css` | 必要なら微調整 |
| `src/dashboard.ts` | ASSET_VERSION 更新 |
| `test/dashboard-root.test.ts` | トグル要素の配信確認（任意） |
| `README.md` | 「AIから使う」節の下などに統合ビューの一言（任意） |

---

### Task 1: Slackダイジェストに当日摂取行

**Files:**
- Modify: `src/slack.ts`（`buildDigestBlocks` 152-193, `buildDailyDigestMessage` 295-332）
- Test: `test/digest.test.ts`

**Interfaces:**
- Consumes: `getIntakeForDay(env, ymd): Promise<DailyIntake | null>`（src/meals.ts、既存）。`DailyIntake = { d, count, calories, protein_g, fat_g, carbs_g }`
- Produces: `buildDigestBlocks` が新オプション `intake?: DailyIntake | null` を受け、摂取行を追加。`formatIntakeLine(intake): string | null` を slack.ts に export（テスト用）

- [ ] **Step 1: 失敗するテストを書く（test/digest.test.ts の末尾に describe 追加）**

```ts
import { formatIntakeLine } from '../src/slack';

describe('ダイジェストの摂取カロリー行', () => {
  it('カロリー+PFCを整形する', () => {
    expect(formatIntakeLine({ d: '2026-08-12', count: 3, calories: 1850.4, protein_g: 90.2, fat_g: 55, carbs_g: 210 }))
      .toBe('*摂取* : 1850 kcal (P90.2 F55 C210)');
  });
  it('PFCが全てnullならカロリーのみ', () => {
    expect(formatIntakeLine({ d: '2026-08-12', count: 1, calories: 700, protein_g: null, fat_g: null, carbs_g: null }))
      .toBe('*摂取* : 700 kcal');
  });
  it('PFCが一部だけでも入力済み分を出す', () => {
    expect(formatIntakeLine({ d: '2026-08-12', count: 2, calories: 900, protein_g: 30, fat_g: null, carbs_g: 100 }))
      .toBe('*摂取* : 900 kcal (P30 C100)');
  });
  it('記録なし（null）は行を出さない', () => {
    expect(formatIntakeLine(null)).toBeNull();
  });
});
```

- [ ] **Step 2: 失敗を確認** — Run: `npx vitest run test/digest.test.ts` → FAIL（formatIntakeLine未定義）

- [ ] **Step 3: slack.ts に formatIntakeLine を実装し、digestに配線**

`DailyIntake` を import（`import type { ... DailyIntake } from './types';` の既存 import 群に追加）、`getIntakeForDay` を import（`import { getIntakeForDay } from './meals';`）。

```ts
// 小数第1位まで（整数はそのまま）
function r1(n: number): string {
  return (Math.round(n * 10) / 10).toString();
}

/** ダイジェストの摂取行。記録なし(null)は行を出さない。mrkdwn: コードスパン前後は半角括弧+空白 */
export function formatIntakeLine(intake: DailyIntake | null): string | null {
  if (!intake) return null;
  const pfc: string[] = [];
  if (intake.protein_g != null) pfc.push(`P${r1(intake.protein_g)}`);
  if (intake.fat_g != null) pfc.push(`F${r1(intake.fat_g)}`);
  if (intake.carbs_g != null) pfc.push(`C${r1(intake.carbs_g)}`);
  const macros = pfc.length ? ` (${pfc.join(' ')})` : '';
  return `*摂取* : ${Math.round(intake.calories)} kcal${macros}`;
}
```

`buildDigestBlocks` の input 型に `intake?: DailyIntake | null;` を追加し、分割代入に `intake` を加える。`blocks` 生成後、ダッシュボード行の**前**に挿入:

```ts
  const intakeLine = formatIntakeLine(input.intake ?? null);
  if (intakeLine) blocks.push(section(intakeLine));
  blocks.push(section(`ダッシュボード: ${dashboardUrl}`));
```

（既存の `blocks.push(section('ダッシュボード: ...'))` の直前に intakeLine push を置く）

`buildDailyDigestMessage`（src/slack.ts:295）の `Promise.all` に intake 取得を追加:

```ts
    const [series, count, intake] = await Promise.all([
      getDailySeries(env, date, date),
      getDayMeasurementCount(env, date),
      getIntakeForDay(env, date),
    ]);
```

`buildDigestBlocks({ ... })` の呼び出しに `intake,` を追加。

- [ ] **Step 4: テスト通過を確認** — Run: `npm run typecheck && npx vitest run test/digest.test.ts`（全PASS）

- [ ] **Step 5: 全体テスト実行して Commit**

```bash
npx vitest run
git add src/slack.ts test/digest.test.ts
git commit -m "feat: add today's calorie intake line to Slack daily digest"
```

---

### Task 2: 統合ビュー（app.js: カロリー取得・右軸・棒・ツールチップ・トグル）

**Files:**
- Modify: `src/dashboard/app.js`, `src/dashboard/index.html`, `src/dashboard.ts`(ASSET_VERSION)
- Test: 手動確認 + 既存スイート回帰（ブラウザJSは単体テスト対象外）

**Interfaces:**
- Consumes: `GET /api/meals/daily?from&to` → `{ days: [{ d, calories, protein_g, fat_g, carbs_g }] }`（欠損日なし）。既存 `buildDateLabels(from,to)`, `seriesFrom` の date-keyed 整列パターン、`loadData`(252), `renderAll`(650), `buildDatasets`(387), `createChart` scales(591-620), `applyAxisRanges`(484), `applyThemeToChart`(775)
- Produces: カロリーオーバーレイ付きチャート。トグル `#calorie-toggle`（localStorage `dash-calorie-overlay`, 既定ON）

**実装方針（順に）:**

- [ ] **Step 1: index.html にトグルを追加**

既存の `.segment-btn[data-mode]`（実測/7日平均）トグル群の近く（`index.html` の期間・モードのcontrols付近）に、チェックボックス風トグルを追加:

```html
<label id="calorie-toggle-wrap" class="toggle"><input type="checkbox" id="calorie-toggle" checked> カロリーを重ねる</label>
```

- [ ] **Step 2: app.js — カロリー日次の取得と整列**

`loadData()`（252）の `Promise.all` に meals/daily を追加。`r.from`/`r.to` は既存のまま:

```js
    var mealsUrl = BASE + 'api/meals/daily?from=' + encodeURIComponent(r.from) + '&to=' + encodeURIComponent(r.to);
    Promise.all([
      fetch(url).then(function (res) { if (!res.ok) throw new Error('HTTP ' + res.status); return res.json(); }),
      fetch(mealsUrl).then(function (res) { return res.ok ? res.json() : { days: [] }; })
        .catch(function () { return { days: [] }; }), // カロリー取得失敗は体重表示を壊さない
      fetchStatus(),
    ])
```

`.then` の results を `results[0]`(measurements), `results[1]`(meals/daily), `results[2]`(status) に付け替える。`renderAll(days, r.from, r.to)` に mealsDays を渡す: `renderAll(days, mealsDays, r.from, r.to)`。

`seriesFrom` と同様に、カロリーをラベル整列する関数を追加:

```js
  function calorieSeriesFrom(mealsDays, labels) {
    var byDate = Object.create(null);
    (mealsDays || []).forEach(function (row) { byDate[row.d] = row; });
    return {
      cal: labels.map(function (l) { return byDate[l] ? byDate[l].calories : null; }),
      p: labels.map(function (l) { var r = byDate[l]; return r && r.protein_g != null ? r.protein_g : null; }),
      f: labels.map(function (l) { var r = byDate[l]; return r && r.fat_g != null ? r.fat_g : null; }),
      c: labels.map(function (l) { var r = byDate[l]; return r && r.carbs_g != null ? r.carbs_g : null; }),
      raw: byDate, // 表結合用
    };
  }
```

`renderAll` を `renderAll(days, mealsDays, from, to)` に変更し、labels 生成後 `var cals = calorieSeriesFrom(mealsDays, labels);` を作り、`renderChart(labels, sets, cals, density)` と `renderDailyTable(days, cals.raw)` に渡す。`lastDays` と同様に `lastCals`（テーマ再描画・リサイズ時の再利用）をモジュール変数に保持する。

- [ ] **Step 3: app.js — カロリー棒データセットと右軸**

`buildDatasets(sets, density, t)` を `buildDatasets(sets, cals, density, t)` に変更し、末尾にカロリー棒を追加（`calorieOverlay` がONのときのみ hidden=false）:

```js
    // 総カロリー棒（右軸 yKcal, 折れ線の背面）
    ds.push({
      type: 'bar', label: '摂取カロリー', data: cals.cal, yAxisID: 'yKcal',
      backgroundColor: hexToRgba(t.accent2, 0.35), borderWidth: 0, order: 99,
      hidden: !calorieOverlay,
      _pfc: { p: cals.p, f: cals.f, c: cals.c }, // ツールチップ用
    });
```

`createChart` の `scales`（591）に右軸を追加（既存 `yKg` はそのまま）:

```js
          yKcal: {
            position: 'right', beginAtZero: true,
            grid: { drawOnChartArea: false },
            ticks: { color: t.muted, callback: function (v) { return v + ' kcal'; } },
            display: calorieOverlay,
          },
```

`createChart`/`renderChart` のシグネチャに `cals` を通す。`renderChart(labels, sets, cals, density)`。

- [ ] **Step 4: app.js — ツールチップにPFC**

`createChart` の `options.plugins.tooltip.callbacks.afterLabel`（無ければ追加）で、カロリー棒データセットのとき PFC を出す:

```js
          tooltip: {
            callbacks: {
              afterLabel: function (ctx) {
                var pfc = ctx.dataset._pfc;
                if (!pfc) return undefined;
                var i = ctx.dataIndex, parts = [];
                if (pfc.p[i] != null) parts.push('P' + pfc.p[i]);
                if (pfc.f[i] != null) parts.push('F' + pfc.f[i]);
                if (pfc.c[i] != null) parts.push('C' + pfc.c[i]);
                return parts.length ? parts.join(' ') : undefined;
              },
            },
          },
```

（既存の tooltip 設定があればマージする。無ければ plugins に追加）

- [ ] **Step 5: app.js — applyAxisRanges と applyThemeToChart の拡張**

`applyAxisRanges(ch)`（484）に yKcal のスケールを追加:

```js
    var kcal = ch.data.datasets.filter(function (d) { return d.yAxisID === 'yKcal' && !d.hidden; })
      .reduce(function (acc, d) { return acc.concat(d.data.filter(function (v) { return v != null; })); }, []);
    if (kcal.length) { s.yKcal.min = 0; s.yKcal.max = Math.max.apply(null, kcal) * 1.15; }
```

`applyThemeToChart()`（775）: カロリー棒の背景色をテーマ変更時に再設定（棒データセットを名前 or yAxisID で特定し `hexToRgba(t.accent2, 0.35)` を再代入）。ハードコードの色配列を使っているので、カロリー棒はその配列の後ろに追加されている前提でインデックスを合わせる。

- [ ] **Step 6: app.js — トグルの配線**

モジュール変数 `var calorieOverlay = localStorage.getItem('dash-calorie-overlay') !== '0';`（既定ON）。`bindEvents()` にトグルの change を追加:

```js
    var calToggle = document.getElementById('calorie-toggle');
    if (calToggle) {
      calToggle.checked = calorieOverlay;
      calToggle.addEventListener('change', function () {
        calorieOverlay = calToggle.checked;
        localStorage.setItem('dash-calorie-overlay', calorieOverlay ? '1' : '0');
        if (chart) {
          var barDs = chart.data.datasets.filter(function (d) { return d.yAxisID === 'yKcal'; });
          barDs.forEach(function (d) { d.hidden = !calorieOverlay; });
          chart.options.scales.yKcal.display = calorieOverlay;
          applyAxisRanges(chart);
          chart.update('none');
        }
      });
    }
```

- [ ] **Step 7: ASSET_VERSION 更新** — `src/dashboard.ts` の `ASSET_VERSION` を翌日値（例 `2026-08-13-5`）に上げる

- [ ] **Step 8: 検証（回帰 + 手動）**

Run: `node --check src/dashboard/app.js && npm run typecheck && npx vitest run`（全PASS = 体重系の回帰なし）
手動: `npm run dev` でローカル起動し、①カロリー棒が体重折れ線に重なる ②トグルOFFで棒と右軸が消え純体重グラフに戻る ③期間切替（1m/3m/1y）でカロリーも追従 ④ツールチップにPFC ⑤ダーク/ライト切替で色が壊れない、を目視。

- [ ] **Step 9: Commit**

```bash
git add src/dashboard/app.js src/dashboard/index.html src/dashboard/styles.css src/dashboard.ts
git commit -m "feat: overlay calorie intake bars on the weight chart with a toggle"
```

---

### Task 3: 日次テーブルにカロリー列

**Files:**
- Modify: `src/dashboard/app.js`（`renderDailyTable` 691-715）, `src/dashboard/index.html`（日次表ヘッダ）
- Test: 回帰 + 手動

**Interfaces:**
- Consumes: Task 2 の `renderDailyTable(days, calByDate)` シグネチャ（calByDate = `cals.raw`、d→{calories,...}）

- [ ] **Step 1: index.html の日次表ヘッダにカロリー列を追加**

`#table-wrap` 内の日次テーブルのヘッダ行（体重/脂肪量/除脂肪体重）に `<th>摂取</th>` を追加（既存ヘッダの並びに合わせる）。列位置は日付の次でも末尾でもよいが、実装と一致させる。

- [ ] **Step 2: renderDailyTable にカロリーセルを追加**

`renderDailyTable(days, calByDate)` に変更。各行の生成で、その日の `calByDate[day.d]` があれば `Math.round(calories) + ' kcal'`、無ければ空欄のセルを追加。既存の体重セル生成に倣う（エスケープ不要な数値）。

- [ ] **Step 3: 検証 + Commit**

Run: `npm run typecheck && npx vitest run`（全PASS）。手動で「表で見る→日次集計」にカロリー列が出ることを確認。

```bash
git add src/dashboard/app.js src/dashboard/index.html
git commit -m "feat: add calorie column to the daily table"
```

---

### Task 4: ドキュメントと全体検証

- [ ] **Step 1: README（任意）** — 「ダッシュボード」節に「食事タブで記録した摂取カロリーを体重グラフに重ねて表示（トグルで切替）」を1行追記。実環境値は書かない

- [ ] **Step 2: 全体検証**

Run: `npm run typecheck && npx vitest run && npx wrangler deploy --dry-run --outdir "$TMPDIR/withings-p2"`（全PASS + バンドル成功）

- [ ] **Step 3: 実環境値混入チェック**

Run: 本番ドメイン文字列を `git grep`（追跡ファイル）でヒットしないこと（リポジトリ自身のGitHub URLはOK）

- [ ] **Step 4: Commit（あれば）**

```bash
git add README.md
git commit -m "docs: note calorie overlay on the weight chart"
```

---

## Self-Review結果（作成時に実施済み）

- スペック全要件を対応付け: 統合ビュー=Task2、日次表カロリー列=Task3、Slack当日摂取=Task1、目標設定=対象外（仕様どおり）、テスト=各タスク、ASSET_VERSION=Task2 Step7
- 型・関数名整合: `formatIntakeLine`/`getIntakeForDay`/`DailyIntake`、`renderDailyTable(days, calByDate)`、`renderAll(days, mealsDays, from, to)` はタスク間で一貫
- 未検証リスク: app.js の2軸拡張は回帰しうる → Task2 Step8で体重系の回帰（既存スイート）+手動目視。ブラウザJSは単体テスト不可のため手動確認を明記
