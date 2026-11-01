// Bradley–Terry fitting, bootstrap intervals, and comparison-graph helpers.
// Pure functions: no DOM, no Firebase. Shared by the browser and Node.

const ELO_SCALE = 400 / Math.LN10; // 173.7178

export function eloFromTheta(theta) {
  return 1500 + ELO_SCALE * theta;
}

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function isCounted(ballot) {
  return ballot && ballot.a && ballot.b && ballot.a !== ballot.b &&
    (ballot.winner === 'a' || ballot.winner === 'b' || ballot.winner === 'tie');
}

/**
 * Fit a Bradley–Terry model with a weak L2 prior (one pseudo-match at equal
 * strength) using the MM / Zermelo iteration.
 *
 * Ties count as half a win for each side. 'skip' ballots are ignored.
 * Returns theta centred on zero plus observed tallies.
 */
export function fitBT(items, ballots, options = {}) {
  const ids = [...items];
  const index = new Map(ids.map((id, i) => [id, i]));
  const n = ids.length;
  const prior = options.prior ?? 1;
  const iterations = options.iterations ?? 500;
  const tol = options.tol ?? 1e-10;

  const decisiveWins = new Float64Array(n);
  const ties = new Float64Array(n);
  const losses = new Float64Array(n);
  const matches = new Float64Array(n);
  const pairCounts = new Map();
  const adj = Array.from({ length: n }, () => []);

  for (const b of ballots) {
    if (!isCounted(b)) continue;
    const i = index.get(b.a);
    const j = index.get(b.b);
    if (i == null || j == null || i === j) continue;

    matches[i] += 1;
    matches[j] += 1;
    if (b.winner === 'a') { decisiveWins[i] += 1; losses[j] += 1; }
    else if (b.winner === 'b') { decisiveWins[j] += 1; losses[i] += 1; }
    else { ties[i] += 1; ties[j] += 1; }

    const key = i < j ? i * n + j : j * n + i;
    pairCounts.set(key, (pairCounts.get(key) || 0) + 1);
  }

  for (const [key, count] of pairCounts) {
    const i = Math.floor(key / n);
    const j = key % n;
    adj[i].push([j, count]);
    adj[j].push([i, count]);
  }

  // Strength parameters, p_i > 0. theta_i = ln p_i.
  const p = new Float64Array(n).fill(1);
  let iter = 0;
  for (; iter < iterations; iter++) {
    const next = new Float64Array(n);
    let maxChange = 0;
    for (let i = 0; i < n; i++) {
      // Prior: half a win in `prior` pseudo-games against an equal opponent.
      const wins = 0.5 * prior + decisiveWins[i] + 0.5 * ties[i];
      let denom = prior / (p[i] + 1);
      for (const [j, c] of adj[i]) denom += c / (p[i] + p[j]);
      const value = denom > 0 ? wins / denom : 1;
      next[i] = value;
      maxChange = Math.max(maxChange, Math.abs(value - p[i]) / Math.max(p[i], 1e-300));
    }

    // Fix the scale: geometric mean = 1.
    let logSum = 0;
    for (let i = 0; i < n; i++) logSum += Math.log(Math.max(next[i], 1e-300));
    const gm = Math.exp(logSum / n);
    for (let i = 0; i < n; i++) next[i] /= gm;
    for (let i = 0; i < n; i++) p[i] = next[i];
    if (maxChange < tol) { iter += 1; break; }
  }

  const theta = new Float64Array(n);
  let mean = 0;
  for (let i = 0; i < n; i++) {
    theta[i] = Math.log(Math.max(p[i], 1e-300));
    mean += theta[i];
  }
  mean /= n || 1;
  for (let i = 0; i < n; i++) theta[i] -= mean;

  return { items: ids, theta, decisiveWins, ties, losses, matches, iterations: iter };
}

/**
 * Resample ballots and refit. Returns per-item bootstrap theta samples and
 * P(item is #1 among items with at least one match in that replicate).
 */
export function bootstrapBT(items, ballots, reps = 300, seed = 20261101) {
  const valid = ballots.filter(isCounted);
  const n = items.length;
  const samples = [];
  const pTop = new Float64Array(n);
  if (!valid.length) return { samples, pTop, reps: 0 };

  const rng = mulberry32(seed);
  for (let r = 0; r < reps; r++) {
    const draw = new Array(valid.length);
    for (let k = 0; k < valid.length; k++) {
      draw[k] = valid[Math.floor(rng() * valid.length)];
    }
    const fit = fitBT(items, draw, { iterations: 220, tol: 1e-7 });
    samples.push(fit.theta);

    let best = -Infinity;
    let bestIndex = -1;
    for (let i = 0; i < n; i++) {
      if (fit.matches[i] > 0 && fit.theta[i] > best) {
        best = fit.theta[i];
        bestIndex = i;
      }
    }
    if (bestIndex >= 0) pTop[bestIndex] += 1;
  }
  for (let i = 0; i < n; i++) pTop[i] /= reps;
  return { samples, pTop, reps };
}

export function estimateSummary(items, fit, boot) {
  return items.map((id, i) => {
    const values = boot.samples.map((s) => s[i]).filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
    const low = values.length ? percentile(values, 0.025) : null;
    const high = values.length ? percentile(values, 0.975) : null;
    return {
      id,
      theta: fit.theta[i],
      rating: eloFromTheta(fit.theta[i]),
      ciLow: low == null ? null : eloFromTheta(low),
      ciHigh: high == null ? null : eloFromTheta(high),
      pTop: boot.pTop[i] || 0,
      matches: fit.matches[i],
      wins: fit.decisiveWins[i],
      losses: fit.losses[i],
      ties: fit.ties[i],
      winRate: fit.matches[i] ? (fit.decisiveWins[i] + 0.5 * fit.ties[i]) / fit.matches[i] : null,
    };
  });
}

export function percentile(sorted, q) {
  if (!sorted.length) return null;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

/** Map ballots between submissions onto families, dropping same-family pairs. */
export function familyBallots(ballots, familyById) {
  const out = [];
  for (const b of ballots) {
    const fa = familyById.get(b.a);
    const fb = familyById.get(b.b);
    if (!fa || !fb || fa === fb) continue;
    out.push({ a: fa, b: fb, winner: b.winner });
  }
  return out;
}

export function connectedComponents(items, ballots) {
  const index = new Map(items.map((id, i) => [id, i]));
  const adj = Array.from({ length: items.length }, () => new Set());
  for (const b of ballots) {
    if (!isCounted(b)) continue;
    const i = index.get(b.a);
    const j = index.get(b.b);
    if (i == null || j == null || i === j) continue;
    adj[i].add(j);
    adj[j].add(i);
  }
  const seen = new Uint8Array(items.length);
  const comps = [];
  for (let start = 0; start < items.length; start++) {
    if (seen[start]) continue;
    const comp = [];
    const stack = [start];
    seen[start] = 1;
    while (stack.length) {
      const i = stack.pop();
      comp.push(items[i]);
      for (const j of adj[i]) {
        if (!seen[j]) { seen[j] = 1; stack.push(j); }
      }
    }
    comps.push(comp);
  }
  return comps.sort((a, b) => b.length - a.length);
}

export function tally(ballots) {
  const per = new Map();
  const ensure = (id) => {
    if (!per.has(id)) per.set(id, { matches: 0, wins: 0, losses: 0, ties: 0 });
    return per.get(id);
  };
  let ties = 0;
  let skips = 0;
  let quick = 0;
  let broken = 0;
  let minTime = null;
  let maxTime = null;
  const voters = new Set();
  const pairs = new Set();
  let total = 0;

  for (const b of ballots) {
    total += 1;
    if (b.voter) voters.add(b.voter);
    if (b.pairKey) pairs.add(b.pairKey);
    if (b.winner === 'skip') { skips += 1; }
    if (b.broken) broken += 1;
    if (Number.isFinite(b.dwellMs) && b.dwellMs < 3000) quick += 1;
    if (Number.isFinite(b.createdAtMs)) {
      if (minTime == null || b.createdAtMs < minTime) minTime = b.createdAtMs;
      if (maxTime == null || b.createdAtMs > maxTime) maxTime = b.createdAtMs;
    }
    if (!isCounted(b)) continue;
    const a = ensure(b.a);
    const c = ensure(b.b);
    a.matches += 1;
    c.matches += 1;
    if (b.winner === 'a') { a.wins += 1; c.losses += 1; }
    else if (b.winner === 'b') { c.wins += 1; a.losses += 1; }
    else { ties += 1; a.ties += 1; c.ties += 1; }
  }
  return { total, voters: voters.size, pairs: pairs.size, ties, skips, quick, broken, minTime, maxTime, per };
}
