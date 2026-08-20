# measurements 主キー再設計 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** measurements の主キーを内部ID `id` に再設計し、`grpid` を Withings 行の属性（NULL許容UNIQUE）に格下げする。

**Architecture:** migration 0008 でテーブル再構築（id=旧grpid で移行し保留通知の参照を保つ）。ingest は UPSERT→claim の順に変更、weight.ts は負ID採番を廃止して素のINSERTに簡素化。読み取りは id/measurement_id 参照へ更新。

**Tech Stack:** Cloudflare Workers + Hono + D1 + vitest(workers pool)

**Spec:** docs/superpowers/specs/2026-08-20-measurements-pk-redesign-design.md（SQL・変更点・リスク対策はスペックが正）

## Global Constraints

- パブリックリポジトリ: 実環境値を書かない。コミットは Conventional Commits、Co-Authored-By なし
- 検証: `npm run typecheck` と `npm test`
- 本番適用前に `wrangler d1 export` でバックアップ、適用後に行数一致を確認

---

### Task 1: migration 0008（スペックのSQLをそのまま）＋既存テストのスキーマ追随

**Files:** Create `migrations/0008_measurement_pk.sql` / Modify `test/weight.test.ts` `test/raw-api.test.ts` `test/mcp.test.ts`（id期待値の更新は Task 2-4 で実施）

- [ ] スペックの「新スキーマ」節のSQLで 0008 を作成
- [ ] `npm test -- --run test/queries.test.ts` で既存読み取りが壊れないこと（grpid AS id が残る旧コードのままでも列互換で通る想定）
- [ ] Commit: `feat: rebuild measurements with surrogate primary key (grpid demoted to attribute)`

### Task 2: ingest.ts の UPSERT→claim 順序変更

**Files:** Modify `src/ingest.ts` / Test `test/ingest.test.ts`

- [ ] UPSERT文はそのまま（列互換）。claim文を `INSERT OR IGNORE INTO notification_batch_items (measurement_id, batch_id) SELECT id, ?2 FROM measurements WHERE grpid = ?1` に変更
- [ ] db.batch の文順を [UPSERTチャンク..., claim×N, batches登録×destinations] にし、claimedGrpids 判定インデックスを UPSERT文数分オフセット
- [ ] `npm test -- --run test/ingest.test.ts test/slack.test.ts test/digest.test.ts` PASS
- [ ] Commit: `refactor: claim notification items by measurement id after upsert`

### Task 3: weight.ts の簡素化

**Files:** Modify `src/weight.ts` / Test `test/weight.test.ts`

- [ ] INSERT を素の `(source, measured_at, weight, fat_ratio, fat_free_mass, raw_json)` に。後続文の自行参照は `(SELECT MAX(id) FROM measurements)`
- [ ] delete を `WHERE id = ?1 AND source = 'manual'` に
- [ ] テスト更新: 負ID検証→「正のidで単調増加」「items.measurement_id にenqueue」
- [ ] `npm test -- --run test/weight.test.ts test/weight-api.test.ts` PASS
- [ ] Commit: `refactor: manual weight rows use surrogate ids (drop negative-id allocation)`

### Task 4: 読み取り・型・docs の追随

**Files:** Modify `src/queries.ts` `src/types.ts` `src/ai.ts` `README.md` / Test `test/raw-api.test.ts` `test/mcp.test.ts`

- [ ] queries.ts: `SELECT id, source,...`、`JOIN ... ON m.id = i.measurement_id`、`ORDER BY ..., id DESC`
- [ ] types.ts/ai.ts/README の id 説明を「サーバ内部の計測ID」に更新
- [ ] テストのid期待値更新（手動行は正のid、Withings行は id = grpid）
- [ ] `npm run typecheck && npm test` 全PASS
- [ ] Commit: `refactor: read paths reference measurement id instead of grpid`

### Task 5: バックアップ→デプロイ→本番検証

- [ ] `npx wrangler d1 export bodylog --remote --output <scratchpad>/backup-pre-0008.sql`（gitにコミットしない）
- [ ] 適用前の本番 `SELECT COUNT(*) FROM measurements` を控える
- [ ] 実値混入チェック → push → `gh run watch` → 適用後 COUNT(*) 一致・最新行の値・/api/raw の id/source を確認
- [ ] MCP `log_weight` で1件記録→正のidが返る→削除、まで通しで確認（本番スモーク）
