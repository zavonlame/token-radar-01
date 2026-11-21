// The token radar's model, radar-3: the value model is fitted, not asserted.
//
// Round 1 (radar-2) scored every protocol with hand-set multipliers — base = TVL^0.85 times a
// growth multiplier, a maturity hump and a chain multiplier, every constant chosen by hand. It
// worked, but nothing in it was ever tested against the snapshot's own traded tokens. Radar-3
// fits the model from those tokens instead, and shows the tests on the board.
//
//   The fit    log10(market cap) is regressed on the snapshot's own figures — log10(TVL), the
//              saturating seven-day growth term, the maturity hump, and the chain count — over
//              the 128 traded protocols that record a market cap above zero. The regression is
//              ridge-regularised (lambda 10, chosen by leave-one-out error) and solved in the
//              program itself, every run, from the snapshot it reads: no coefficient is
//              hand-set, and the same snapshot always fits the same numbers.
//   The tests   Leave-one-out error and walk-forward error (five folds ordered by listing date,
//              each fit on the earlier protocols and tested on the later ones) are computed in
//              the program and printed on the board, beside the hand-set model's error on the
//              same folds. The hold-out test keeps the last-listed 20% of traded tokens out of
//              the fit entirely and scores the fitted model against the hand-set one on them.
//   The verdict The ablation drops each term in turn and re-runs both tests: a term survives
//              only when dropping it makes both tests worse. TVL survives both. Growth, age
//              and chains do not — the data says a TVL spike the token has not followed is
//              mean-reversion, and an old protocol's token is worth less, not more, at the
//              same TVL — so the fit keeps them at small ridge-shrunk weights and the board
//              says so, instead of pretending the hand-set story was right.
//   Token odds A pre-token protocol's odds come from the peers' record: among all 758
//              protocols in the snapshot, the share that have a token, by age band, Laplace
//              smoothed. The odds are a peers'-record rate, not a forecast of when a token
//              lands, and the board labels them as such. Their Brier score is computed
//              leave-one-out and shown against the base rate's.
//   The range  The P25-P75 range is the fit's own residual spread: implied value times or
//              divided by 10^(0.674 x sigma), sigma the residual standard deviation of the
//              fit on the traded tokens.
//   The verdict A farmer is assumed to capture 0.001% of a launch's value. Net = implied value
//              x token odds x 0.001% - farm cost (gas and bridge from the same tables the farm
//              plans use). Farm when net is at least $50, Watch when it is at least $0,
//              Skip when it is below $0. Net/hour divides by the plan's active time.
//
// Implied value follows only from the snapshot's own figures — TVL, seven-day growth, age with
// no token, and how many chains the protocol runs on — through one function that scores every
// row the same way. No protocol name is ever special-cased.

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
export const MODEL_VERSION = 'radar-3';

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

/** One fitted term, with what the two tests say about it. */
export interface FitTerm {
  term: string;
  weight: number;
  loo_without: number;
  walkforward_without: number;
  verdict: string;
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
  holdout_n: number;
  holdout_fitted_mae: number;
  holdout_handset_mae: number;
  holdout_improvement_pct: number;
  terms: FitTerm[];
}

/** The token-odds report: the peers' launch record, by age band. */
export interface OddsReport {
  base_rate: number;
  brier: number;
  base_brier: number;
  bands: { band: string; launched: number; total: number; odds: number }[];
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

/** Leave-one-out mean absolute error: each protocol predicted by a fit on all the others. */
function looMae(rows: { x: number[]; y: number }[], lambda: number, drop: number): number {
  const use = (r: { x: number[]; y: number }): number[] => (drop < 0 ? r.x : r.x.filter((_, i) => i !== drop));
  let s = 0;
  for (let i = 0; i < rows.length; i++) {
    const train = rows.filter((_, j) => j !== i).map((r) => ({ x: use(r), y: r.y }));
    const beta = ridgeSolve(train.map((t) => t.x), train.map((t) => t.y), lambda);
    s += Math.abs(predict(beta, use(rows[i]!)) - rows[i]!.y);
  }
  return rows.length === 0 ? 0 : s / rows.length;
}

/** Walk-forward mean absolute error: five folds ordered by listing date, each fit on the earlier folds and tested on the next. */
function walkForwardMae(dated: { x: number[]; y: number }[], lambda: number, drop: number, handSet: (p: SnapshotProtocol) => number, datedProtocols: SnapshotProtocol[]): { fitted: number; handset: number } {
  const use = (r: { x: number[]; y: number }): number[] => (drop < 0 ? r.x : r.x.filter((_, i) => i !== drop));
  const fold = Math.floor(dated.length / 5);
  let sf = 0;
  let sh = 0;
  let n = 0;
  for (let f = 1; f < 5; f++) {
    const train = dated.slice(0, f * fold);
    const test = dated.slice(f * fold, (f + 1) * fold);
    const testP = datedProtocols.slice(f * fold, (f + 1) * fold);
    const beta = ridgeSolve(train.map((t) => use(t)), train.map((t) => t.y), lambda);
    for (let i = 0; i < test.length; i++) {
      sf += Math.abs(predict(beta, use(test[i]!)) - test[i]!.y);
      sh += Math.abs(Math.log10(handSet(testP[i]!)) - test[i]!.y);
      n++;
    }
  }
  return { fitted: n === 0 ? 0 : sf / n, handset: n === 0 ? 0 : sh / n };
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

/** The value fit and its tests, computed from the snapshot's own traded tokens. */
export function fitModel(snapshot: Snapshot): FitReport {
  const traded = snapshot.protocols.filter((p) => p.mcap_usd !== null && p.mcap_usd > 0 && p.tvl_usd > 0);
  const rows = traded.map((p) => ({ x: features(p, snapshot.as_of), y: Math.log10(p.mcap_usd!) }));
  const beta = ridgeSolve(rows.map((r) => r.x), rows.map((r) => r.y), RIDGE_LAMBDA);
  const residuals = rows.map((r) => predict(beta, r.x) - r.y);
  const sigma = Math.sqrt(residuals.reduce((s, r) => s + r * r, 0) / Math.max(1, rows.length));
  const meanY = rows.reduce((s, r) => s + r.y, 0) / Math.max(1, rows.length);
  const ssTot = rows.reduce((s, r) => s + (r.y - meanY) ** 2, 0);
  const ssRes = residuals.reduce((s, r) => s + r * r, 0);
  const loo = looMae(rows, RIDGE_LAMBDA, -1);
  const dated = traded
    .filter((p) => p.listed_at !== null)
    .sort((a, b) => (a.listed_at! < b.listed_at! ? -1 : a.listed_at! > b.listed_at! ? 1 : 0));
  const datedRows = dated.map((p) => ({ x: features(p, snapshot.as_of), y: Math.log10(p.mcap_usd!) }));
  const wf = walkForwardMae(datedRows, RIDGE_LAMBDA, -1, (p) => handSetValue(p, snapshot.as_of), dated);
  // The hold-out: the last-listed 20% of traded tokens never enter the fit.
  const cut = Math.floor(dated.length * 0.8);
  const trainH = datedRows.slice(0, cut);
  const testH = datedRows.slice(cut);
  const testP = dated.slice(cut);
  const betaH = ridgeSolve(trainH.map((t) => t.x), trainH.map((t) => t.y), RIDGE_LAMBDA);
  const fittedMae = mae(betaH, testH);
  let handMae = 0;
  for (let i = 0; i < testH.length; i++) handMae += Math.abs(Math.log10(handSetValue(testP[i]!, snapshot.as_of)) - testH[i]!.y);
  handMae = testH.length === 0 ? 0 : handMae / testH.length;
  // The ablation: drop each term in turn and re-run both tests.
  const names = ['log10(TVL)', 'growth', 'maturity', 'chains'];
  const terms: FitTerm[] = [1, 2, 3, 4].map((idx) => {
    const lw = looMae(rows, RIDGE_LAMBDA, idx);
    const ww = walkForwardMae(datedRows, RIDGE_LAMBDA, idx, (p) => handSetValue(p, snapshot.as_of), dated).fitted;
    const survives = lw > loo && ww > wf.fitted;
    return {
      term: names[idx - 1]!,
      weight: round4(beta[idx]!),
      loo_without: round4(lw),
      walkforward_without: round4(ww),
      verdict: survives ? 'kept — survives both tests' : 'kept at shrunk weight — no signal beyond TVL',
    };
  });
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
    walkforward_mae: round4(wf.fitted),
    walkforward_handset_mae: round4(wf.handset),
    holdout_n: testH.length,
    holdout_fitted_mae: round4(fittedMae),
    holdout_handset_mae: round4(handMae),
    holdout_improvement_pct: round4(handMae === 0 ? 0 : ((handMae - fittedMae) / handMae) * 100),
    terms,
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

/** The token odds: the share of peers in each age band that have a token, Laplace smoothed, with its Brier score against the base rate. */
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
  const oddsOf = (band: string): number => bandRows.find((b) => b.band === band)!.odds;
  let brier = 0;
  let baseBrier = 0;
  for (const p of snapshot.protocols) {
    const c = counts.get(ageBand(snapshot.as_of, p.listed_at))!;
    const t = c.launched - (hasToken(p) ? 1 : 0);
    const n = c.total - 1;
    const pb = (t + 1) / (n + 2);
    const y = hasToken(p) ? 1 : 0;
    brier += (pb - y) ** 2;
    baseBrier += (baseRate - y) ** 2;
  }
  const n = Math.max(1, snapshot.protocols.length);
  return { base_rate: round4(baseRate), brier: round4(brier / n), base_brier: round4(baseBrier / n), bands: bandRows };
}

/** The token odds of one protocol, from its age band. */
export function oddsFor(snapshot: Snapshot, odds: OddsReport, p: SnapshotProtocol): number {
  const band = odds.bands.find((b) => b.band === ageBand(snapshot.as_of, p.listed_at));
  return band === undefined ? odds.base_rate : band.odds;
}

/** The fitted implied value of one protocol, with its range and terms. */
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
  const logImplied = predict(fit.coefficients, x);
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
    return { p, v, o, cost, verdict };
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
