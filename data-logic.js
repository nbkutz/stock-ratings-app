export const RATING_ORDER = ['Buy', 'Hold', 'Sell/Avoid', 'Unrated'];
export const TIER_ORDER = ['Strong', 'Neutral', 'Fading'];

export function computeDistribution(ratings) {
  const counts = new Map(RATING_ORDER.map((r) => [r, 0]));
  for (const item of ratings || []) {
    const key = item.finalRating ?? 'Unrated';
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return Array.from(counts.entries()).map(([rating, count]) => ({ rating, count }));
}

export function validateSeedIntegrity(data) {
  const errors = [];
  if (!data || typeof data !== 'object') {
    return { ok: false, errors: ['Payload is not a valid JSON object.'], computed: [] };
  }
  for (const key of ['ratings', 'distribution', 'themes', 'episodes', 'summary']) {
    if (!(key in data)) {
      errors.push(`Missing required top-level key: ${key}`);
    }
  }
  if (!Array.isArray(data.ratings)) {
    return { ok: false, errors: [...errors, 'ratings must be an array.'], computed: [] };
  }

  const computed = computeDistribution(data.ratings);
  const computedMap = new Map(computed.map((d) => [d.rating, d.count]));
  const seedMap = new Map((data.distribution || []).map((d) => [d.rating, d.count]));

  const allKeys = new Set([...computedMap.keys(), ...seedMap.keys()]);
  for (const key of allKeys) {
    const actual = computedMap.get(key) ?? 0;
    const expected = seedMap.get(key) ?? 0;
    if (actual !== expected) {
      errors.push(`Distribution mismatch for "${key}": ratings[] has ${actual}, distribution[] says ${expected}.`);
    }
  }

  const totalFromSeed = (data.distribution || []).reduce((acc, d) => acc + (Number(d.count) || 0), 0);
  if (totalFromSeed !== data.ratings.length) {
    errors.push(`Total count mismatch: ratings[] has ${data.ratings.length}, distribution[] sums to ${totalFromSeed}.`);
  }

  return { ok: errors.length === 0, errors, computed };
}

export function filterAndSortRatings(ratings, { query = '', rating = 'All', theme = 'All', sort = 'conviction-desc' } = {}) {
  const q = query.trim().toLowerCase();

  const filtered = (ratings || []).filter((item) => {
    if (rating !== 'All' && item.finalRating !== rating) return false;
    if (theme !== 'All' && item.theme !== theme) return false;
    if (q) {
      const hay = [item.ticker, item.company, item.sector, item.theme]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });

  const numOrNegInf = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : -Infinity);

  return [...filtered].sort((a, b) => {
    switch (sort) {
      case 'ticker-asc':
        return (a.ticker || '').localeCompare(b.ticker || '');
      case 'entry-desc':
        return numOrNegInf(b.entry) - numOrNegInf(a.entry) || numOrNegInf(b.conviction) - numOrNegInf(a.conviction);
      case 'price-desc':
        return numOrNegInf(b.priceAtRating) - numOrNegInf(a.priceAtRating);
      case 'trend-desc':
        return numOrNegInf(b.trendRungs) - numOrNegInf(a.trendRungs) || numOrNegInf(b.conviction) - numOrNegInf(a.conviction);
      case 'conviction-desc':
      default:
        return numOrNegInf(b.conviction) - numOrNegInf(a.conviction) || (a.ticker || '').localeCompare(b.ticker || '');
    }
  });
}

export function formatScore(value) {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return '—';
  const n = Number(value);
  return Number.isInteger(n) ? String(n) : n.toFixed(1);
}

export function formatPrice(value) {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return '—';
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  }).format(Number(value));
}

export function formatPct(value) {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return '—';
  const n = Number(value);
  const sign = n > 0 ? '+' : '';
  return `${sign}${n.toFixed(2)}%`;
}

export function formatTrendLadder(rungs) {
  if (rungs === null || rungs === undefined || !Number.isFinite(Number(rungs))) return '—';
  return `${Number(rungs)}/3`;
}

export function describeEpisodeState(episode) {
  const hasMark = episode.markDate !== null && episode.markDate !== undefined && episode.markPrice !== null && episode.markPrice !== undefined;
  const isClosed = Boolean(episode.sellDate || episode.downgradeDate);
  let status = 'Open';
  if (episode.sellDate) status = 'Closed (Sell)';
  else if (episode.downgradeDate) status = 'Closed (Downgrade)';
  return { hasMark, isClosed, status };
}

export function ratingSlug(rating) {
  if (rating === 'Buy') return 'buy';
  if (rating === 'Hold') return 'hold';
  if (rating === 'Sell/Avoid') return 'sell';
  return 'unrated';
}

export function tierSlug(tier) {
  if (tier === 'Strong') return 'strong';
  if (tier === 'Neutral') return 'neutral';
  if (tier === 'Fading') return 'fading';
  return 'none';
}
