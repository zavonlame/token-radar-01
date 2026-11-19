// Token Radar, radar-2 dashboard. It reads window.RADAR (written beside dashboard/ by main.ts)
// and renders the ranked board, the filters, a per-protocol detail view with the model's own
// breakdown and the protocol's farm plan. No network: every byte it shows is in data.js.
//
// The page recomputes every row from the snapshot figures with the same function main.ts runs,
// and regenerates every farm plan from the same derivation, so the page's code and the board's
// data are visibly the same arithmetic. No protocol name is special-cased anywhere.
(function () {
  'use strict';

  var DATA = window.RADAR;
  if (!DATA) return;
  var WATCH = {};
  (DATA.watchlist || []).forEach(function (s) { WATCH[s] = true; });

  var app = document.getElementById('rows');
  var head = document.getElementById('board-head');
  var table = document.getElementById('board-table');
  var empty = document.getElementById('empty');
  var count = document.getElementById('count');
  var dialog = document.getElementById('detail');
  var state = { q: '', category: 'all', chain: 'all', minTvl: 0, tab: 'pre-token', sort: 'implied', dir: -1, selected: null };

  var usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
  function fmtUsd(n) {
    if (n === null || n === undefined || !isFinite(n)) return 'n/a';
    if (Math.abs(n) >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
    if (Math.abs(n) >= 1e6) return '$' + (n / 1e6).toFixed(1) + 'M';
    if (Math.abs(n) >= 1e3) return '$' + Math.round(n / 1e3) + 'K';
    return usd.format(n);
  }
  function fmtPct(n) {
    if (n === null || n === undefined || !isFinite(n)) return 'n/a';
    return (n > 0 ? '+' : '') + n.toFixed(2) + '%';
  }
  function fmtAge(days) {
    if (days === null || days === undefined) return 'unknown';
    if (days >= 365) return (days / 365).toFixed(1) + 'y';
    return Math.max(0, Math.round(days)) + 'd';
  }
  function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }

  // ---- the model, as the page recomputes it -----------------------------------------
  // implied = round( 1e6 x (tvl/1e6)^0.85 x (1 + 0.45 x tanh(g/75)) x (0.7 + 0.55 x hump(age))
  //                   x (1 + 0.03 x min(chains-1, 5)) ), g clamped to [-80, 200], hump peaking at 900 days.
  function impliedOf(row, model) {
    var m = model || DATA.model;
    var g = row.change_7d === null || row.change_7d === undefined ? 0 : row.change_7d;
    g = Math.min(m.growth_cap, Math.max(m.growth_floor, g));
    var growthMult = 1 + m.growth_weight * Math.tanh(g / m.growth_scale);
    var age = row.age_days === null || row.age_days === undefined ? m.unknown_age_days : row.age_days;
    var x = age / m.maturity_peak_days;
    var maturityMult = m.maturity_base + m.maturity_span * x * Math.exp(1 - x);
    var chainMult = 1 + m.chain_step * Math.min(Math.max((row.chains || []).length - 1, 0), m.chain_cap);
    var base = m.tvl_scale * Math.pow(row.tvl_usd / 1e6, m.tvl_power);
    return { implied: Math.max(1, Math.round(base * growthMult * maturityMult * chainMult)), base: Math.round(base), growthMult: growthMult, maturityMult: maturityMult, chainMult: chainMult, growthPct: g };
  }

  // ---- the farm plan, as the page regenerates it ------------------------------------
  var GAS = { Ethereum: 6, Solana: 0.02, Base: 0.05, Arbitrum: 0.1, Optimism: 0.1, Binance: 0.15, Avalanche: 0.3, Polygon: 0.05, Bitcoin: 0.25, Tron: 1, Linea: 0.05, 'zkSync Era': 0.1, Scroll: 0.1, Blast: 0.05, Berachain: 0.05, Sonic: 0.02, 'Hyperliquid L1': 0.01, Monad: 0.02, Sui: 0.02, Aptos: 0.02, Sei: 0.02, 'Plume Mainnet': 0.05, Ink: 0.05, Unichain: 0.05, Katana: 0.05, HyperEVM: 0.05, Plasma: 0.05, Stable: 0.05, Arc: 0.05, Tempo: 0.05, Corn: 0.05 };
  function gasUsd(chain) { return GAS[chain] === undefined ? 0.5 : GAS[chain]; }
  function money(n) { return n >= 1 ? '$' + (Math.round(n * 100) / 100) : '$' + n.toFixed(2); }
  function chainOf(p) { return p.chains && p.chains.length > 0 ? p.chains[0] : 'its main chain'; }
  function capitalFor(p) {
    if (p.tvl_usd >= 1e9) return 250;
    if (p.tvl_usd >= 1e8) return 150;
    if (p.tvl_usd >= 2.5e7) return 100;
    return 50;
  }
  function holdDaysFor(age) {
    if (age === null || age === undefined) return 30;
    if (age < 180) return 60;
    if (age < 365) return 45;
    return 30;
  }
  function actionsFor(p, capital, chain) {
    var c = (p.category || '').toLowerCase();
    var name = p.name;
    var small = Math.max(10, Math.round(capital / 5));
    if (c.indexOf('lend') >= 0 && c.indexOf('leveraged') < 0) return ['Supply $' + capital + ' of USDC to ' + name + ' on ' + chain + ' and leave it earning', 'Borrow $' + small + ' against the supply, then repay it within the week'];
    if (c.indexOf('cdp manager') >= 0) return ['Deposit $' + capital + ' of collateral into a ' + name + ' managed vault on ' + chain, "Adjust the vault's debt ratio once, then leave it"];
    if (c.indexOf('cdp') >= 0) return ['Lock $' + capital + ' of collateral in ' + name + ' on ' + chain + ' and mint its stable asset', 'Repay a small part of the minted amount to move the debt ratio'];
    if (c.indexOf('leveraged farm') >= 0) return ['Supply $' + capital + ' of collateral to ' + name + ' on ' + chain + ' and open one leveraged farm position', 'Reduce the leverage by a notch after the first week'];
    if (c.indexOf('dex') >= 0 || c.indexOf('liquidity manager') >= 0) return ['Add $' + capital + ' of liquidity to ' + name + "'s main pool on " + chain + ' and hold the LP position', 'Swap $' + small + ' through ' + name + ' once a week'];
    if (c.indexOf('yield aggregator') >= 0) return ['Deposit $' + capital + ' into ' + name + ' on ' + chain + ' and let it route across its strategies', 'Move $' + small + ' of the deposit between two of its strategies'];
    if (c.indexOf('yield') >= 0) return ['Deposit $' + capital + ' of USDC into ' + name + "'s main yield vault on " + chain, 'Harvest or compound the yield once a week'];
    if (c.indexOf('risk curator') >= 0) return ['Deposit $' + capital + ' into a ' + name + ' curator vault on ' + chain + ' and hold the vault shares', 'Vote once on a curator allocation or risk proposal'];
    if (c.indexOf('capital allocator') >= 0) return ['Allocate $' + capital + ' through ' + name + ' on ' + chain + ' and hold the allocation receipt', 'Rebalance $' + small + ' of the allocation once'];
    if (c.indexOf('perpetual') >= 0 || c.indexOf('derivative') >= 0) return ['Deposit $' + capital + ' of USDC as margin on ' + name + ' and open one small hedged position', 'Close the hedge and reopen it at a different size'];
    if (c.indexOf('rwa') >= 0) return ["Mint $" + capital + " of " + name + "'s yield-bearing asset on " + chain + ' and hold it', "Read the asset's backing report and hold through one payout"];
    if (c.indexOf('bridge') >= 0) return ['Bridge $' + capital + ' of USDC to ' + chain + ' through ' + name + ' and put the bridged funds to work in its app', 'Bridge $' + small + ' back again to prove the route both ways'];
    if (c.indexOf('payment') >= 0) return ['Open a ' + name + ' payment channel on ' + chain + ' with $' + capital + ' and route one payment through it', 'Send one small payment a week through the channel'];
    if (c.indexOf('prediction') >= 0) return ['Fund $' + capital + ' and take a position in one ' + name + ' market on ' + chain, 'Settle or claim one market outcome'];
    if (c.indexOf('staking') >= 0 || c.indexOf('restak') >= 0) return ["Stake $" + capital + " of the chain's staking asset through " + name + ' and hold the receipt', 'Claim the staking rewards once'];
    if (c.indexOf('basis trad') >= 0) return ['Deposit $' + capital + " into " + name + "'s basis trade on " + chain, 'Check the funding rate and rebalance once'];
    if (c.indexOf('farm') >= 0) return ['Stake $' + capital + ' of LP tokens in ' + name + "'s farm on " + chain, 'Harvest the farm rewards once a week'];
    if (c.indexOf('insurance') >= 0) return ['Buy $' + capital + ' of cover from ' + name + ' on ' + chain + ' and hold the policy', "Check the policy's terms once before renewal"];
    if (c.indexOf('otc') >= 0) return ['Open a $' + capital + ' OTC listing on ' + name + ' on ' + chain, 'Settle one small trade through the marketplace'];
    if (c.indexOf('collateral') >= 0) return ['Post $' + capital + ' of collateral on ' + name + ' on ' + chain, 'Adjust the collateral once'];
    if (c.indexOf('stablecoin') >= 0) return ['Wrap $' + capital + " into " + name + "'s stable asset on " + chain, 'Unwrap $' + small + ' to confirm the redemption path'];
    return ['Deposit $' + capital + ' of USDC into ' + name + ' on ' + chain + ' and keep the position open', 'Do one more qualifying action a week later — a swap, a vote or a deposit'];
  }
  function stepText(step) {
    var s = step.text + ' Cost: ' + step.cost + '. Time: ' + step.time + '.';
    if (s.length > 600) s = s.slice(0, 596) + '...';
    if (s.length < 20) s = s + " Hold the position and check the protocol's own page.";
    return s;
  }
  function farmSteps(p) {
    var chain = chainOf(p);
    var gas = gasUsd(chain);
    var capital = capitalFor(p);
    var hold = holdDaysFor(p.age_days);
    var acts = actionsFor(p, capital, chain);
    var bridgeFee = Math.max(1, Math.round(gas * 2 * 100) / 100);
    return [
      { text: 'Open a fresh wallet for this farm only and write its seed phrase on paper, offline — never in a screenshot or a chat', cost: 'free to create; the first transaction costs about ' + money(gas) + ' of gas on ' + chain, time: '5 minutes' },
      { text: 'Move $' + capital + ' of USDC to ' + chain + ' for ' + p.name + ' — bridge from where your funds sit, or buy USDC on ' + chain + ' directly', cost: 'about ' + money(bridgeFee) + ' of bridge fees and ' + money(gas) + ' of gas', time: '10 to 20 minutes' },
      { text: acts[0], cost: '$' + capital + ' of capital and about ' + money(gas) + ' of gas', time: '15 minutes to set up' },
      { text: acts[1], cost: 'about ' + money(gas * 2) + ' of gas', time: '10 minutes' },
      { text: 'Repeat one qualifying action every week — a deposit, a swap, a borrow or a vote — so the wallet shows steady use, not one burst', cost: 'about ' + money(gas) + ' of gas a week', time: '10 minutes a week' },
      { text: "Open " + p.name + "'s own points or rewards page from its official site or docs and check what counts", cost: 'free to check, and never pay to claim', time: '10 minutes' },
      { text: 'Keep the position open for at least ' + hold + ' days so it spans more than one snapshot of activity', cost: 'the $' + capital + ' stays in the position', time: hold + ' days' },
      { text: 'Unwind in reverse — close the second action first, then the core position — and write the wallet, the dates and every transaction hash in a farm log', cost: 'about ' + money(gas * 2) + ' of gas to unwind', time: '20 minutes' }
    ].map(stepText);
  }
  function planTotals(p) {
    var gas = gasUsd(chainOf(p));
    var capital = capitalFor(p);
    var hold = holdDaysFor(p.age_days);
    var bridgeFee = Math.max(1, Math.round(gas * 2 * 100) / 100);
    // One-off gas is the steps that run once: wallet, funding, core action, second action
    // and the unwind — 1 + 1 + 1 + 2 + 2 transactions — plus the bridge fee.
    return { capital: capital, oneOffGas: gas * 7 + bridgeFee, weeklyGas: gas, hold: hold };
  }

  // ---- DOM helpers ------------------------------------------------------------------
  function el(tag, attrs) {
    var node = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (k) {
        if (k === 'class') node.className = attrs[k];
        else if (k === 'text') node.textContent = attrs[k];
        else if (k === 'html') node.innerHTML = attrs[k];
        else if (k.slice(0, 2) === 'on') node.addEventListener(k.slice(2), attrs[k]);
        else if (attrs[k] !== null && attrs[k] !== undefined) node.setAttribute(k, attrs[k]);
      });
    }
    for (var i = 2; i < arguments.length; i++) {
      var child = arguments[i];
      if (child === null || child === undefined) continue;
      if (Array.isArray(child)) child.forEach(function (c) { if (c) node.appendChild(c); });
      else if (typeof child === 'string') node.appendChild(document.createTextNode(child));
      else node.appendChild(child);
    }
    return node;
  }

  // ---- header, lede, facts ------------------------------------------------------------
  function initChrome() {
    document.getElementById('model-tag').textContent = DATA.model_version;
    document.getElementById('meta-snapshot').textContent = 'Snapshot ' + DATA.as_of;
    document.getElementById('meta-count').textContent = DATA.board_size + ' pre-token rows · ' + DATA.live_size + ' live';
    document.getElementById('lede-text').textContent = 'The watchlist is the floor: every protocol with at least $' + Math.round(DATA.floor_usd / 1e6) + 'M of TVL and no token on record. The early radar adds ' + DATA.early_size + ' pre-token protocols below that floor and ' + DATA.above_size + ' above it that the list leaves out. Implied value is a model, not a promise.';
    var kpis = document.getElementById('kpis');
    var med = DATA.median_growth_pct;
    kpis.appendChild(el('div', { class: 'kpi' }, el('span', { text: 'Total implied value' }), el('b', { text: fmtUsd(DATA.total_implied_usd) })));
    kpis.appendChild(el('div', { class: 'kpi' }, el('span', { text: 'Top implied value' }), el('b', { text: fmtUsd(DATA.rows[0] ? DATA.rows[0].implied_value_usd : 0) })));
    kpis.appendChild(el('div', { class: 'kpi' }, el('span', { text: 'Median 7-day growth' }), el('b', { class: med !== null && med >= 0 ? 'green' : 'red', text: fmtPct(med) })));
    kpis.appendChild(el('div', { class: 'kpi' }, el('span', { text: 'Most common chain' }), el('b', { text: DATA.top_chain || '—' })));
    var facts = document.getElementById('facts');
    facts.appendChild(el('div', { class: 'fact' }, el('span', { text: 'Watchlist covered' }), el('b', { text: DATA.watchlist_size + ' / ' + DATA.watchlist_size })));
    facts.appendChild(el('div', { class: 'fact' }, el('span', { text: 'Pre-token rows scored' }), el('b', { text: String(DATA.board_size) })));
    facts.appendChild(el('div', { class: 'fact' }, el('span', { text: 'Early rows below the floor' }), el('b', { text: String(DATA.early_size) })));
    facts.appendChild(el('div', { class: 'fact' }, el('span', { text: 'Above the floor, off the list' }), el('b', { text: String(DATA.above_size) })));
    facts.appendChild(el('div', { class: 'fact' }, el('span', { text: 'Live-token protocols set aside' }), el('b', { text: String(DATA.live_size) })));
    var m = DATA.model;
    document.getElementById('formula').innerHTML =
      'implied = round( <span class="hl">$1M × (TVL / $1M)<sup>0.85</sup></span> × (1 + 0.45 × tanh(growth / 75)) × (0.7 + 0.55 × hump(age)) × (1 + 0.03 × min(chains − 1, 5)) )<br>' +
      'growth clamped to [−80, +200] · hump(age) = (age / 900) × e<sup>(1 − age / 900)</sup>, peaking near 2.5 years · age is days since first listing, ' + m.unknown_age_days + ' days when unlisted';
    var grid = document.getElementById('model-grid');
    grid.appendChild(el('div', { class: 'model-cell' }, el('span', { text: 'TVL power' }), el('b', { text: '× (TVL / $1M)^' + m.tvl_power })));
    grid.appendChild(el('div', { class: 'model-cell' }, el('span', { text: 'Growth' }), el('b', { text: 'tanh, saturates at ±' + Math.round(m.growth_weight * 100) + '%' })));
    grid.appendChild(el('div', { class: 'model-cell' }, el('span', { text: 'Maturity' }), el('b', { text: 'hump, peak ' + m.maturity_peak_days + ' days' })));
    grid.appendChild(el('div', { class: 'model-cell' }, el('span', { text: 'Chain breadth' }), el('b', { text: '+' + Math.round(m.chain_step * 100) + '% a chain, max ' + m.chain_cap })));
    document.getElementById('model-note').textContent = 'TVL and seven-day growth come from the snapshot. Age is the time since the protocol was first listed, the best record of how long it has run with no token. Chain count is how many chains DefiLlama counts its TVL on. The early radar is every pre-token protocol the snapshot\u2019s own fields keep, and the live-token protocols are set aside with their market caps shown.';
  }

  function initControls() {
    var cat = document.getElementById('category');
    cat.appendChild(el('option', { value: 'all', text: 'All categories' }));
    DATA.categories.forEach(function (c) { cat.appendChild(el('option', { value: c, text: c })); });
    var ch = document.getElementById('chain');
    ch.appendChild(el('option', { value: 'all', text: 'All chains' }));
    DATA.chains.forEach(function (c) { ch.appendChild(el('option', { value: c, text: c })); });
    var q = document.getElementById('q');
    q.value = state.q;
    q.addEventListener('input', function () { state.q = q.value; writeHash(); render(); });
    cat.value = state.category;
    cat.addEventListener('change', function () { state.category = cat.value; writeHash(); render(); });
    ch.value = state.chain;
    ch.addEventListener('change', function () { state.chain = ch.value; writeHash(); render(); });
    var tvl = document.getElementById('min-tvl');
    tvl.value = String(state.minTvl);
    tvl.addEventListener('change', function () { state.minTvl = Number(tvl.value); writeHash(); render(); });
    document.getElementById('tab-pre').addEventListener('click', function () { state.tab = 'pre-token'; writeHash(); render(); });
    document.getElementById('tab-live').addEventListener('click', function () { state.tab = 'live'; writeHash(); render(); });
    document.getElementById('clear-filters').addEventListener('click', function () {
      state.q = ''; state.category = 'all'; state.chain = 'all'; state.minTvl = 0;
      document.getElementById('q').value = '';
      document.getElementById('category').value = 'all';
      document.getElementById('chain').value = 'all';
      document.getElementById('min-tvl').value = '0';
      writeHash(); render();
    });
  }

  // ---- filtering + sorting --------------------------------------------------------------
  function filteredRows() {
    var q = state.q.trim().toLowerCase();
    return DATA.rows.filter(function (r) {
      if (state.category !== 'all' && (r.category || 'Other') !== state.category) return false;
      if (state.chain !== 'all' && (r.chains || []).indexOf(state.chain) < 0) return false;
      if (r.tvl_usd < state.minTvl) return false;
      if (!q) return true;
      var hay = [r.name, r.slug, r.category, (r.chains || []).join(' ')].join(' ').toLowerCase();
      return hay.indexOf(q) >= 0;
    });
  }
  function sortedRows(list) {
    var key = state.sort;
    return list.slice().sort(function (a, b) {
      var av, bv;
      if (key === 'name') { av = a.name.toLowerCase(); bv = b.name.toLowerCase(); }
      else if (key === 'tvl') { av = a.tvl_usd; bv = b.tvl_usd; }
      else if (key === 'growth') { av = a.change_7d === null ? -Infinity : a.change_7d; bv = b.change_7d === null ? -Infinity : b.change_7d; }
      else if (key === 'age') { av = a.age_days === null ? Infinity : a.age_days; bv = b.age_days === null ? Infinity : b.age_days; }
      else if (key === 'mcap') { av = a.mcap_usd === null ? -Infinity : a.mcap_usd; bv = b.mcap_usd === null ? -Infinity : b.mcap_usd; }
      else { av = a.implied_value_usd; bv = b.implied_value_usd; }
      if (av < bv) return -state.dir;
      if (av > bv) return state.dir;
      return a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0;
    });
  }

  function sortHeader(key, label) {
    return el('th', { scope: 'col' },
      el('button', { type: 'button', onclick: function () { if (state.sort === key) state.dir = -state.dir; else { state.sort = key; state.dir = -1; } render(); } },
        label,
        state.sort === key ? el('span', { class: 'arrow', 'aria-hidden': 'true', text: state.dir < 0 ? ' ↓' : ' ↑' }) : null
      )
    );
  }

  function renderHead() {
    head.textContent = '';
    var tr = el('tr');
    if (state.tab === 'live') {
      tr.appendChild(el('th', { scope: 'col', text: 'Status' }));
      tr.appendChild(sortHeader('name', 'Protocol'));
      tr.appendChild(sortHeader('tvl', 'TVL'));
      tr.appendChild(sortHeader('growth', '7d'));
      tr.appendChild(sortHeader('mcap', 'Market cap'));
      tr.appendChild(el('th', { scope: 'col', text: 'Token' }));
    } else {
      tr.appendChild(sortHeader('implied', 'Rank'));
      tr.appendChild(sortHeader('name', 'Protocol'));
      tr.appendChild(sortHeader('tvl', 'TVL'));
      tr.appendChild(sortHeader('growth', '7d'));
      tr.appendChild(sortHeader('age', 'Age'));
      tr.appendChild(sortHeader('implied', 'Implied value'));
      tr.appendChild(el('th', { scope: 'col', text: 'Token' }));
    }
    head.appendChild(tr);
    table.querySelector('caption').textContent = state.tab === 'live'
      ? 'Token live: these protocols already trade, so their market cap is a fact, not a model. They are set aside from the pre-token ranking.'
      : 'Pre-token protocols, strongest implied value first. Select a row for its model breakdown and farm plan.';
  }

  function renderRows() {
    app.textContent = '';
    if (state.tab === 'live') {
      var live = sortedRows(DATA.live.slice());
      live.forEach(function (r) {
        app.appendChild(el('tr', null,
          el('td', { class: 'num', text: 'live' }),
          el('td', null, el('div', { class: 'name' }, el('b', { text: r.name }), el('span', { class: 'sub', text: (r.category || 'Other') + ' on ' + (r.chains && r.chains.length ? r.chains.slice(0, 3).join(', ') : 'an unnamed chain') }))),
          el('td', { class: 'num', text: fmtUsd(r.tvl_usd) }),
          el('td', { class: 'num ' + (r.change_7d !== null && r.change_7d >= 0 ? 'pos' : 'neg'), text: fmtPct(r.change_7d) }),
          el('td', { class: 'num', text: fmtUsd(r.mcap_usd) }),
          el('td', null, el('span', { class: 'status live', text: 'already trades' }))
        ));
      });
      count.textContent = DATA.live.length + ' live-token protocols';
      empty.hidden = true;
      return;
    }
    var list = sortedRows(filteredRows());
    count.textContent = list.length + ' of ' + DATA.board_size + ' rows shown';
    empty.hidden = list.length !== 0;
    if (list.length === 0) return;
    var max = 0;
    list.forEach(function (r) { if (r.implied_value_usd > max) max = r.implied_value_usd; });
    list.forEach(function (r) {
      var growth = r.change_7d === null ? 'n/a' : fmtPct(r.change_7d);
      var growthClass = r.change_7d === null ? '' : r.change_7d >= 0 ? 'pos' : 'neg';
      var nameCell = el('div', { class: 'name' },
        el('b', { text: r.name }),
        el('span', { class: 'sub', text: (r.category || 'Other') + ' on ' + (r.chains && r.chains.length ? r.chains.slice(0, 2).join(', ') : 'an unnamed chain') })
      );
      if (WATCH[r.slug]) nameCell.appendChild(el('span', { class: 'watch', text: 'WATCHLIST' }));
      var tr = el('tr', {
        class: r.rank <= 3 ? 'top3' : null,
        'data-selected': state.selected === r.slug ? 'true' : 'false',
        tabindex: '0',
        onclick: function () { openDetail(r.slug); },
        onkeydown: function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openDetail(r.slug); } }
      },
        el('td', { class: 'rank-num', text: String(r.rank) }),
        el('td', null, nameCell),
        el('td', { class: 'num', text: fmtUsd(r.tvl_usd) }),
        el('td', { class: 'num ' + growthClass, text: growth }),
        el('td', { class: 'num', text: fmtAge(r.age_days) }),
        el('td', null, el('div', { class: 'implied' },
          el('div', { class: 'bar', 'aria-hidden': 'true' }, el('i', { style: 'width:' + Math.max(3, Math.round((r.implied_value_usd / max) * 100)) + '%' })),
          el('span', { class: 'num', text: fmtUsd(r.implied_value_usd) })
        )),
        el('td', null, el('span', { class: 'status', text: 'no token' }))
      );
      app.appendChild(tr);
    });
  }

  // ---- detail view ----------------------------------------------------------------------
  function openDetail(slug) {
    var row = null;
    DATA.rows.forEach(function (r) { if (r.slug === slug) row = r; });
    if (!row) return;
    state.selected = slug;
    writeHash();
    dialog.textContent = '';
    var rec = impliedOf(row, DATA.model);
    var steps = farmSteps(row);
    var totals = planTotals(row);
    dialog.appendChild(el('div', { class: 'detail-head' },
      el('div', null,
        el('span', { class: 'brand-name', text: 'Rank ' + row.rank + ' of ' + DATA.board_size + (WATCH[row.slug] ? ' · WATCHLIST' : '') }),
        el('h2', { id: 'detail-title', text: row.name }),
        el('p', { class: 'sub', text: (row.category || 'Other') + ' on ' + (row.chains && row.chains.length ? row.chains.join(', ') : 'an unnamed chain') + ' · listed ' + (row.listed_at || 'unknown') })
      ),
      el('button', { class: 'close', type: 'button', 'aria-label': 'Close details', text: 'Close', onclick: function () { dialog.close(); } })
    ));
    dialog.appendChild(el('section', { class: 'detail-section' },
      el('h3', { text: 'Implied value' }),
      el('div', { class: 'equation' },
        el('div', null, el('span', { text: 'TVL' }), el('b', { class: 'num', text: fmtUsd(row.tvl_usd) })),
        el('div', null, el('span', { text: 'Seven-day growth' }), el('b', { class: 'num', text: fmtPct(row.change_7d) })),
        el('div', null, el('span', { text: 'Age with no token' }), el('b', { class: 'num', text: fmtAge(row.age_days) })),
        el('div', null, el('span', { text: 'Chains' }), el('b', { class: 'num', text: String((row.chains || []).length) })),
        el('div', null, el('span', { text: 'TVL base' }), el('b', { class: 'num', text: fmtUsd(rec.base) })),
        el('div', null, el('span', { text: 'Growth multiplier' }), el('b', { class: 'num', text: rec.growthMult.toFixed(4) })),
        el('div', null, el('span', { text: 'Maturity multiplier' }), el('b', { class: 'num', text: rec.maturityMult.toFixed(4) })),
        el('div', null, el('span', { text: 'Chain multiplier' }), el('b', { class: 'num', text: rec.chainMult.toFixed(4) })),
        el('div', { class: 'total' }, el('span', { text: 'Implied value' }), el('b', { class: 'num', text: fmtUsd(row.implied_value_usd) }))
      ),
      el('p', { class: 'sub', text: 'Model ' + DATA.model_version + ': the page recomputes this row as ' + fmtUsd(rec.implied) + (rec.implied === row.implied_value_usd ? ' — the same number board.json carries.' : ' — which differs from the board: the data would be stale.') + ' This is an estimate, not a price.' })
    ));
    dialog.appendChild(el('section', { class: 'detail-section' },
      el('h3', { text: 'Farm plan — 8 steps' }),
      el('ol', { class: 'steps' }, steps.map(function (s) {
        var at = s.indexOf(' Cost: ');
        var action = at >= 0 ? s.slice(0, at) : s;
        var tail = at >= 0 ? s.slice(at + 1) : '';
        return el('li', null, el('b', { text: action }), el('span', { class: 'cost', text: tail }));
      })),
      el('div', { class: 'plan-totals' },
        el('span', { html: 'Capital <b>$' + totals.capital + '</b>' }),
        el('span', { html: 'One-off gas ≈ <b>' + money(totals.oneOffGas) + '</b>' }),
        el('span', { html: 'Weekly gas ≈ <b>' + money(totals.weeklyGas) + '</b>' }),
        el('span', { html: 'Hold <b>' + totals.hold + ' days</b>' })
      )
    ));
    if (typeof dialog.showModal === 'function') {
      if (!dialog.open) dialog.showModal();
    } else {
      dialog.setAttribute('open', '');
    }
  }
  dialog.addEventListener('close', function () { state.selected = null; writeHash(); });

  // ---- hash + render ----------------------------------------------------------------------
  function readHash() {
    var hash = window.location.hash.replace(/^#/, '');
    if (!hash) return;
    var params = new URLSearchParams(hash);
    if (params.get('q')) state.q = params.get('q');
    if (params.get('p')) state.selected = params.get('p');
    if (params.get('category')) state.category = params.get('category');
    if (params.get('chain')) state.chain = params.get('chain');
    if (params.get('min-tvl')) state.minTvl = Number(params.get('min-tvl')) || 0;
    if (params.get('tab')) state.tab = params.get('tab');
    if (params.get('sort')) state.sort = params.get('sort');
  }
  function writeHash() {
    var params = new URLSearchParams();
    if (state.q) params.set('q', state.q);
    if (state.category !== 'all') params.set('category', state.category);
    if (state.chain !== 'all') params.set('chain', state.chain);
    if (state.minTvl) params.set('min-tvl', String(state.minTvl));
    if (state.tab !== 'pre-token') params.set('tab', state.tab);
    if (state.selected) params.set('p', state.selected);
    var next = params.toString();
    if (next) window.history.replaceState(null, '', '#' + next);
    else window.history.replaceState(null, '', window.location.pathname + window.location.search);
  }

  function render() {
    if (state.tab === 'live' && state.sort === 'implied') state.sort = 'mcap';
    if (state.tab === 'pre-token' && state.sort === 'mcap') state.sort = 'implied';
    document.getElementById('tab-pre').setAttribute('aria-pressed', state.tab === 'pre-token' ? 'true' : 'false');
    document.getElementById('tab-live').setAttribute('aria-pressed', state.tab === 'live' ? 'true' : 'false');
    renderHead();
    renderRows();
    if (state.selected) openDetail(state.selected);
  }

  readHash();
  initChrome();
  initControls();
  render();
  window.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && dialog.open) dialog.close();
  });
})();
