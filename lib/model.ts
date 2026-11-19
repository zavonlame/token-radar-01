// The token radar's model, radar-2: one snapshot of the protocol universe in, one ranked board out.
//
// The board ranks every protocol the radar may rank: the whole watchlist (the floor, never the
// ceiling) plus every other pre-token protocol the snapshot's own fields keep — below the floor and
// above it — that is not a wrapped, staked or bridged product, not an exchange, and not a versioned
// pool. Live-token protocols are kept apart and shown with the market's own values, never mixed into
// the ranked board.
//
// Implied value follows only from the snapshot's own figures — TVL, seven-day growth, age with no
// token, and how many chains the protocol runs on — through one function that scores every row the
// same way. No protocol name is ever special-cased.
//
//   tvl power    base = TVL_SCALE x (tvl_usd / 1e6) ^ TVL_POWER
//                Token value grows with TVL, but slower than TVL itself: a protocol ten times
//                larger is not ten times the launch. The power law is the compression.
//   growth       g = tanh(clamp(change_7d, -80, 200) / GROWTH_SCALE)
//                growthMult = 1 + GROWTH_WEIGHT x g
//                Growth saturates: a +4,448% week is a data spike, not a durable trend, and a
//                -40% week is a warning, not a death sentence. The curve is smooth, so no
//                protocol sits on a cliff edge.
//   maturity     hump(age) = (age / MATURITY_PEAK) x exp(1 - age / MATURITY_PEAK)
//                maturityMult = MATURITY_BASE + MATURITY_SPAN x hump(age)
//                A protocol that has run a long time with no token has built pent-up launch value,
//                but one that has run very long without launching is less likely to launch at all:
//                the premium rises to a peak near two and a half years, then fades. Age is the
//                time since DefiLlama first listed the protocol; an unlisted age uses 365 days.
//   breadth      chainMult = 1 + CHAIN_STEP x min(chains - 1, CHAIN_CAP)
//                Each extra chain is another surface the launch can land on.
//   implied      = max(1, round(base x growthMult x maturityMult x chainMult))
//
// The constants are stated in the dashboard and changeable in the model sandbox. The page recomputes
// every row from the same function, so the board's numbers and the page's code visibly agree.

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

/** The model's constants, as the dashboard states them and the sandbox may change them. */
export interface ModelConstants {
  tvl_scale: number;
  tvl_power: number;
  growth_weight: number;
  growth_scale: number;
  growth_floor: number;
  growth_cap: number;
  maturity_base: number;
  maturity_span: number;
  maturity_peak_days: number;
  unknown_age_days: number;
  chain_step: number;
  chain_cap: number;
}

export const MODEL: ModelConstants = {
  tvl_scale: 1_000_000,
  tvl_power: 0.85,
  growth_weight: 0.45,
  growth_scale: 75,
  growth_floor: -80,
  growth_cap: 200,
  maturity_base: 0.7,
  maturity_span: 0.55,
  maturity_peak_days: 900,
  unknown_age_days: 365,
  chain_step: 0.03,
  chain_cap: 5,
};

/** The model's version label: the dashboard names it and the rules quote it. */
export const MODEL_VERSION = 'radar-2';

/** How many live-token protocols the Live token view carries, by market cap. */
export const LIVE_ROWS = 24;

/** A farm step: the action, what it costs, and how long it takes. */
export interface FarmStep {
  text: string;
  cost: string;
  time: string;
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
  model: {
    base_usd: number;
    growth_pct: number;
    growth_multiplier: number;
    maturity_multiplier: number;
    chain_multiplier: number;
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
  base_usd: number;
  growth_multiplier: number;
  maturity_multiplier: number;
  chain_multiplier: number;
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

/** Everything the dashboard needs: the board, the live set, and the model it runs. */
export interface RadarData {
  as_of: string;
  source: string;
  floor_usd: number;
  model: ModelConstants;
  model_version: string;
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

/** The four multipliers and the implied value one protocol gets under `model`. */
export function impliedValue(protocol: SnapshotProtocol, asOf: string, model: ModelConstants): {
  implied: number;
  base: number;
  growthPct: number;
  growthMult: number;
  maturityMult: number;
  chainMult: number;
  age: number | null;
} {
  const age = ageDays(asOf, protocol.listed_at);
  const rawGrowth = finite(protocol.change_7d, 0);
  const growthPct = Math.min(model.growth_cap, Math.max(model.growth_floor, rawGrowth));
  const growthMult = 1 + model.growth_weight * Math.tanh(growthPct / model.growth_scale);
  const ageForModel = age ?? model.unknown_age_days;
  const x = ageForModel / model.maturity_peak_days;
  const hump = x * Math.exp(1 - x);
  const maturityMult = model.maturity_base + model.maturity_span * hump;
  const chainCount = Math.max(0, protocol.chains.length - 1);
  const chainMult = 1 + model.chain_step * Math.min(chainCount, model.chain_cap);
  const base = model.tvl_scale * Math.pow(protocol.tvl_usd / 1_000_000, model.tvl_power);
  const implied = Math.max(1, Math.round(base * growthMult * maturityMult * chainMult));
  return { implied, base: Math.round(base), growthPct, growthMult, maturityMult, chainMult, age };
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

/** The protocols the board ranks, strongest first, with ranks 1..n. */
export function buildBoard(snapshot: Snapshot, model: ModelConstants = MODEL): BoardRow[] {
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
    const v = impliedValue(p, snapshot.as_of, model);
    return { p, v };
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
    model: {
      base_usd: s.v.base,
      growth_pct: s.v.growthPct,
      growth_multiplier: round4(s.v.growthMult),
      maturity_multiplier: round4(s.v.maturityMult),
      chain_multiplier: round4(s.v.chainMult),
      age_days: s.v.age,
    },
    farm_steps: farmSteps(s.p, s.v.age).map(stepText),
  }));
}

const round4 = (n: number): number => Math.round(n * 1e4) / 1e4;

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
    base_usd: row.model.base_usd,
    growth_multiplier: row.model.growth_multiplier,
    maturity_multiplier: row.model.maturity_multiplier,
    chain_multiplier: row.model.chain_multiplier,
  };
}

/** Everything the dashboard renders, from the snapshot. */
export function buildRadar(snapshot: Snapshot, model: ModelConstants = MODEL): { board: BoardRow[]; radar: RadarData } {
  const board = buildBoard(snapshot, model);
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
  const radar: RadarData = {
    as_of: snapshot.as_of,
    source: snapshot.source,
    floor_usd: snapshot.floor_usd,
    model,
    model_version: MODEL_VERSION,
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
