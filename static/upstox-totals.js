const $ = id => document.getElementById(id);
const OPTION_COLUMNS = window.UPSTOX_COLUMNS;
// Summed across expiries in the TOTAL row (matches how the server totals each expiry); others are averaged.
const SUM_KEYS = new Set(['custom_oi', 'oi', 'coi', 'volume', 'bid_size', 'ask_size', 'delta', 'theta', 'vega']);
const store = {
  get(k, fallback) { try { const v = localStorage.getItem(k); return v == null ? fallback : JSON.parse(v); } catch (e) { return fallback; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} },
};
const params = new URLSearchParams(location.search);
const st = {
  symbol: (params.get('symbol') || store.get('upstox-symbol', 'NIFTY')).toUpperCase(),
  rows: [], loading: false,
  visible: new Set(store.get('upstox-totals-cols', ['strikes', 'custom_oi', 'oi', 'coi', 'volume'])),
};
const fmt = (n, d = 2) => n == null || !Number.isFinite(Number(n)) ? '—' : Number(n).toLocaleString('en-IN', {minimumFractionDigits: 0, maximumFractionDigits: d});
const signed = (n, d) => n == null ? '—' : `${n > 0 ? '+' : n < 0 ? '−' : ''}${fmt(Math.abs(n), d)}`;
const esc = s => String(s).replace(/[&<>"]/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;'}[c]));
const dmy = iso => iso.split('-').reverse().join('-');

function value(n, col) {
  if (n == null || !Number.isFinite(Number(n))) return '—';
  if (col.signed) return `<span class="${n > 0 ? 'positive' : n < 0 ? 'negative' : ''}">${signed(n, col.d ?? 2)}</span>`;
  return fmt(n, col.d ?? 2);
}

function setupColumns() {
  const menu = [{key: 'strikes', label: 'STRIKES'}, ...OPTION_COLUMNS];
  $('totalsColumnOptions').innerHTML = menu.map(c => `<label class="column-option"><input type="checkbox" data-total-col="${c.key}" ${st.visible.has(c.key) ? 'checked' : ''}> ${c.label}</label>`).join('');
  document.querySelectorAll('[data-total-col]').forEach(x => x.onchange = () => {
    x.checked ? st.visible.add(x.dataset.totalCol) : st.visible.delete(x.dataset.totalCol);
    store.set('upstox-totals-cols', [...st.visible]); render();
  });
}

function render() {
  const selected = [...$('expiryFilter').selectedOptions].map(o => o.value);
  const shown = st.rows.filter(r => !selected.length || selected.includes(r.expiry));
  const opts = OPTION_COLUMNS.filter(c => st.visible.has(c.key));
  const showStrikes = st.visible.has('strikes');
  $('totalsColumnCount').textContent = opts.length + 1 + (showStrikes ? 1 : 0);
  $('totalsTable').querySelector('thead').innerHTML = `<tr><th>EXPIRY</th>${showStrikes ? '<th>STRIKES</th>' : ''}${opts.map(c => `<th class="call-head">CALL ${c.label}</th>`).join('')}${opts.map(c => `<th class="put-head">PUT ${c.label}</th>`).join('')}</tr>`;
  const span = 1 + (showStrikes ? 1 : 0) + opts.length * 2;
  if (!shown.length) { $('totals').innerHTML = `<tr><td colspan="${span}" class="empty-state">No expiries to show.</td></tr>`; $('totalsFoot').innerHTML = ''; return; }
  $('totals').innerHTML = shown.map(r => r.error
    ? `<tr><td>${dmy(r.expiry)}</td><td colspan="${span - 1}" class="row-error">${esc(r.error)}</td></tr>`
    : `<tr><td>${dmy(r.expiry)}</td>${showStrikes ? `<td>${fmt(r.strikes, 0)}</td>` : ''}${opts.map(c => `<td class="call-cell">${value(r.call[c.key], c)}</td>`).join('')}${opts.map(c => `<td class="put-cell">${value(r.put[c.key], c)}</td>`).join('')}</tr>`).join('');
  const ok = shown.filter(r => !r.error);
  const total = (side, c) => {
    const vals = ok.map(r => Number(r[side][c.key])).filter(Number.isFinite);
    if (!vals.length) return '—';
    const sum = vals.reduce((a, b) => a + b, 0);
    return value(SUM_KEYS.has(c.key) ? sum : sum / vals.length, c);
  };
  $('totalsFoot').innerHTML = `<tr><td class="total-cell total-label">TOTAL</td>${showStrikes ? `<td class="total-cell">${fmt(ok.reduce((s, r) => s + (r.strikes || 0), 0), 0)}</td>` : ''}${opts.map(c => `<td class="total-cell">${total('call', c)}</td>`).join('')}${opts.map(c => `<td class="total-cell">${total('put', c)}</td>`).join('')}</tr>`;
}

function applyData(d) {
  st.rows = d.totals || [];
  const sel = $('expiryFilter'), old = [...sel.selectedOptions].map(o => o.value);
  sel.innerHTML = st.rows.map(r => `<option value="${r.expiry}">${dmy(r.expiry)}</option>`).join('');
  // Default selection: this month's expiries (same as the crypto totals page).
  const now = new Date(), month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  const keep = old.filter(v => st.rows.some(r => r.expiry === v));
  const selected = keep.length ? keep : st.rows.filter(r => r.expiry.startsWith(month)).map(r => r.expiry);
  [...sel.options].forEach(o => o.selected = selected.includes(o.value));
  const chg = d.index_change;
  $('spotLine').innerHTML = `${esc(d.symbol)} ${fmt(d.spot, 2)} ${chg == null ? '' : `<span class="${chg > 0 ? 'positive' : chg < 0 ? 'negative' : ''}">${signed(chg, 2)}</span>`}`;
  $('status').textContent = `Updated ${new Date(d.updated).toLocaleTimeString([], {hour: '2-digit', minute: '2-digit', second: '2-digit'})}`;
  render();
}

async function load() {
  if (st.loading) return;
  st.loading = true;
  $('totalsRefresh').classList.add('is-loading');
  const cacheKey = `upstox-totals-${st.symbol}`, cached = store.get(cacheKey, null);
  if (cached && cached.symbol === st.symbol) applyData(cached);
  $('status').textContent = 'Loading all expiries…';
  $('chainLink').href = `/upstox?symbol=${encodeURIComponent(st.symbol)}`;
  try {
    const r = await fetch(`/api/upstox/totals?symbol=${encodeURIComponent(st.symbol)}`, {cache: 'no-store'});
    const d = await r.json();
    if (!r.ok) throw Error(d.error || `HTTP ${r.status}`);
    store.set(cacheKey, d); store.set('upstox-symbol', st.symbol);
    applyData(d);
  } catch (err) {
    $('status').textContent = err.message;
    if (!cached) $('totals').innerHTML = `<tr><td colspan="20"><div class="error-banner">${esc(err.message)}</div></td></tr>`;
  } finally {
    st.loading = false;
    $('totalsRefresh').classList.remove('is-loading');
  }
}

function selectSymbol(sym) {
  sym = sym.trim().toUpperCase();
  if (!sym || sym === st.symbol) return;
  st.symbol = sym; st.rows = [];
  $('expiryFilter').innerHTML = '';
  history.replaceState(null, '', `?symbol=${encodeURIComponent(sym)}`);
  load();
}

function applyTheme(theme) {
  document.body.classList.toggle('light', theme === 'light');
  try { localStorage.setItem('delta-theme', theme); } catch (e) {}
  $('themeToggle').innerHTML = theme === 'light' ? '◐ <span>Dark</span>' : '☼ <span>Light</span>';
}

fetch('/api/upstox/symbols').then(r => r.json()).then(j => {
  const indices = j.indices || ['NIFTY', 'BANKNIFTY', 'FINNIFTY', 'MIDCPNIFTY'];
  $('symbol').innerHTML = indices.map(s => `<option${s === st.symbol ? ' selected' : ''}>${s}</option>`).join('') + (indices.includes(st.symbol) ? '' : `<option selected>${esc(st.symbol)}</option>`);
  $('stockList').innerHTML = (j.stocks || []).map(s => `<option value="${esc(s)}">`).join('');
}).catch(() => { $('symbol').innerHTML = `<option>${esc(st.symbol)}</option>`; });
$('symbol').addEventListener('change', e => { $('stock').value = ''; selectSymbol(e.target.value); });
$('stock').addEventListener('change', e => selectSymbol(e.target.value));
$('expiryFilter').onchange = render;
$('totalsRefresh').onclick = load;
$('totalsColumnsBtn').onclick = e => { e.stopPropagation(); $('totalsColumnMenu').classList.toggle('hidden'); };
document.addEventListener('click', e => { if (!$('totalsColumnMenu').contains(e.target)) $('totalsColumnMenu').classList.add('hidden'); });
$('themeToggle').addEventListener('click', () => applyTheme(document.body.classList.contains('light') ? 'dark' : 'light'));
let savedTheme = 'dark'; try { savedTheme = localStorage.getItem('delta-theme') || 'dark'; } catch (e) {}
applyTheme(savedTheme);
setupColumns(); load();
