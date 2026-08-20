/* 運動タブ: 公開READは無認証、書き込みはOAuth(PKCE)のトークンで /api の POST/DELETE を呼ぶ。
   タブ切替・OAuth・トースト・ピッカーは shared.js（window.__dash）を使う */
(() => {
  const { base, $, esc, todayJst, localDateOf, HISTORY_DAYS, toast, rw, apiGet, login, loggedIn, createPicker } = window.__dash;

  const selectedDate = () => $('exercise-date').value || todayJst();

  // ---- 小さなチャートユーティリティ（app.jsは同期スクリプトのため共有できず、最小限を複製） ----
  const DAY_MS = 86400000;
  const addDays = (ymd, d) => new Date(Date.parse(ymd + 'T00:00:00Z') + d * DAY_MS).toISOString().slice(0, 10);
  function buildDateLabels(from, to) {
    const out = [];
    const end = Date.parse(to + 'T00:00:00Z');
    for (let t = Date.parse(from + 'T00:00:00Z'); t <= end; t += DAY_MS) out.push(new Date(t).toISOString().slice(0, 10));
    return out;
  }
  function hexToRgba(color, alpha) {
    const m = /^#([0-9a-f]{6})$/i.exec(String(color).trim());
    if (!m) return color;
    const n = parseInt(m[1], 16);
    return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${alpha})`;
  }
  const readVar = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

  // ---- 状態 ----
  let menus = [];
  let selectedMenu = null;
  let latestWeight = null; // 消費kcalプレビュー用（直近の実測体重）
  let volumeChart = null;
  let lastDaily = [];
  let lastMeas = [];

  // ---- 認証UI ----
  function updateAuthUi() {
    $('exercise-auth').hidden = loggedIn();
    $('exercise-add-form').hidden = !loggedIn();
    $('exercise-menus-manage').hidden = !loggedIn();
  }
  // 履歴の削除ボタンは描画時のloggedIn()で出し分けるため、認証状態が変わったら再描画も行う。
  // 再描画は自パネル表示中のみ（非表示タブは次のtabshownで必ずrefreshされるため二重取得を避ける）
  document.addEventListener('authchanged', () => {
    updateAuthUi();
    if (!$('panel-exercise').hidden) refresh();
  });
  $('exercise-login').addEventListener('click', () => {
    login().catch((e) => toast(`ログインを開始できませんでした: ${e.message}`, { tone: 'error' }));
  });

  // ---- データ取得（タブ表示時） ----
  async function refresh() {
    updateAuthUi();
    const hist = $('exercise-history');
    if (!hist.innerHTML) hist.innerHTML = '<p class="meals-empty">読み込み中…</p>';
    try {
      // apiGet: READ_ACCESS=private のサーバーでもログイン済みなら読めるようBearerを付ける
      const responses = await Promise.all([
        apiGet(`exercise/logs?days=${HISTORY_DAYS}`),
        apiGet('exercise/menus'),
        apiGet(`exercise/daily?days=${HISTORY_DAYS}`),
        apiGet(`measurements?days=${HISTORY_DAYS}`),
      ]);
      // 失敗を空データ扱いすると「まだ記録がありません」に化けて実データが消えたように見える
      if (responses.some((r) => !r.ok)) throw new Error(`HTTP ${responses.map((r) => r.status).join('/')}`);
      const [logsRes, menusRes, dailyRes, measRes] = responses;
      const logs = (await logsRes.json()).logs ?? [];
      menus = (await menusRes.json()).menus ?? [];
      lastDaily = (await dailyRes.json()).days ?? [];
      lastMeas = (await measRes.json()).days ?? [];
      latestWeight = lastWeightOf(lastMeas);
      renderHistory(logs);
      renderMenus();
      renderVolumeChart();
    } catch (err) {
      console.error('[exercise] refresh failed', err);
      $('exercise-volume-wrap').hidden = true;
      hist.innerHTML =
        '<div class="state-box"><p>データの取得に失敗しました。</p><button type="button" class="primary-btn" data-retry>再試行</button></div>';
    }
  }
  document.addEventListener('tabshown', (e) => {
    if (e.detail === 'exercise') refresh();
  });

  function lastWeightOf(days) {
    for (let i = days.length - 1; i >= 0; i--) {
      if (days[i].weight != null) return days[i].weight;
    }
    return null;
  }

  // ---- 種目管理 ----
  function menuMeta(m) {
    if (m.category === 'cardio') return `有酸素 · ${m.mets} METs`;
    const parts = ['筋トレ'];
    if (m.muscle_group) parts.push(m.muscle_group);
    if (m.is_bodyweight) parts.push(m.bodyweight_factor != null && m.bodyweight_factor < 1 ? `自重×${m.bodyweight_factor}` : '自重');
    return parts.join(' · ');
  }
  function renderMenus() {
    $('exercise-menus-list').innerHTML = menus
      .map((m) => `<li>${esc(m.name)}（${esc(menuMeta(m))}）<button data-arch="${m.id}" type="button">アーカイブ</button></li>`)
      .join('');
  }
  $('exercise-menus-list').addEventListener('click', async (e) => {
    const id = e.target.dataset?.arch;
    if (id) {
      const res = await rw(`exercise/menus/${id}/archive`, 'POST');
      if (res.ok) {
        // 誤タップから戻せるよう、undo付きトーストにする（unarchive APIは既存）
        toast('アーカイブしました', {
          action: {
            label: '元に戻す',
            onClick: async () => {
              await rw(`exercise/menus/${id}/unarchive`, 'POST');
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

  // カテゴリ選択でMETs（有酸素）／部位・自重（筋トレ）の入力欄を出し分ける
  function syncMenuFormFields() {
    const isCardio = $('exercise-menu-category').value === 'cardio';
    $('exercise-menu-mets').hidden = !isCardio;
    $('exercise-menu-muscle').hidden = isCardio;
    $('exercise-menu-bw-wrap').hidden = isCardio;
    $('exercise-menu-bwf-wrap').hidden = isCardio;
  }
  $('exercise-menu-category').addEventListener('change', syncMenuFormFields);
  syncMenuFormFields();

  $('exercise-menu-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const category = $('exercise-menu-category').value;
    const body = { name: $('exercise-menu-name').value.trim(), category };
    if (category === 'cardio') {
      body.mets = Number($('exercise-menu-mets').value);
    } else {
      const muscle = $('exercise-menu-muscle').value.trim();
      if (muscle) body.muscle_group = muscle;
      body.is_bodyweight = $('exercise-menu-bw').checked;
      if (body.is_bodyweight) {
        // 体重算入係数（0〜1）。未入力・不正値は既定1.0（サーバー側の既定に任せる）
        const factor = parseFloat($('exercise-menu-bwf').value);
        if (Number.isFinite(factor) && factor >= 0 && factor <= 1) body.bodyweight_factor = factor;
      }
    }
    const res = await rw('exercise/menus', 'POST', body);
    if (!res.ok) return toast(`種目追加に失敗: ${(await res.json()).error ?? res.status}`, { tone: 'error' });
    toast('種目を追加しました');
    e.target.reset();
    syncMenuFormFields();
    refresh();
  });

  // ---- 履歴テーブル（直近50日、日付グループ化） ----
  function setsLabel(log) {
    return log.sets
      .map((s) => `${s.weight_kg != null ? s.weight_kg : (log.is_bodyweight ? '自重' : 0)}×${s.reps}`)
      .join(', ');
  }
  function renderHistory(logs) {
    if (!logs.length) {
      $('exercise-history').innerHTML = '<p class="meals-empty">まだ記録がありません。</p>';
      return;
    }
    const canDel = loggedIn();
    const groups = [];
    const byDate = Object.create(null);
    logs.forEach((l) => {
      const d = localDateOf(l.performed_at);
      if (!byDate[d]) {
        byDate[d] = { d, items: [] };
        groups.push(byDate[d]);
      }
      byDate[d].items.push(l);
    });
    const span = canDel ? 5 : 4;
    const rows = groups
      .map((g) => {
        g.items.sort((a, b) => String(a.performed_at).localeCompare(String(b.performed_at)));
        const burn = g.items.reduce((a, l) => a + (l.calories || 0), 0);
        const vol = g.items.reduce((a, l) => a + (l.total_volume || 0), 0);
        const totals = [];
        if (burn > 0) totals.push(`消費 ${Math.round(burn)} kcal`);
        if (vol > 0) totals.push(`ボリューム ${Math.round(vol)}`);
        const head = `<tr class="mh-day"><td colspan="${span}">${g.d}${totals.length ? '　' + totals.join(' · ') : ''}</td></tr>`;
        const items = g.items
          .map((l) => {
            if (l.category === 'cardio') {
              return `<tr><td>${esc(l.menu_name)}</td><td>${l.duration_min}分</td><td class="mh-num">${Math.round(l.calories || 0)} kcal</td><td class="mh-num">—</td>${canDel ? delCell(l.id) : ''}</tr>`;
            }
            return `<tr><td>${esc(l.menu_name)}</td><td>${esc(setsLabel(l))}</td><td class="mh-num">—</td><td class="mh-num">${Math.round(l.total_volume || 0)}</td>${canDel ? delCell(l.id) : ''}</tr>`;
          })
          .join('');
        return head + items;
      })
      .join('');
    $('exercise-history').innerHTML =
      `<table class="meals-history-table"><thead><tr><th>種目</th><th>内容</th><th>kcal</th><th>ボリューム</th>${canDel ? '<th></th>' : ''}</tr></thead><tbody>${rows}</tbody></table>`;
  }
  const delCell = (id) => `<td><button class="mh-del" data-del="${id}" type="button">削除</button></td>`;

  $('exercise-history').addEventListener('click', async (e) => {
    if (e.target.closest('[data-retry]')) return refresh();
    const btn = e.target.closest('button[data-del]');
    if (btn && confirm('この記録を削除しますか？')) {
      const res = await rw(`exercise/logs/${btn.dataset.del}`, 'DELETE');
      toast(res.ok ? '削除しました' : '削除に失敗しました');
      refresh();
    }
  });

  // ---- 筋トレ総ボリューム × 除脂肪体重 グラフ ----
  function renderVolumeChart() {
    const to = todayJst();
    const from = addDays(to, -(HISTORY_DAYS - 1));
    const labels = buildDateLabels(from, to);
    const volBy = Object.create(null);
    lastDaily.forEach((r) => {
      volBy[r.d] = r.strength_volume;
    });
    const ffmBy = Object.create(null);
    lastMeas.forEach((r) => {
      ffmBy[r.d] = r.fat_free_mass;
    });
    const vol = labels.map((l) => (volBy[l] != null ? volBy[l] : null));
    const ffm = labels.map((l) => (ffmBy[l] != null ? ffmBy[l] : null));
    const hasVol = vol.some((v) => v != null && v > 0);
    $('exercise-volume-wrap').hidden = !hasVol;
    if (!hasVol) {
      if (volumeChart) {
        volumeChart.destroy();
        volumeChart = null;
      }
      return;
    }
    const t = {
      text: readVar('--text'),
      muted: readVar('--text-muted'),
      grid: readVar('--grid'),
      accent: readVar('--accent'),
      ffm: readVar('--accent-3'),
    };
    const datasets = [
      {
        type: 'bar', label: '総ボリューム', data: vol, yAxisID: 'yVol',
        backgroundColor: hexToRgba(t.accent, 0.5), borderWidth: 0, order: 2,
      },
      {
        type: 'line', label: '除脂肪体重', data: ffm, yAxisID: 'yFfm',
        borderColor: t.ffm, backgroundColor: t.ffm, borderWidth: 2, tension: 0.3,
        pointRadius: 0, pointHoverRadius: 4, spanGaps: true, order: 1,
      },
    ];
    if (volumeChart) {
      volumeChart.data = { labels, datasets };
      applyChartTheme(t);
      volumeChart.update('none');
      return;
    }
    volumeChart = new Chart($('exercise-volume-chart'), {
      type: 'line',
      data: { labels, datasets },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false },
        color: t.text,
        plugins: {
          legend: { labels: { color: t.text, usePointStyle: true, boxWidth: 8, boxHeight: 8 } },
          tooltip: {
            position: 'nearest',
            callbacks: {
              label: (ctx) => {
                const v = ctx.parsed.y;
                if (ctx.dataset.yAxisID === 'yFfm') return ` 除脂肪体重: ${v == null ? '—' : v.toFixed(1) + ' kg'}`;
                return ` 総ボリューム: ${v == null ? '—' : Math.round(v)}`;
              },
            },
          },
        },
        scales: {
          x: { ticks: { color: t.muted, maxRotation: 0, maxTicksLimit: 8 }, grid: { display: false }, border: { color: t.grid } },
          yVol: {
            type: 'linear', position: 'left', beginAtZero: true, min: 0,
            title: { display: true, text: 'ボリューム', color: t.muted },
            ticks: { color: t.muted }, grid: { color: t.grid }, border: { display: false },
          },
          yFfm: {
            type: 'linear', position: 'right',
            title: { display: true, text: '除脂肪体重 kg', color: t.muted },
            ticks: { color: t.muted, callback: (v) => Number(v).toFixed(1) },
            grid: { drawOnChartArea: false }, border: { display: false },
          },
        },
      },
    });
  }
  function applyChartTheme(t) {
    if (!volumeChart) return;
    const o = volumeChart.options;
    o.color = t.text;
    o.plugins.legend.labels.color = t.text;
    o.scales.x.ticks.color = t.muted;
    o.scales.x.border.color = t.grid;
    o.scales.yVol.ticks.color = t.muted;
    o.scales.yVol.grid.color = t.grid;
    o.scales.yVol.title.color = t.muted;
    o.scales.yFfm.ticks.color = t.muted;
    o.scales.yFfm.title.color = t.muted;
  }
  // テーマ切替時、運動タブが表示中ならボリュームグラフを再描画する
  function rerenderChartTheme() {
    if (!$('panel-exercise').hidden && volumeChart) renderVolumeChart();
  }
  $('theme-toggle').addEventListener('click', () => setTimeout(rerenderChartTheme, 0));
  const darkMq = window.matchMedia('(prefers-color-scheme: dark)');
  if (darkMq.addEventListener) {
    darkMq.addEventListener('change', () => {
      if (!document.documentElement.dataset.theme) rerenderChartTheme();
    });
  }

  // ---- 記録フォーム（fzf風の種目ピッカー。実装はshared.jsのcreatePicker） ----
  createPicker({
    input: $('exercise-menu-search'),
    list: $('exercise-menu-candidates'),
    getItems: () => menus,
    renderMeta: (m) => `（${esc(menuMeta(m))}）`,
    emptyHint: '種目がありません。下の「種目管理」から追加してください',
    onInput: () => {
      selectedMenu = null;
      syncRecordFields();
    },
    onPick: (m) => {
      selectedMenu = m;
      syncRecordFields();
    },
  });

  // 選択した種目のカテゴリで有酸素／筋トレの入力欄を出し分ける
  function syncRecordFields() {
    const isCardio = selectedMenu && selectedMenu.category === 'cardio';
    const isStrength = selectedMenu && selectedMenu.category === 'strength';
    $('exercise-cardio-fields').hidden = !isCardio;
    $('exercise-strength-fields').hidden = !isStrength;
    if (isStrength && $('exercise-sets').children.length === 0) addSetRow();
    if (isCardio) updateKcalPreview();
  }
  function updateKcalPreview() {
    const min = Number($('exercise-duration').value);
    const el = $('exercise-kcal-preview');
    if (!selectedMenu || !selectedMenu.mets || !min) {
      el.textContent = '';
      return;
    }
    if (latestWeight == null) {
      el.textContent = '体重の実測がないと消費kcalを算出できません';
      return;
    }
    el.textContent = `推定 ${Math.round(selectedMenu.mets * latestWeight * (min / 60) * 1.05)} kcal`;
  }
  $('exercise-duration').addEventListener('input', updateKcalPreview);

  function addSetRow(reps, weight) {
    const div = document.createElement('div');
    div.className = 'set-row';
    div.innerHTML =
      `<input class="set-reps" type="number" min="1" max="1000" step="1" placeholder="回" aria-label="回数" value="${reps ?? ''}">` +
      `<input class="set-weight" type="number" min="0" max="1000" step="0.5" placeholder="${selectedMenu && selectedMenu.is_bodyweight ? '追加kg(任意)' : 'kg'}" aria-label="重量kg" value="${weight ?? ''}">` +
      `<button type="button" class="ghost-btn set-remove">×</button>`;
    $('exercise-sets').appendChild(div);
  }
  // ジムでは同重量×同回数の繰り返しが多いため、＋セットは直前行の値をプリフィルする
  $('exercise-add-set').addEventListener('click', () => {
    const last = $('exercise-sets').lastElementChild;
    addSetRow(
      last ? last.querySelector('.set-reps').value : undefined,
      last ? last.querySelector('.set-weight').value : undefined,
    );
  });
  $('exercise-sets').addEventListener('click', (e) => {
    if (e.target.classList.contains('set-remove')) {
      const rows = $('exercise-sets').children;
      const row = e.target.closest('.set-row');
      if (rows.length > 1) {
        row.remove();
      } else {
        // 最後の1行は消せない代わりに入力をクリアする（無反応に見えないように）
        row.querySelector('.set-reps').value = '';
        row.querySelector('.set-weight').value = '';
      }
    }
  });

  $('exercise-add-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!selectedMenu) return toast('種目を選択してください', { tone: 'error' });
    const day = selectedDate();
    const performed_at = day < todayJst() ? `${day}T03:00:00Z` : undefined;
    const body = { menu_id: selectedMenu.id, performed_at };
    if (selectedMenu.category === 'cardio') {
      const min = Number($('exercise-duration').value);
      if (!min) return toast('時間（分）を入力してください', { tone: 'error' });
      body.duration_min = min;
    } else {
      const sets = [];
      for (const row of $('exercise-sets').children) {
        const reps = Number(row.querySelector('.set-reps').value);
        const w = row.querySelector('.set-weight').value;
        if (!reps) continue;
        sets.push({ reps, weight_kg: w === '' ? null : Number(w) });
      }
      if (!sets.length) return toast('セット（回数）を入力してください', { tone: 'error' });
      body.sets = sets;
    }
    const res = await rw('exercise/logs', 'POST', body);
    if (!res.ok) return toast(`記録に失敗: ${(await res.json()).error ?? res.status}`, { tone: 'error' });
    toast('記録しました');
    selectedMenu = null;
    $('exercise-menu-search').value = '';
    $('exercise-duration').value = '';
    $('exercise-sets').innerHTML = '';
    $('exercise-kcal-preview').textContent = '';
    syncRecordFields();
    refresh();
  });

  // 記録する日（初期値=今日・上限=今日）
  $('exercise-date').value = todayJst();
  $('exercise-date').max = todayJst();
  $('exercise-date').addEventListener('change', () => {
    if (!$('exercise-date').value || $('exercise-date').value > todayJst()) $('exercise-date').value = todayJst();
  });

  updateAuthUi();
})();
