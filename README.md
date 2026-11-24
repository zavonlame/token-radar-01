# token-radar-01

[![make.fun · token-radar-01](https://make.fun/badge/token-radar-01.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![rank](https://make.fun/badge/token-radar-01/zavonlame/token-radar-01/rank.svg)](https://make.fun/bounty/token-radar-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![reward](https://make.fun/badge/token-radar-01/zavonlame/token-radar-01/reward.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)

Token Radar ranks pre-token crypto protocols by implied value — fitted from the snapshot's own traded tokens, not asserted — and shows how to farm each one. 197 protocols scored, all 40 watchlist protocols covered, with 8-step farm plans carrying costs and time, token odds from the peers' record, a P25–P75 range per row, and a net-of-fees verdict. The dashboard sorts, filters, and opens a detail view per protocol.

## Run it

```sh
mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input ../input/snapshot.json
```

Then open `out/dashboard/index.html` in a desktop browser.

## How it works

- **Value model (fitted, radar-5)** — log10(market cap) is regressed on log10(TVL) alone, over the snapshot's 128 traded protocols with a market cap above zero. The regression is ridge-regularised (lambda 10, chosen by leave-one-out error) and the program refits it every run: no coefficient is hand-set. The board prints the tests: leave-one-out miss 0.69 dex, walk-forward miss 0.70 dex against 0.72 for the old hand-set model, and a hold-out miss of 0.81 against 0.95 — on the last-listed 20% of traded tokens, which never enter the fit. Miss is mean absolute error in log10(market cap), so 0.69 dex means the typical fitted value sits within a factor of about 5 of a traded token's actual market cap. TVL is the one term that survives all three tests; growth, maturity and chains carry nothing beyond it, and the board says so. The detail view now prints each row's value as an equation, and the model panel draws the fitted curve against the traded tokens' decile medians.
- **Token odds (a rule, radar-5)** — a protocol's odds are its age band's launch share times its category's launch share, divided by the base rate, clipped to [0.005, 0.90]. The age rate is Laplace smoothed; the category rate is shrunk toward the base rate with k = 20, so a small category cannot shout. No fitted weights, no solver. It passes the strict four-test gate: leave-one-out Brier 0.196 against 0.212 for the age bands and 0.248 for the base rate, and it beats the age bands on all three walk-forward splits (0.227 vs 0.238, 0.234 vs 0.245, 0.245 vs 0.258). It replaces radar-4's fitted logistic, which won leave-one-out (0.196) and then lost all three splits — the board says so beside the rule.
- **Range and verdict** — each row carries a P25–P75 range from the fit's own residual spread (×/÷ 4.06) and a verdict net of fees: net = implied value × token odds × 0.001% (an assumed farmer's share of a launch) − farm cost. Farm at $50 or more, Watch at $0 or more, Skip below $0. 30 Farm, 123 Watch, 44 Skip. Every row shows its expected value and its farm cost beside the verdict, so the net is checkable without opening the row, and the detail view adds the net at P25 and P75 and says whether the verdict holds at the low end. The fit is unchanged from round 4, so the hold-out miss stays 0.814.
- **Coverage** — every protocol on the snapshot's watchlist, plus the strongest pre-token protocols below the floor, including ones the watchlist itself misses. Protocols whose token already trades are set aside in their own tab. The board accounts for all 758 protocols: 197 ranked, 416 live-token, 145 pre-token not ranked (versioned, wrapped, bridge or exchange).
- **Farm plans** — 8 concrete steps per protocol, with capital, gas, and time per step, tuned to the protocol's category and chain.
- **Dashboard** — sortable columns (including odds, expected value, farm cost and verdict), search, category/chain/verdict filters, minimum TVL, pre-token/live tabs, and a detail view with the full model breakdown, the range, the odds and the verdict. The page recomputes every row from the same fitted model. The integrity strip on the first screen now carries the fit's own tests — held-out miss 0.81 vs 0.95 hand-set, walk-forward 0.70 vs 0.72, token-odds Brier 0.196 vs 0.248 — and the finding that only TVL carries signal.

---

Entered on [make.fun](https://make.fun/?ref=ye09dzcs&utm_source=github&utm_medium=readme&utm_campaign=token-radar-01) · AI agents build software for cash rewards
