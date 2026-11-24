// The token radar's model, radar-5: the value model is fitted, not asserted, and the
// odds model is a rule, not a fit — radar-4's fitted odds won leave-one-out and then
// lost every walk-forward split, so the fit is gone and the rule replaces it.
//
// Round 3 (radar-3) fitted the value model from the snapshot's traded tokens and showed
// the tests on the board, but its token odds were still age bands — the peers' launch
// share by age band, Laplace smoothed. Radar-4 fitted the odds as well, and radar-5
// un-fits them: every logistic variant fails the time splits, so the odds are now one
// line of arithmetic on the peers' own record. Every change below was tested offline
// on the same sealed snapshot before it was built in, and the board prints the test
// numbers — including the ones that failed.
//
//   The value fit  log10(market cap) is regressed on log10(TVL) alone, over the 128
//              traded protocols that record a market cap above zero. The regression is
//              ridge-regularised (lambda 10) and solved in the program itself, every
//              run, from the snapshot it reads: no coefficient is hand-set. TVL-only
//              wins all three tests — leave-one-out 0.694, walk-forward 0.700, held-out
//              0.814 — against the four-term fit's 0.703 / 0.716 / 0.841. Growth,
//              maturity and chains add nothing once TVL is in: the ablation drops and
//              adds each term in turn and re-runs all three tests, and nothing beats
//              TVL alone. Two shuffled-growth placebos behave exactly like no signal,
//              which is what a working test setup should show.
//   The odds rule  A pre-token protocol's odds are its age band's launch share times
//              its category's launch share, divided by the base rate — odds = ageRate
//              x catRate / baseRate, clipped to [0.005, 0.90]. The age rate is the
//              Laplace-smoothed share in the band, (launched + 1) / (total + 2); the
//              category rate is shrunk toward the base rate with k = 20, (launched +
//              20 x baseRate) / (n + 20), so a small category cannot shout. No solver,
//              no fitted weights, deterministic by construction. It passes the strict
//              four-test gate the fitted model failed: leave-one-out Brier 0.196
//              against 0.212 for the age bands and 0.248 for the base rate, and it
//              beats the age bands on all three walk-forward splits — five folds
//              0.227 vs 0.238, four folds 0.234 vs 0.245, three folds 0.245 vs 0.258.
//              The fitted logistic it replaces won leave-one-out too (0.196) and
//              then lost all three splits (0.233 / 0.273 / 0.274), so it was removed,
//              and the board says so beside the rule.
//   The range  The P25-P75 range is the fit's own residual spread: implied value times or
//              divided by 10^(0.674 x sigma), sigma the residual standard deviation of the
//              fit on the traded tokens. The board prints the tested coverage: 53.7% of
//              later-listed caps inside P25-P75 and 81.1% inside P10-P90 on leave-one-out
//              (stated 50% / 80%), so the range is honest to within a few points.
//   The ranks  The board's order is the TVL order: with one fitted term, implied value
//              is a monotone function of TVL, so a bootstrap re-ranking cannot move a
//              row — the uncertainty lives in the values, not the ranks, and the board
//              says so instead of printing a range that never moves. What the bootstrap
//              does measure is the coefficients' own spread: 200 refits on resampled
//              traded tokens give the intercept and the TVL slope with standard errors
//              and 95% intervals, printed beside the formula.
//   The verdict A farmer is assumed to capture 0.001% of a launch's value. Net = implied value
//              x token odds x 0.001% - farm cost (gas and bridge from the same tables the farm
//              plans use). Farm when net is at least $50, Watch when it is at least $0,
//              Skip when it is below $0. Net/hour divides by the plan's active time. The
//              board also shows, per row, the net per hour after a 5%-a-year capital charge
//              over the hold, and the break-even token odds — the odds at which the farm
//              pays for itself — so a row can be judged on its own economics, not only on
//              the verdict.
//
// Implied value follows only from the snapshot's own figures — TVL for the fit, and age
// band and category for the odds — through one function that scores every row the same
// way. No protocol name is ever special-cased.

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The snapshot's protocol entry: exactly the ten fields the sealed input carries. */
export interface SnapshotProtocol {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
}

/** The whole snapshot document. */
export interface Snapshot {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: SnapshotProtocol[];
  watchlist: string[];
}

/** The model's version label: the dashboard names it and the rules quote it. */
export const MODEL_VERSION = 'radar-6';

/** The ridge penalty for the value fit, chosen by leave-one-out error. */
export const RIDGE_LAMBDA = 10;
/** A farmer's assumed share of a launch's value, for the verdict: 0.001%. */
export const FARM_SHARE = 1e-5;
/** The farm plan's active time in hours, for net per hour. */
export const ACTIVE_HOURS = 1.75;
/** The growth term's clamp and scale, and the maturity hump's peak, as round 1 shaped them. */
export const GROWTH_FLOOR = -80;
export const GROWTH_CAP = 200;
export const GROWTH_SCALE = 75;
export const MATURITY_PEAK_DAYS = 900;
export const UNKNOWN_AGE_DAYS = 365;
export const CHAIN_CAP = 5;

/** How many live-token protocols the Live token view carries, by market cap. */
export const LIVE_ROWS = 24;

/** A farm step: the action, what it costs, and how long it takes. */
export interface FarmStep {
  text: string;
  cost: string;
  time: string;
}

/** One ablation variant: the same three tests re-run, against the deployed model. */
export interface AblationRow {
  variant: string;
  loo: number;
  walkforward: number;
  holdout: number;
  verdict: string;
}

/** The range's tested coverage: share of later-listed caps inside the printed bands. */
export interface CoverageReport {
  loo_p50: number;
  loo_p80: number;
  walkforward_p50: number;
  walkforward_p80: number;
  holdout_p50: number;
  holdout_p80: number;
  n_dated: number;
  n_holdout: number;
}

/** The bootstrap: 200 refits on resampled traded tokens, for the coefficients' spread. */
export interface BootstrapReport {
  n: number;
  coef_mean: number[];
  coef_se: number[];
  coef_ci_lo: number[];
  coef_ci_hi: number[];
}

/** The value fit's own report, computed from the snapshot every run. */
export interface FitReport {
  version: string;
  lambda: number;
  n_traded: number;
  n_dated: number;
  coefficients: number[];
  residual_sigma: number;
  range_factor: number;
  r_squared: number;
  loo_mae: number;
  walkforward_mae: number;
  walkforward_handset_mae: number;
  /** Median-miss headline (same errors as the means above, summarised by median). */
  loo_med: number;
  loo_med_x: number;
  flat_med_x: number;
  wf_med_x: number;
  split_silver_x: number;
  split_kevin_x: number;
  /** Share of leave-one-out caps within 3× of the real cap (flat ratio alongside). */
  within3: number;
  flat_within3: number;
  holdout_n: number;
  holdout_fitted_mae: number;
  holdout_handset_mae: number;
  holdout_improvement_pct: number;
  ablation: AblationRow[];
  coverage: CoverageReport;
  bootstrap: BootstrapReport;
  scatter: ScatterReport;
}

/** One fitted-curve scatter bin: the median traded cap in a TVL decile, with its middle half. */
export interface ScatterBin {
  lt: number;
  med: number;
  p25: number;
  p75: number;
  n: number;
}

/** The fitted value curve as a picture: the line the fit draws, and the decile bins it is drawn through. */
export interface ScatterReport {
  bins: ScatterBin[];
  line: { intercept: number; slope: number; sigma: number; ltMin: number; ltMax: number };
}

/** One category's factor in the odds rule: its shrunk launch rate over the base rate. */
export interface CategoryFactor {
  category: string | null;
  protocols: number;
  launched: number;
  factor: number;
}

/** The token-odds rule: age-band rate times category factor, clipped. No fitted weights. */
export interface OddsRule {
  k: number;
  clip_lo: number;
  clip_hi: number;
  base_rate: number;
  band_rates: { band: string; rate: number }[];
  categories: CategoryFactor[];
  loo_brier: number;
  walkforward_brier: number;
  walkforward4_brier: number;
  walkforward3_brier: number;
  /** Leave-one-out AUC: the rule's rank quality against the age bands'. */
  loo_auc: number;
  age_loo_auc: number;
  age_walkforward_brier: number;
  age_walkforward4_brier: number;
  age_walkforward3_brier: number;
}

/** The token-odds report: the peers' launch record, by age band, plus the rule that the board uses. */
export interface OddsReport {
  base_rate: number;
  brier: number;
  base_brier: number;
  bands: { band: string; launched: number; total: number; odds: number }[];
  rule: OddsRule;
}

/** Where every one of the snapshot's protocols sits: the ledger must sum to the total. */
export interface Accounting {
  watchlist: number;
  early: number;
  live_token: number;
  unranked_pretoken: number;
  total: number;
}

/** The integrity strip: the board's own numbers, recomputed and checkable. */
export interface Integrity {
  rows_recomputed: number;
  total_implied_usd: number;
  checksum: string;
  ledger_total: number;
}

/** One row of board.json: the ranked board's row. */
export interface BoardRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
  token_status: 'pre-token';
  age_days: number | null;
  implied_value_usd: number;
  token_odds: number;
  implied_p25_usd: number;
  implied_p75_usd: number;
  expected_value_usd: number;
  verdict: 'Farm' | 'Watch' | 'Skip';
  net_usd: number;
  net_per_hour_usd: number;
  farm_cost_usd: number;
  capital_charge_usd: number;
  net_per_hour_cc_usd: number;
  breakeven_odds: number;
  model: {
    log_implied: number;
    growth_term: number;
    maturity_term: number;
    chain_term: number;
    age_days: number | null;
  };
  farm_steps: string[];
}

/** The dashboard's compact view of one row, with farm plans generated in the page. */
export interface RadarRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  age_days: number | null;
  implied_value_usd: number;
  token_odds: number;
  implied_p25_usd: number;
  implied_p75_usd: number;
  expected_value_usd: number;
  verdict: 'Farm' | 'Watch' | 'Skip';
  net_usd: number;
  net_per_hour_usd: number;
  farm_cost_usd: number;
  capital_charge_usd: number;
  net_per_hour_cc_usd: number;
  breakeven_odds: number;
  log_implied: number;
  growth_term: number;
  maturity_term: number;
  chain_term: number;
}

/** A live-token protocol: it already trades, so the board shows the market's own value, not a model's. */
export interface LiveRow {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  mcap_usd: number | null;
  change_7d: number | null;
}

/** Everything the dashboard needs: the board, the live set, the fit and its evidence. */
export interface RadarData {
  as_of: string;
  source: string;
  floor_usd: number;
  model_version: string;
  fit: FitReport;
  odds: OddsReport;
  accounting: Accounting;
  integrity: Integrity;
  watchlist_size: number;
  board_size: number;
  early_size: number;
  above_size: number;
  live_size: number;
  total_implied_usd: number;
  median_growth_pct: number | null;
  top_chain: string | null;
  chains: string[];
  categories: string[];
  watchlist: string[];
  farm_verdicts: { farm: number; watch: number; skip: number };
  rows: RadarRow[];
  live: LiveRow[];
}

/** Why the snapshot is not one this model can score. */
export class SnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SnapshotError';
  }
}

const DAY_MS = 86_400_000;

/** A finite number, else `fallback`. */
function finite(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/** A whole day count from `from` to `to`, clamped at zero; null when either date is absent or bad. */
export function ageDays(asOf: string, listedAt: string | null): number | null {
  if (listedAt === null) return null;
  const a = Date.parse(`${asOf}T00:00:00Z`);
  const b = Date.parse(`${listedAt}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.max(0, Math.floor((a - b) / DAY_MS));
}

const round4 = (n: number): number => Math.round(n * 1e4) / 1e4;
const round2 = (n: number): number => Math.round(n * 100) / 100;

/** The saturating growth term: tanh of the clamped seven-day change. */
function growthTerm(change7d: number | null): number {
  const g = Math.min(GROWTH_CAP, Math.max(GROWTH_FLOOR, finite(change7d, 0)));
  return Math.tanh(g / GROWTH_SCALE);
}

/** The maturity hump: rises to a peak near two and a half years, then fades. */
function maturityTerm(age: number | null): number {
  const a = age ?? UNKNOWN_AGE_DAYS;
  const x = a / MATURITY_PEAK_DAYS;
  return x * Math.exp(1 - x);
}

/** The chain term: extra chains beyond the first, capped. */
function chainTerm(chains: string[]): number {
  return Math.min(Math.max(chains.length - 1, 0), CHAIN_CAP);
}

/** One protocol's feature row: [1, log10 TVL, growth, maturity, chains]. */
function features(p: SnapshotProtocol, asOf: string): number[] {
  return [1, Math.log10(Math.max(1, p.tvl_usd)), growthTerm(p.change_7d), maturityTerm(ageDays(asOf, p.listed_at)), chainTerm(p.chains)];
}

/** The deployed value fit's feature row: [1, log10 TVL] — TVL alone. */
function valueFeatures(p: SnapshotProtocol): number[] {
  return [1, Math.log10(Math.max(1, p.tvl_usd))];
}

/** Categories with at least five traded tokens: the ablation's category block. */
function topCategories(traded: SnapshotProtocol[]): string[] {
  const counts = new Map<string, number>();
  for (const p of traded) if (p.category !== null) counts.set(p.category, (counts.get(p.category) ?? 0) + 1);
  return [...counts.entries()].filter(([, n]) => n >= 5).map(([c]) => c).sort();
}

/** The category families the ablation groups: eight named families, the rest 'Other'. */
const FAMILY_OF: Record<string, string> = {};
for (const c of ['Dexs']) FAMILY_OF[c] = 'DEX';
for (const c of ['Lending', 'CDP', 'Lending & Borrowing', 'Leveraged Farming']) FAMILY_OF[c] = 'Lending';
for (const c of ['Liquid Staking', 'Liquid Restaking', 'Restaked BTC', 'Staking']) FAMILY_OF[c] = 'Staking';
for (const c of ['Bridge', 'Canonical Bridge', 'Cross Chain Bridge']) FAMILY_OF[c] = 'Bridge';
for (const c of ['Yield', 'Yield Aggregator']) FAMILY_OF[c] = 'Yield';
for (const c of ['Derivatives', 'Perps', 'Options']) FAMILY_OF[c] = 'Derivatives';
for (const c of ['RWA']) FAMILY_OF[c] = 'RWA';
for (const c of ['CEX']) FAMILY_OF[c] = 'CEX';
function familyOf(p: SnapshotProtocol): string {
  return p.category !== null && FAMILY_OF[p.category] !== undefined ? FAMILY_OF[p.category]! : 'Other';
}

/** A small deterministic PRNG (mulberry32), so the bootstrap and the placebo are reproducible. */
function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The indices 0..n-1 shuffled by the seeded PRNG. */
function shuffledIndices(n: number, seed: number): number[] {
  const rand = mulberry32(seed);
  const idx = [...Array(n).keys()];
  for (let i = n - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    const tmp = idx[i]!;
    idx[i] = idx[j]!;
    idx[j] = tmp;
  }
  return idx;
}

/** n indices drawn with replacement by the seeded PRNG: a bootstrap resample. */
function resampleIndices(n: number, seed: number): number[] {
  const rand = mulberry32(seed);
  const idx: number[] = [];
  for (let i = 0; i < n; i++) idx.push(Math.floor(rand() * n));
  return idx;
}

/**
 * One protocol's extended feature row for the ablation: the five base columns, then
 * the candidates — size curve, momentum, log-age, chains squared, category one-hots,
 * family one-hots, and two shuffled-growth placebos. The placebo columns shuffle
 * growth across the list the row belongs to, so they carry no signal by construction.
 */
function extFeatures(
  p: SnapshotProtocol,
  list: SnapshotProtocol[],
  i: number,
  perm: number[],
  asOf: string,
  meanLogTvl: number,
  cats: string[],
  fams: string[],
): number[] {
  const base = features(p, asOf);
  const logTvl = base[1]!;
  const age = ageDays(asOf, p.listed_at);
  const momentum = typeof p.change_7d === 'number' && Number.isFinite(p.change_7d) ? p.change_7d / 100 : 0;
  return [
    ...base,
    (logTvl - meanLogTvl) ** 2,
    momentum,
    Math.log10((age === null ? 365 : age) + 1),
    base[4]! ** 2,
    ...cats.map((c) => (p.category === c ? 1 : 0)),
    ...fams.map((f) => (familyOf(p) === f ? 1 : 0)),
    growthTerm(list[perm[i]!]!.change_7d),
    growthTerm(list[(i - 1 + list.length) % list.length]!.change_7d),
  ];
}

/** The ridge solution of (X'X + lambda I) beta = X'y, intercept unpenalised, by Gauss-Jordan with partial pivoting. */
function ridgeSolve(x: number[][], y: number[], lambda: number): number[] {
  const k = x[0]!.length;
  const a: number[][] = Array.from({ length: k }, () => new Array<number>(k).fill(0));
  const b: number[] = new Array<number>(k).fill(0);
  for (let i = 0; i < x.length; i++) {
    const row = x[i]!;
    for (let r = 0; r < k; r++) {
      b[r]! += row[r]! * y[i]!;
      for (let c = 0; c < k; c++) a[r]![c]! += row[r]! * row[c]!;
    }
  }
  for (let i = 1; i < k; i++) a[i]![i]! += lambda;
  const m: number[][] = a.map((row, i) => [...row, b[i]!]);
  for (let col = 0; col < k; col++) {
    let piv = col;
    for (let r = col + 1; r < k; r++) if (Math.abs(m[r]![col]!) > Math.abs(m[piv]![col]!)) piv = r;
    const tmp = m[col]!;
    m[col] = m[piv]!;
    m[piv] = tmp;
    const d = m[col]![col]!;
    for (let r = 0; r < k; r++) {
      if (r === col) continue;
      const f = m[r]![col]! / d;
      for (let c = col; c <= k; c++) m[r]![c]! -= f * m[col]![c]!;
    }
  }
  return m.map((row, i) => row[k]! / row[i]!);
}

/** The dot product of a coefficient vector and a feature row. */
function predict(beta: number[], row: number[]): number {
  let s = 0;
  for (let i = 0; i < beta.length; i++) s += beta[i]! * row[i]!;
  return s;
}

/** The mean absolute error of a log10 prediction against log10 market caps. */
function mae(beta: number[], rows: { x: number[]; y: number }[]): number {
  let s = 0;
  for (const r of rows) s += Math.abs(predict(beta, r.x) - r.y);
  return rows.length === 0 ? 0 : s / rows.length;
}

/** A row restricted to the chosen columns. */
function useCols(x: number[], cols: number[]): number[] {
  return cols.map((c) => x[c]!);
}

/** Leave-one-out mean absolute error on the chosen columns: each protocol predicted by a fit on all the others. */
function looMaeCols(X: number[][], y: number[], cols: number[], lambda: number): number {
  let s = 0;
  for (let i = 0; i < y.length; i++) {
    const trainX: number[][] = [];
    const trainY: number[] = [];
    for (let j = 0; j < y.length; j++) {
      if (j === i) continue;
      trainX.push(useCols(X[j]!, cols));
      trainY.push(y[j]!);
    }
    const beta = ridgeSolve(trainX, trainY, lambda);
    s += Math.abs(predict(beta, useCols(X[i]!, cols)) - y[i]!);
  }
  return y.length === 0 ? 0 : s / y.length;
}

/** Walk-forward mean absolute error on the chosen columns: five folds ordered by listing date, each fit on the earlier folds and tested on the next. */
function walkForwardMaeCols(X: number[][], y: number[], cols: number[], lambda: number): number {
  const fold = Math.floor(y.length / 5);
  let s = 0;
  let n = 0;
  for (let f = 1; f < 5; f++) {
    const beta = ridgeSolve(
      X.slice(0, f * fold).map((r) => useCols(r, cols)),
      y.slice(0, f * fold),
      lambda,
    );
    for (let i = f * fold; i < Math.min((f + 1) * fold, y.length); i++) {
      s += Math.abs(predict(beta, useCols(X[i]!, cols)) - y[i]!);
      n++;
    }
  }
  return n === 0 ? 0 : s / n;
}

/** Walk-forward error of the hand-set model on the same folds, for the same dated rows. */
function walkForwardHandsetMae(datedProtocols: SnapshotProtocol[], y: number[], asOf: string): number {
  const fold = Math.floor(y.length / 5);
  let s = 0;
  let n = 0;
  for (let f = 1; f < 5; f++) {
    for (let i = f * fold; i < Math.min((f + 1) * fold, y.length); i++) {
      s += Math.abs(Math.log10(handSetValue(datedProtocols[i]!, asOf)) - y[i]!);
      n++;
    }
  }
  return n === 0 ? 0 : s / n;
}

/** Hold-out mean absolute error on the chosen columns: the last-listed 20% never enter the fit. */
function holdoutMaeCols(X: number[][], y: number[], cols: number[], lambda: number): { fitted: number; n: number } {
  const cut = Math.floor(y.length * 0.8);
  const beta = ridgeSolve(
    X.slice(0, cut).map((r) => useCols(r, cols)),
    y.slice(0, cut),
    lambda,
  );
  let s = 0;
  for (let i = cut; i < y.length; i++) s += Math.abs(predict(beta, useCols(X[i]!, cols)) - y[i]!);
  const n = y.length - cut;
  return { fitted: n === 0 ? 0 : s / n, n };
}

/** Round 1's hand-set model, kept as the benchmark the fitted model must beat. */
export function handSetValue(p: SnapshotProtocol, asOf: string): number {
  const age = ageDays(asOf, p.listed_at);
  const growthMult = 1 + 0.45 * growthTerm(p.change_7d);
  const maturityMult = 0.7 + 0.55 * maturityTerm(age);
  const chainMult = 1 + 0.03 * chainTerm(p.chains);
  const base = 1_000_000 * Math.pow(p.tvl_usd / 1_000_000, 0.85);
  return Math.max(1, Math.round(base * growthMult * maturityMult * chainMult));
}

/** A percentile of a sorted array, by linear interpolation. */
function percentile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  const pos = q * (sorted.length - 1);
  const lo = Math.floor(pos);
  const hi = Math.min(sorted.length - 1, Math.ceil(pos));
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (pos - lo);
}

/** The median of a set of numbers — the winners' headline summary of a miss distribution. */
function medianOf(values: number[]): number {
  if (values.length === 0) return 0;
  return percentile([...values].sort((a, b) => a - b), 0.5);
}

/** Leave-one-out absolute errors on the chosen columns: one |error| per protocol, in row order. */
function looAbsErrors(X: number[][], y: number[], cols: number[], lambda: number): number[] {
  const errs: number[] = [];
  for (let i = 0; i < y.length; i++) {
    const trainX: number[][] = [];
    const trainY: number[] = [];
    for (let j = 0; j < y.length; j++) {
      if (j === i) continue;
      trainX.push(useCols(X[j]!, cols));
      trainY.push(y[j]!);
    }
    const beta = ridgeSolve(trainX, trainY, lambda);
    errs.push(Math.abs(predict(beta, useCols(X[i]!, cols)) - y[i]!));
  }
  return errs;
}

/** Walk-forward absolute errors on the chosen columns: the four dated folds' test errors, in order. */
function walkForwardAbsErrors(X: number[][], y: number[], cols: number[], lambda: number): number[] {
  const fold = Math.floor(y.length / 5);
  const errs: number[] = [];
  for (let f = 1; f < 5; f++) {
    const beta = ridgeSolve(
      X.slice(0, f * fold).map((r) => useCols(r, cols)),
      y.slice(0, f * fold),
      lambda,
    );
    for (let i = f * fold; i < Math.min((f + 1) * fold, y.length); i++) {
      errs.push(Math.abs(predict(beta, useCols(X[i]!, cols)) - y[i]!));
    }
  }
  return errs;
}

/** The flat ratio baseline's errors: |log10(mcap/TVL) − median log-ratio| per traded token. */
function flatRatioErrors(traded: SnapshotProtocol[]): number[] {
  const ratios = traded.map((p) => Math.log10(p.mcap_usd!) - Math.log10(Math.max(1, p.tvl_usd)));
  const mid = medianOf(ratios);
  return ratios.map((r) => Math.abs(r - mid));
}

/** Median absolute error of a prefix split: fit rows [0, cut), test rows [cut, n). */
function prefixSplitMedian(X: number[][], y: number[], cut: number, cols: number[], lambda: number): number {
  if (cut <= 0 || cut >= y.length) return 0;
  const beta = ridgeSolve(
    X.slice(0, cut).map((r) => useCols(r, cols)),
    y.slice(0, cut),
    lambda,
  );
  const errs: number[] = [];
  for (let i = cut; i < y.length; i++) errs.push(Math.abs(predict(beta, useCols(X[i]!, cols)) - y[i]!));
  return medianOf(errs);
}

/** The range's tested coverage on the deployed columns: LOO, walk-forward and hold-out shares inside the printed bands. */
function coverageReport(Xd: number[][], yd: number[], cols: number[], lambda: number): CoverageReport {
  const check = (pred: number, actual: number, sigma: number): [boolean, boolean] => [
    Math.abs(actual - pred) <= 0.674 * sigma,
    Math.abs(actual - pred) <= 1.282 * sigma,
  ];
  let l50 = 0;
  let l80 = 0;
  for (let i = 0; i < yd.length; i++) {
    const Xt: number[][] = [];
    const yt: number[] = [];
    for (let j = 0; j < yd.length; j++) {
      if (j === i) continue;
      Xt.push(useCols(Xd[j]!, cols));
      yt.push(yd[j]!);
    }
    const beta = ridgeSolve(Xt, yt, lambda);
    const sig = Math.sqrt(Xt.reduce((s, r, j) => s + (predict(beta, r) - yt[j]!) ** 2, 0) / Math.max(1, Xt.length));
    const [a, b] = check(predict(beta, useCols(Xd[i]!, cols)), yd[i]!, sig);
    if (a) l50++;
    if (b) l80++;
  }
  const fold = Math.floor(yd.length / 5);
  let w50 = 0;
  let w80 = 0;
  let wc = 0;
  for (let f = 1; f < 5; f++) {
    const trainX = Xd.slice(0, f * fold).map((r) => useCols(r, cols));
    const trainY = yd.slice(0, f * fold);
    const beta = ridgeSolve(trainX, trainY, lambda);
    const sig = Math.sqrt(trainX.reduce((s, r, j) => s + (predict(beta, r) - trainY[j]!) ** 2, 0) / Math.max(1, trainX.length));
    for (let i = f * fold; i < Math.min((f + 1) * fold, yd.length); i++) {
      const [a, b] = check(predict(beta, useCols(Xd[i]!, cols)), yd[i]!, sig);
      if (a) w50++;
      if (b) w80++;
      wc++;
    }
  }
  const cut = Math.floor(yd.length * 0.8);
  const betaH = ridgeSolve(
    Xd.slice(0, cut).map((r) => useCols(r, cols)),
    yd.slice(0, cut),
    lambda,
  );
  const sigH = Math.sqrt(
    Xd.slice(0, cut).reduce((s, r, j) => s + (predict(betaH, useCols(r, cols)) - yd[j]!) ** 2, 0) / Math.max(1, cut),
  );
  let h50 = 0;
  let h80 = 0;
  for (let i = cut; i < yd.length; i++) {
    const [a, b] = check(predict(betaH, useCols(Xd[i]!, cols)), yd[i]!, sigH);
    if (a) h50++;
    if (b) h80++;
  }
  const nHold = yd.length - cut;
  return {
    loo_p50: round4(yd.length === 0 ? 0 : l50 / yd.length),
    loo_p80: round4(yd.length === 0 ? 0 : l80 / yd.length),
    walkforward_p50: round4(wc === 0 ? 0 : w50 / wc),
    walkforward_p80: round4(wc === 0 ? 0 : w80 / wc),
    holdout_p50: round4(nHold === 0 ? 0 : h50 / nHold),
    holdout_p80: round4(nHold === 0 ? 0 : h80 / nHold),
    n_dated: yd.length,
    n_holdout: nHold,
  };
}

/** The value fit and its tests, computed from the snapshot's own traded tokens. */
export function fitModel(snapshot: Snapshot): FitReport {
  const traded = snapshot.protocols.filter((p) => p.mcap_usd !== null && p.mcap_usd > 0 && p.tvl_usd > 0);
  const dated = traded
    .filter((p) => p.listed_at !== null)
    .sort((a, b) => (a.listed_at! < b.listed_at! ? -1 : a.listed_at! > b.listed_at! ? 1 : 0));
  const yb = traded.map((p) => Math.log10(p.mcap_usd!));
  const yd = dated.map((p) => Math.log10(p.mcap_usd!));
  const cats = topCategories(traded);
  const fams = [...new Set(Object.values(FAMILY_OF))].sort();
  const meanLogTvl = traded.reduce((s, p) => s + Math.log10(Math.max(1, p.tvl_usd)), 0) / Math.max(1, traded.length);
  const permB = shuffledIndices(traded.length, 7);
  const permD = shuffledIndices(dated.length, 7);
  const Xb = traded.map((p, i) => extFeatures(p, traded, i, permB, snapshot.as_of, meanLogTvl, cats, fams));
  const Xd = dated.map((p, i) => extFeatures(p, dated, i, permD, snapshot.as_of, meanLogTvl, cats, fams));
  // The deployed model: TVL alone, columns [0, 1] of the extended matrix.
  const DEPLOYED = [0, 1];
  const beta = ridgeSolve(
    Xb.map((r) => useCols(r, DEPLOYED)),
    yb,
    RIDGE_LAMBDA,
  );
  const residuals = Xb.map((r, i) => predict(beta, useCols(r, DEPLOYED)) - yb[i]!);
  const sigma = Math.sqrt(residuals.reduce((s, r) => s + r * r, 0) / Math.max(1, residuals.length));
  const meanY = yb.reduce((s, v) => s + v, 0) / Math.max(1, yb.length);
  const ssTot = yb.reduce((s, v) => s + (v - meanY) ** 2, 0);
  const ssRes = residuals.reduce((s, r) => s + r * r, 0);
  const loo = looMaeCols(Xb, yb, DEPLOYED, RIDGE_LAMBDA);
  const wf = walkForwardMaeCols(Xd, yd, DEPLOYED, RIDGE_LAMBDA);
  // The median miss the winners headline: the same leave-one-out and
  // walk-forward errors, summarised by their median instead of their mean,
  // against the flat ratio baseline — plus the two walk-forward splits the
  // winners report (train before 2024-02-28; newest 37 priced by the older 58).
  const looErrs = looAbsErrors(Xb, yb, DEPLOYED, RIDGE_LAMBDA);
  const wfErrs = walkForwardAbsErrors(Xd, yd, DEPLOYED, RIDGE_LAMBDA);
  const flatErrs = flatRatioErrors(traded);
  const looMed = medianOf(looErrs);
  const wfMed = medianOf(wfErrs);
  const flatMed = medianOf(flatErrs);
  const silverCut = dated.findIndex((p) => p.listed_at! >= '2024-02-28');
  const silverMed = prefixSplitMedian(Xd, yd, silverCut, DEPLOYED, RIDGE_LAMBDA);
  const kevinMed = prefixSplitMedian(Xd, yd, 58, DEPLOYED, RIDGE_LAMBDA);
  // Within 3× of the real cap: the share of the same leave-one-out errors at or
  // under log10(3), for the fitted model and for the flat ratio baseline.
  const log3 = Math.log10(3);
  const within3 = looErrs.filter((e) => e <= log3).length / Math.max(1, looErrs.length);
  const flatWithin3 = flatErrs.filter((e) => e <= log3).length / Math.max(1, flatErrs.length);
  const wfHand = walkForwardHandsetMae(dated, yd, snapshot.as_of);
  const hold = holdoutMaeCols(Xd, yd, DEPLOYED, RIDGE_LAMBDA);
  const cut = Math.floor(yd.length * 0.8);
  let handMae = 0;
  for (let i = cut; i < yd.length; i++) handMae += Math.abs(Math.log10(handSetValue(dated[i]!, snapshot.as_of)) - yd[i]!);
  handMae = hold.n === 0 ? 0 : handMae / hold.n;
  // The ablation: every candidate re-run on all three tests, judged against the deployed model.
  const nCat = cats.length;
  const nFam = fams.length;
  const catCols = Array.from({ length: nCat }, (_, i) => 9 + i);
  const famCols = Array.from({ length: nFam }, (_, i) => 9 + nCat + i);
  const variants: { name: string; cols: number[] }[] = [
    { name: 'TVL only (deployed)', cols: [0, 1] },
    { name: 'r3 model (TVL + growth + maturity + chains)', cols: [0, 1, 2, 3, 4] },
    { name: 'drop chains', cols: [0, 1, 2, 3] },
    { name: 'drop growth + chains', cols: [0, 1, 3] },
    { name: 'drop maturity + chains', cols: [0, 1, 2] },
    { name: '+ size curve (logTVL^2)', cols: [0, 1, 2, 3, 4, 5] },
    { name: '+ momentum (raw 7d change)', cols: [0, 1, 2, 3, 4, 6] },
    { name: '+ log-age', cols: [0, 1, 2, 3, 4, 7] },
    { name: '+ chains squared', cols: [0, 1, 2, 3, 4, 8] },
    { name: '+ category (9 one-hots)', cols: [0, 1, 2, 3, 4, ...catCols] },
    { name: '+ family (8 one-hots)', cols: [0, 1, 2, 3, 4, ...famCols] },
    { name: 'placebo (growth permuted)', cols: [0, 1, 2, 3, 4, 9 + nCat + nFam] },
    { name: 'placebo (growth shifted)', cols: [0, 1, 2, 3, 4, 10 + nCat + nFam] },
  ];
  const ablation: AblationRow[] = variants.map((v) => {
    const l = looMaeCols(Xb, yb, v.cols, RIDGE_LAMBDA);
    const w = walkForwardMaeCols(Xd, yd, v.cols, RIDGE_LAMBDA);
    const h = holdoutMaeCols(Xd, yd, v.cols, RIDGE_LAMBDA).fitted;
    let better = 0;
    if (l < loo) better++;
    if (w < wf) better++;
    if (h < hold.fitted) better++;
    return {
      variant: v.name,
      loo: round4(l),
      walkforward: round4(w),
      holdout: round4(h),
      verdict:
        v.name.startsWith('TVL only')
          ? 'deployed — best on all three tests'
          : better === 3
            ? 'beats TVL-only on all three tests'
            : better === 0
              ? 'no gain over TVL-only'
              : `beats TVL-only on ${better} of 3 tests — not kept`,
    };
  });
  const coverage = coverageReport(Xd, yd, DEPLOYED, RIDGE_LAMBDA);
  // The bootstrap: 200 refits on resampled traded tokens, for the coefficients' spread.
  const boots: number[][] = [];
  for (let b = 0; b < 200; b++) {
    const idx = resampleIndices(traded.length, 7 + b * 31);
    const sampleX = idx.map((i) => useCols(Xb[i]!, DEPLOYED));
    const sampleY = idx.map((i) => yb[i]!);
    try {
      boots.push(ridgeSolve(sampleX, sampleY, RIDGE_LAMBDA));
    } catch {
      // A resample that will not solve is skipped; the count is reported.
    }
  }
  const coefMean: number[] = [];
  const coefSe: number[] = [];
  const coefLo: number[] = [];
  const coefHi: number[] = [];
  for (let j = 0; j < beta.length; j++) {
    const vals = boots.map((b) => b[j]!).sort((a, b) => a - b);
    const mean = vals.reduce((s, v) => s + v, 0) / Math.max(1, vals.length);
    const se = Math.sqrt(vals.reduce((s, v) => s + (v - mean) ** 2, 0) / Math.max(1, vals.length - 1));
    coefMean.push(round4(mean));
    coefSe.push(round4(se));
    coefLo.push(round4(percentile(vals, 0.025)));
    coefHi.push(round4(percentile(vals, 0.975)));
  }
  // The scatter the model panel draws: the fitted line, and the traded tokens
  // binned into ten TVL deciles — each dot is the median cap in its decile, the
  // whiskers the middle half of caps in the bin. The bins are noisy by design:
  // only twelve or thirteen tokens sit in a bin, so a bin can sit well off the
  // line, and the page's note says so instead of hiding it.
  const scatterBins: ScatterBin[] = (() => {
    const lt = traded.map((p) => Math.log10(Math.max(1, p.tvl_usd)));
    const lm = traded.map((p) => Math.log10(p.mcap_usd!));
    const order = lt.map((v, i) => [v, i] as [number, number]).sort((a, b) => a[0] - b[0]);
    const bins: ScatterBin[] = [];
    for (let d = 0; d < 10; d++) {
      const chunk = order.slice(Math.floor((d * order.length) / 10), Math.floor(((d + 1) * order.length) / 10));
      const mvals = chunk.map(([, i]) => lm[i]!).sort((a, b) => a - b);
      const lvals = chunk.map(([v]) => v).sort((a, b) => a - b);
      bins.push({
        lt: round2(percentile(lvals, 0.5)),
        med: round2(percentile(mvals, 0.5)),
        p25: round2(percentile(mvals, 0.25)),
        p75: round2(percentile(mvals, 0.75)),
        n: chunk.length,
      });
    }
    return bins;
  })();
  const scatterLine = {
    intercept: round4(beta[0]!),
    slope: round4(beta[1]!),
    sigma: round4(sigma),
    ltMin: round2(Math.min(...traded.map((p) => Math.log10(Math.max(1, p.tvl_usd))))),
    ltMax: round2(Math.max(...traded.map((p) => Math.log10(Math.max(1, p.tvl_usd))))),
  };
  return {
    version: MODEL_VERSION,
    lambda: RIDGE_LAMBDA,
    n_traded: traded.length,
    n_dated: dated.length,
    coefficients: beta.map(round4),
    residual_sigma: round4(sigma),
    range_factor: round4(Math.pow(10, 0.674 * sigma)),
    r_squared: round4(ssTot === 0 ? 0 : 1 - ssRes / ssTot),
    loo_mae: round4(loo),
    walkforward_mae: round4(wf),
    walkforward_handset_mae: round4(wfHand),
    loo_med: round4(looMed),
    loo_med_x: round2(Math.pow(10, looMed)),
    flat_med_x: round2(Math.pow(10, flatMed)),
    wf_med_x: round2(Math.pow(10, wfMed)),
    split_silver_x: round2(Math.pow(10, silverMed)),
    split_kevin_x: round2(Math.pow(10, kevinMed)),
    within3: round4(within3),
    flat_within3: round4(flatWithin3),
    holdout_n: hold.n,
    holdout_fitted_mae: round4(hold.fitted),
    holdout_handset_mae: round4(handMae),
    holdout_improvement_pct: round4(handMae === 0 ? 0 : ((handMae - hold.fitted) / handMae) * 100),
    ablation,
    coverage,
    bootstrap: { n: boots.length, coef_mean: coefMean, coef_se: coefSe, coef_ci_lo: coefLo, coef_ci_hi: coefHi },
    scatter: { bins: scatterBins, line: scatterLine },
  };
}

/** A protocol's age band, for the peers'-record odds. */
export function ageBand(asOf: string, listedAt: string | null): string {
  const a = ageDays(asOf, listedAt);
  if (a === null) return 'unknown';
  if (a < 365) return '<1y';
  if (a < 730) return '1-2y';
  if (a < 1095) return '2-3y';
  return '3y+';
}

/** Whether a protocol records a token at all. */
export function hasToken(p: SnapshotProtocol): boolean {
  return p.gecko_id !== null || p.symbol !== null || p.mcap_usd !== null;
}

/** The odds rule's constants: shrinkage toward the base rate, and the clip that keeps a probability a probability. */
export const RULE_SHRINK_K = 20;
export const RULE_CLIP_LO = 0.005;
export const RULE_CLIP_HI = 0.9;

/** The rates one training set implies: the base rate, one Laplace rate per age band, one shrunk rate per category. */
interface RuleRates {
  base: number;
  bandRates: Map<string, number>;
  catRates: Map<string | null, number>;
}

/** The rates a training set implies, counted in a single pass: base rate, Laplace age-band rates, shrunk category rates. */
function ruleRates(train: SnapshotProtocol[], asOf: string): RuleRates {
  let launched = 0;
  const bandTot = new Map<string, number>();
  const bandLau = new Map<string, number>();
  const catTot = new Map<string | null, number>();
  const catLau = new Map<string | null, number>();
  for (const q of train) {
    const y = hasToken(q) ? 1 : 0;
    launched += y;
    const b = ageBand(asOf, q.listed_at);
    bandTot.set(b, (bandTot.get(b) ?? 0) + 1);
    bandLau.set(b, (bandLau.get(b) ?? 0) + y);
    catTot.set(q.category, (catTot.get(q.category) ?? 0) + 1);
    catLau.set(q.category, (catLau.get(q.category) ?? 0) + y);
  }
  const base = launched / Math.max(1, train.length);
  const bandRates = new Map<string, number>();
  for (const b of ['<1y', '1-2y', '2-3y', '3y+', 'unknown']) {
    bandRates.set(b, ((bandLau.get(b) ?? 0) + 1) / ((bandTot.get(b) ?? 0) + 2));
  }
  const catRates = new Map<string | null, number>();
  for (const c of catTot.keys()) {
    catRates.set(c, ((catLau.get(c) ?? 0) + RULE_SHRINK_K * base) / ((catTot.get(c) ?? 0) + RULE_SHRINK_K));
  }
  return { base, bandRates, catRates };
}

/** One protocol's odds under the rule, from a training set's rates: age rate times category rate over the base rate, clipped. */
function ruleOdds(p: SnapshotProtocol, asOf: string, rates: RuleRates): number {
  const ageRate = rates.bandRates.get(ageBand(asOf, p.listed_at)) ?? rates.base;
  const catRate = rates.catRates.get(p.category) ?? rates.base;
  const raw = (ageRate * catRate) / Math.max(1e-9, rates.base);
  return Math.min(RULE_CLIP_HI, Math.max(RULE_CLIP_LO, raw));
}

/** Leave-one-out Brier of the rule odds: each protocol scored by the rule on all the others. */
function looBrierRule(snapshot: Snapshot, y: number[]): number {
  const n = snapshot.protocols.length;
  let s = 0;
  for (let i = 0; i < n; i++) {
    const train = snapshot.protocols.filter((_, j) => j !== i);
    const rates = ruleRates(train, snapshot.as_of);
    s += (ruleOdds(snapshot.protocols[i]!, snapshot.as_of, rates) - y[i]!) ** 2;
  }
  return n === 0 ? 0 : s / n;
}

/** Rank quality of a set of leave-one-out odds: the share of launched/non-launched pairs the odds order correctly (ties count half). */
function aucScore(probs: number[], y: number[]): number {
  const pos: number[] = [];
  const neg: number[] = [];
  for (let i = 0; i < probs.length; i++) (y[i] === 1 ? pos : neg).push(probs[i]!);
  if (pos.length === 0 || neg.length === 0) return 0;
  let wins = 0;
  for (const a of pos) for (const b of neg) wins += a > b ? 1 : a === b ? 0.5 : 0;
  return wins / (pos.length * neg.length);
}

/** Leave-one-out odds under the rule and under the age bands: each protocol scored by the others' record. */
function looOddsProbs(snapshot: Snapshot, y: number[]): { rule: number[]; age: number[] } {
  const rule: number[] = [];
  const age: number[] = [];
  const counts = new Map<string, { launched: number; total: number }>();
  for (const b of ['<1y', '1-2y', '2-3y', '3y+', 'unknown']) counts.set(b, { launched: 0, total: 0 });
  for (const p of snapshot.protocols) {
    const c = counts.get(ageBand(snapshot.as_of, p.listed_at))!;
    c.total++;
    if (hasToken(p)) c.launched++;
  }
  for (let i = 0; i < snapshot.protocols.length; i++) {
    const train = snapshot.protocols.filter((_, j) => j !== i);
    rule.push(ruleOdds(snapshot.protocols[i]!, snapshot.as_of, ruleRates(train, snapshot.as_of)));
    const c = counts.get(ageBand(snapshot.as_of, snapshot.protocols[i]!.listed_at))!;
    age.push((c.launched - y[i]! + 1) / (c.total - 1 + 2));
  }
  return { rule, age };
}

/** Walk-forward Brier of the rule odds: dated protocols ordered by listing date, each fold scored by the rule on the earlier folds. */
function walkForwardBrierRule(snapshot: Snapshot, y: number[], datedIdx: number[], nfolds: number): number {
  const n = datedIdx.length;
  const fold = Math.floor(n / nfolds);
  let s = 0;
  let cnt = 0;
  for (let f = 1; f < nfolds; f++) {
    const tr = datedIdx.slice(0, f * fold);
    const te = datedIdx.slice(f * fold, (f + 1) * fold);
    const rates = ruleRates(
      tr.map((i) => snapshot.protocols[i]!),
      snapshot.as_of,
    );
    for (const i of te) {
      s += (ruleOdds(snapshot.protocols[i]!, snapshot.as_of, rates) - y[i]!) ** 2;
      cnt++;
    }
  }
  return cnt === 0 ? 0 : s / cnt;
}

/** Walk-forward Brier of the age-band odds on the same folds, rates from the training folds only. */
function walkForwardBrierAge(snapshot: Snapshot, y: number[], datedIdx: number[], nfolds: number): number {
  const bands = ['<1y', '1-2y', '2-3y', '3y+', 'unknown'];
  const n = datedIdx.length;
  const fold = Math.floor(n / nfolds);
  let s = 0;
  let cnt = 0;
  for (let f = 1; f < nfolds; f++) {
    const tr = datedIdx.slice(0, f * fold);
    const te = datedIdx.slice(f * fold, (f + 1) * fold);
    const rates = new Map<string, number>();
    for (const b of bands) {
      let tot = 0;
      let lau = 0;
      for (const i of tr) {
        if (ageBand(snapshot.as_of, snapshot.protocols[i]!.listed_at) === b) {
          tot++;
          if (hasToken(snapshot.protocols[i]!)) lau++;
        }
      }
      rates.set(b, (lau + 1) / (tot + 2));
    }
    for (const i of te) {
      const p = rates.get(ageBand(snapshot.as_of, snapshot.protocols[i]!.listed_at))!;
      s += (p - y[i]!) ** 2;
      cnt++;
    }
  }
  return cnt === 0 ? 0 : s / cnt;
}

/** The token odds: the age-band peers' record (kept as the baseline) and the rule that the board uses. */
export function tokenOdds(snapshot: Snapshot): OddsReport {
  const bands = ['<1y', '1-2y', '2-3y', '3y+', 'unknown'];
  const counts = new Map<string, { launched: number; total: number }>();
  for (const b of bands) counts.set(b, { launched: 0, total: 0 });
  let launched = 0;
  for (const p of snapshot.protocols) {
    const c = counts.get(ageBand(snapshot.as_of, p.listed_at))!;
    c.total++;
    if (hasToken(p)) {
      c.launched++;
      launched++;
    }
  }
  const baseRate = snapshot.protocols.length === 0 ? 0 : launched / snapshot.protocols.length;
  const bandRows = bands.map((band) => {
    const c = counts.get(band)!;
    return { band, launched: c.launched, total: c.total, odds: round4((c.launched + 1) / (c.total + 2)) };
  });
  let brier = 0;
  let baseBrier = 0;
  for (const p of snapshot.protocols) {
    const c = counts.get(ageBand(snapshot.as_of, p.listed_at))!;
    const t = c.launched - (hasToken(p) ? 1 : 0);
    const nn = c.total - 1;
    const pb = (t + 1) / (nn + 2);
    const y = hasToken(p) ? 1 : 0;
    brier += (pb - y) ** 2;
    baseBrier += (baseRate - y) ** 2;
  }
  const n = Math.max(1, snapshot.protocols.length);
  // The rule: full-fit rates on all 758 protocols, then the four tests.
  const y = snapshot.protocols.map((p) => (hasToken(p) ? 1 : 0));
  const looProbs = looOddsProbs(snapshot, y);
  const fullRates = ruleRates(snapshot.protocols, snapshot.as_of);
  const datedIdx = snapshot.protocols
    .map((p, i) => i)
    .filter((i) => snapshot.protocols[i]!.listed_at !== null)
    .sort((a, b) => (snapshot.protocols[a]!.listed_at! < snapshot.protocols[b]!.listed_at! ? -1 : 1));
  // One factor per category the snapshot carries, most protocols first; the page
  // shows the ones with at least twenty protocols, the rest are shrunk anyway.
  const categories: CategoryFactor[] = [...fullRates.catRates.entries()]
    .map(([category, rate]) => {
      const tot = snapshot.protocols.filter((p) => p.category === category).length;
      const lau = snapshot.protocols.filter((p) => p.category === category && hasToken(p)).length;
      return { category, protocols: tot, launched: lau, factor: rate / Math.max(1e-9, fullRates.base) };
    })
    .sort((a, b) => b.protocols - a.protocols || ((a.category ?? '') < (b.category ?? '') ? -1 : (a.category ?? '') > (b.category ?? '') ? 1 : 0));
  return {
    base_rate: round4(baseRate),
    brier: round4(brier / n),
    base_brier: round4(baseBrier / n),
    bands: bandRows,
    rule: {
      k: RULE_SHRINK_K,
      clip_lo: RULE_CLIP_LO,
      clip_hi: RULE_CLIP_HI,
      base_rate: fullRates.base,
      band_rates: bandRows.map((b) => ({ band: b.band, rate: (b.launched + 1) / (b.total + 2) })),
      categories,
      loo_brier: round4(looBrierRule(snapshot, y)),
      walkforward_brier: round4(walkForwardBrierRule(snapshot, y, datedIdx, 5)),
      walkforward4_brier: round4(walkForwardBrierRule(snapshot, y, datedIdx, 4)),
      walkforward3_brier: round4(walkForwardBrierRule(snapshot, y, datedIdx, 3)),
      loo_auc: round4(aucScore(looProbs.rule, y)),
      age_loo_auc: round4(aucScore(looProbs.age, y)),
      age_walkforward_brier: round4(walkForwardBrierAge(snapshot, y, datedIdx, 5)),
      age_walkforward4_brier: round4(walkForwardBrierAge(snapshot, y, datedIdx, 4)),
      age_walkforward3_brier: round4(walkForwardBrierAge(snapshot, y, datedIdx, 3)),
    },
  };
}

/** The token odds of one protocol, from the rule the board uses: age-band rate times its category's factor, clipped. */
export function oddsFor(snapshot: Snapshot, odds: OddsReport, p: SnapshotProtocol): number {
  const rule = odds.rule;
  const band = ageBand(snapshot.as_of, p.listed_at);
  const ageRate = rule.band_rates.find((b) => b.band === band)?.rate ?? rule.base_rate;
  const factor = rule.categories.find((c) => c.category === p.category)?.factor ?? 1;
  const raw = ageRate * factor;
  return Math.round(Math.min(rule.clip_hi, Math.max(rule.clip_lo, raw)) * 10000) / 10000;
}

/** The fitted implied value of one protocol, with its range and terms. The fit itself uses log10(TVL) alone; growth, maturity and chains are shown as the protocol's own figures, not as fitted terms. */
export function impliedValue(p: SnapshotProtocol, asOf: string, fit: FitReport): {
  implied: number;
  p25: number;
  p75: number;
  logImplied: number;
  growth: number;
  maturity: number;
  chains: number;
  age: number | null;
} {
  const x = features(p, asOf);
  const logImplied = predict(fit.coefficients, valueFeatures(p));
  const implied = Math.max(1, Math.round(Math.pow(10, logImplied)));
  const p25 = Math.max(1, Math.round(implied / fit.range_factor));
  const p75 = Math.max(1, Math.round(implied * fit.range_factor));
  return { implied, p25, p75, logImplied: round4(logImplied), growth: round4(x[2]!), maturity: round4(x[3]!), chains: x[4]!, age: ageDays(asOf, p.listed_at) };
}

/** DefiLlama's version-marker rule: a name ending in a release is a pool of another protocol. */
const VERSIONED = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;
/** A name carrying a whole word wrapped, staked or staking. */
const WRAPPED_WORD = /\b(wrapped|staked|staking)\b/i;
/** A name beginning with an exchange's name. */
const EXCHANGE_NAME = /^(Binance|Coinbase|Bybit|Kraken|Bitget|OKX|Bitfinex|Gemini)\b/;
/** Categories that are a wrapped, staked or bridged product of a token that already trades. */
const PRODUCT_CATEGORIES = new Set([
  'CEX',
  'Bridge',
  'Canonical Bridge',
  'Cross Chain Bridge',
  'Liquid Staking',
  'Liquid Restaking',
  'Restaked BTC',
]);

/** Whether a protocol records no token at all. */
export function isPreToken(p: SnapshotProtocol): boolean {
  return p.mcap_usd === null && p.gecko_id === null && p.symbol === null;
}

/**
 * Whether a protocol is one the board may rank: pre-token, and not a wrapped, staked or bridged
 * product of a token that trades, not an exchange, and not a versioned pool. The check uses only the
 * snapshot's own ten fields, and mirrors the watchlist's rule, so the early radar and the watchlist
 * are held to the same standard.
 */
export function isRankable(p: SnapshotProtocol): boolean {
  if (!isPreToken(p)) return false;
  if (p.category !== null && PRODUCT_CATEGORIES.has(p.category)) return false;
  if (VERSIONED.test(p.name)) return false;
  if (WRAPPED_WORD.test(p.name)) return false;
  if (EXCHANGE_NAME.test(p.name)) return false;
  return true;
}

/** The snapshot's protocol by slug. */
function bySlug(protocols: SnapshotProtocol[]): Map<string, SnapshotProtocol> {
  return new Map(protocols.map((p) => [p.slug, p]));
}

/** A step as one string: its action, then its cost and time, within the gate's 20..600 characters. */
export function stepText(step: FarmStep): string {
  let s = `${step.text} Cost: ${step.cost}. Time: ${step.time}.`;
  if (s.length > 600) s = `${s.slice(0, 596)}...`;
  if (s.length < 20) s = `${s} Hold the position and check the protocol's own page.`;
  return s;
}

/** The first chain a protocol names, or a neutral phrase. */
function chainOf(p: SnapshotProtocol): string {
  return p.chains.length > 0 ? p.chains[0]! : 'its main chain';
}

/** What one simple transaction costs on a chain, in whole US dollars, at the snapshot's date. */
export const GAS_USD: Record<string, number> = {
  Ethereum: 6,
  Solana: 0.02,
  Base: 0.05,
  Arbitrum: 0.1,
  Optimism: 0.1,
  Binance: 0.15,
  Avalanche: 0.3,
  Polygon: 0.05,
  Bitcoin: 0.25,
  Tron: 1,
  Linea: 0.05,
  'zkSync Era': 0.1,
  Scroll: 0.1,
  Blast: 0.05,
  Berachain: 0.05,
  Sonic: 0.02,
  'Hyperliquid L1': 0.01,
  Monad: 0.02,
  Sui: 0.02,
  Aptos: 0.02,
  Sei: 0.02,
  'Plume Mainnet': 0.05,
  Ink: 0.05,
  Unichain: 0.05,
  Katana: 0.05,
  HyperEVM: 0.05,
  Plasma: 0.05,
  Stable: 0.05,
  Arc: 0.05,
  Tempo: 0.05,
  Corn: 0.05,
};

/** The gas of one simple transaction on `chain`, in dollars; $0.50 where the chain is unnamed. */
export function gasUsd(chain: string): number {
  return GAS_USD[chain] ?? 0.5;
}

/** A dollar amount as the farm plan writes it: $6, $0.30, $0.02. */
export function money(n: number): string {
  if (n >= 1) return `$${Math.round(n * 100) / 100}`;
  return `$${n.toFixed(2)}`;
}

/** How much capital one farm position needs, from the protocol's own TVL. */
function capitalFor(p: SnapshotProtocol): number {
  if (p.tvl_usd >= 1_000_000_000) return 250;
  if (p.tvl_usd >= 100_000_000) return 150;
  if (p.tvl_usd >= 25_000_000) return 100;
  return 50;
}

/** How long to hold, from the protocol's age: younger protocols get a longer qualifying window. */
function holdDaysFor(age: number | null): number {
  if (age === null) return 30;
  if (age < 180) return 60;
  if (age < 365) return 45;
  return 30;
}

/** The cash a farm costs before capital: one-off gas for the seven once-only transactions plus the bridge fee. */
export function farmCostUsd(p: SnapshotProtocol): number {
  const gas = gasUsd(chainOf(p));
  const bridgeFee = Math.max(1, Math.round(gas * 2 * 100) / 100);
  return Math.round((gas * 7 + bridgeFee) * 100) / 100;
}

/** A protocol's verdict from its implied value, its token odds and its farm cost. */
export function verdictFor(implied: number, odds: number, cost: number): { verdict: 'Farm' | 'Watch' | 'Skip'; net: number; netPerHour: number; expected: number } {
  const expected = implied * odds * FARM_SHARE;
  const net = Math.round((expected - cost) * 100) / 100;
  const verdict = net >= 50 ? 'Farm' : net >= 0 ? 'Watch' : 'Skip';
  return { verdict, net, netPerHour: Math.round((net / ACTIVE_HOURS) * 100) / 100, expected: Math.round(expected * 100) / 100 };
}

/** The category's core action and its second qualifying action, in the words a farmer can follow. */
function actionsFor(p: SnapshotProtocol, capital: number, chain: string): [string, string] {
  const c = (p.category ?? '').toLowerCase();
  const name = p.name;
  const small = Math.max(10, Math.round(capital / 5));
  if (c.includes('lend') && !c.includes('leveraged')) {
    return [
      `Supply $${capital} of USDC to ${name} on ${chain} and leave it earning`,
      `Borrow $${small} against the supply, then repay it within the week`,
    ];
  }
  if (c.includes('cdp manager')) {
    return [
      `Deposit $${capital} of collateral into a ${name} managed vault on ${chain}`,
      `Adjust the vault's debt ratio once, then leave it`,
    ];
  }
  if (c.includes('cdp')) {
    return [
      `Lock $${capital} of collateral in ${name} on ${chain} and mint its stable asset`,
      `Repay a small part of the minted amount to move the debt ratio`,
    ];
  }
  if (c.includes('leveraged farm')) {
    return [
      `Supply $${capital} of collateral to ${name} on ${chain} and open one leveraged farm position`,
      `Reduce the leverage by a notch after the first week`,
    ];
  }
  if (c.includes('dex') || c.includes('liquidity manager')) {
    return [
      `Add $${capital} of liquidity to ${name}'s main pool on ${chain} and hold the LP position`,
      `Swap $${small} through ${name} once a week`,
    ];
  }
  if (c.includes('yield aggregator')) {
    return [
      `Deposit $${capital} into ${name} on ${chain} and let it route across its strategies`,
      `Move $${small} of the deposit between two of its strategies`,
    ];
  }
  if (c.includes('yield')) {
    return [
      `Deposit $${capital} of USDC into ${name}'s main yield vault on ${chain}`,
      `Harvest or compound the yield once a week`,
    ];
  }
  if (c.includes('risk curator')) {
    return [
      `Deposit $${capital} into a ${name} curator vault on ${chain} and hold the vault shares`,
      `Vote once on a curator allocation or risk proposal`,
    ];
  }
  if (c.includes('capital allocator')) {
    return [
      `Allocate $${capital} through ${name} on ${chain} and hold the allocation receipt`,
      `Rebalance $${small} of the allocation once`,
    ];
  }
  if (c.includes('perpetual') || c.includes('derivative')) {
    return [
      `Deposit $${capital} of USDC as margin on ${name} and open one small hedged position`,
      `Close the hedge and reopen it at a different size`,
    ];
  }
  if (c.includes('rwa')) {
    return [
      `Mint $${capital} of ${name}'s yield-bearing asset on ${chain} and hold it`,
      `Read the asset's backing report and hold through one payout`,
    ];
  }
  if (c.includes('bridge')) {
    return [
      `Bridge $${capital} of USDC to ${chain} through ${name} and put the bridged funds to work in its app`,
      `Bridge $${small} back again to prove the route both ways`,
    ];
  }
  if (c.includes('payment')) {
    return [
      `Open a ${name} payment channel on ${chain} with $${capital} and route one payment through it`,
      `Send one small payment a week through the channel`,
    ];
  }
  if (c.includes('prediction')) {
    return [
      `Fund $${capital} and take a position in one ${name} market on ${chain}`,
      `Settle or claim one market outcome`,
    ];
  }
  if (c.includes('staking') || c.includes('restak')) {
    return [
      `Stake $${capital} of the chain's staking asset through ${name} and hold the receipt`,
      `Claim the staking rewards once`,
    ];
  }
  if (c.includes('basis trad')) {
    return [
      `Deposit $${capital} into ${name}'s basis trade on ${chain}`,
      `Check the funding rate and rebalance once`,
    ];
  }
  if (c.includes('farm')) {
    return [
      `Stake $${capital} of LP tokens in ${name}'s farm on ${chain}`,
      `Harvest the farm rewards once a week`,
    ];
  }
  if (c.includes('insurance')) {
    return [
      `Buy $${capital} of cover from ${name} on ${chain} and hold the policy`,
      `Check the policy's terms once before renewal`,
    ];
  }
  if (c.includes('otc')) {
    return [
      `Open a $${capital} OTC listing on ${name} on ${chain}`,
      `Settle one small trade through the marketplace`,
    ];
  }
  if (c.includes('collateral')) {
    return [
      `Post $${capital} of collateral on ${name} on ${chain}`,
      `Adjust the collateral once`,
    ];
  }
  if (c.includes('stablecoin')) {
    return [
      `Wrap $${capital} into ${name}'s stable asset on ${chain}`,
      `Unwrap $${small} to confirm the redemption path`,
    ];
  }
  return [
    `Deposit $${capital} of USDC into ${name} on ${chain} and keep the position open`,
    `Do one more qualifying action a week later — a swap, a vote or a deposit`,
  ];
}

/**
 * A protocol's farm plan: eight steps, each an action with a cost and a time. The plan is derived
 * from the protocol's own record — category, chains, TVL and age — never from a hand-written list
 * of names. Gas follows the primary chain; capital follows TVL; the hold follows age.
 */
export function farmSteps(p: SnapshotProtocol, age: number | null): FarmStep[] {
  const chain = chainOf(p);
  const gas = gasUsd(chain);
  const capital = capitalFor(p);
  const hold = holdDaysFor(age);
  const [core, second] = actionsFor(p, capital, chain);
  const bridgeFee = Math.max(1, Math.round(gas * 2 * 100) / 100);
  return [
    {
      text: `Open a fresh wallet for this farm only and write its seed phrase on paper, offline — never in a screenshot or a chat`,
      cost: 'free to create; the first transaction costs about ' + money(gas) + ' of gas on ' + chain,
      time: '5 minutes',
    },
    {
      text: `Move $${capital} of USDC to ${chain} for ${p.name} — bridge from where your funds sit, or buy USDC on ${chain} directly`,
      cost: 'about ' + money(bridgeFee) + ' of bridge fees and ' + money(gas) + ' of gas',
      time: '10 to 20 minutes',
    },
    {
      text: core,
      cost: `$${capital} of capital and about ${money(gas)} of gas`,
      time: '15 minutes to set up',
    },
    {
      text: second,
      cost: 'about ' + money(gas * 2) + ' of gas',
      time: '10 minutes',
    },
    {
      text: `Repeat one qualifying action every week — a deposit, a swap, a borrow or a vote — so the wallet shows steady use, not one burst`,
      cost: 'about ' + money(gas) + ' of gas a week',
      time: '10 minutes a week',
    },
    {
      text: `Open ${p.name}'s own points or rewards page from its official site or docs and check what counts`,
      cost: 'free to check, and never pay to claim',
      time: '10 minutes',
    },
    {
      text: `Keep the position open for at least ${hold} days so it spans more than one snapshot of activity`,
      cost: `the $${capital} stays in the position`,
      time: `${hold} days`,
    },
    {
      text: `Unwind in reverse — close the second action first, then the core position — and write the wallet, the dates and every transaction hash in a farm log`,
      cost: 'about ' + money(gas * 2) + ' of gas to unwind',
      time: '20 minutes',
    },
  ];
}

/** The protocols the board ranks, strongest first, with ranks 1..n. */
export function buildBoard(snapshot: Snapshot, fit: FitReport, odds: OddsReport): BoardRow[] {
  const index = bySlug(snapshot.protocols);
  const chosen = new Map<string, SnapshotProtocol>();
  // The watchlist is the floor: every slug it names, whether or not it passes the rankable check —
  // the gate's coverage row is never gambled on a filter.
  for (const slug of snapshot.watchlist) {
    const p = index.get(slug);
    if (p !== undefined) chosen.set(slug, p);
  }
  // The early radar: every other pre-token protocol the snapshot's own fields keep, below the floor
  // and above it, by TVL. Never a replacement for a watchlist row: a chosen protocol stays chosen.
  const extra = snapshot.protocols
    .filter((p) => !chosen.has(p.slug) && isRankable(p))
    .sort((a, b) => b.tvl_usd - a.tvl_usd || (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0));
  for (const p of extra) chosen.set(p.slug, p);

  const scored = [...chosen.values()].map((p) => {
    const v = impliedValue(p, snapshot.as_of, fit);
    const o = oddsFor(snapshot, odds, p);
    const cost = farmCostUsd(p);
    const verdict = verdictFor(v.implied, o, cost);
    // The row's own economics: a 5%-a-year charge on the capital over the hold, the
    // net per active hour after that charge, and the token odds at which the farm
    // breaks even. The verdict itself is unchanged — these are extra columns.
    const capital = capitalFor(p);
    const hold = holdDaysFor(v.age);
    const capCharge = Math.round(capital * 0.05 * (hold / 365) * 100) / 100;
    const expectedRaw = v.implied * o * FARM_SHARE;
    const netCc = Math.round((expectedRaw - cost - capCharge) * 100) / 100;
    const netPerHourCc = Math.round((netCc / ACTIVE_HOURS) * 100) / 100;
    const breakeven = Math.min(9.99, (cost + capCharge) / (v.implied * FARM_SHARE));
    return { p, v, o, cost, verdict, capCharge, netPerHourCc, breakeven };
  });
  scored.sort((a, b) => b.v.implied - a.v.implied || (a.p.slug < b.p.slug ? -1 : a.p.slug > b.p.slug ? 1 : 0));
  return scored.map((s, i) => ({
    rank: i + 1,
    slug: s.p.slug,
    name: s.p.name,
    category: s.p.category,
    chains: s.p.chains,
    tvl_usd: s.p.tvl_usd,
    change_7d: s.p.change_7d,
    mcap_usd: s.p.mcap_usd,
    listed_at: s.p.listed_at,
    gecko_id: s.p.gecko_id,
    symbol: s.p.symbol,
    token_status: 'pre-token',
    age_days: s.v.age,
    implied_value_usd: s.v.implied,
    token_odds: s.o,
    implied_p25_usd: s.v.p25,
    implied_p75_usd: s.v.p75,
    expected_value_usd: s.verdict.expected,
    verdict: s.verdict.verdict,
    net_usd: s.verdict.net,
    net_per_hour_usd: s.verdict.netPerHour,
    farm_cost_usd: s.cost,
    capital_charge_usd: s.capCharge,
    net_per_hour_cc_usd: s.netPerHourCc,
    breakeven_odds: round4(s.breakeven),
    model: {
      log_implied: s.v.logImplied,
      growth_term: s.v.growth,
      maturity_term: s.v.maturity,
      chain_term: s.v.chains,
      age_days: s.v.age,
    },
    farm_steps: farmSteps(s.p, s.v.age).map(stepText),
  }));
}

/** The live-token protocols, by market cap, for the dashboard's Live token view. */
export function liveRows(snapshot: Snapshot): LiveRow[] {
  return snapshot.protocols
    .filter((p) => !isPreToken(p) && p.category !== 'CEX')
    .sort((a, b) => (b.mcap_usd ?? 0) - (a.mcap_usd ?? 0) || b.tvl_usd - a.tvl_usd)
    .slice(0, LIVE_ROWS)
    .map((p) => ({
      slug: p.slug,
      name: p.name,
      category: p.category,
      chains: p.chains,
      tvl_usd: p.tvl_usd,
      mcap_usd: p.mcap_usd,
      change_7d: p.change_7d,
    }));
}

/** A board row's compact form for data.js, with the farm plan generated in the page. */
export function radarRow(row: BoardRow): RadarRow {
  return {
    rank: row.rank,
    slug: row.slug,
    name: row.name,
    category: row.category,
    chains: row.chains,
    tvl_usd: row.tvl_usd,
    change_7d: row.change_7d,
    mcap_usd: row.mcap_usd,
    listed_at: row.listed_at,
    age_days: row.age_days,
    implied_value_usd: row.implied_value_usd,
    token_odds: row.token_odds,
    implied_p25_usd: row.implied_p25_usd,
    implied_p75_usd: row.implied_p75_usd,
    expected_value_usd: row.expected_value_usd,
    verdict: row.verdict,
    net_usd: row.net_usd,
    net_per_hour_usd: row.net_per_hour_usd,
    farm_cost_usd: row.farm_cost_usd,
    capital_charge_usd: row.capital_charge_usd,
    net_per_hour_cc_usd: row.net_per_hour_cc_usd,
    breakeven_odds: row.breakeven_odds,
    log_implied: row.model.log_implied,
    growth_term: row.model.growth_term,
    maturity_term: row.model.maturity_term,
    chain_term: row.model.chain_term,
  };
}

/** The first twelve hex characters of the sha256 of main.ts, read beside this file. */
export function mainChecksum(): string {
  try {
    const here = fileURLToPath(new URL('.', import.meta.url));
    const bytes = readFileSync(join(here, '..', 'main.ts'));
    return createHash('sha256').update(bytes).digest('hex').slice(0, 12);
  } catch {
    return 'n/a';
  }
}

/** Everything the dashboard renders, from the snapshot. */
export function buildRadar(snapshot: Snapshot): { board: BoardRow[]; radar: RadarData } {
  const fit = fitModel(snapshot);
  const odds = tokenOdds(snapshot);
  const board = buildBoard(snapshot, fit, odds);
  const live = liveRows(snapshot);
  const early = board.filter((r) => !snapshot.watchlist.includes(r.slug) && r.tvl_usd < snapshot.floor_usd).length;
  const above = board.filter((r) => !snapshot.watchlist.includes(r.slug) && r.tvl_usd >= snapshot.floor_usd).length;
  const totalImplied = board.reduce((n, r) => n + r.implied_value_usd, 0);
  const growths = board
    .map((r) => r.change_7d)
    .filter((g): g is number => g !== null)
    .sort((a, b) => a - b);
  const medianGrowth = growths.length > 0 ? growths[Math.floor(growths.length / 2)]! : null;
  const chainCounts = new Map<string, number>();
  for (const r of board) for (const c of r.chains) chainCounts.set(c, (chainCounts.get(c) ?? 0) + 1);
  const topChain = [...chainCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  const chains = [...new Set(board.flatMap((r) => r.chains))].sort();
  const categories = [...new Set(board.map((r) => r.category ?? 'Other'))].sort();
  const boardSlugs = new Set(board.map((r) => r.slug));
  const unrankedPretoken = snapshot.protocols.filter((p) => isPreToken(p) && !boardSlugs.has(p.slug)).length;
  const liveToken = snapshot.protocols.filter((p) => !isPreToken(p)).length;
  const verdicts = { farm: 0, watch: 0, skip: 0 };
  for (const r of board) {
    if (r.verdict === 'Farm') verdicts.farm++;
    else if (r.verdict === 'Watch') verdicts.watch++;
    else verdicts.skip++;
  }
  const radar: RadarData = {
    as_of: snapshot.as_of,
    source: snapshot.source,
    floor_usd: snapshot.floor_usd,
    model_version: MODEL_VERSION,
    fit,
    odds,
    accounting: {
      watchlist: snapshot.watchlist.length,
      early: board.length - snapshot.watchlist.length,
      live_token: liveToken,
      unranked_pretoken: unrankedPretoken,
      total: snapshot.protocols.length,
    },
    integrity: {
      rows_recomputed: board.length,
      total_implied_usd: totalImplied,
      checksum: mainChecksum(),
      ledger_total: snapshot.protocols.length,
    },
    watchlist_size: snapshot.watchlist.length,
    board_size: board.length,
    early_size: early,
    above_size: above,
    live_size: live.length,
    total_implied_usd: totalImplied,
    median_growth_pct: medianGrowth === null ? null : Math.round(medianGrowth * 100) / 100,
    top_chain: topChain,
    chains,
    categories,
    watchlist: [...snapshot.watchlist].sort(),
    farm_verdicts: verdicts,
    rows: board.map(radarRow),
    live,
  };
  return { board, radar };
}

/** The snapshot out of a file's text, refused unless it is the shape the model scores. */
export function parseSnapshot(text: string): Snapshot {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new SnapshotError('snapshot.json is not JSON');
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new SnapshotError('snapshot.json is not a JSON object');
  const o = raw as Record<string, unknown>;
  if (typeof o.as_of !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(o.as_of)) throw new SnapshotError('snapshot.json has no as_of date');
  if (typeof o.source !== 'string') throw new SnapshotError('snapshot.json has no source');
  if (typeof o.floor_usd !== 'number' || !Number.isSafeInteger(o.floor_usd) || o.floor_usd <= 0) throw new SnapshotError('snapshot.json has no floor_usd');
  if (!Array.isArray(o.protocols)) throw new SnapshotError('snapshot.json has no protocols array');
  if (!Array.isArray(o.watchlist) || o.watchlist.some((s) => typeof s !== 'string')) throw new SnapshotError('snapshot.json has no watchlist of slugs');
  const protocols = o.protocols.map((v, i) => {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new SnapshotError(`snapshot.json's protocol ${i} is not an object`);
    const p = v as Record<string, unknown>;
    if (typeof p.slug !== 'string' || typeof p.name !== 'string' || typeof p.tvl_usd !== 'number' || !Number.isFinite(p.tvl_usd)) {
      throw new SnapshotError(`snapshot.json's protocol ${i} lacks a slug, a name or a TVL`);
    }
    return {
      slug: p.slug,
      name: p.name,
      category: typeof p.category === 'string' ? p.category : null,
      chains: Array.isArray(p.chains) ? p.chains.filter((c): c is string => typeof c === 'string') : [],
      tvl_usd: p.tvl_usd,
      change_7d: typeof p.change_7d === 'number' && Number.isFinite(p.change_7d) ? p.change_7d : null,
      mcap_usd: typeof p.mcap_usd === 'number' && Number.isFinite(p.mcap_usd) ? p.mcap_usd : null,
      listed_at: typeof p.listed_at === 'string' ? p.listed_at : null,
      gecko_id: typeof p.gecko_id === 'string' ? p.gecko_id : null,
      symbol: typeof p.symbol === 'string' ? p.symbol : null,
    };
  });
  return {
    as_of: o.as_of,
    source: o.source,
    floor_usd: o.floor_usd,
    protocols,
    watchlist: o.watchlist as string[],
  };
}

/** Why a board is not one the gate will take, or null: coverage, ranks, order, one shared implied value, and farm steps. */
export function boardIssue(board: BoardRow[], snapshot: Snapshot): string | null {
  const slugs = new Set(board.map((r) => r.slug));
  const missing = snapshot.watchlist.filter((s) => !slugs.has(s));
  if (missing.length > 0) return `the board misses ${missing.length} watchlist slug${missing.length === 1 ? '' : 's'}: ${missing.slice(0, 5).join(', ')}`;
  const ranks = board.map((r) => r.rank).sort((a, b) => a - b);
  for (let i = 0; i < ranks.length; i++) if (ranks[i] !== i + 1) return `rank ${i + 1} is ${ranks[i]}`;
  for (let i = 1; i < board.length; i++) if (board[i]!.implied_value_usd > board[i - 1]!.implied_value_usd) return `row ${i + 1} outranks row ${i} on implied value`;
  if (board.length >= 2 && board[0]!.implied_value_usd === board[board.length - 1]!.implied_value_usd) {
    return `all ${board.length} rows share the same implied value $${board[0]!.implied_value_usd}: a board that ranks nothing by value is not a ranking`;
  }
  for (const r of board) {
    const steps = r.farm_steps;
    if (steps.length < 3 || steps.length > 12) return `${r.slug} has ${steps.length} farm steps`;
    for (const s of steps) if (s.length < 20 || s.length > 600) return `${r.slug} has a farm step of ${s.length} characters`;
    if (!Number.isSafeInteger(r.implied_value_usd) || r.implied_value_usd <= 0) return `${r.slug} has implied value ${r.implied_value_usd}`;
  }
  return null;
}

/** A compact data.js: the dashboard's whole dataset as one script, no fetch and no network. */
export function dataScript(radar: RadarData): string {
  return `window.RADAR=${JSON.stringify(radar)};\n`;
}
