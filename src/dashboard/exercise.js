/* 運動タブ: 公開READは無認証、書き込みはmeals.jsが用意した window.__dashAuth（OAuth PKCE）経由 */
(() => {
  const base = document.querySelector('script[src*="exercise.js"]').src.replace(/exercise\.js.*$/, '');
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s).replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
  const todayJst = () => new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10);
  const selectedDate = () => $('exercise-date').value || todayJst();
  const r1 = (n) => (Math.round(n * 10) / 10).toString();
  const localDateOf = (iso) => new Date(Date.parse(iso) + 9 * 3600_000).toISOString().slice(0, 10);
  const HISTORY_DAYS = 50;

  // 認証はmeals.js（先に読み込まれる）が公開する共有API。トークンは同一localStorageキーを使う
  const auth = () => window.__dashAuth;
  const loggedIn = () => Boolean(auth() && auth().loggedIn());
  const rw = (path, method, body) => auth().rw(path, method, body);

  // ---- 小さなチャートユーティリティ（app.jsとは別インスタンスなので最小限を複製） ----
  const DAY_MS = 86400000;
  const pad2 = (n) => (n < 10 ? '0' : '') + n;
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
  $('exercise-login').addEventListener('click', () => auth() && auth().login());

  // ---- データ取得（タブ表示時） ----
  async function refresh() {
    updateAuthUi();
    const [logsRes, menusRes, dailyRes, measRes] = await Promise.all([
      fetch(`${base}api/exercise/logs?days=${HISTORY_DAYS}`),
      fetch(`${base}api/exercise/menus`),
      fetch(`${base}api/exercise/daily?days=${HISTORY_DAYS}`),
      fetch(`${base}api/measurements?days=${HISTORY_DAYS}`),
    ]);
    const logs = (await logsRes.json()).logs ?? [];
    menus = (await menusRes.json()).menus ?? [];
    lastDaily = (await dailyRes.json()).days ?? [];
    lastMeas = (await measRes.json()).days ?? [];
    latestWeight = lastWeightOf(lastMeas);
    renderHistory(logs);
    renderMenus();
    renderVolumeChart();
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
    if (m.is_bodyweight) parts.push('自重');
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
      await rw(`exercise/menus/${id}/archive`, 'POST');
      refresh();
    }
  });

  // カテゴリ選択でMETs（有酸素）／部位・自重（筋トレ）の入力欄を出し分ける
  function syncMenuFormFields() {
    const isCardio = $('exercise-menu-category').value === 'cardio';
    $('exercise-menu-mets').hidden = !isCardio;
    $('exercise-menu-muscle').hidden = isCardio;
    $('exercise-menu-bw-wrap').hidden = isCardio;
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
    }
    const res = await rw('exercise/menus', 'POST', body);
    if (!res.ok) return alert(`種目追加に失敗: ${(await res.json()).error ?? res.status}`);
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
    const btn = e.target.closest('button[data-del]');
    if (btn && confirm('この記録を削除しますか？')) {
      await rw(`exercise/logs/${btn.dataset.del}`, 'DELETE');
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

  // ---- 記録フォーム（fzf風の種目ピッカー） ----
  const CAND_LIMIT = 10;
  let candList = [];
  let activeIdx = -1;

  const fuzzyMatch = (name, q) => {
    const chars = [...name];
    if (!q) return { score: 0, matched: [] };
    const lc = chars.map((c) => c.toLowerCase());
    const lq = [...q.toLowerCase()];
    const matched = [];
    let qi = 0;
    let score = 0;
    let prev = -2;
    for (let i = 0; i < lc.length && qi < lq.length; i++) {
      if (lc[i] === lq[qi]) {
        matched.push(i);
        score += (prev === i - 1 ? 3 : 1) + (i === 0 ? 2 : 0);
        prev = i;
        qi++;
      }
    }
    if (qi < lq.length) return null;
    return { score: score - chars.length * 0.01, matched };
  };
  const computeCandidates = () => {
    const q = $('exercise-menu-search').value.trim();
    const scored = [];
    for (const m of menus) {
      const r = fuzzyMatch(m.name, q);
      if (r) scored.push({ m, ...r });
    }
    scored.sort(
      q
        ? (a, b) => b.score - a.score || [...a.m.name].length - [...b.m.name].length
        : (a, b) => a.m.name.localeCompare(b.m.name, 'ja'),
    );
    return scored.slice(0, CAND_LIMIT);
  };
  const highlight = (name, matched) => {
    const set = new Set(matched);
    return [...name].map((ch, i) => (set.has(i) ? `<mark>${esc(ch)}</mark>` : esc(ch))).join('');
  };
  const drawCandidates = () => {
    $('exercise-menu-candidates').innerHTML = candList
      .map((c, i) => `<li data-pick="${c.m.id}" class="${i === activeIdx ? 'active' : ''}">${highlight(c.m.name, c.matched)}（${esc(menuMeta(c.m))}）</li>`)
      .join('');
  };
  const showCandidates = () => {
    candList = computeCandidates();
    activeIdx = candList.length ? 0 : -1;
    drawCandidates();
  };
  const hideCandidates = () => {
    candList = [];
    activeIdx = -1;
    $('exercise-menu-candidates').innerHTML = '';
  };
  const pickMenu = (m) => {
    if (!m) return;
    selectedMenu = m;
    $('exercise-menu-search').value = m.name;
    hideCandidates();
    syncRecordFields();
  };

  $('exercise-menu-search').addEventListener('focus', showCandidates);
  $('exercise-menu-search').addEventListener('input', () => {
    selectedMenu = null;
    syncRecordFields();
    showCandidates();
  });
  $('exercise-menu-search').addEventListener('keydown', (e) => {
    if (!candList.length) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      activeIdx = (activeIdx + 1) % candList.length;
      drawCandidates();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      activeIdx = (activeIdx - 1 + candList.length) % candList.length;
      drawCandidates();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (activeIdx >= 0) pickMenu(candList[activeIdx].m);
    } else if (e.key === 'Escape') {
      hideCandidates();
    }
  });
  $('exercise-menu-search').addEventListener('blur', () => setTimeout(hideCandidates, 150));
  $('exercise-menu-candidates').addEventListener('mousedown', (e) => {
    const id = e.target.closest('li')?.dataset?.pick;
    if (!id) return;
    e.preventDefault();
    pickMenu(menus.find((m) => m.id === id));
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
      `<input class="set-reps" type="number" min="1" max="1000" step="1" placeholder="回" value="${reps ?? ''}">` +
      `<input class="set-weight" type="number" min="0" max="1000" step="0.5" placeholder="${selectedMenu && selectedMenu.is_bodyweight ? '追加kg(任意)' : 'kg'}" value="${weight ?? ''}">` +
      `<button type="button" class="ghost-btn set-remove">×</button>`;
    $('exercise-sets').appendChild(div);
  }
  $('exercise-add-set').addEventListener('click', () => addSetRow());
  $('exercise-sets').addEventListener('click', (e) => {
    if (e.target.classList.contains('set-remove')) {
      const rows = $('exercise-sets').children;
      if (rows.length > 1) e.target.closest('.set-row').remove();
    }
  });

  $('exercise-add-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!selectedMenu) return alert('種目を選択してください');
    const day = selectedDate();
    const performed_at = day < todayJst() ? `${day}T03:00:00Z` : undefined;
    const body = { menu_id: selectedMenu.id, performed_at };
    if (selectedMenu.category === 'cardio') {
      const min = Number($('exercise-duration').value);
      if (!min) return alert('時間（分）を入力してください');
      body.duration_min = min;
    } else {
      const sets = [];
      for (const row of $('exercise-sets').children) {
        const reps = Number(row.querySelector('.set-reps').value);
        const w = row.querySelector('.set-weight').value;
        if (!reps) continue;
        sets.push({ reps, weight_kg: w === '' ? null : Number(w) });
      }
      if (!sets.length) return alert('セット（回数）を入力してください');
      body.sets = sets;
    }
    const res = await rw('exercise/logs', 'POST', body);
    if (!res.ok) return alert(`記録に失敗: ${(await res.json()).error ?? res.status}`);
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
})();
