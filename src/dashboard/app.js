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
    Promise.all([
      fetch(url).then(function (res) {
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.json();
      }),
      fetchStatus(),
    ])
      .then(function (results) {
        var days = (results[0] && results[0].days) || [];
        var status = results[1];
        rawRows = null; // 期間が変わった可能性があるので明細キャッシュを破棄
        renderHeader(days, status);
        if (days.length === 0) {
          renderEmpty(status);
          return;
        }
        showState('ready');
        renderAll(days, r.from, r.to);
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
      fat: pick('fat_ratio'),
      fat7: pick('fat_ratio_7d_avg'),
      ffm: pick('fat_free_mass'),
      ffm7: pick('fat_free_mass_7d_avg'),
    };
  }

  function weightGradient(ctx) {
    var area = ctx.chart.chartArea;
    if (!area) return 'rgba(0,0,0,0)';
    var g = ctx.chart.ctx.createLinearGradient(0, area.top, 0, area.bottom);
    g.addColorStop(0, hexToRgba(themeCache.accent, 0.25));
    g.addColorStop(1, hexToRgba(themeCache.accent, 0));
    return g;
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

  function buildDatasets(sets, density, t) {
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
    function avg(label, data, color, axis, unit, hidden) {
      // 7日平均モードでは主役の系列になるため、点は実測と同じ密度ルールで描く
      return {
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
    // 実測3系列と7日平均3系列をモードで一括切替（凡例タップでの個別変更も可能）
    var hideRaw = seriesMode === 'avg';
    return [
      measured('体重', sets.weight, t.accent, 'yKg', 'kg', {
        fill: density === 'sparse' ? false : 'origin',
        backgroundColor: weightGradient,
        hidden: hideRaw,
      }),
      avg('体重 7日平均', sets.weight7, t.accent, 'yKg', 'kg', !hideRaw),
      measured('体脂肪率', sets.fat, t.accent2, 'yPct', '%', { hidden: hideRaw }),
      avg('体脂肪率 7日平均', sets.fat7, t.accent2, 'yPct', '%', !hideRaw),
      measured('除脂肪体重', sets.ffm, t.accent3, 'yKg', 'kg', { hidden: hideRaw }),
      avg('除脂肪体重 7日平均', sets.ffm7, t.accent3, 'yKg', 'kg', !hideRaw),
    ];
  }

  var RAW_DATASET_INDEXES = [0, 2, 4];
  var AVG_DATASET_INDEXES = [1, 3, 5];

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
    RAW_DATASET_INDEXES.forEach(function (i) {
      chart.setDatasetVisibility(i, mode === 'raw');
    });
    AVG_DATASET_INDEXES.forEach(function (i) {
      chart.setDatasetVisibility(i, mode === 'avg');
    });
    applyAxisRanges(chart);
    chart.update('none');
  }

  function visibleValues(ch, axisId) {
    var vals = [];
    ch.data.datasets.forEach(function (ds, i) {
      if (ds.yAxisID !== axisId || !ch.isDatasetVisible(i)) return;
      ds.data.forEach(function (v) {
        if (v != null) vals.push(v);
      });
    });
    return vals;
  }

  function applyAxisRanges(ch) {
    var s = ch.options.scales;
    var kg = axisRange(visibleValues(ch, 'yKg'));
    var pct = axisRange(visibleValues(ch, 'yPct'));
    if (kg) {
      s.yKg.min = kg.min;
      s.yKg.max = kg.max;
    } else {
      delete s.yKg.min;
      delete s.yKg.max;
    }
    if (pct) {
      s.yPct.min = pct.min;
      s.yPct.max = pct.max;
    } else {
      delete s.yPct.min;
      delete s.yPct.max;
    }
  }

  function onLegendClick(evt, item, legend) {
    var ch = legend.chart;
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
        if (!ch.isDatasetVisible(i)) return;
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
        if (!ch.isDatasetVisible(di)) return;
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

  function createChart(labels, sets, density) {
    var t = themeCache;
    var limits = tickLimitsFor(currentBp);
    // 初期レンジは「表示モードで見えている系列」全部から計算する
    // （kg軸は体重+除脂肪体重。体重だけだと除脂肪体重が軸外に出て描画が壊れる）
    var kgRange = axisRange(
      seriesMode === 'avg' ? sets.weight7.concat(sets.ffm7) : sets.weight.concat(sets.ffm),
    );
    var pctRange = axisRange(seriesMode === 'avg' ? sets.fat7 : sets.fat);
    chart = new Chart(els.canvas, {
      type: 'line',
      data: { labels: labels, datasets: buildDatasets(sets, density, t) },
      plugins: [pointLabelsPlugin],
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: reducedMotion ? false : { duration: 600 },
        interaction: { mode: 'index', intersect: false },
        color: t.text,
        plugins: {
          legend: {
            labels: { color: t.text, usePointStyle: true, boxWidth: 8, boxHeight: 8 },
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
                return ' ' + ctx.dataset.label + ': ' + (v == null ? '—' : v.toFixed(1) + ' ' + (ctx.dataset.unit || ''));
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
          yPct: {
            type: 'linear',
            position: 'right',
            display: 'auto',
            min: pctRange ? pctRange.min : undefined,
            max: pctRange ? pctRange.max : undefined,
            ticks: { color: t.muted, maxTicksLimit: limits.y, callback: yTickCallback },
            grid: { drawOnChartArea: false, color: t.grid },
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

  function renderChart(labels, sets, density) {
    currentLabels = labels;
    currentDensity = density;
    if (!chart) {
      createChart(labels, sets, density);
      return;
    }
    chart.data.labels = labels;
    var d = chart.data.datasets;
    d[0].data = sets.weight;
    d[1].data = sets.weight7;
    d[2].data = sets.fat;
    d[3].data = sets.fat7;
    d[4].data = sets.ffm;
    d[5].data = sets.ffm7;
    var pr = pointRadiusFor(density);
    var phr = pointHoverRadiusFor(density);
    d.forEach(function (ds) {
      ds.pointRadius = pr;
      ds.pointHoverRadius = phr;
    });
    d[0].fill = density === 'sparse' ? false : 'origin';
    var limits = tickLimitsFor(currentBp);
    chart.options.scales.x.ticks.autoSkip = density !== 'sparse';
    chart.options.scales.x.ticks.maxTicksLimit = limits.x;
    applyAxisRanges(chart);
    chart.update('none');
  }

  function renderAll(days, from, to) {
    lastDays = days;
    var labels = buildDateLabels(from, to);
    var density = densityFor(labels.length);
    var sets = seriesFrom(days, labels);
    renderChart(labels, sets, density);
    renderCards(days);
    renderTable(days);
  }

  /* ---- サマリーカード ---- */

  function renderCards(days) {
    var metrics = [
      { key: 'weight', id: 'card-weight' },
      { key: 'fat_ratio', id: 'card-fat' },
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
    var frag = document.createDocumentFragment();
    for (var i = days.length - 1; i >= 0; i--) {
      var d = days[i];
      appendRow(frag, [d.d, fmt(d.weight), fmt(d.fat_ratio), fmt(d.fat_free_mass)]);
    }
    els.tableBody.replaceChildren(frag);
  }

  function renderRawTable(rows) {
    els.tableColDate.textContent = '日時';
    var frag = document.createDocumentFragment();
    rows.forEach(function (m) {
      var ms = parseUtcMs(m.measured_at);
      appendRow(frag, [
        ms == null ? '—' : formatLocalDateTime(ms),
        fmt(m.weight),
        fmt(m.fat_ratio),
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
    var colors = [t.accent, t.accent, t.accent2, t.accent2, t.accent3, t.accent3];
    chart.data.datasets.forEach(function (ds, i) {
      ds.borderColor = colors[i];
      ds.pointBackgroundColor = colors[i];
      if (i !== 0) ds.backgroundColor = colors[i];
    });
    chart.options.color = t.text;
    chart.options.plugins.legend.labels.color = t.text;
    var s = chart.options.scales;
    s.x.ticks.color = t.muted;
    s.x.border.color = t.grid;
    s.yKg.ticks.color = t.muted;
    s.yKg.grid.color = t.grid;
    s.yPct.ticks.color = t.muted;
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
        chart.options.scales.yPct.ticks.maxTicksLimit = limits.y;
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
