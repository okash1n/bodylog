/* 食事タブ: 公開READは無認証、書き込みはOAuth(PKCE)のトークンで /rw/ を呼ぶ */
(() => {
  const base = document.querySelector('script[src*="meals.js"]').src.replace(/meals\.js.*$/, '');
  const origin = location.origin;
  const LS = { token: 'meals.token', refresh: 'meals.refresh', client: 'meals.client_id', verifier: 'meals.pkce' };

  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s).replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);

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
    const challenge = b64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
    const url = new URL(`${origin}/authorize`);
    url.search = new URLSearchParams({
      response_type: 'code', client_id: clientId, redirect_uri: base,
      code_challenge: challenge, code_challenge_method: 'S256', state: 'dash', scope: 'meals',
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
    await exchangeToken({
      grant_type: 'authorization_code', code: q.get('code'), redirect_uri: base,
      client_id: localStorage.getItem(LS.client), code_verifier: localStorage.getItem(LS.verifier),
    });
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
      fetch(`${base}api/meals?days=1`),
      fetch(`${base}api/menus`),
    ]);
    const meals = (await mealsRes.json()).meals ?? [];
    menus = (await menusRes.json()).menus ?? [];
    const total = meals.reduce((a, m) => a + m.effective_calories, 0);
    $('meals-total').textContent = meals.length ? `${Math.round(total)} kcal` : '';
    $('meals-list').innerHTML = meals
      .map(
        (m) => `<li>${esc(m.menu_name)} ×${m.multiplier}（${Math.round(m.effective_calories)} kcal）
          ${loggedIn() ? `<button data-del="${m.id}" type="button">削除</button>` : ''}</li>`,
      )
      .join('');
    $('menus-list').innerHTML = menus
      .map((m) => `<li>${esc(m.name)}（${m.calories} kcal）<button data-arch="${m.id}" type="button">アーカイブ</button></li>`)
      .join('');
  }
  $('meals-list').addEventListener('click', async (e) => {
    const id = e.target.dataset?.del;
    if (id && confirm('この記録を削除しますか？')) {
      await rw(`meals/${id}`, 'DELETE');
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

  // ---- 記録フォーム ----
  $('meal-menu-search').addEventListener('input', () => {
    const q = $('meal-menu-search').value.trim();
    const hits = q ? menus.filter((m) => m.name.includes(q)) : menus;
    $('meal-menu-candidates').innerHTML = hits
      .slice(0, 8)
      .map((m) => `<li data-pick="${m.id}">${esc(m.name)}（${m.calories} kcal）</li>`)
      .join('');
  });
  $('meal-menu-candidates').addEventListener('click', (e) => {
    const id = e.target.dataset?.pick;
    if (!id) return;
    selectedMenu = menus.find((m) => m.id === id);
    $('meal-menu-search').value = selectedMenu.name;
    $('meal-menu-candidates').innerHTML = '';
  });
  $('meal-add-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!selectedMenu) return alert('メニューを選択してください');
    const res = await rw('meals', 'POST', {
      menu_id: selectedMenu.id,
      multiplier: Number($('meal-multiplier').value) || 1,
      meal_type: $('meal-type').value || undefined,
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

  handleCallback();
  updateAuthUi();
})();
