import {
  RATING_ORDER,
  computeDistribution,
  describeEpisodeState,
  filterAndSortRatings,
  formatPct,
  formatPrice,
  formatScore,
  formatTrendLadder,
  ratingSlug,
  tierSlug,
  validateSeedIntegrity
} from './data-logic.js';

const STORAGE_CACHE_KEY = 'kutz_stock_ratings_cached_v1';
const STORAGE_URL_KEY = 'kutz_stock_ratings_remote_url_v1';

const state = {
  config: {
    hostedBaseUrl: 'https://nbkutz.github.io/stock-ratings-app/',
    remoteDataUrl: 'https://nbkutz.github.io/stock-ratings-app/ratings-seed.json',
    bundledDataUrl: './ratings-seed.json'
  },
  data: null,
  sourceMode: 'bundled', // 'live' | 'cached' | 'bundled'
  sourceDetail: '',
  lastLoadedAt: null,
  activeTab: 'ratings',
  filterRating: 'All',
  filterTheme: 'All',
  searchQuery: '',
  sortBy: 'conviction-desc',
  expandedTickers: new Set(),
  deferredInstallPrompt: null
};

const els = {
  headerMeta: document.getElementById('header-meta'),
  sourceBtn: document.getElementById('source-btn'),
  sourceDot: document.getElementById('source-dot'),
  sourceLabel: document.getElementById('source-label'),
  refreshBtn: document.getElementById('refresh-btn'),
  installBtn: document.getElementById('install-btn'),
  tabRatings: document.getElementById('tab-ratings'),
  tabScorecard: document.getElementById('tab-scorecard'),
  tabRatingsCount: document.getElementById('tab-ratings-count'),
  tabScorecardCount: document.getElementById('tab-scorecard-count'),
  panelRatings: document.getElementById('panel-ratings'),
  panelScorecard: document.getElementById('panel-scorecard'),
  integrityBanner: document.getElementById('integrity-banner'),
  distStrip: document.getElementById('dist-strip'),
  themesPanel: document.getElementById('themes-panel'),
  themesCount: document.getElementById('themes-count'),
  themesGrid: document.getElementById('themes-grid'),
  searchInput: document.getElementById('search-input'),
  searchClear: document.getElementById('search-clear'),
  themeSelect: document.getElementById('theme-select'),
  sortSelect: document.getElementById('sort-select'),
  resultsCount: document.getElementById('results-count'),
  resetFiltersBtn: document.getElementById('reset-filters-btn'),
  ratingsCards: document.getElementById('ratings-cards'),
  ratingsTbody: document.getElementById('ratings-tbody'),
  ratingsEmpty: document.getElementById('ratings-empty'),
  scorecardKpis: document.getElementById('scorecard-kpis'),
  episodesList: document.getElementById('episodes-list'),
  sourceDialog: document.getElementById('source-dialog'),
  closeSourceBtn: document.getElementById('close-source-btn'),
  sourceMetaDl: document.getElementById('source-meta-dl'),
  sourceForm: document.getElementById('source-form'),
  remoteUrlInput: document.getElementById('remote-url-input'),
  resetUrlBtn: document.getElementById('reset-url-btn')
};

function isCapacitorNative() {
  return Boolean(window.Capacitor && typeof window.Capacitor.isNativePlatform === 'function' && window.Capacitor.isNativePlatform());
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function getEffectiveRemoteUrl() {
  try {
    const custom = localStorage.getItem(STORAGE_URL_KEY);
    if (custom !== null && custom.trim() !== '') return custom.trim();
  } catch (_) {}
  return state.config.remoteDataUrl || null;
}

async function fetchJsonWithTimeout(url, timeoutMs = 6000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const sep = url.includes('?') ? '&' : '?';
    const bustUrl = `${url}${sep}_t=${Date.now()}`;
    const res = await fetch(bustUrl, { cache: 'no-store', signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

async function loadConfig() {
  try {
    const res = await fetch('./config.json', { cache: 'no-store' });
    if (res.ok) {
      const cfg = await res.json();
      state.config = { ...state.config, ...cfg };
    }
  } catch (_) {}
}

function readCachedData() {
  try {
    const raw = localStorage.getItem(STORAGE_CACHE_KEY);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch (_) {
    return null;
  }
}

function writeCachedData(payload, url) {
  try {
    localStorage.setItem(
      STORAGE_CACHE_KEY,
      JSON.stringify({ payload, url, fetchedAt: new Date().toISOString() })
    );
  } catch (_) {}
}

async function loadRatingsData({ preferRemote = true } = {}) {
  els.refreshBtn.classList.add('spinning');
  try {
    const native = isCapacitorNative();
    const customUrl = (() => {
      try { return localStorage.getItem(STORAGE_URL_KEY)?.trim() || ''; } catch (_) { return ''; }
    })();
    const remoteUrl = getEffectiveRemoteUrl();

    // 1. In Capacitor APK (or if user explicitly set a custom remote URL on web), try hosted JSON first.
    if (preferRemote && remoteUrl && (native || customUrl)) {
      try {
        const remoteData = await fetchJsonWithTimeout(remoteUrl, 6000);
        if (remoteData && Array.isArray(remoteData.ratings)) {
          state.data = remoteData;
          state.sourceMode = 'live';
          state.sourceDetail = `Hosted live (${remoteUrl})`;
          state.lastLoadedAt = new Date().toISOString();
          writeCachedData(remoteData, remoteUrl);
          renderAll();
          return;
        }
      } catch (err) {
        const cached = readCachedData();
        if (cached && cached.payload && Array.isArray(cached.payload.ratings)) {
          state.data = cached.payload;
          state.sourceMode = 'cached';
          state.sourceDetail = `Cached from ${cached.url} (hosted unreachable: ${err.message})`;
          state.lastLoadedAt = cached.fetchedAt;
          renderAll();
          return;
        }
        // Fall through to bundled snapshot
        state.sourceDetail = `Bundled snapshot (hosted URL unreachable: ${err.message})`;
      }
    }

    // 2. Web app (PWA) fetches ./ratings-seed.json from its own origin; APK falls back to its bundled copy.
    const bundledUrl = state.config.bundledDataUrl || './ratings-seed.json';
    const localData = await fetchJsonWithTimeout(bundledUrl, 6000);
    state.data = localData;
    state.sourceMode = native ? 'bundled' : 'live';
    if (!native) {
      state.sourceDetail = `Hosted origin (${new URL(bundledUrl, window.location.href).href})`;
    } else if (!state.sourceDetail) {
      state.sourceDetail = 'Bundled APK snapshot';
    }
    state.lastLoadedAt = new Date().toISOString();
    renderAll();
  } catch (err) {
    els.integrityBanner.textContent = `Could not load ratings data: ${err.message}`;
    els.integrityBanner.classList.remove('hidden');
  } finally {
    els.refreshBtn.classList.remove('spinning');
  }
}

function pillarFillClass(val) {
  if (val === null || val === undefined) return '';
  if (val >= 70) return 'high';
  if (val >= 40) return 'mid';
  return 'low';
}

function renderLadder(rungs) {
  if (rungs === null || rungs === undefined) {
    return '<span class="ladder-wrap">—</span>';
  }
  const n = Number(rungs);
  return `
    <span class="ladder-wrap" title="Trend ladder ${n} of 3">
      <span class="ladder-pips" aria-hidden="true">
        <span class="pip pip-1 ${n >= 1 ? 'filled' : ''}"></span>
        <span class="pip pip-2 ${n >= 2 ? 'filled' : ''}"></span>
        <span class="pip pip-3 ${n >= 3 ? 'filled' : ''}"></span>
      </span>
      <span>${formatTrendLadder(n)}</span>
    </span>
  `;
}

function renderFlags(item) {
  const parts = [];
  if (item.extendedFlag) {
    parts.push(`<span class="flag-pill flag-extended">${escapeHtml(item.extendedFlag)}</span>`);
  }
  if (item.entryDragApplied) {
    const label = item.baseRating && item.baseRating !== item.finalRating
      ? `Entry drag (${item.baseRating} → ${item.finalRating})`
      : 'Entry drag applied';
    parts.push(`<span class="flag-pill flag-drag">${escapeHtml(label)}</span>`);
  }
  return parts.join('');
}

function renderHeaderAndIntegrity() {
  const d = state.data;
  if (!d) return;

  const total = d.ratings.length;
  els.headerMeta.textContent = `${d.rubric || 'v2.0'} · Focus ${total} · ${d.ratings_as_of || '—'}`;
  els.tabRatingsCount.textContent = String(total);
  els.tabScorecardCount.textContent = String((d.episodes || []).length);

  els.sourceDot.className = `source-dot ${state.sourceMode}`;
  els.sourceLabel.textContent =
    state.sourceMode === 'live' ? 'Live' : state.sourceMode === 'cached' ? 'Cached' : 'Bundled';

  const check = validateSeedIntegrity(d);
  if (!check.ok) {
    els.integrityBanner.textContent = `Data count integrity warning: ${check.errors.join(' ')}`;
    els.integrityBanner.classList.remove('hidden');
  } else {
    els.integrityBanner.classList.add('hidden');
  }
}

function renderDistributionStrip() {
  const d = state.data;
  if (!d) return;
  const computed = computeDistribution(d.ratings);
  const countMap = new Map(computed.map((x) => [x.rating, x.count]));

  const items = [
    { key: 'All', label: 'All', count: d.ratings.length, cls: 'dist-all' },
    ...RATING_ORDER.map((r) => ({
      key: r,
      label: r,
      count: countMap.get(r) ?? 0,
      cls: `dist-${ratingSlug(r)}`
    }))
  ];

  els.distStrip.innerHTML = items
    .map((item) => {
      const active = state.filterRating === item.key ? 'active' : '';
      return `
        <button type="button" class="dist-card ${item.cls} ${active}" data-rating="${escapeHtml(item.key)}" aria-pressed="${state.filterRating === item.key}">
          <span class="dist-num">${item.count}</span>
          <span class="dist-label">${escapeHtml(item.label)}</span>
        </button>
      `;
    })
    .join('');

  els.distStrip.querySelectorAll('.dist-card').forEach((btn) => {
    btn.addEventListener('click', () => {
      const next = btn.dataset.rating;
      state.filterRating = state.filterRating === next && next !== 'All' ? 'All' : next;
      renderDistributionStrip();
      renderRatingsList();
    });
  });
}

function renderThemes() {
  const d = state.data;
  if (!d) return;
  const themes = d.themes || [];
  els.themesCount.textContent = String(themes.length);

  // Sync theme <select> options without losing selection
  const currentVal = state.filterTheme;
  els.themeSelect.innerHTML =
    '<option value="All">All themes (8)</option>' +
    themes
      .map(
        (t) =>
          `<option value="${escapeHtml(t.theme)}">${escapeHtml(t.theme)} (${escapeHtml(t.tier)} · ${t.count})</option>`
      )
      .join('');
  els.themeSelect.value = currentVal;

  els.themesGrid.innerHTML = themes
    .map((t) => {
      const active = state.filterTheme === t.theme ? 'active' : '';
      return `
        <button type="button" class="theme-chip ${active}" data-theme="${escapeHtml(t.theme)}">
          <span>${escapeHtml(t.theme)}</span>
          <span class="tier-tag tier-${tierSlug(t.tier)}">${escapeHtml(t.tier)}</span>
          <span>${t.count}</span>
        </button>
      `;
    })
    .join('');

  els.themesGrid.querySelectorAll('.theme-chip').forEach((btn) => {
    btn.addEventListener('click', () => {
      const t = btn.dataset.theme;
      state.filterTheme = state.filterTheme === t ? 'All' : t;
      renderThemes();
      renderRatingsList();
    });
  });
}

function renderPillarBox(label, val) {
  const pct = typeof val === 'number' && Number.isFinite(val) ? Math.max(0, Math.min(100, val)) : 0;
  return `
    <div class="pillar-box">
      <div class="pillar-top">
        <span class="pillar-name">${label}</span>
        <span class="pillar-num">${formatScore(val)}</span>
      </div>
      <div class="pillar-bar">
        <div class="pillar-fill ${pillarFillClass(val)}" style="width:${pct}%"></div>
      </div>
    </div>
  `;
}

function renderRatingsList() {
  const d = state.data;
  if (!d) return;

  const list = filterAndSortRatings(d.ratings, {
    query: state.searchQuery,
    rating: state.filterRating,
    theme: state.filterTheme,
    sort: state.sortBy
  });

  const isFiltered =
    state.filterRating !== 'All' || state.filterTheme !== 'All' || state.searchQuery.trim() !== '';
  els.resultsCount.textContent = `Showing ${list.length} of ${d.ratings.length} names`;
  els.resetFiltersBtn.classList.toggle('hidden', !isFiltered);

  if (list.length === 0) {
    els.ratingsCards.innerHTML = '';
    els.ratingsTbody.innerHTML = '';
    els.ratingsEmpty.classList.remove('hidden');
    return;
  }
  els.ratingsEmpty.classList.add('hidden');

  // Mobile cards
  els.ratingsCards.innerHTML = list
    .map((item) => {
      const slug = ratingSlug(item.finalRating);
      const flagsHtml = renderFlags(item);
      const themeHtml = item.theme
        ? `<span class="meta-pill">${escapeHtml(item.theme)} <span class="tier-tag tier-${tierSlug(item.themeTier)}">${escapeHtml(item.themeTier || '—')}</span></span>`
        : `<span class="meta-pill">Theme: —</span>`;
      const exposureHtml = `<span class="meta-pill">Exp: ${escapeHtml(item.exposure || '—')}</span>`;
      const sectorHtml = `<span class="meta-pill">${escapeHtml(item.sector || '—')}</span>`;

      return `
        <article class="stock-card card-${slug}">
          <div class="card-head">
            <div class="card-id">
              <div class="ticker-row">
                <span class="ticker">${escapeHtml(item.ticker)}</span>
                <span class="price-text">${formatPrice(item.priceAtRating)}</span>
              </div>
              <div class="company-name">${escapeHtml(item.company)}</div>
            </div>
            <span class="rating-badge rating-${slug}">${escapeHtml(item.finalRating)}</span>
          </div>

          ${flagsHtml ? `<div class="flags-row">${flagsHtml}</div>` : ''}

          <div class="card-scores">
            <div class="score-cell">
              <span class="score-label">Conviction</span>
              <span class="score-val">${formatScore(item.conviction)}</span>
            </div>
            <div class="score-cell">
              <span class="score-label">Entry</span>
              <span class="score-val">${formatScore(item.entry)}</span>
            </div>
            <div class="score-cell">
              <span class="score-label">Trend</span>
              <span class="score-val">${renderLadder(item.trendRungs)}</span>
            </div>
          </div>

          <div class="pillars-grid">
            ${renderPillarBox('GRW', item.growth)}
            ${renderPillarBox('QLT', item.quality)}
            ${renderPillarBox('VAL', item.valuation)}
            ${renderPillarBox('THM', item.thematic)}
          </div>

          <div class="card-meta-row">
            ${themeHtml}
            ${exposureHtml}
            ${sectorHtml}
          </div>

          <details class="card-details">
            <summary>Rationale &amp; rubric details</summary>
            <div class="rationale-body">
              <p style="margin:0">${escapeHtml(item.rationale || 'No rationale provided.')}</p>
              <div class="rationale-extras">
                <span>Base rating: <strong>${escapeHtml(item.baseRating || '—')}</strong></span>
                <span>Entry val: <strong>${formatScore(item.entryValuationComponent)}</strong></span>
                <span>Fundamentals: <strong>${escapeHtml(item.fundamentalsPeriodEnd || '—')}</strong></span>
              </div>
            </div>
          </details>
        </article>
      `;
    })
    .join('');

  // Desktop table
  els.ratingsTbody.innerHTML = list
    .map((item) => {
      const slug = ratingSlug(item.finalRating);
      const flagsHtml = renderFlags(item);
      const expanded = state.expandedTickers.has(item.ticker);
      return `
        <tr class="stock-row row-${slug}">
          <td>
            <div class="table-stock-ticker">${escapeHtml(item.ticker)}</div>
            <div class="table-stock-company">${escapeHtml(item.company)}</div>
            <div class="table-stock-sector">${escapeHtml(item.sector || '—')}</div>
          </td>
          <td>
            <div class="table-flags">
              <span class="rating-badge rating-${slug}">${escapeHtml(item.finalRating)}</span>
              ${flagsHtml}
            </div>
          </td>
          <td class="num" style="font-weight:700; white-space:nowrap">${formatPrice(item.priceAtRating)}</td>
          <td>
            <div class="table-conviction">${formatScore(item.conviction)}</div>
            <div class="table-pillars">
              <div class="tp-chip"><span>GRW</span>${formatScore(item.growth)}</div>
              <div class="tp-chip"><span>QLT</span>${formatScore(item.quality)}</div>
              <div class="tp-chip"><span>VAL</span>${formatScore(item.valuation)}</div>
              <div class="tp-chip"><span>THM</span>${formatScore(item.thematic)}</div>
            </div>
          </td>
          <td>
            <div class="table-entry">${formatScore(item.entry)}</div>
            ${renderLadder(item.trendRungs)}
          </td>
          <td>
            <div class="table-theme-name">${escapeHtml(item.theme || '—')}</div>
            <div class="table-theme-tags">
              ${item.themeTier ? `<span class="tier-tag tier-${tierSlug(item.themeTier)}">${escapeHtml(item.themeTier)}</span>` : ''}
              <span class="meta-pill">${escapeHtml(item.exposure || '—')}</span>
            </div>
          </td>
          <td class="center">
            <button type="button" class="expand-btn" data-expand="${escapeHtml(item.ticker)}" aria-expanded="${expanded}">
              ${expanded ? 'Hide' : 'View'}
            </button>
          </td>
        </tr>
        <tr class="detail-row ${expanded ? '' : 'hidden'}" data-detail-for="${escapeHtml(item.ticker)}">
          <td colspan="7">
            <div class="rationale-body" style="margin-top:0">
              <p style="margin:0">${escapeHtml(item.rationale || 'No rationale provided.')}</p>
              <div class="rationale-extras">
                <span>Base rating: <strong>${escapeHtml(item.baseRating || '—')}</strong></span>
                <span>Entry valuation component: <strong>${formatScore(item.entryValuationComponent)}</strong></span>
                <span>Fundamentals period end: <strong>${escapeHtml(item.fundamentalsPeriodEnd || '—')}</strong></span>
              </div>
            </div>
          </td>
        </tr>
      `;
    })
    .join('');

  els.ratingsTbody.querySelectorAll('.expand-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const ticker = btn.dataset.expand;
      if (state.expandedTickers.has(ticker)) {
        state.expandedTickers.delete(ticker);
      } else {
        state.expandedTickers.add(ticker);
      }
      renderRatingsList();
    });
  });
}

function renderScorecard() {
  const d = state.data;
  if (!d) return;

  const summary = d.summary || {};
  const episodes = d.episodes || [];
  const companyMap = new Map((d.ratings || []).map((r) => [r.ticker, r.company]));

  const kpis = [
    {
      label: 'Episodes Opened',
      value: summary.episodesOpened ?? episodes.length,
      note: `${summary.openEpisodes ?? 0} currently open`
    },
    {
      label: 'Closed Episodes',
      value: `${summary.closedAtDowngrade ?? 0} / ${summary.closedAtSell ?? 0}`,
      note: 'Downgrade / Sell exits'
    },
    {
      label: 'Avg Excess vs SPY',
      value: formatPct(summary.avgExcessDowngradePct),
      note:
        summary.avgExcessDowngradePct === null || summary.avgExcessDowngradePct === undefined
          ? 'No closed episodes yet'
          : `At sell: ${formatPct(summary.avgExcessSellPct)}`
    },
    {
      label: 'Win Rate vs SPY',
      value: formatPct(summary.winRateDowngradePct),
      note:
        summary.winRateDowngradePct === null || summary.winRateDowngradePct === undefined
          ? 'No closed episodes yet'
          : `At sell: ${formatPct(summary.winRateSellPct)}`
    }
  ];

  els.scorecardKpis.innerHTML = kpis
    .map(
      (k) => `
      <div class="kpi-card">
        <div class="kpi-label">${escapeHtml(k.label)}</div>
        <div class="kpi-value">${escapeHtml(k.value)}</div>
        <div class="kpi-note">${escapeHtml(k.note)}</div>
      </div>
    `
    )
    .join('');

  if (episodes.length === 0) {
    els.episodesList.innerHTML = `
      <div class="empty-state">
        <p class="empty-title">No Buy episodes recorded</p>
        <p class="empty-sub">Episodes appear here once a stock receives a Buy rating.</p>
      </div>
    `;
    return;
  }

  els.episodesList.innerHTML = episodes
    .map((ep) => {
      const { hasMark, isClosed, status } = describeEpisodeState(ep);
      const company = companyMap.get(ep.ticker) || '';

      const markHtml = hasMark
        ? `
          <div class="ep-metrics">
            <div><span class="ep-metric-label">Mark Date</span><span class="ep-metric-val">${escapeHtml(ep.markDate)}</span></div>
            <div><span class="ep-metric-label">Mark Price</span><span class="ep-metric-val">${formatPrice(ep.markPrice)}</span></div>
            <div><span class="ep-metric-label">Stock Return</span><span class="ep-metric-val">${formatPct(ep.markReturnPct)}</span></div>
            <div><span class="ep-metric-label">SPY Return</span><span class="ep-metric-val">${formatPct(ep.spyMarkReturnPct)}</span></div>
            <div><span class="ep-metric-label">Excess vs SPY</span><span class="ep-metric-val">${formatPct(ep.markExcessPct)}</span></div>
          </div>
        `
        : `<p class="ep-empty-note">No mark yet — episode opened on <strong>${escapeHtml(ep.startDate || '—')}</strong>. Mark price, return, and excess vs SPY will appear after the next pricing mark.</p>`;

      const exitHtml = isClosed
        ? `
          <div class="ep-metrics">
            <div><span class="ep-metric-label">Downgrade Date</span><span class="ep-metric-val">${escapeHtml(ep.downgradeDate || '—')}</span></div>
            <div><span class="ep-metric-label">Downgrade Price</span><span class="ep-metric-val">${formatPrice(ep.downgradePrice)}</span></div>
            <div><span class="ep-metric-label">Excess to Downgrade</span><span class="ep-metric-val">${formatPct(ep.excessToDowngradePct)}</span></div>
            <div><span class="ep-metric-label">Sell Date</span><span class="ep-metric-val">${escapeHtml(ep.sellDate || '—')}</span></div>
            <div><span class="ep-metric-label">Sell Price</span><span class="ep-metric-val">${formatPrice(ep.sellPrice)}</span></div>
            <div><span class="ep-metric-label">Excess to Sell</span><span class="ep-metric-val">${formatPct(ep.excessToSellPct)}</span></div>
          </div>
        `
        : `<p class="ep-empty-note">Still open — no downgrade or sell exit has occurred.</p>`;

      return `
        <article class="episode-card">
          <div class="episode-head">
            <div class="episode-title">
              <span class="episode-ticker">${escapeHtml(ep.ticker)}</span>
              <span class="episode-company">${escapeHtml(company)}</span>
            </div>
            <div class="episode-badges">
              <span class="rating-badge rating-buy">${escapeHtml(status)}</span>
              ${ep.extendedFlag ? `<span class="flag-pill flag-extended">${escapeHtml(ep.extendedFlag)}</span>` : ''}
            </div>
          </div>

          <div class="episode-sections">
            <div class="ep-box">
              <h4>Opening Basis</h4>
              <div class="ep-metrics">
                <div><span class="ep-metric-label">Start Date</span><span class="ep-metric-val">${escapeHtml(ep.startDate || '—')}</span></div>
                <div><span class="ep-metric-label">Start Price</span><span class="ep-metric-val">${formatPrice(ep.startPrice)}</span></div>
                <div><span class="ep-metric-label">SPY Start</span><span class="ep-metric-val">${formatPrice(ep.spyStartPrice)}</span></div>
                <div><span class="ep-metric-label">Entry Price</span><span class="ep-metric-val">${ep.entryPrice !== null && ep.entryPrice !== undefined ? formatPrice(ep.entryPrice) : '— (not set)'}</span></div>
              </div>
            </div>

            <div class="ep-box">
              <h4>Current Mark vs SPY</h4>
              ${markHtml}
            </div>

            <div class="ep-box">
              <h4>Exit / Closure</h4>
              ${exitHtml}
            </div>
          </div>
        </article>
      `;
    })
    .join('');
}

function renderSourceModal() {
  const d = state.data || {};
  const rows = [
    ['Runtime', isCapacitorNative() ? 'Capacitor Android App' : 'Web App (PWA)'],
    ['Active source', state.sourceDetail || state.sourceMode],
    ['Ratings as of', d.ratings_as_of || '—'],
    ['Prices as of', d.price_as_of || '—'],
    ['Seeded at', d.seeded_at || '—'],
    ['Seeded from', d.seeded_from || '—'],
    ['Loaded at', state.lastLoadedAt ? new Date(state.lastLoadedAt).toLocaleString() : '—']
  ];
  els.sourceMetaDl.innerHTML = rows
    .map(([k, v]) => `<dt>${escapeHtml(k)}</dt><dd>${escapeHtml(v)}</dd>`)
    .join('');
  els.remoteUrlInput.value = getEffectiveRemoteUrl() || '';
}

function renderAll() {
  renderHeaderAndIntegrity();
  renderDistributionStrip();
  renderThemes();
  renderRatingsList();
  renderScorecard();
}

function setActiveTab(tab) {
  state.activeTab = tab;
  const isRatings = tab === 'ratings';
  els.tabRatings.classList.toggle('active', isRatings);
  els.tabRatings.setAttribute('aria-selected', String(isRatings));
  els.tabScorecard.classList.toggle('active', !isRatings);
  els.tabScorecard.setAttribute('aria-selected', String(!isRatings));
  els.panelRatings.classList.toggle('hidden', !isRatings);
  els.panelScorecard.classList.toggle('hidden', isRatings);
}

function wireEvents() {
  els.tabRatings.addEventListener('click', () => setActiveTab('ratings'));
  els.tabScorecard.addEventListener('click', () => setActiveTab('scorecard'));

  els.searchInput.addEventListener('input', (e) => {
    state.searchQuery = e.target.value;
    els.searchClear.classList.toggle('hidden', state.searchQuery === '');
    renderRatingsList();
  });

  els.searchClear.addEventListener('click', () => {
    state.searchQuery = '';
    els.searchInput.value = '';
    els.searchClear.classList.add('hidden');
    els.searchInput.focus();
    renderRatingsList();
  });

  els.themeSelect.addEventListener('change', (e) => {
    state.filterTheme = e.target.value;
    renderThemes();
    renderRatingsList();
  });

  els.sortSelect.addEventListener('change', (e) => {
    state.sortBy = e.target.value;
    renderRatingsList();
  });

  els.resetFiltersBtn.addEventListener('click', () => {
    state.filterRating = 'All';
    state.filterTheme = 'All';
    state.searchQuery = '';
    els.searchInput.value = '';
    els.searchClear.classList.add('hidden');
    renderDistributionStrip();
    renderThemes();
    renderRatingsList();
  });

  els.refreshBtn.addEventListener('click', () => loadRatingsData({ preferRemote: true }));

  els.sourceBtn.addEventListener('click', () => {
    renderSourceModal();
    els.sourceDialog.showModal();
  });

  els.closeSourceBtn.addEventListener('click', () => els.sourceDialog.close());
  els.sourceDialog.addEventListener('click', (e) => {
    if (e.target === els.sourceDialog) els.sourceDialog.close();
  });

  els.sourceForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const val = els.remoteUrlInput.value.trim();
    try {
      if (val) localStorage.setItem(STORAGE_URL_KEY, val);
      else localStorage.removeItem(STORAGE_URL_KEY);
    } catch (_) {}
    els.sourceDialog.close();
    loadRatingsData({ preferRemote: true });
  });

  els.resetUrlBtn.addEventListener('click', () => {
    try { localStorage.removeItem(STORAGE_URL_KEY); } catch (_) {}
    els.remoteUrlInput.value = state.config.remoteDataUrl || '';
  });

  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    state.deferredInstallPrompt = e;
    els.installBtn.classList.remove('hidden');
  });

  els.installBtn.addEventListener('click', async () => {
    if (!state.deferredInstallPrompt) return;
    state.deferredInstallPrompt.prompt();
    await state.deferredInstallPrompt.userChoice;
    state.deferredInstallPrompt = null;
    els.installBtn.classList.add('hidden');
  });

  window.addEventListener('appinstalled', () => {
    els.installBtn.classList.add('hidden');
  });
}

function registerServiceWorker() {
  if (isCapacitorNative()) return;
  if ('serviceWorker' in navigator && (window.location.protocol === 'https:' || window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1')) {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  }
}

async function init() {
  if (window.innerWidth >= 900) {
    els.themesPanel.setAttribute('open', '');
  }
  wireEvents();
  registerServiceWorker();
  await loadConfig();
  await loadRatingsData({ preferRemote: true });
}

init();
