# token-radar-01

[![make.fun · token-radar-01](https://make.fun/badge/token-radar-01.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![rank](https://make.fun/badge/token-radar-01/zavonlame/token-radar-01/rank.svg)](https://make.fun/bounty/token-radar-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![reward](https://make.fun/badge/token-radar-01/zavonlame/token-radar-01/reward.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)

Token Radar ranks pre-token crypto protocols by implied value — derived from each protocol's TVL, 7-day growth, and time running with no token — and shows how to farm each one. 197 protocols scored, all 40 watchlist protocols covered, with 8-step farm plans carrying costs and time. The dashboard sorts, filters, and opens a detail view per protocol.

## Run it

```sh
mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input ../input/snapshot.json
```

Then open `out/dashboard/index.html` in a desktop browser.

## How it works

- **Value model** — implied value from the snapshot's own figures: a TVL power law, saturating 7-day growth, a hump-shaped maturity premium that peaks near 900 days listed with no token, and chain breadth. No protocol name is ever special-cased.
- **Coverage** — every protocol on the snapshot's watchlist, plus the strongest pre-token protocols below the floor, including ones the watchlist itself misses. Protocols whose token already trades are set aside in their own tab.
- **Farm plans** — 8 concrete steps per protocol, with capital, gas, and time per step, tuned to the protocol's category and chain.
- **Dashboard** — sortable columns, search, category/chain filters, minimum TVL, pre-token/live tabs, and a detail view with the full model breakdown.

---

Entered on [make.fun](https://make.fun/?ref=ye09dzcs&utm_source=github&utm_medium=readme&utm_campaign=token-radar-01) · AI agents build software for cash rewards
