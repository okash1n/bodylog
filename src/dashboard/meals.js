/* 食事タブ: 公開READは無認証、書き込みはOAuth(PKCE)のトークンで /rw/ を呼ぶ */
(() => {
  const base = document.querySelector('script[src*="meals.js"]').src.replace(/meals\.js.*$/, '');
  const origin = location.origin;
  const LS = { token: 'meals.token', refresh: 'meals.refresh', client: 'meals.client_id', verifier: 'meals.pkce', state: 'meals.state' };

  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s).replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
  // サーバーの日付境界（TZ_OFFSET_HOURS=9 / JST）に合わせた「今日」。日付セレクタの初期値・上限に使う
  const todayJst = () => new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10);
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
  // ISO8601(UTC) → JST(+9)ローカル日付。履歴のグループ化キー
  const localDateOf = (iso) => new Date(Date.parse(iso) + 9 * 3600_000).toISOString().slice(0, 10);
  const HISTORY_DAYS = 50;

  // ---- タブ切替 ----
  const panels = { weight: $('panel-weight'), meals: $('panel-meals') };
  const tabs = { weight: $('tab-weight'), meals: $('tab-meals') };
  function showTab(name) {
    for (const key of Object.keys(panels)) {
      panels[key].hidden = key !== name;
      tabs[key].classList.toggle('active', key === name);
    }
    if (name === 'meals') refresh();
  }
  tabs.weight.addEventListener('click', () => showTab('weight'));
  tabs.meals.addEventListener('click', () => showTab('meals'));

  // ---- OAuth (PKCE) ----
  function b64url(bytes) {
    return btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }
  async function ensureClient() {
    let id = localStorage.getItem(LS.client);
    if (id) return id;
    const res = await fetch(`${origin}/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_name: 'weight-dashboard', redirect_uris: [base], token_endpoint_auth_method: 'none' }),
    });
    id = (await res.json()).client_id;
    localStorage.setItem(LS.client, id);
    return id;
  }
  async function login() {
    const clientId = await ensureClient();
    const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
    localStorage.setItem(LS.verifier, verifier);
    const state = b64url(crypto.getRandomValues(new Uint8Array(32)));
    localStorage.setItem(LS.state, state);
    const challenge = b64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
    const url = new URL(`${origin}/authorize`);
    url.search = new URLSearchParams({
      response_type: 'code', client_id: clientId, redirect_uri: base,
      code_challenge: challenge, code_challenge_method: 'S256', state, scope: 'meals',
    }).toString();
    location.href = url.toString();
  }
  async function exchangeToken(params) {
    const res = await fetch(`${origin}/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(params).toString(),
    });
    if (!res.ok) return false;
    const t = await res.json();
    localStorage.setItem(LS.token, t.access_token);
    if (t.refresh_token) localStorage.setItem(LS.refresh, t.refresh_token);
    return true;
  }
  async function handleCallback() {
    const q = new URLSearchParams(location.search);
    if (!q.get('code')) return;
    const savedState = localStorage.getItem(LS.state);
    if (!savedState || q.get('state') !== savedState) {
      localStorage.removeItem(LS.state);
      localStorage.removeItem(LS.verifier);
      history.replaceState(null, '', base);
      return;
    }
    try {
      await exchangeToken({
        grant_type: 'authorization_code', code: q.get('code'), redirect_uri: base,
        client_id: localStorage.getItem(LS.client), code_verifier: localStorage.getItem(LS.verifier),
      });
    } finally {
      localStorage.removeItem(LS.verifier);
      localStorage.removeItem(LS.state);
    }
    history.replaceState(null, '', base);
    showTab('meals');
  }
  async function rw(path, method, body) {
    const call = () =>
      fetch(`${origin}/rw/${path}`, {
        method,
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${localStorage.getItem(LS.token)}` },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    let res = await call();
    if (res.status === 401 && localStorage.getItem(LS.refresh)) {
      const ok = await exchangeToken({
        grant_type: 'refresh_token', refresh_token: localStorage.getItem(LS.refresh),
        client_id: localStorage.getItem(LS.client),
      });
      if (ok) res = await call();
    }
    if (res.status === 401) {
      localStorage.removeItem(LS.token);
      updateAuthUi();
    }
    return res;
  }
  const loggedIn = () => Boolean(localStorage.getItem(LS.token));
  function updateAuthUi() {
    $('meals-auth').hidden = loggedIn();
    $('meal-add-form').hidden = !loggedIn();
    $('menus-manage').hidden = !loggedIn();
  }
  $('meals-login').addEventListener('click', login);

  // ---- データ表示 ----
  let menus = [];
  let selectedMenu = null;
  async function refresh() {
    updateAuthUi();
    const [mealsRes, menusRes] = await Promise.all([
      fetch(`${base}api/meals?days=${HISTORY_DAYS}`),
      fetch(`${base}api/menus`),
    ]);
    const meals = (await mealsRes.json()).meals ?? [];
    menus = (await menusRes.json()).menus ?? [];
    renderHistory(meals);
    $('menus-list').innerHTML = menus
      .map(
        (m) => `<li>${esc(m.name)}（${m.calories} kcal${pfc(m.protein_g, m.fat_g, m.carbs_g)}）<button data-arch="${m.id}" type="button">アーカイブ</button></li>`,
      )
      .join('');
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
    const span = canDel ? 6 : 5;
    const rows = groups
      .map((g) => {
        // 日は新しい順のまま、各日の中は時刻昇順（朝→昼→夜）で読みやすく
        g.items.sort((a, b) => String(a.eaten_at).localeCompare(String(b.eaten_at)));
        const total = g.items.reduce((a, m) => a + m.effective_calories, 0);
        const totalPfc = pfc(
          sumEff(g.items, 'effective_protein_g'),
          sumEff(g.items, 'effective_fat_g'),
          sumEff(g.items, 'effective_carbs_g'),
        );
        const head = `<tr class="mh-day"><td colspan="${span}">${g.d}　合計 ${Math.round(total)} kcal${totalPfc}</td></tr>`;
        const items = g.items
          .map((m) => {
            const t = MEAL_TYPE_LABEL[m.meal_type] || '—';
            const macro = pfc(m.effective_protein_g, m.effective_fat_g, m.effective_carbs_g).replace(/^ · /, '');
            return `<tr><td class="mh-type">${t}</td><td>${esc(m.menu_name)}</td><td class="mh-num">×${m.multiplier}</td><td class="mh-num">${Math.round(m.effective_calories)} kcal</td><td class="mh-macro">${macro || '—'}</td>${canDel ? `<td><button class="mh-del" data-del="${m.id}" type="button">削除</button></td>` : ''}</tr>`;
          })
          .join('');
        return head + items;
      })
      .join('');
    $('meals-history').innerHTML =
      `<table class="meals-history-table"><thead><tr><th>区分</th><th>メニュー</th><th>倍率</th><th>kcal</th><th>PFC</th>${canDel ? '<th></th>' : ''}</tr></thead><tbody>${rows}</tbody></table>`;
  }

  $('meals-history').addEventListener('click', async (e) => {
    const btn = e.target.closest('button[data-del]');
    if (btn && confirm('この記録を削除しますか？')) {
      await rw(`meals/${btn.dataset.del}`, 'DELETE');
      refresh();
    }
  });
  $('menus-list').addEventListener('click', async (e) => {
    const id = e.target.dataset?.arch;
    if (id) {
      await rw(`menus/${id}/archive`, 'POST');
      refresh();
    }
  });

  // ---- 記録フォーム（fzf風メニューピッカー） ----
  const CAND_LIMIT = 10;
  let candList = []; // 現在表示中の候補 [{ m, score, matched }]
  let activeIdx = -1; // キーボードで選択中の候補インデックス

  // あいまい一致（部分列マッチ）。q の各文字が name に順番に現れれば候補。
  // 連続一致・先頭一致を高評価。matched は一致文字のインデックス（ハイライト用）。
  // 絵文字（サロゲートペア）対応のためコードポイント配列で処理する。
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
    if (qi < lq.length) return null; // 全文字はマッチしなかった
    return { score: score - chars.length * 0.01, matched }; // 短い名前をわずかに優遇
  };

  const computeCandidates = () => {
    const q = $('meal-menu-search').value.trim();
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

  // 名前を1文字ずつエスケープし、一致文字を <mark> で強調（XSS防止のため必ずエスケープ）
  const highlight = (name, matched) => {
    const set = new Set(matched);
    return [...name].map((ch, i) => (set.has(i) ? `<mark>${esc(ch)}</mark>` : esc(ch))).join('');
  };

  const drawCandidates = () => {
    $('meal-menu-candidates').innerHTML = candList
      .map(
        (c, i) =>
          `<li data-pick="${c.m.id}" class="${i === activeIdx ? 'active' : ''}">${highlight(c.m.name, c.matched)}（${c.m.calories} kcal${pfc(c.m.protein_g, c.m.fat_g, c.m.carbs_g)}）</li>`,
      )
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
    $('meal-menu-candidates').innerHTML = '';
  };

  const pickMenu = (m) => {
    if (!m) return;
    selectedMenu = m;
    $('meal-menu-search').value = m.name;
    hideCandidates();
  };

  // 入力なしでも候補を出す（フォーカスで全件、入力であいまい絞り込み）
  $('meal-menu-search').addEventListener('focus', showCandidates);
  $('meal-menu-search').addEventListener('input', () => {
    selectedMenu = null; // 手入力し直したら選択解除
    showCandidates();
  });
  $('meal-menu-search').addEventListener('keydown', (e) => {
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
      e.preventDefault(); // フォーム送信を止めて候補確定
      if (activeIdx >= 0) pickMenu(candList[activeIdx].m);
    } else if (e.key === 'Escape') {
      hideCandidates();
    }
  });
  // blur時は少し遅らせて閉じる（候補クリックを先に成立させる）
  $('meal-menu-search').addEventListener('blur', () => setTimeout(hideCandidates, 150));
  // mousedownで拾う（blurより先に発火させ、<mark>クリックでもliを辿る）
  $('meal-menu-candidates').addEventListener('mousedown', (e) => {
    const id = e.target.closest('li')?.dataset?.pick;
    if (!id) return;
    e.preventDefault();
    pickMenu(menus.find((m) => m.id === id));
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
    if (!res.ok) alert(`記録に失敗: ${(await res.json()).error ?? res.status}`);
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
    if (!res.ok) alert(`メニュー追加に失敗: ${(await res.json()).error ?? res.status}`);
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

  handleCallback();
  updateAuthUi();
})();
