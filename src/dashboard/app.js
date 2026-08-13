/* 体重ダッシュボード フロントエンド。バンドルなしのプレーンJS（グローバルChartを使用） */
(function () {
  'use strict';

  var DAY_MS = 86400000;
  var MAX_RANGE_DAYS = 731;

  /* ---- 純粋関数: ブレークポイント・ラベル整形・表示域計算 ---- */

  function breakpointFor(width) {
    if (width < 380) return 'xs';
    if (width < 768) return 'sm';
    return 'lg';
  }

  function tickLimitsFor(bp) {
    if (bp === 'xs') return { x: 4, y: 4 };
    if (bp === 'sm') return { x: 6, y: 5 };
    return { x: 10, y: 6 };
  }

  function monthStepFor(bp) {
    if (bp === 'xs') return 3;
    if (bp === 'sm') return 2;
    return 1;
  }

  /* 日数からグラフ密度を決める（1M相当/3M相当/1Y相当） */
  function densityFor(dayCount) {
    if (dayCount <= 45) return 'dense';
    if (dayCount <= 150) return 'mid';
    return 'sparse';
  }

  /* dense/mid: 'M/D'。sparse: 'M月'（年初のみ 'YYYY/M'） */
  function formatTickLabel(ymd, density) {
    var m = Number(ymd.slice(5, 7));
    var d = Number(ymd.slice(8, 10));
    if (density === 'sparse') return m === 1 ? ymd.slice(0, 4) + '/' + m : m + '月';
    return m + '/' + d;
  }

  /* Y軸表示域: データのmin/max±10%（0起点にしない） */
  function axisRange(values) {
    var min = Infinity;
    var max = -Infinity;
    for (var i = 0; i < values.length; i++) {
      var v = values[i];
      if (v == null) continue;
      if (v < min) min = v;
      if (v > max) max = v;
    }
    if (min === Infinity) return null;
    var span = max - min;
    var pad = span === 0 ? Math.max(Math.abs(max) * 0.05, 0.5) : span * 0.1;
    return { min: min - pad, max: max + pad };
  }

  function pad2(n) {
    return (n < 10 ? '0' : '') + n;
  }

  function addDays(ymd, days) {
    return new Date(Date.parse(ymd + 'T00:00:00Z') + days * DAY_MS).toISOString().slice(0, 10);
  }

  function inclusiveDays(from, to) {
    return Math.round((Date.parse(to + 'T00:00:00Z') - Date.parse(from + 'T00:00:00Z')) / DAY_MS) + 1;
  }

  function buildDateLabels(from, to) {
    var out = [];
    var end = Date.parse(to + 'T00:00:00Z');
    for (var t = Date.parse(from + 'T00:00:00Z'); t <= end; t += DAY_MS) {
      out.push(new Date(t).toISOString().slice(0, 10));
    }
    return out;
  }

  function todayYmd() {
    var d = new Date();
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
  }

  function fmt(v) {
    return v == null ? '—' : Number(v).toFixed(1);
  }

  function fmtSigned(v) {
    if (v == null) return '—';
    return (v >= 0 ? '+' : '') + Number(v).toFixed(1);
  }

  function hexToRgba(color, alpha) {
    var m = /^#([0-9a-f]{6})$/i.exec(String(color).trim());
    if (!m) return color;
    var n = parseInt(m[1], 16);
    return 'rgba(' + ((n >> 16) & 255) + ',' + ((n >> 8) & 255) + ',' + (n & 255) + ',' + alpha + ')';
  }

  /* D1由来のUTC日時文字列をepoch msへ（'Z'なし・スペース区切りにも耐える） */
  function parseUtcMs(s) {
    if (!s) return null;
    var iso = s.indexOf('T') === -1 ? s.replace(' ', 'T') : s;
    if (!/([zZ]|[+-]\d\d:?\d\d)$/.test(iso)) iso += 'Z';
    var t = Date.parse(iso);
    return isNaN(t) ? null : t;
  }

  function formatLocalDateTime(ms) {
    var d = new Date(ms);
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) +
      ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes());
  }

  function validateCustomRange(from, to, today) {
    if (!from || !to) return '開始日と終了日を入力してください';
    if (from > to) return '開始日は終了日以前にしてください';
    if (to > today) return '未来の日付は指定できません';
    if (inclusiveDays(from, to) > MAX_RANGE_DAYS) return '期間は' + MAX_RANGE_DAYS + '日以内にしてください';
    return null;
  }

  function lastNonNull(days, key) {
    for (var i = days.length - 1; i >= 0; i--) {
      if (days[i][key] != null) return days[i][key];
    }
    return null;
  }

  function firstNonNull(days, key) {
    for (var i = 0; i < days.length; i++) {
      if (days[i][key] != null) return days[i][key];
    }
    return null;
  }

  /* ---- DOM参照 ---- */

  var BASE = location.pathname.slice(-1) === '/' ? location.pathname : location.pathname + '/';

  function $(id) {
    return document.getElementById(id);
  }

  var els = {
    skeleton: $('state-skeleton'),
    empty: $('state-empty'),
    emptyMessage: $('empty-message'),
    emptyReload: $('empty-reload'),
    error: $('state-error'),
    retry: $('retry-btn'),
    content: $('content'),
    heroDiff: $('hero-diff'),
    heroMeasured: $('hero-measured'),
    offlineBadge: $('offline-badge'),
    themeToggle: $('theme-toggle'),
    chartWrap: $('chart-wrap'),
    chartSection: $('chart-section'),
    canvas: $('chart'),
    tableWrap: $('table-wrap'),
    tableBody: $('table-body'),
    tableColDate: $('table-col-date'),
    viewToggle: $('view-toggle'),
    customRange: $('custom-range'),
    customFrom: $('custom-from'),
    customTo: $('custom-to'),
    customApply: $('custom-apply'),
    customError: $('custom-error'),
  };
  var segButtons = Array.prototype.slice.call(document.querySelectorAll('.segment-btn[data-period]'));
  var modeButtons = Array.prototype.slice.call(document.querySelectorAll('.segment-btn[data-mode]'));
  var tableModeButtons = Array.prototype.slice.call(document.querySelectorAll('.segment-btn[data-table-mode]'));

  /* ---- 状態 ---- */

  var chart = null;
  var currentLabels = [];
  var currentDensity = 'dense';
  var currentBp = breakpointFor(window.innerWidth);
  // カロリーオーバーレイ（既定ON）。localStorageに保存
  var calorieOverlay = (function () {
    try {
      return localStorage.getItem('dash-calorie-overlay') !== '0';
    } catch (e) {
      return true;
    }
  })();
  // 体重トレンドライン（既定オフ）。localStorageに保存
  var trendOn = (function () {
    try {
      return localStorage.getItem('dash-trend') === '1';
    } catch (e) {
      return false;
    }
  })();
  var lastCals = null; // 直近のカロリー整列結果（テーマ/リサイズ再描画で参照）
  var period = '1m';
  var customFromValue = null;
  var customToValue = null;
  var tableVisible = false;
  var seriesMode = readSeriesMode(); // 'raw'（実測） | 'avg'（7日平均）
  var tableMode = 'daily'; // 'daily'（日次集計） | 'raw'（計測明細）
  var lastDays = [];
  var rawRows = null; // 明細のキャッシュ（期間が変わったらnullに戻す）
  var importPollTimer = null;
  var themeCache = readTheme();
  var reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  function readSeriesMode() {
    try {
      var m = localStorage.getItem('dash-series-mode');
      if (m === 'raw' || m === 'avg') return m;
    } catch (e) { /* localStorage不可はデフォルト */ }
    return 'raw';
  }

  function readTheme() {
    var cs = getComputedStyle(document.documentElement);
    function v(name) {
      return cs.getPropertyValue(name).trim();
    }
    return {
      text: v('--text'),
      muted: v('--text-muted'),
      grid: v('--grid'),
      surface: v('--surface'),
      accent: v('--accent'),
      accent2: v('--accent-2'),
      accent3: v('--accent-3'),
      cal: v('--accent-cal'),
      burn: v('--accent-burn'),
    };
  }

  /* ---- 状態表示 ---- */

  function showState(name) {
    els.skeleton.classList.toggle('hidden', name !== 'loading');
    els.empty.classList.toggle('hidden', name !== 'empty');
    els.error.classList.toggle('hidden', name !== 'error');
    els.content.classList.toggle('hidden', name !== 'ready');
  }

  function updateOnlineState() {
    els.offlineBadge.hidden = navigator.onLine;
  }

  /* ---- データ取得 ---- */

  function rangeForPeriod() {
    var to = todayYmd();
    if (period === '3m') return { from: addDays(to, -89), to: to };
    if (period === '1y') return { from: addDays(to, -364), to: to };
    if (period === 'custom') return { from: customFromValue, to: customToValue };
    return { from: addDays(to, -29), to: to };
  }

  function fetchStatus() {
    return fetch(BASE + 'api/status')
      .then(function (res) {
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.json();
      })
      .catch(function (err) {
        console.error('[dashboard] status fetch failed', err);
        return null;
      });
  }

  function loadData() {
    if (importPollTimer) {
      clearTimeout(importPollTimer);
      importPollTimer = null;
    }
    showState('loading');
    var r = rangeForPeriod();
    var url = BASE + 'api/measurements?from=' + encodeURIComponent(r.from) + '&to=' + encodeURIComponent(r.to);
    var mealsUrl = BASE + 'api/meals/daily?from=' + encodeURIComponent(r.from) + '&to=' + encodeURIComponent(r.to);
    var exUrl = BASE + 'api/exercise/daily?from=' + encodeURIComponent(r.from) + '&to=' + encodeURIComponent(r.to);
    // カロリー系の日次は取得失敗しても体重表示を壊さない（空扱い）
    var tolerantDays = function (u, label) {
      return fetch(u)
        .then(function (res) {
          return res.ok ? res.json() : { days: [] };
        })
        .catch(function (err) {
          console.error('[dashboard] ' + label + ' fetch failed', err);
          return { days: [] };
        });
    };
    Promise.all([
      fetch(url).then(function (res) {
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.json();
      }),
      tolerantDays(mealsUrl, 'meals/daily'),
      tolerantDays(exUrl, 'exercise/daily'),
      fetchStatus(),
    ])
      .then(function (results) {
        var days = (results[0] && results[0].days) || [];
        var mealsDays = (results[1] && results[1].days) || [];
        var exDays = (results[2] && results[2].days) || [];
        var status = results[3];
        rawRows = null; // 期間が変わった可能性があるので明細キャッシュを破棄
        renderHeader(days, status);
        if (days.length === 0) {
          renderEmpty(status);
          return;
        }
        showState('ready');
        renderAll(days, mealsDays, exDays, r.from, r.to);
      })
      .catch(function (err) {
        console.error('[dashboard] load failed', err);
        showState('error');
      });
  }

  function renderEmpty(status) {
    var msg = 'まだ表示できるデータがありません。';
    if (status && (status.import_status === 'pending' || status.import_status === 'running')) {
      msg = '初期インポートを実行中です。完了までしばらくお待ちください（自動で再読み込みします）。';
      importPollTimer = setTimeout(loadData, 15000);
    } else if (status && status.import_status === 'error') {
      msg = 'データ取り込みでエラーが発生しています。時間をおいて再度お試しください。';
    }
    els.emptyMessage.textContent = msg;
    showState('empty');
  }

  /* ---- ヘッダー ---- */

  function renderHeader(days, status) {
    var latestWeight = null;
    var latestAvg = null;
    for (var i = days.length - 1; i >= 0; i--) {
      if (days[i].weight != null) {
        latestWeight = days[i].weight;
        latestAvg = days[i].weight_7d_avg;
        break;
      }
    }
    var diff = latestWeight != null && latestAvg != null ? latestWeight - latestAvg : null;
    els.heroDiff.textContent = '7日平均比 ' + (diff == null ? '—' : fmtSigned(diff) + ' kg');

    els.heroMeasured.classList.remove('warn');
    var ms = status ? parseUtcMs(status.latest_measured_at) : null;
    if (ms != null) {
      els.heroMeasured.textContent = '最終計測 ' + formatLocalDateTime(ms);
      if (Date.now() - ms > DAY_MS) els.heroMeasured.classList.add('warn');
    } else {
      els.heroMeasured.textContent = '最終計測 —';
    }
  }

  /* ---- グラフ ---- */

  function seriesFrom(days, labels) {
    var byDate = Object.create(null);
    days.forEach(function (row) {
      byDate[row.d] = row;
    });
    function pick(key) {
      return labels.map(function (l) {
        var r = byDate[l];
        return r && r[key] != null ? r[key] : null;
      });
    }
    return {
      weight: pick('weight'),
      weight7: pick('weight_7d_avg'),
      fat: pick('fat_mass'),
      fat7: pick('fat_mass_7d_avg'),
      ffm: pick('fat_free_mass'),
      ffm7: pick('fat_free_mass_7d_avg'),
    };
  }

  // カロリー日次(/api/meals/daily)を日付ラベルへ整列。欠損日はnull。rawはテーブル結合用のd→row
  function calorieSeriesFrom(mealsDays, labels) {
    var byDate = Object.create(null);
    (mealsDays || []).forEach(function (row) {
      byDate[row.d] = row;
    });
    function pick(key) {
      return labels.map(function (l) {
        var r = byDate[l];
        return r && r[key] != null ? r[key] : null;
      });
    }
    return {
      cal: pick('calories'),
      p: pick('protein_g'),
      f: pick('fat_g'),
      c: pick('carbs_g'),
      raw: byDate,
    };
  }

  function xTickCallback(value, index) {
    var idx = typeof value === 'number' ? value : index;
    var ymd = currentLabels[idx];
    if (!ymd) return null;
    if (currentDensity === 'sparse') {
      if (ymd.slice(8, 10) !== '01') return null;
      var m = Number(ymd.slice(5, 7));
      if ((m - 1) % monthStepFor(currentBp) !== 0) return null;
      return formatTickLabel(ymd, 'sparse');
    }
    return formatTickLabel(ymd, currentDensity);
  }

  /* 1Y相当のときだけ月境界にグリッド線を描く */
  function xGridColor(ctx) {
    if (currentDensity !== 'sparse') return 'rgba(0,0,0,0)';
    var idx = ctx.tick && ctx.tick.value != null ? ctx.tick.value : ctx.index;
    var ymd = currentLabels[idx];
    return ymd && ymd.slice(8, 10) === '01' ? themeCache.grid : 'rgba(0,0,0,0)';
  }

  function yTickCallback(value) {
    return Number(value).toFixed(1);
  }

  function pointRadiusFor(density) {
    return density === 'dense' ? 2.5 : 0;
  }

  function pointHoverRadiusFor(density) {
    return density === 'sparse' ? 0 : 4;
  }

  function buildDatasets(sets, cals, density, t) {
    var pr = pointRadiusFor(density);
    var phr = pointHoverRadiusFor(density);
    function measured(label, data, color, axis, unit, extra) {
      var ds = {
        label: label,
        data: data,
        yAxisID: axis,
        unit: unit,
        borderColor: color,
        backgroundColor: color,
        pointBackgroundColor: color,
        borderWidth: 2,
        tension: 0.3,
        pointRadius: pr,
        pointHoverRadius: phr,
        spanGaps: true,
        fill: false,
      };
      for (var k in extra) ds[k] = extra[k];
      return ds;
    }
    function avg(label, data, color, axis, unit, hidden, key) {
      // 7日平均モードでは主役の系列になるため、点は実測と同じ密度ルールで描く
      return {
        _key: key,
        _role: 'avg',
        label: label,
        data: data,
        yAxisID: axis,
        unit: unit,
        borderColor: color,
        backgroundColor: color,
        pointBackgroundColor: color,
        borderWidth: 1.5,
        borderDash: [6, 4],
        tension: 0.3,
        pointRadius: pr,
        pointHoverRadius: phr,
        spanGaps: true,
        fill: false,
        hidden: hidden,
      };
    }
    // 実測3系列と7日平均3系列をモードで一括切替（凡例タップでの個別変更も可能）。
    // 各データセットは _key（データ再代入・テーマ色の引き当て）と _role（トグル・凡例の
    // グループ判定）を持つ。固定インデックスだと系列追加のたびに複数箇所の同期が要るため
    var hideRaw = seriesMode === 'avg';
    return [
      measured('体重', sets.weight, t.accent, 'yKg', 'kg', {
        fill: false, // 体重線下の青いエリア塗りは無し（線のみ）
        hidden: hideRaw,
        _key: 'weight',
        _role: 'raw',
      }),
      avg('体重 7日平均', sets.weight7, t.accent, 'yKg', 'kg', !hideRaw, 'weight7'),
      measured('脂肪量', sets.fat, t.accent2, 'yKg', 'kg', { hidden: hideRaw, _key: 'fat', _role: 'raw' }),
      avg('脂肪量 7日平均', sets.fat7, t.accent2, 'yKg', 'kg', !hideRaw, 'fat7'),
      measured('除脂肪体重', sets.ffm, t.accent3, 'yKg', 'kg', { hidden: hideRaw, _key: 'ffm', _role: 'raw' }),
      avg('除脂肪体重 7日平均', sets.ffm7, t.accent3, 'yKg', 'kg', !hideRaw, 'ffm7'),
      // カロリーは「ネット=摂取−消費（基礎+運動）」の1本に集約（右軸 yKcal）。
      // 摂取が未記録の日はnull=非表示。黒字は上向き・赤字（消費超過）は下向きの棒になる。
      // 摂取/消費の内訳とPFCはツールチップに残す（_netParts）
      {
        type: 'bar',
        label: 'ネット(摂取−消費)',
        data: cals.net,
        yAxisID: 'yKcal',
        unit: 'kcal',
        backgroundColor: hexToRgba(t.cal, 0.5),
        borderWidth: 0,
        order: 99,
        hidden: !calorieOverlay,
        _key: 'net',
        _role: 'energy',
        _energy: 'net',
        _netParts: { intake: cals.cal, burn: cals.burn, parts: cals.burnParts, p: cals.p, f: cals.f, c: cals.c },
      },
      // 各系列の線形トレンドライン（最小二乗）。オンオフはトグルで。系列色の直線（長い破線）
      trend('体重トレンド', sets.weight, 'weight', 'accent', t.accent),
      trend('脂肪量トレンド', sets.fat, 'fat', 'accent2', t.accent2),
      trend('除脂肪体重トレンド', sets.ffm, 'ffm', 'accent3', t.accent3),
      // ネットのトレンド（kcal右軸）。カロリー非表示時は軸ごと消えるため出さない
      trend('ネット トレンド', cals.net, 'net', 'cal', t.cal, 'yKcal', !trendOn || !calorieOverlay),
    ];
  }

  // トレンド系列の定義。_series は元データのキー（再描画時の回帰再計算用）、
  // _trendColor はテーマ変更時の再着色キー。axis省略時はkg左軸
  function trend(label, values, seriesKey, colorKey, color, axis, hidden) {
    return {
      _key: 'trend-' + seriesKey,
      _role: 'trend',
      _series: seriesKey,
      label: label,
      data: trendLine(values),
      yAxisID: axis || 'yKg',
      unit: axis === 'yKcal' ? 'kcal' : 'kg',
      borderColor: color,
      borderWidth: 1.5,
      borderDash: [12, 6],
      pointRadius: 0,
      pointHoverRadius: 0,
      spanGaps: true,
      fill: false,
      order: 50,
      hidden: hidden === undefined ? !trendOn : hidden,
      _trend: true,
      _trendColor: colorKey,
    };
  }

  // 体重(index順)の非null点から最小二乗回帰の直線を全ラベル分算出。点が2未満ならnull配列
  function trendLine(weights) {
    var n = 0;
    var sx = 0;
    var sy = 0;
    var sxx = 0;
    var sxy = 0;
    weights.forEach(function (y, x) {
      if (y == null) return;
      n++;
      sx += x;
      sy += y;
      sxx += x * x;
      sxy += x * y;
    });
    if (n < 2) return weights.map(function () { return null; });
    var denom = n * sxx - sx * sx;
    if (denom === 0) return weights.map(function () { return null; });
    var slope = (n * sxy - sx * sy) / denom;
    var intercept = (sy - slope * sx) / n;
    return weights.map(function (_, x) { return slope * x + intercept; });
  }

  // 役割（raw/avg/energy/trend）でデータセットの可視性を一括切替する。
  // 固定インデックスの配列だと系列追加のたびに複数箇所の同期が必要でズレやすい
  function setRoleVisibility(ch, role, visible) {
    ch.data.datasets.forEach(function (ds, i) {
      if (ds._role === role) ch.setDatasetVisibility(i, visible);
    });
  }

  // トレンドの可視性: kg系はトレンドトグルのみ、kcal系（ネット）はカロリー表示中に限る
  // （カロリーを消すと右軸ごと消えるため、ネットのトレンドだけ浮かせない）
  function applyTrendVisibility(ch) {
    ch.data.datasets.forEach(function (ds, i) {
      if (ds._role !== 'trend') return;
      ch.setDatasetVisibility(i, trendOn && (ds.yAxisID !== 'yKcal' || calorieOverlay));
    });
  }

  function setActiveMode(mode) {
    modeButtons.forEach(function (btn) {
      var active = btn.getAttribute('data-mode') === mode;
      btn.classList.toggle('active', active);
      btn.setAttribute('aria-pressed', String(active));
    });
  }

  function applySeriesMode(mode) {
    seriesMode = mode;
    setActiveMode(mode);
    try {
      localStorage.setItem('dash-series-mode', mode);
    } catch (e) { /* 保存不可でも表示は切り替わる */ }
    if (!chart) return;
    setRoleVisibility(chart, 'raw', mode === 'raw');
    setRoleVisibility(chart, 'avg', mode === 'avg');
    applyAxisRanges(chart);
    chart.update('none');
  }

  function visibleValues(ch, axisId) {
    var vals = [];
    ch.data.datasets.forEach(function (ds, i) {
      // トレンド直線は回帰値なので体重軸のオートスケール母数から除外（実データで軸を決める）
      if (ds._trend || ds.yAxisID !== axisId || !ch.isDatasetVisible(i)) return;
      ds.data.forEach(function (v) {
        if (v != null) vals.push(v);
      });
    });
    return vals;
  }

  function applyAxisRanges(ch) {
    var s = ch.options.scales;
    var kg = axisRange(visibleValues(ch, 'yKg'));
    if (kg) {
      s.yKg.min = kg.min;
      s.yKg.max = kg.max;
    } else {
      delete s.yKg.min;
      delete s.yKg.max;
    }
    // カロリー右軸は0を含み可視最大の1.15倍まで。ネット（摂取−消費）が赤字の日は負側にも広げる
    var kcal = visibleValues(ch, 'yKcal');
    if (s.yKcal && kcal.length) {
      var kmax = Math.max.apply(null, kcal);
      var kmin = Math.min.apply(null, kcal);
      s.yKcal.max = kmax > 0 ? kmax * 1.15 : 0;
      s.yKcal.min = kmin < 0 ? kmin * 1.15 : 0;
    }
  }

  // カロリー表示の一括反映（凡例クリックから呼ぶ）。棒・右軸・ネットトレンドを同期して切り替え、
  // 状態はlocalStorageに保存する
  function applyCalorieOverlay() {
    try {
      localStorage.setItem('dash-calorie-overlay', calorieOverlay ? '1' : '0');
    } catch (e) { /* 保存不可でも表示は切り替わる */ }
    if (!chart) return;
    setRoleVisibility(chart, 'energy', calorieOverlay);
    applyTrendVisibility(chart);
    chart.options.scales.yKcal.display = calorieOverlay;
    applyAxisRanges(chart);
    chart.update('none');
  }

  function onLegendClick(evt, item, legend) {
    var ch = legend.chart;
    var ds = ch.data.datasets[item.datasetIndex];
    if (ds && ds._role === 'energy') {
      calorieOverlay = !ch.isDatasetVisible(item.datasetIndex);
      applyCalorieOverlay();
      return;
    }
    ch.setDatasetVisibility(item.datasetIndex, !ch.isDatasetVisible(item.datasetIndex));
    applyAxisRanges(ch);
    ch.update();
  }

  /*
   * 点の近くに値を常時表示する。表示中の点の総数が閾値以下なら全点、
   * 超える場合は各系列の最新点のみ（1Mを3系列表示すると90点前後になり全表示は潰れるため）
   */
  var POINT_LABEL_MAX = 40;
  var pointLabelsPlugin = {
    id: 'pointLabels',
    afterDatasetsDraw: function (ch) {
      var total = 0;
      ch.data.datasets.forEach(function (ds, i) {
        if (ds.yAxisID === 'yKcal' || ds._trend || !ch.isDatasetVisible(i)) return; // カロリー棒・トレンドは点ラベル対象外
        ds.data.forEach(function (v) {
          if (v != null) total++;
        });
      });
      var showAll = total <= POINT_LABEL_MAX;
      var ctx = ch.ctx;
      ctx.save();
      ctx.font = '600 10px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'bottom';
      ch.data.datasets.forEach(function (ds, di) {
        if (ds.yAxisID === 'yKcal' || ds._trend || !ch.isDatasetVisible(di)) return; // カロリー棒・トレンドは点ラベルを描かない
        var meta = ch.getDatasetMeta(di);
        var lastIdx = -1;
        if (!showAll) {
          for (var j = ds.data.length - 1; j >= 0; j--) {
            if (ds.data[j] != null) {
              lastIdx = j;
              break;
            }
          }
        }
        ds.data.forEach(function (v, j) {
          if (v == null || (!showAll && j !== lastIdx)) return;
          var el = meta.data[j];
          if (!el || isNaN(el.x) || isNaN(el.y)) return;
          var label = Number(v).toFixed(1);
          // 背景色の縁取りで線・グリッドと重なっても読めるようにする
          ctx.strokeStyle = themeCache.surface || '#ffffff';
          ctx.lineWidth = 3;
          ctx.strokeText(label, el.x, el.y - 6);
          ctx.fillStyle = typeof ds.borderColor === 'string' ? ds.borderColor : themeCache.text;
          ctx.fillText(label, el.x, el.y - 6);
        });
      });
      ctx.restore();
    },
  };

  function createChart(labels, sets, cals, density) {
    var t = themeCache;
    var limits = tickLimitsFor(currentBp);
    // 初期レンジは「表示モードで見えている系列」全部から計算する（全系列kgの単一軸）
    var kgRange = axisRange(
      seriesMode === 'avg'
        ? sets.weight7.concat(sets.fat7, sets.ffm7)
        : sets.weight.concat(sets.fat, sets.ffm),
    );
    // カロリー右軸の初期レンジ（applyAxisRangesと同じ規則）。以降の更新と一貫させる。
    // 描くのはネットのみ。棒は0起点なので、全日赤字でも上端は必ず0を含める
    // （max×1.15をそのまま使うと全負のとき上端が負になり、浅い赤字の棒が画面外に消える）
    var kcalVals = (cals.net || []).filter(function (v) {
      return v != null;
    });
    var kcalMaxRaw = kcalVals.length ? Math.max.apply(null, kcalVals) : 0;
    var kcalMax = kcalVals.length ? (kcalMaxRaw > 0 ? kcalMaxRaw * 1.15 : 0) : undefined;
    var kcalMinRaw = kcalVals.length ? Math.min.apply(null, kcalVals) : 0;
    var kcalMin = kcalMinRaw < 0 ? kcalMinRaw * 1.15 : 0;
    chart = new Chart(els.canvas, {
      type: 'line',
      data: { labels: labels, datasets: buildDatasets(sets, cals, density, t) },
      plugins: [pointLabelsPlugin],
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: reducedMotion ? false : { duration: 600 },
        interaction: { mode: 'index', intersect: false },
        color: t.text,
        plugins: {
          legend: {
            // カロリー棒は専用トグルで制御するため凡例には出さない
            // （凡例クリックでmeta.hiddenが確定するとトグルと二重管理になり壊れるのを防ぐ）
            labels: {
              color: t.text,
              usePointStyle: true,
              boxWidth: 8,
              boxHeight: 8,
              // ネット棒は凡例に出す（クリックはカロリートグルと同じ経路で同期）。トレンドは出さない
              filter: function (item, data) {
                var role = data.datasets[item.datasetIndex] && data.datasets[item.datasetIndex]._role;
                return role !== 'trend';
              },
            },
            onClick: onLegendClick,
          },
          tooltip: {
            // mode:index の既定位置は「全系列の平均位置」でカーソルから離れるため最近傍に出す
            position: 'nearest',
            callbacks: {
              title: function (items) {
                return items.length ? currentLabels[items[0].dataIndex] : '';
              },
              label: function (ctx) {
                var v = ctx.parsed.y;
                if (ctx.dataset.yAxisID === 'yKcal') {
                  return ' ' + ctx.dataset.label + ': ' + (v == null ? '—' : Math.round(v) + ' kcal');
                }
                return ' ' + ctx.dataset.label + ': ' + (v == null ? '—' : v.toFixed(1) + ' ' + (ctx.dataset.unit || ''));
              },
              afterLabel: function (ctx) {
                // ネット棒に摂取/消費の内訳とPFCを添える（1本化しても情報は失わない）
                var np = ctx.dataset._netParts;
                if (!np) return undefined;
                var i = ctx.dataIndex;
                var lines = [];
                if (np.intake[i] != null && np.burn[i] != null) {
                  var seg = '摂取 ' + Math.round(np.intake[i]) + ' − 消費 ' + Math.round(np.burn[i]);
                  var bp = np.parts && np.parts[i];
                  if (bp && bp.bmr != null && bp.ex != null && bp.ex > 0) {
                    seg += ' (基礎 ' + Math.round(bp.bmr) + ' + 運動 ' + Math.round(bp.ex) + ')';
                  }
                  lines.push('   ' + seg);
                }
                var round1 = function (n) {
                  return Math.round(n * 10) / 10;
                };
                var parts = [];
                if (np.p[i] != null) parts.push('P' + round1(np.p[i]));
                if (np.f[i] != null) parts.push('F' + round1(np.f[i]));
                if (np.c[i] != null) parts.push('C' + round1(np.c[i]));
                // PFC比率: エネルギー換算(4/9/4)して3者内で正規化（登録kcal割りは食物繊維等でずれるため）
                if (np.p[i] != null && np.f[i] != null && np.c[i] != null) {
                  var pe = np.p[i] * 4;
                  var fe = np.f[i] * 9;
                  var ce = np.c[i] * 4;
                  var te = pe + fe + ce;
                  if (te > 0) {
                    var pct = function (x) {
                      return Math.round((x / te) * 100);
                    };
                    parts.push('(' + pct(pe) + ':' + pct(fe) + ':' + pct(ce) + ')');
                  }
                }
                if (parts.length) lines.push('   ' + parts.join(' '));
                return lines.length ? lines : undefined;
              },
            },
          },
        },
        scales: {
          x: {
            ticks: {
              color: t.muted,
              maxRotation: 0,
              autoSkip: density !== 'sparse',
              maxTicksLimit: limits.x,
              callback: xTickCallback,
            },
            grid: { color: xGridColor },
            border: { color: t.grid },
          },
          yKg: {
            type: 'linear',
            position: 'left',
            min: kgRange ? kgRange.min : undefined,
            max: kgRange ? kgRange.max : undefined,
            ticks: { color: t.muted, maxTicksLimit: limits.y, callback: yTickCallback },
            grid: { color: t.grid },
            border: { display: false },
          },
          yKcal: {
            type: 'linear',
            position: 'right',
            beginAtZero: true,
            min: kcalMin,
            max: kcalMax,
            display: calorieOverlay,
            // カロリー軸のグリッドは体重グリッドと重なると煩いので描かない
            grid: { drawOnChartArea: false },
            ticks: {
              color: t.muted,
              maxTicksLimit: limits.y,
              callback: function (v) {
                return Math.round(v) + ' kcal';
              },
            },
            border: { display: false },
          },
        },
      },
    });
    // アニメーションは初回描画の600msのみ。以降は無効化する
    setTimeout(function () {
      if (chart) chart.options.animation = false;
    }, 700);
  }

  function renderChart(labels, sets, cals, density) {
    currentLabels = labels;
    currentDensity = density;
    if (!chart) {
      createChart(labels, sets, cals, density);
      return;
    }
    chart.data.labels = labels;
    var d = chart.data.datasets;
    // _keyで新データを引き当てる（並び順に依存しない）。トレンドは元系列から回帰を再計算
    var dataByKey = {
      weight: sets.weight,
      weight7: sets.weight7,
      fat: sets.fat,
      fat7: sets.fat7,
      ffm: sets.ffm,
      ffm7: sets.ffm7,
      intake: cals.cal,
      burn: cals.burn,
      net: cals.net,
    };
    var pr = pointRadiusFor(density);
    var phr = pointHoverRadiusFor(density);
    d.forEach(function (ds) {
      if (ds._role === 'trend') {
        // トレンド直線は点なしの直線のまま。ネットのトレンドは元データがcals側にある
        ds.data = trendLine(ds._series === 'net' ? cals.net : sets[ds._series]);
        return;
      }
      if (dataByKey[ds._key]) ds.data = dataByKey[ds._key];
      if (ds._key === 'net') {
        ds._netParts = { intake: cals.cal, burn: cals.burn, parts: cals.burnParts, p: cals.p, f: cals.f, c: cals.c };
      }
      ds.pointRadius = pr;
      ds.pointHoverRadius = phr;
    });
    setRoleVisibility(chart, 'energy', calorieOverlay);
    applyTrendVisibility(chart);
    chart.options.scales.yKcal.display = calorieOverlay;
    var limits = tickLimitsFor(currentBp);
    chart.options.scales.x.ticks.autoSkip = density !== 'sparse';
    chart.options.scales.x.ticks.maxTicksLimit = limits.x;
    applyAxisRanges(chart);
    chart.update('none');
  }

  // 運動・基礎代謝の日次をラベルへ整列し、消費（基礎+運動）とネット（摂取−消費）をcalsに足す。
  // 基礎代謝はKatch-McArdle推定（サーバー算出）。ネットは摂取がある日だけ描く（赤字=負値も出る）
  function addBurnNet(cals, exDays, labels) {
    var byDate = Object.create(null);
    (exDays || []).forEach(function (row) {
      byDate[row.d] = row;
    });
    cals.burn = labels.map(function (l) {
      var r = byDate[l];
      if (!r) return null;
      if (r.bmr == null && r.calories_burned == null) return null;
      return (r.bmr || 0) + (r.calories_burned || 0);
    });
    // ツールチップ内訳用（基礎/運動）
    cals.burnParts = labels.map(function (l) {
      var r = byDate[l];
      return r ? { bmr: r.bmr, ex: r.calories_burned } : null;
    });
    cals.net = labels.map(function (l, i) {
      var intake = cals.cal[i];
      var burn = cals.burn[i];
      if (intake == null || burn == null || burn <= 0) return null;
      return intake - burn;
    });
    cals.exRaw = byDate;
  }

  function renderAll(days, mealsDays, exDays, from, to) {
    lastDays = days;
    var labels = buildDateLabels(from, to);
    var density = densityFor(labels.length);
    var sets = seriesFrom(days, labels);
    var cals = calorieSeriesFrom(mealsDays, labels);
    addBurnNet(cals, exDays, labels);
    lastCals = cals;
    renderChart(labels, sets, cals, density);
    renderCards(days);
    renderTable(days);
  }

  /* ---- サマリーカード ---- */

  function renderCards(days) {
    var metrics = [
      { key: 'weight', id: 'card-weight' },
      { key: 'fat_mass', id: 'card-fat' },
      { key: 'fat_free_mass', id: 'card-ffm' },
    ];
    metrics.forEach(function (m) {
      var value = lastNonNull(days, m.key);
      var avg7 = lastNonNull(days, m.key + '_7d_avg');
      var first = firstNonNull(days, m.key);
      var diff = value != null && first != null ? value - first : null;
      $(m.id + '-value').textContent = fmt(value);
      $(m.id + '-avg').textContent = fmt(avg7);
      $(m.id + '-diff').textContent = fmtSigned(diff);
    });
  }

  /* ---- テーブル（新しい日付が上。日次集計と計測明細を切り替え可能） ---- */

  function appendRow(frag, cells) {
    var tr = document.createElement('tr');
    cells.forEach(function (text) {
      var td = document.createElement('td');
      td.textContent = text;
      tr.appendChild(td);
    });
    frag.appendChild(tr);
  }

  function renderDailyTable(days) {
    els.tableColDate.textContent = '日付';
    els.tableWrap.classList.remove('hide-kcal');
    var byDate = (lastCals && lastCals.raw) || Object.create(null);
    var exBy = (lastCals && lastCals.exRaw) || Object.create(null);
    var frag = document.createDocumentFragment();
    for (var i = days.length - 1; i >= 0; i--) {
      var d = days[i];
      var mealRow = byDate[d.d];
      var exRow = exBy[d.d];
      var intake = mealRow && mealRow.calories != null ? mealRow.calories : null;
      // 消費 = 基礎代謝(推定) + 運動。どちらも無い日はnull
      var burn = null;
      if (exRow && (exRow.bmr != null || exRow.calories_burned != null)) {
        burn = (exRow.bmr || 0) + (exRow.calories_burned || 0);
      }
      var calCell = intake != null ? Math.round(intake) + '' : '—';
      var burnCell = burn != null ? Math.round(burn) + '' : '—';
      var netCell = intake != null && burn != null ? Math.round(intake - burn) + '' : '—';
      appendRow(frag, [d.d, fmt(d.weight), fmt(d.fat_mass), fmt(d.fat_free_mass), calCell, burnCell, netCell]);
    }
    els.tableBody.replaceChildren(frag);
  }

  function renderRawTable(rows) {
    els.tableColDate.textContent = '日時';
    // 計測明細は1計測=1行で日次カロリーとは粒度が違うため摂取/消費/ネット列ごと隠す
    els.tableWrap.classList.add('hide-kcal');
    var frag = document.createDocumentFragment();
    rows.forEach(function (m) {
      var ms = parseUtcMs(m.measured_at);
      appendRow(frag, [
        ms == null ? '—' : formatLocalDateTime(ms),
        fmt(m.weight),
        fmt(m.fat_mass),
        fmt(m.fat_free_mass),
      ]);
    });
    els.tableBody.replaceChildren(frag);
  }

  function renderTable(days) {
    if (tableMode === 'raw') {
      loadRawRows();
      return;
    }
    renderDailyTable(days);
  }

  function loadRawRows() {
    if (rawRows) {
      renderRawTable(rawRows);
      return;
    }
    var r = rangeForPeriod();
    var url = BASE + 'api/raw?from=' + encodeURIComponent(r.from) + '&to=' + encodeURIComponent(r.to);
    fetch(url)
      .then(function (res) {
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.json();
      })
      .then(function (data) {
        rawRows = (data && data.measurements) || [];
        if (tableMode === 'raw') renderRawTable(rawRows);
      })
      .catch(function (err) {
        console.error('[dashboard] raw fetch failed', err);
        // 明細が取れなくても日次表示にフォールバックして空表にはしない
        tableMode = 'daily';
        setActiveTableMode('daily');
        renderDailyTable(lastDays);
      });
  }

  /* スマホでは短い文言にして行数を抑える */
  var narrowMq = window.matchMedia('(max-width: 559px)');

  function updateViewToggleLabel() {
    var short = narrowMq.matches;
    els.viewToggle.textContent = tableVisible
      ? (short ? 'グラフ' : 'グラフで見る')
      : (short ? '表' : '表で見る');
  }

  function setActiveTableMode(mode) {
    tableModeButtons.forEach(function (btn) {
      var active = btn.getAttribute('data-table-mode') === mode;
      btn.classList.toggle('active', active);
      btn.setAttribute('aria-pressed', String(active));
    });
  }

  /* ---- テーマ ---- */

  function currentThemeName() {
    var forced = document.documentElement.dataset.theme;
    if (forced === 'light' || forced === 'dark') return forced;
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }

  function applyThemeToChart() {
    themeCache = readTheme();
    if (!chart) return;
    var t = themeCache;
    // 系列色は_keyで引き当てる（並び順に依存しない）
    var colorByKey = {
      weight: t.accent,
      weight7: t.accent,
      fat: t.accent2,
      fat7: t.accent2,
      ffm: t.accent3,
      ffm7: t.accent3,
    };
    chart.data.datasets.forEach(function (ds) {
      if (ds._energy) {
        // ネット棒（摂取−消費）はテーマの緑で塗り直す
        ds.backgroundColor = hexToRgba(t.cal, 0.5);
        return;
      }
      if (ds._trend) {
        // トレンド直線は各系列色で再着色
        ds.borderColor = t[ds._trendColor] || t.muted;
        return;
      }
      var color = colorByKey[ds._key] || t.muted;
      ds.borderColor = color;
      ds.pointBackgroundColor = color;
      ds.backgroundColor = color;
    });
    chart.options.color = t.text;
    chart.options.plugins.legend.labels.color = t.text;
    var s = chart.options.scales;
    s.x.ticks.color = t.muted;
    s.x.border.color = t.grid;
    s.yKg.ticks.color = t.muted;
    s.yKg.grid.color = t.grid;
    if (s.yKcal) s.yKcal.ticks.color = t.muted;
    chart.update('none');
  }

  /* ---- イベント ---- */

  function setActivePeriod(p) {
    segButtons.forEach(function (btn) {
      var active = btn.getAttribute('data-period') === p;
      btn.classList.toggle('active', active);
      btn.setAttribute('aria-pressed', String(active));
    });
  }

  function bindEvents() {
    segButtons.forEach(function (btn) {
      btn.addEventListener('click', function () {
        var p = btn.getAttribute('data-period');
        setActivePeriod(p);
        if (p === 'custom') {
          els.customRange.classList.remove('hidden');
          return;
        }
        els.customRange.classList.add('hidden');
        period = p;
        loadData();
      });
    });

    modeButtons.forEach(function (btn) {
      btn.addEventListener('click', function () {
        applySeriesMode(btn.getAttribute('data-mode'));
      });
    });

    var trendToggle = document.getElementById('trend-toggle');
    if (trendToggle) {
      trendToggle.checked = trendOn;
      trendToggle.addEventListener('change', function () {
        trendOn = trendToggle.checked;
        try {
          localStorage.setItem('dash-trend', trendOn ? '1' : '0');
        } catch (e) { /* 保存不可でも表示は切り替わる */ }
        if (!chart) return;
        applyTrendVisibility(chart);
        chart.update('none');
      });
    }

    tableModeButtons.forEach(function (btn) {
      btn.addEventListener('click', function () {
        tableMode = btn.getAttribute('data-table-mode');
        setActiveTableMode(tableMode);
        renderTable(lastDays);
      });
    });

    els.customApply.addEventListener('click', function () {
      var from = els.customFrom.value;
      var to = els.customTo.value;
      var err = validateCustomRange(from, to, todayYmd());
      if (err) {
        els.customError.textContent = err;
        return;
      }
      els.customError.textContent = '';
      customFromValue = from;
      customToValue = to;
      period = 'custom';
      loadData();
    });

    els.viewToggle.addEventListener('click', function () {
      tableVisible = !tableVisible;
      els.tableWrap.classList.toggle('hidden', !tableVisible);
      els.chartSection.classList.toggle('hidden', tableVisible);
      updateViewToggleLabel();
      els.viewToggle.setAttribute('aria-pressed', String(tableVisible));
      if (!tableVisible && chart) chart.resize();
    });
    if (narrowMq.addEventListener) narrowMq.addEventListener('change', updateViewToggleLabel);

    els.themeToggle.addEventListener('click', function () {
      var next = currentThemeName() === 'dark' ? 'light' : 'dark';
      document.documentElement.dataset.theme = next;
      try {
        localStorage.setItem('dash-theme', next);
      } catch (e) { /* 保存不可でも表示は切り替わる */ }
      applyThemeToChart();
    });

    var mq = window.matchMedia('(prefers-color-scheme: dark)');
    if (mq.addEventListener) {
      mq.addEventListener('change', function () {
        if (!document.documentElement.dataset.theme) applyThemeToChart();
      });
    }

    els.retry.addEventListener('click', loadData);
    els.emptyReload.addEventListener('click', loadData);

    window.addEventListener('online', updateOnlineState);
    window.addEventListener('offline', updateOnlineState);

    if (typeof ResizeObserver !== 'undefined') {
      var ro = new ResizeObserver(function () {
        var bp = breakpointFor(window.innerWidth);
        if (bp === currentBp) return;
        currentBp = bp;
        if (!chart) return;
        var limits = tickLimitsFor(bp);
        chart.options.scales.x.ticks.maxTicksLimit = limits.x;
        chart.options.scales.yKg.ticks.maxTicksLimit = limits.y;
        chart.options.scales.yKcal.ticks.maxTicksLimit = limits.y;
        chart.update('none');
      });
      ro.observe(els.chartWrap);
    }
  }

  function initCustomInputs() {
    var today = todayYmd();
    els.customFrom.value = addDays(today, -29);
    els.customTo.value = today;
    els.customFrom.max = today;
    els.customTo.max = today;
  }

  function registerServiceWorker() {
    if (!('serviceWorker' in navigator)) return;
    navigator.serviceWorker.register(BASE + 'sw.js').catch(function (err) {
      console.error('[dashboard] service worker registration failed', err);
    });
  }

  /* ---- 初期化 ---- */

  registerServiceWorker();
  bindEvents();
  initCustomInputs();
  setActiveMode(seriesMode);
  updateViewToggleLabel();
  updateOnlineState();
  loadData();
})();
