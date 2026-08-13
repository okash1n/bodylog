/* 食事タブ: 公開READは無認証、書き込みはOAuth(PKCE)のトークンで /api の POST/PATCH/DELETE を呼ぶ。
   タブ切替・OAuth・トースト・ピッカーは shared.js（window.__dash）を使う */
(() => {
  const { base, $, esc, todayJst, localDateOf, HISTORY_DAYS, toast, rw, login, loggedIn, handleCallback, createPicker } = window.__dash;

  // 表示・記録の対象日（空なら今日）
  const selectedDate = () => $('meal-date').value || todayJst();
  // 小数第1位まで（整数はそのまま）
  const r1 = (n) => (Math.round(n * 10) / 10).toString();
  // P/F/C を「 · P9.3 F6.4 C60」の形に。全て未入力なら空文字（栄養素はnull可）
  const pfc = (p, f, c) => {
    const parts = [];
    if (p != null) parts.push(`P${r1(p)}`);
    if (f != null) parts.push(`F${r1(f)}`);
    if (c != null) parts.push(`C${r1(c)}`);
    return parts.length ? ` · ${parts.join(' ')}` : '';
  };
  // PFC比率（%）。エネルギー換算（P4/F9/C4 kcal/g）して3者の中で正規化する。
  // 登録kcalで割ると食物繊維等の差でずれる（100%を超えうる）ため、換算値同士で閉じる。
  // 3つ揃っている場合のみ返す（部分入力の日に嘘の比率を出さない）
  const pfcRatio = (p, f, c) => {
    if (p == null || f == null || c == null) return '';
    const pe = p * 4;
    const fe = f * 9;
    const ce = c * 4;
    const t = pe + fe + ce;
    if (t <= 0) return '';
    const r = (x) => Math.round((x / t) * 100);
    return `${r(pe)}:${r(fe)}:${r(ce)}`;
  };
  // 実効PFCの合計（未入力=nullは加算しない。日次PFCの部分合計仕様に合わせる）
  const sumEff = (arr, key) => {
    let any = false;
    let s = 0;
    for (const m of arr) {
      if (m[key] != null) {
        any = true;
        s += m[key];
      }
    }
    return any ? s : null;
  };
  const MEAL_TYPE_LABEL = { breakfast: '朝', lunch: '昼', dinner: '夜', snack: '間食' };

  function updateAuthUi() {
    $('meals-auth').hidden = loggedIn();
    $('meal-add-form').hidden = !loggedIn();
    $('menus-manage').hidden = !loggedIn();
  }
  document.addEventListener('tabshown', (e) => {
    if (e.detail === 'meals') refresh();
  });
  document.addEventListener('authchanged', updateAuthUi);
  $('meals-login').addEventListener('click', () => {
    login().catch((e) => alert(`ログインを開始できませんでした: ${e.message}`));
  });

  // ---- データ表示 ----
  let menus = [];
  let selectedMenu = null;
  async function refresh() {
    updateAuthUi();
    const hist = $('meals-history');
    if (!hist.innerHTML) hist.innerHTML = '<p class="meals-empty">読み込み中…</p>';
    try {
      const [mealsRes, menusRes] = await Promise.all([
        fetch(`${base}api/meals?days=${HISTORY_DAYS}`),
        fetch(`${base}api/menus`),
      ]);
      // 失敗を空データ扱いすると「まだ記録がありません」に化けて実データが消えたように見える
      if (!mealsRes.ok || !menusRes.ok) throw new Error(`HTTP ${mealsRes.status}/${menusRes.status}`);
      const meals = (await mealsRes.json()).meals ?? [];
      menus = (await menusRes.json()).menus ?? [];
      renderHistory(meals);
      $('menus-list').innerHTML = menus
        .map(
          (m) => `<li>${esc(m.name)}（${m.calories} kcal${pfc(m.protein_g, m.fat_g, m.carbs_g)}）<button data-arch="${m.id}" type="button">アーカイブ</button></li>`,
        )
        .join('');
    } catch (err) {
      console.error('[meals] refresh failed', err);
      hist.innerHTML =
        '<div class="state-box"><p>データの取得に失敗しました。</p><button type="button" class="primary-btn" data-retry>再試行</button></div>';
    }
  }

  // 直近50日の食事を日付ごとにグループ化して表示。各日の見出しに合計、各食事にPFC。
  // mealsはAPIが新しい順(ORDER BY eaten_at DESC)で返すので、その順序でグループ化＝日付降順になる。
  function renderHistory(meals) {
    if (!meals.length) {
      $('meals-history').innerHTML = '<p class="meals-empty">まだ記録がありません。</p>';
      return;
    }
    const canDel = loggedIn();
    const groups = [];
    const byDate = Object.create(null);
    meals.forEach((m) => {
      const d = localDateOf(m.eaten_at);
      if (!byDate[d]) {
        byDate[d] = { d, items: [] };
        groups.push(byDate[d]);
      }
      byDate[d].items.push(m);
    });
    const rows = groups
      .map((g) => {
        // 日は新しい順のまま、各日の中は時刻昇順（朝→昼→夜）で読みやすく
        g.items.sort((a, b) => String(a.eaten_at).localeCompare(String(b.eaten_at)));
        const total = g.items.reduce((a, m) => a + m.effective_calories, 0);
        const dp = sumEff(g.items, 'effective_protein_g');
        const df = sumEff(g.items, 'effective_fat_g');
        const dc = sumEff(g.items, 'effective_carbs_g');
        // 合計行も明細と同じ列に値を揃える（区分+メニューをまたいで日付、倍率は空）
        const head =
          `<tr class="mh-day"><td colspan="2">${g.d}　合計</td><td></td>` +
          `<td class="mh-num">${Math.round(total)} kcal</td>` +
          `<td class="mh-macro">${pfc(dp, df, dc).replace(/^ · /, '') || '—'}</td>` +
          `<td class="mh-macro">${pfcRatio(dp, df, dc) || '—'}</td>` +
          `${canDel ? '<td></td>' : ''}</tr>`;
        const items = g.items
          .map((m) => {
            const t = MEAL_TYPE_LABEL[m.meal_type] || '—';
            const macro = pfc(m.effective_protein_g, m.effective_fat_g, m.effective_carbs_g).replace(/^ · /, '');
            const ratio = pfcRatio(m.effective_protein_g, m.effective_fat_g, m.effective_carbs_g);
            return `<tr><td class="mh-type">${t}</td><td>${esc(m.menu_name)}</td><td class="mh-num">×${m.multiplier}</td><td class="mh-num">${Math.round(m.effective_calories)} kcal</td><td class="mh-macro">${macro || '—'}</td><td class="mh-macro">${ratio || '—'}</td>${canDel ? `<td><button class="mh-del" data-del="${m.id}" type="button">削除</button></td>` : ''}</tr>`;
          })
          .join('');
        return head + items;
      })
      .join('');
    $('meals-history').innerHTML =
      `<table class="meals-history-table"><thead><tr><th>区分</th><th>メニュー</th><th>倍率</th><th>kcal</th><th>PFC <span class="unit">g</span></th><th>PFC <span class="unit">%</span></th>${canDel ? '<th></th>' : ''}</tr></thead><tbody>${rows}</tbody></table>`;
  }

  $('meals-history').addEventListener('click', async (e) => {
    if (e.target.closest('[data-retry]')) return refresh();
    const btn = e.target.closest('button[data-del]');
    if (btn && confirm('この記録を削除しますか？')) {
      const res = await rw(`meals/${btn.dataset.del}`, 'DELETE');
      toast(res.ok ? '削除しました' : '削除に失敗しました');
      refresh();
    }
  });
  $('menus-list').addEventListener('click', async (e) => {
    const id = e.target.dataset?.arch;
    if (id) {
      const res = await rw(`menus/${id}/archive`, 'POST');
      if (res.ok) {
        // 誤タップから戻せるよう、undo付きトーストにする（unarchive APIは既存）
        toast('アーカイブしました', {
          action: {
            label: '元に戻す',
            onClick: async () => {
              await rw(`menus/${id}/unarchive`, 'POST');
              toast('元に戻しました');
              refresh();
            },
          },
        });
      } else {
        toast('アーカイブに失敗しました');
      }
      refresh();
    }
  });

  // ---- 記録フォーム（fzf風メニューピッカー。実装はshared.jsのcreatePicker） ----
  createPicker({
    input: $('meal-menu-search'),
    list: $('meal-menu-candidates'),
    getItems: () => menus,
    renderMeta: (m) => `（${m.calories} kcal${pfc(m.protein_g, m.fat_g, m.carbs_g)}）`,
    emptyHint: 'メニューがありません。下の「メニュー管理」から追加してください',
    onInput: () => {
      selectedMenu = null; // 手入力し直したら選択解除
    },
    onPick: (m) => {
      selectedMenu = m;
    },
  });

  $('meal-add-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!selectedMenu) return alert('メニューを選択してください');
    // 過去日を選択中ならその日のJST正午(03:00Z)で記録（未来時刻回避＋日付境界で当該日に入る）。
    // 今日なら eaten_at を省略してサーバーの現在時刻を使う
    const day = selectedDate();
    const eaten_at = day < todayJst() ? `${day}T03:00:00Z` : undefined;
    const res = await rw('meals', 'POST', {
      menu_id: selectedMenu.id,
      multiplier: Number($('meal-multiplier').value) || 1,
      meal_type: $('meal-type').value || undefined,
      eaten_at,
    });
    // 失敗時にフォームをクリアすると入力（メニュー選択・倍率・区分）が消えるため、必ずreturnする
    if (!res.ok) return alert(`記録に失敗: ${(await res.json()).error ?? res.status}`);
    toast('記録しました');
    selectedMenu = null;
    $('meal-menu-search').value = '';
    refresh();
  });
  $('menu-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const num = (id) => ($(id).value === '' ? undefined : Number($(id).value));
    const res = await rw('menus', 'POST', {
      name: $('menu-name').value.trim(),
      calories: Number($('menu-calories').value),
      protein_g: num('menu-protein'), fat_g: num('menu-fat'), carbs_g: num('menu-carbs'),
    });
    // 失敗時にreset()すると入力済みの名前/kcal/PFCが消えるため、必ずreturnする
    if (!res.ok) return alert(`メニュー追加に失敗: ${(await res.json()).error ?? res.status}`);
    toast('メニューを追加しました');
    e.target.reset();
    refresh();
  });

  // 日付セレクタ初期化（初期値=今日・上限=今日）。これは「記録する日」専用（backfill）。
  // 履歴テーブルは常に直近50日を表示するため、日付変更では再取得しない（未来だけ弾く）
  $('meal-date').value = todayJst();
  $('meal-date').max = todayJst();
  $('meal-date').addEventListener('change', () => {
    if (!$('meal-date').value || $('meal-date').value > todayJst()) $('meal-date').value = todayJst();
  });

  // OAuthリダイレクト処理はリスナー登録後に（ログイン完了時にshowTab('meals')→tabshown→refreshが走る）
  handleCallback();
  updateAuthUi();
})();
