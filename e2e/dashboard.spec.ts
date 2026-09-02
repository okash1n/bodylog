/**
 * ダッシュボードの read-only スモーク（PR-007b 初版）。
 * 検証: 主要 journey の characterization（seed データの描画・タブ切替・空期間からの復帰）と
 * console error 0。書き込み（OAuth）系・a11y の網羅は今後の拡張で追補する。
 */
import { expect, test, type Page } from '@playwright/test';

function collectConsoleErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(msg.text());
  });
  page.on('pageerror', (err) => errors.push(String(err)));
  return errors;
}

test('体重タブ: seedデータのカード・チャート・表が描画され console error が無い', async ({ page }) => {
  const errors = collectConsoleErrors(page);
  await page.goto('/');
  await expect(page.locator('#content')).toBeVisible();
  await expect(page.locator('#card-weight-value')).toHaveText('82.5');
  // 表ビューへ切替 → 日次表に体重と摂取・消費が出る（日次表union: 食事のみの日も対象）
  await page.locator('#view-toggle').click();
  const table = page.locator('#data-table, table').first();
  await expect(table).toContainText('82.5');
  await expect(table).toContainText('650'); // 摂取（seedした食事）
  expect(errors).toEqual([]);
});

test('食事・運動タブ: 履歴にseedした記録が表示される', async ({ page }) => {
  const errors = collectConsoleErrors(page);
  await page.goto('/');
  await page.locator('#tab-meals').click();
  await expect(page.locator('#meals-history')).toContainText('E2E定食');
  await page.locator('#tab-exercise').click();
  await expect(page.locator('#exercise-history')).toContainText('E2Eベンチプレス');
  await expect(page.locator('#exercise-history')).toContainText('60×5');
  expect(errors).toEqual([]);
});

test('空期間からの復帰: カスタム期間が空でも期間ボタンで戻れる（行き止まり防止）', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#content')).toBeVisible();
  // データの無い過去期間を選ぶ → 空状態
  await page.locator('.segment-btn[data-period="custom"]').click();
  await page.locator('#custom-from').fill('2020-01-01');
  await page.locator('#custom-to').fill('2020-01-31');
  await page.locator('#custom-apply').click();
  await expect(page.locator('#state-empty')).toBeVisible();
  await expect(page.locator('#content')).toBeHidden();
  // 空状態の期間ボタンで再読み込みなしに復帰できる
  await page.locator('[data-empty-period="1y"]').click();
  await expect(page.locator('#content')).toBeVisible();
  await expect(page.locator('#state-empty')).toBeHidden();
  await expect(page.locator('#card-weight-value')).toHaveText('82.5');
});

test('320px幅: 全タブで本文が横スクロールしない', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 700 });
  await page.goto('/');
  await expect(page.locator('#content')).toBeVisible();

  const measure = () =>
    page.evaluate(() => {
      const el = document.scrollingElement ?? document.documentElement;
      const limit = el.clientWidth;
      const bad: string[] = [];
      document.querySelectorAll('*').forEach((n) => {
        const r = n.getBoundingClientRect();
        if (r.right > limit + 1 && r.width > 0) {
          const e = n as HTMLElement;
          bad.push(`${e.tagName}#${e.id || ''}.${String(e.className).slice(0, 40)} right=${Math.round(r.right)} w=${Math.round(r.width)}`);
        }
      });
      return { overflow: el.scrollWidth - el.clientWidth, offenders: bad.slice(0, 12) };
    });

  const weight = await measure();
  expect(weight.overflow, `weight tab overflow; offenders: ${weight.offenders.join(' | ')}`).toBeLessThanOrEqual(0);

  await page.locator('#tab-meals').click();
  await expect(page.locator('#meals-history')).toContainText('E2E定食');
  const meals = await measure();
  expect(meals.overflow, `meals tab overflow; offenders: ${meals.offenders.join(' | ')}`).toBeLessThanOrEqual(0);

  await page.locator('#tab-exercise').click();
  await expect(page.locator('#exercise-history')).toContainText('E2Eベンチプレス');
  const exercise = await measure();
  expect(exercise.overflow, `exercise tab overflow; offenders: ${exercise.offenders.join(' | ')}`).toBeLessThanOrEqual(0);
});
