const $ = id => document.getElementById(id);
const COLUMNS = [
  {key: 'custom_oi', label: 'CUSTOM OI', sum: 1},
  {key: 'oi', label: 'OPEN INT.', sum: 1},
  {key: 'coi', label: 'CHG IN OI', sum: 1, signed: 1},
  {key: 'coi_pct', label: 'OI CHG %', signed: 1, d: 2},
  {key: 'volume', label: 'VOLUME', sum: 1},
  {key: 'iv', label: 'IV', d: 2},
  {key: 'delta', label: 'DELTA', d: 4, signed: 1},
  {key: 'custom_delta', label: 'CUSTOM Δ', d: 4, signed: 1},
  {key: 'gamma', label: 'GAMMA', d: 4},
  {key: 'theta', label: 'THETA', d: 2, signed: 1},
  {key: 'vega', label: 'VEGA', d: 2},
  {key: 'bid_size', label: 'BID QTY', sum: 1},
  {key: 'bid', label: 'BID', d: 2},
  {key: 'ask', label: 'ASK', d: 2},
  {key: 'ask_size', label: 'ASK QTY', sum: 1},
  {key: 'ltp_change', label: 'LTP CHANGE', d: 2, signed: 1},
  {key: 'ltp', label: 'LTP', d: 2},
];
const DEFAULT_COLS = ['oi', 'coi', 'volume', 'iv', 'ltp_change', 'ltp'];
const store = {
  get(k, fallback) { try { const v = localStorage.getItem(k); return v == null ? fallback : JSON.parse(v); } catch (e) { return fallback; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} },
};
const st = {
  symbol: store.get('upstox-symbol', 'NIFTY'), expiry: '', data: null, loading: false,
  visible: new Set(store.get('upstox-cols', DEFAULT_COLS)), strikes: store.get('upstox-strikes', '30'),
};
const fmt = (n, d = 0) => n == null || !Number.isFinite(Number(n)) ? '—' : Number(n).toLocaleString('en-IN', {minimumFractionDigits: d, maximumFractionDigits: d});
const signed = (n, d) => n == null ? '—' : `${n > 0 ? '+' : n < 0 ? '−' : ''}${fmt(Math.abs(n), d)}`;
const esc = s => String(s).replace(/[&<>"]/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;'}[c]));

function cell(row, c) {
  if (!row || row[c.key] == null) return '—';
  const n = row[c.key];
  if (c.key === 'ltp_change') {
    const cls = n > 0 ? 'positive' : n < 0 ? 'negative' : '';
    return `<span class="${cls}" title="Previous close ${fmt(row.prev_close, 2)}">${signed(n, 2)}<small>${row.ltp_change_pct == null ? '' : signed(row.ltp_change_pct, 2) + '%'}</small></span>`;
  }
  if (c.key === 'custom_delta') return `<span title="Option LTP change ÷ index change">${signed(n, 4)}</span>`;
  if (c.signed) return `<span class="${n > 0 ? 'positive' : n < 0 ? 'negative' : ''}">${signed(n, c.d || 0)}</span>`;
  return fmt(n, c.d || 0);
}

function renderColumnMenu() {
  $('columnOptions').innerHTML = COLUMNS.map(c => `<label class="column-option"><input type="checkbox" data-col="${c.key}" ${st.visible.has(c.key) ? 'checked' : ''}> ${c.label}</label>`).join('')
    + '<button class="outline-button" id="resetCols" style="width:100%;margin-top:8px">Reset to default</button>';
  document.querySelectorAll('[data-col]').forEach(el => el.addEventListener('change', e => {
    e.target.checked ? st.visible.add(e.target.dataset.col) : st.visible.delete(e.target.dataset.col);
    store.set('upstox-cols', [...st.visible]); renderTable();
  }));
  $('resetCols').addEventListener('click', () => { st.visible = new Set(DEFAULT_COLS); store.set('upstox-cols', DEFAULT_COLS); renderColumnMenu(); renderTable(); });
}

function renderTable() {
  const fields = COLUMNS.filter(c => st.visible.has(c.key)), calls = fields, puts = [...fields].reverse();
  $('columnCount').textContent = fields.length;
  $('chainTable').querySelector('thead').innerHTML = `<tr><th class="group-call" colspan="${calls.length}">CALLS</th><th class="strike-head strike-top" rowspan="2">STRIKE</th><th class="group-put" colspan="${puts.length}">PUTS</th></tr><tr>${calls.map(c => `<th class="call-head">${c.label}</th>`).join('')}${puts.map(c => `<th class="put-head">${c.label}</th>`).join('')}</tr>`;
  const body = $('chainTable').querySelector('tbody'), foot = $('chainTable').querySelector('tfoot');
  const d = st.data;
  if (!d || !d.rows.length) { foot.innerHTML = ''; return; }
  const spot = d.spot, pairs = [...d.rows].sort((a, b) => a.strike - b.strike);
  const atm = pairs.reduce((b, p) => Math.abs(p.strike - spot) < Math.abs(b.strike - spot) ? p : b, pairs[0]);
  const center = pairs.indexOf(atm), half = Math.floor(Number(st.strikes) / 2);
  const shown = st.strikes === 'all' ? pairs : pairs.slice(Math.max(0, center - half), center + half + 1);
  // Percentage of each column's maximum (absolute value) across all strikes.
  const pct = {Call: {}, Put: {}};
  for (const side of ['Call', 'Put']) for (const c of fields) {
    const max = Math.max(0, ...pairs.map(p => Math.abs(Number(p[side]?.[c.key]))).filter(Number.isFinite));
    pct[side][c.key] = p => { const v = Math.abs(Number(p[side]?.[c.key])); return max && Number.isFinite(v) ? v / max * 100 : null; };
  }
  const side = (p, s, list) => list.map(c => {
    const v = pct[s][c.key](p), otm = s === 'Call' ? p.strike > spot : p.strike < spot;
    const tone = v != null && v >= 75 ? (v >= 99 && otm ? 'pct-blue' : `pct-yellow pct-${Math.floor(v / 5) * 5}`) : '';
    const itm = otm ? '' : ' itm';
    return `<td class="${s === 'Call' ? 'call-cell' : 'put-cell'}${itm} field-${c.key} ${tone}">${cell(p[s], c)}${v != null ? `<small class="cell-pct">${fmt(v, 0)}%</small>` : ''}</td>`;
  }).join('');
  body.innerHTML = shown.map(p => `<tr class="strike-row ${p === atm ? 'spot-row' : ''}">${side(p, 'Call', calls)}<td class="strike-cell">${fmt(p.strike, p.strike % 1 ? 2 : 0)}${p === atm ? '<span class="spot-tag">ATM</span>' : ''}</td>${side(p, 'Put', puts)}</tr>`).join('');
  const total = (s, c) => {
    const vals = shown.map(p => Number(p[s]?.[c.key])).filter(Number.isFinite);
    if (!vals.length) return '—';
    const v = vals.reduce((a, b) => a + b, 0) / (c.sum ? 1 : vals.length);
    return c.signed ? signed(v, c.d || 0) : fmt(v, c.d || 0);
  };
  foot.innerHTML = `<tr>${calls.map(c => `<td class="total-cell" title="${c.sum ? 'Total' : 'Average'} of shown strikes">${total('Call', c)}</td>`).join('')}<td class="strike-cell total-label">TOTAL / AVG</td>${puts.map(c => `<td class="total-cell" title="${c.sum ? 'Total' : 'Average'} of shown strikes">${total('Put', c)}</td>`).join('')}</tr>`;
  $('rowCount').textContent = `${shown.length} of ${pairs.length} strikes`;
}

function renderSummary() {
  const d = st.data;
  $('underlying').textContent = fmt(d.spot, 2);
  $('symbolLabel').textContent = `${d.symbol} · INR`;
  const chg = d.index_change, lot = d.lot_size ? ` · Lot ${fmt(d.lot_size)}` : '';
  $('lotSize').className = `price-change ${chg > 0 ? 'positive' : chg < 0 ? 'negative' : ''}`;
  $('lotSize').textContent = (chg == null ? 'Change unavailable' : `${signed(chg, 2)} (${signed(d.index_change_pct, 2)}%)`) + lot;
  $('expiryBadge').textContent = d.expiry;
  $('updated').textContent = `Updated ${new Date(d.updated).toLocaleTimeString([], {hour: '2-digit', minute: '2-digit', second: '2-digit'})}`;
  const sum = (s, k) => d.rows.reduce((a, r) => a + (Number(r[s]?.[k]) || 0), 0);
  const co = sum('Call', 'oi'), po = sum('Put', 'oi');
  $('callOi').textContent = fmt(co); $('putOi').textContent = fmt(po);
  $('callCoi').textContent = `Change ${signed(sum('Call', 'coi'), 0)}`; $('putCoi').textContent = `Change ${signed(sum('Put', 'coi'), 0)}`;
  $('pcr').textContent = co ? (po / co).toFixed(2) : '—';
  const atm = d.rows.reduce((b, r) => Math.abs(r.strike - d.spot) < Math.abs(b.strike - d.spot) ? r : b, d.rows[0]);
  const ivs = [atm?.Call?.iv, atm?.Put?.iv].filter(v => v != null && v > 0);
  $('atmIv').textContent = ivs.length ? `${fmt(ivs.reduce((a, b) => a + b, 0) / ivs.length, 2)}%` : '—';
  $('expiry').innerHTML = d.expiries.map(x => `<option value="${x}"${x === d.expiry ? ' selected' : ''}>${x.split('-').reverse().join('-')}</option>`).join('');
}

function showMessage(html, isError) {
  const cols = st.visible.size * 2 + 1;
  $('chainTable').querySelector('tbody').innerHTML = `<tr><td colspan="${cols}"><div class="${isError ? 'error-banner' : 'login-note'}">${html}</div></td></tr>`;
}

async function load(initial = false) {
  if (st.loading) return;
  st.loading = true;
  $('refresh').classList.add('is-loading'); $('refreshTop').classList.add('is-loading');
  if (initial || !st.data) showMessage('<span class="loader"></span> Loading from Upstox. If the daily token has expired, the server logs in automatically first (up to about a minute)…');
  try {
    const res = await fetch(`/api/upstox/chain?symbol=${encodeURIComponent(st.symbol)}&expiry=${encodeURIComponent(st.expiry)}`, {cache: 'no-store'});
    const data = await res.json();
    if (!res.ok) throw Error(data.error || `HTTP ${res.status}`);
    st.data = data; st.expiry = data.expiry; store.set('upstox-symbol', st.symbol);
    renderSummary(); renderTable(); $('chainTable').classList.remove('feed-stale');
    setStatus(true);
  } catch (err) {
    if (st.data && st.data.symbol === st.symbol) {
      $('chainTable').classList.add('feed-stale');
      $('updated').textContent = `Refresh failed · showing last data · ${err.message}`;
    } else {
      st.data = null; renderTable();
      showMessage(esc(err.message), true);
      $('updated').textContent = 'Upstox feed unavailable';
    }
    setStatus(false);
  } finally {
    st.loading = false;
    $('refresh').classList.remove('is-loading'); $('refreshTop').classList.remove('is-loading');
  }
}

function setStatus(ok) {
  $('statusDot').style.background = ok ? '' : 'var(--red)';
  $('statusText').textContent = ok ? 'UPSTOX CONNECTED' : 'UPSTOX ERROR';
}

function selectSymbol(sym) {
  sym = sym.trim().toUpperCase();
  if (!sym || sym === st.symbol) return;
  st.symbol = sym; st.expiry = ''; st.data = null;
  load(true);
}

function applyTheme(theme) {
  document.body.classList.toggle('light', theme === 'light');
  try { localStorage.setItem('delta-theme', theme); } catch (e) {}
  $('themeToggle').innerHTML = theme === 'light' ? '◐ <span>Dark</span>' : '☼ <span>Light</span>';
}

// Controls
fetch('/api/upstox/symbols').then(r => r.json()).then(j => {
  const indices = j.indices || ['NIFTY', 'BANKNIFTY', 'FINNIFTY', 'MIDCPNIFTY'];
  $('symbol').innerHTML = indices.map(s => `<option${s === st.symbol ? ' selected' : ''}>${s}</option>`).join('') + (indices.includes(st.symbol) ? '' : `<option selected>${esc(st.symbol)}</option>`);
  $('stockList').innerHTML = (j.stocks || []).map(s => `<option value="${esc(s)}">`).join('');
}).catch(() => { $('symbol').innerHTML = `<option>${esc(st.symbol)}</option>`; });
$('symbol').addEventListener('change', e => { $('stock').value = ''; selectSymbol(e.target.value); });
$('stock').addEventListener('change', e => selectSymbol(e.target.value));
$('expiry').addEventListener('change', e => { st.expiry = e.target.value; load(true); });
$('strikeCount').value = st.strikes;
$('strikeCount').addEventListener('change', e => { st.strikes = e.target.value; store.set('upstox-strikes', st.strikes); renderTable(); });
$('refresh').addEventListener('click', () => load());
$('refreshTop').addEventListener('click', () => load());
$('relogin').addEventListener('click', async () => {
  const b = $('relogin'); b.disabled = true; b.textContent = 'Logging in…';
  try {
    const r = await fetch('/api/upstox/relogin', {method: 'POST'});
    if (!r.ok) throw Error((await r.json()).error);
    load();
  } catch (err) { $('updated').textContent = `Login failed: ${err.message}`; setStatus(false); }
  finally { b.disabled = false; b.textContent = 'Re-login'; }
});
$('columnsBtn').addEventListener('click', e => { e.stopPropagation(); $('columnMenu').classList.toggle('hidden'); });
document.addEventListener('click', e => { if (!$('columnMenu').contains(e.target)) $('columnMenu').classList.add('hidden'); });
$('themeToggle').addEventListener('click', () => applyTheme(document.body.classList.contains('light') ? 'dark' : 'light'));
let savedTheme = 'dark'; try { savedTheme = localStorage.getItem('delta-theme') || 'dark'; } catch (e) {}
applyTheme(savedTheme);
renderColumnMenu(); renderTable(); load(true);

// Refresh every 15 s while the tab is visible.
setInterval(() => { if (!document.hidden) load(); }, 15000);

// Drag to scroll the chain sideways (same behaviour as the crypto chain).
const scroller = document.querySelector('.chain-table-wrap');
let drag = null;
scroller.addEventListener('pointerdown', e => { if (scroller.scrollWidth <= scroller.clientWidth || (e.pointerType === 'mouse' && e.button !== 0)) return; drag = {id: e.pointerId, x: e.clientX, y: e.clientY, left: scroller.scrollLeft}; });
scroller.addEventListener('pointermove', e => { if (!drag || drag.id !== e.pointerId) return; const dx = e.clientX - drag.x, dy = e.clientY - drag.y; if (Math.abs(dx) > 8 && Math.abs(dx) > Math.abs(dy)) { e.preventDefault(); scroller.scrollLeft = drag.left - dx; scroller.classList.add('is-dragging'); } }, {passive: false});
const endDrag = () => { drag = null; scroller.classList.remove('is-dragging'); };
scroller.addEventListener('pointerup', endDrag); scroller.addEventListener('pointercancel', endDrag);
scroller.addEventListener('pointerleave', e => { if (e.pointerType === 'mouse') endDrag(); });
scroller.addEventListener('wheel', e => { if (e.shiftKey && scroller.scrollWidth > scroller.clientWidth) { e.preventDefault(); scroller.scrollLeft += e.deltaY || e.deltaX; } }, {passive: false});
