/*
 * 共有モジュール: タブ切替・OAuth(PKCE)・トースト・fzf風ピッカー・共通ヘルパー。
 * バンドラ無し構成のため、meals.js / exercise.js より先に defer で読み込み、
 * window.__dash に集約して公開する（deferスクリプトは記述順に実行される）。
 */
(() => {
  'use strict';
  const base = document.querySelector('script[src*="shared.js"]').src.replace(/shared\.js.*$/, '');
  const origin = location.origin;

  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s).replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
  // サーバーの日付境界（TZ_OFFSET_HOURS=9 / JST）に合わせた「今日」
  const todayJst = () => new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10);
  // ISO8601(UTC) → JST(+9)ローカル日付。履歴のグループ化キー
  const localDateOf = (iso) => new Date(Date.parse(iso) + 9 * 3600_000).toISOString().slice(0, 10);
  const HISTORY_DAYS = 50;

  // ---- タブ切替（各タブは tabshown イベントを購読して自分の refresh を行う） ----
  const tabButtons = Array.from(document.querySelectorAll('nav.tabs .tab'));
  function showTab(name) {
    document.querySelectorAll('[id^="panel-"]').forEach((p) => {
      p.hidden = p.id !== `panel-${name}`;
    });
    tabButtons.forEach((b) => {
      const active = b.dataset.panel === name;
      b.classList.toggle('active', active);
      b.setAttribute('aria-selected', String(active));
    });
    document.dispatchEvent(new CustomEvent('tabshown', { detail: name }));
  }
  tabButtons.forEach((b) => b.addEventListener('click', () => showTab(b.dataset.panel)));

  // ---- トースト（成功/失敗の非ブロッキング通知） ----
  let toastTimer = null;
  function toast(msg, opts) {
    let el = document.getElementById('toast');
    if (!el) {
      el = document.createElement('div');
      el.id = 'toast';
      // 支援技術にも結果通知が伝わるようにする（表示のたびではなく生成時に一度だけ設定）
      el.setAttribute('role', 'status');
      el.setAttribute('aria-live', 'polite');
      document.body.appendChild(el);
    }
    el.textContent = msg;
    el.classList.toggle('toast-error', Boolean(opts && opts.tone === 'error'));
    if (opts && opts.action) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = opts.action.label;
      btn.addEventListener('click', () => {
        el.classList.remove('show');
        opts.action.onClick();
      });
      el.appendChild(btn);
    }
    requestAnimationFrame(() => el.classList.add('show'));
    clearTimeout(toastTimer);
    // アクション付き（元に戻す等）とエラーは読む・押す猶予を長めに取る
    const long = Boolean(opts && (opts.action || opts.tone === 'error'));
    toastTimer = setTimeout(() => el.classList.remove('show'), long ? 6000 : 3000);
  }

  // ---- OAuth (PKCE)。トークンはlocalStorageに保持し、食事/運動どちらのタブでも有効 ----
  // キー名は初期実装（食事タブ）の名残で meals.* だが、変更すると既存ログインが切れるため維持
  const LS = { token: 'meals.token', refresh: 'meals.refresh', client: 'meals.client_id', verifier: 'meals.pkce', state: 'meals.state' };

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
    // 失敗時に "undefined" をキャッシュするとログインが恒久故障する（localStorage手動クリアまで）ため、
    // 成功して有効なclient_idが取れたときだけ保存する
    if (!res.ok) throw new Error(`client registration failed: ${res.status}`);
    id = (await res.json()).client_id;
    if (typeof id !== 'string' || !id) throw new Error('client registration returned no client_id');
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
  /** OAuthリダイレクト（?code=）を処理する。各タブのリスナー登録後に呼ぶこと（meals.jsが呼ぶ） */
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
  /** 認証付き書き込み（/api の POST/PATCH/DELETE）。401はリフレッシュ→再試行、失効時はauthchangedを発火 */
  async function rw(path, method, body) {
    const call = () =>
      fetch(`${base}api/${path}`, {
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
      // 各タブが購読して自分の認証UIを更新する
      document.dispatchEvent(new CustomEvent('authchanged'));
    }
    return res;
  }
  const loggedIn = () => Boolean(localStorage.getItem(LS.token));

  // ---- fzf風ピッカー（入力なしで全件、あいまい絞り込み、キーボード/マウス両対応） ----
  /**
   * opts: {
   *   input: 検索input要素, list: 候補ul要素,
   *   getItems: () => {id, name, ...}[]（呼び出し時点の最新一覧を返す）,
   *   renderMeta: (item) => 候補行の補足HTML（**HTML安全な文字列を返すこと**。名前部分は内部でエスケープ済み）,
   *   emptyHint: 一覧が空のときの案内文,
   *   onPick: (item) => void, onInput?: () => void（手入力で選択解除したいとき）
   * }
   */
  function createPicker(opts) {
    const CAND_LIMIT = 10;
    let candList = []; // 現在表示中の候補 [{ m, score, matched }]
    let activeIdx = -1; // 選択中の候補インデックス（キーボード/マウス共通）

    // あいまい一致（部分列マッチ）。q の各文字が name に順番に現れれば候補。
    // 連続一致・先頭一致を高評価。絵文字（サロゲートペア）対応のためコードポイント配列で処理する
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
      const q = opts.input.value.trim();
      const scored = [];
      let idx = 0;
      for (const m of opts.getItems()) {
        const r = fuzzyMatch(m.name, q);
        if (r) scored.push({ m, idx, ...r });
        idx++;
      }
      // APIは利用頻度順（直近90日の記録回数）で返すため、クエリなしはその順のまま出す。
      // クエリありはあいまい一致スコア優先、同点は頻度順（元の並び idx）で崩さない
      if (q) scored.sort((a, b) => b.score - a.score || a.idx - b.idx);
      return scored.slice(0, CAND_LIMIT);
    };

    // 名前を1文字ずつエスケープし、一致文字を <mark> で強調（XSS防止のため必ずエスケープ）
    const highlight = (name, matched) => {
      const set = new Set(matched);
      return [...name].map((ch, i) => (set.has(i) ? `<mark>${esc(ch)}</mark>` : esc(ch))).join('');
    };

    const drawCandidates = () => {
      opts.list.innerHTML = candList
        .map(
          (c, i) =>
            `<li data-pick="${c.m.id}" data-idx="${i}" class="${i === activeIdx ? 'active' : ''}">${highlight(c.m.name, c.matched)}${opts.renderMeta(c.m)}</li>`,
        )
        .join('');
    };

    const showCandidates = () => {
      candList = computeCandidates();
      activeIdx = candList.length ? 0 : -1;
      drawCandidates();
      // 一覧ゼロ（初回）で空のドロップダウンだけ出ると行き止まりに見えるため、導線を出す
      if (!candList.length && opts.getItems().length === 0) {
        opts.list.innerHTML = `<li class="picker-hint">${opts.emptyHint}</li>`;
      }
    };

    const hideCandidates = () => {
      candList = [];
      activeIdx = -1;
      opts.list.innerHTML = '';
    };

    const pick = (m) => {
      if (!m) return;
      opts.input.value = m.name;
      hideCandidates();
      opts.onPick(m);
    };

    // 入力なしでも候補を出す（フォーカスで全件、入力であいまい絞り込み）
    opts.input.addEventListener('focus', showCandidates);
    opts.input.addEventListener('input', () => {
      if (opts.onInput) opts.onInput(); // 手入力し直したら選択解除など
      showCandidates();
    });
    opts.input.addEventListener('keydown', (e) => {
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
        if (activeIdx >= 0) pick(candList[activeIdx].m);
      } else if (e.key === 'Escape') {
        hideCandidates();
      }
    });
    // blur時は少し遅らせて閉じる（候補クリックを先に成立させる）
    opts.input.addEventListener('blur', () => setTimeout(hideCandidates, 150));
    // マウスオーバーでもactive（青ハイライト）を移動させ、キーボードと挙動を揃える
    opts.list.addEventListener('mouseover', (e) => {
      const li = e.target.closest('li');
      if (!li) return;
      const i = Number(li.dataset.idx);
      if (Number.isInteger(i) && i !== activeIdx) {
        activeIdx = i;
        drawCandidates();
      }
    });
    // mousedownで拾う（blurより先に発火させ、<mark>クリックでもliを辿る）
    opts.list.addEventListener('mousedown', (e) => {
      const id = e.target.closest('li')?.dataset?.pick;
      if (!id) return;
      e.preventDefault();
      pick(opts.getItems().find((m) => m.id === id));
    });
  }

  window.__dash = {
    base,
    $,
    esc,
    todayJst,
    localDateOf,
    HISTORY_DAYS,
    showTab,
    toast,
    rw,
    login,
    loggedIn,
    handleCallback,
    createPicker,
  };
})();
