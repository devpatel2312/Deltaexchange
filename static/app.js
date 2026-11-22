const API='/api';
const columns=window.OPTION_COLUMNS;
let asset='BTC',rows=[],underlying=null,visible=new Set(['delta','custom_delta','ltp_change','ltp']),strikeLimit=3,refreshTimer=null,hasLoaded=false,loading=false;
const $=id=>document.getElementById(id);
const fmt=(n,d=2)=>n==null||!Number.isFinite(Number(n))?'—':Number(n).toLocaleString('en-IN',{minimumFractionDigits:d,maximumFractionDigits:d});
const qtyFmt=n=>{if(n==null)return '—';const x=Number(n),d=x===0||Math.abs(x)>=100?0:Math.abs(x)<1?3:2;return fmt(x,d)};
const ivPct=n=>n==null?null:(n<3?n*100:n);

function renderColumnMenu(){
  $('columnOptions').innerHTML=columns.map(c=>`<label class="column-option"><input type="checkbox" data-col="${c.key}" ${visible.has(c.key)?'checked':''}> ${c.label}</label>`).join('');
  document.querySelectorAll('[data-col]').forEach(el=>el.addEventListener('change',e=>{e.target.checked?visible.add(e.target.dataset.col):visible.delete(e.target.dataset.col);renderTable()}));
  $('columnCount').textContent=visible.size;
}
function value(row,key){if(row[key]==null){if(key==='ltp_change')return '<span title="No previous close or Delta 24-hour change available">—</span>';if(key==='custom_delta')return `<span title="${row.ltp_change===0?'Option LTP change is zero; division is undefined':'Matched index change is unavailable'}">—</span>`;return '—'}const n=row[key];if(key==='iv')return `${fmt(ivPct(n),1)}%`;if(['oi','volume','bid_size','ask_size'].includes(key))return qtyFmt(n);if(key==='custom_delta'||key==='delta'||key==='gamma')return fmt(n,4);if(key==='theta'||key==='vega')return fmt(n,3);if(key==='ltp_change'){const sign=n>0?'+':n<0?'−':'',basis=row.ltp_change_basis==='rolling_24h_fallback'?'Delta rolling 24-hour fallback; previous UTC close unavailable':`Previous UTC daily close: ${fmt(row.previous_close,2)}`,suffix=row.ltp_change_basis==='rolling_24h_fallback'?' · 24h fallback':'';return `<span class="${n>0?'positive':n<0?'negative':''}" title="${basis}">${sign}${fmt(Math.abs(n),2)}<small>${n>0?'+':n<0?'−':''}${fmt(Math.abs(row.ltp_change_pct),2)}%${suffix}</small></span>`}return fmt(n,2)}
function renderTable(){
  const fields=columns.filter(c=>visible.has(c.key));$('columnCount').textContent=fields.length;
  const calls=fields,puts=[...fields].reverse(),strikeCol='<th class="strike-head strike-top" rowspan="2">STRIKE</th>';
  $('chainTable').querySelector('thead').innerHTML=`<tr><th class="group-call" colspan="${calls.length}">CALLS</th>${strikeCol}<th class="group-put" colspan="${puts.length}">PUTS</th></tr><tr>${calls.map(c=>`<th class="call-head">${c.label}</th>`).join('')} ${puts.map(c=>`<th class="put-head">${c.label}</th>`).join('')}</tr>`;
  const body=$('chainTable').querySelector('tbody');
  if(!rows.length){body.innerHTML=`<tr><td colspan="${fields.length*2+1}" class="empty-state">No contracts returned for this expiry.</td></tr>`;return;}
  const byStrike=new Map();
  for(const row of rows){if(row.strike==null)continue;const key=String(row.strike);if(!byStrike.has(key))byStrike.set(key,{strike:Number(row.strike),Call:null,Put:null});byStrike.get(key)[row.type]=row;}
  const pairs=[...byStrike.values()].sort((a,b)=>a.strike-b.strike);
  const spotPair=pairs.reduce((best,p)=>!best||Math.abs(p.strike-(underlying||0))<Math.abs(best.strike-(underlying||0))?p:best,null);
  const center=Math.max(0,pairs.indexOf(spotPair));const shown=strikeLimit==='all'?pairs:pairs.slice(Math.max(0,center-Number(strikeLimit)),center+Number(strikeLimit)+1);
  const ranks={Call:{},Put:{}};
  for(const side of ['Call','Put'])for(const field of fields){if(['oi','volume','iv','ltp','ltp_change','bid_size','ask_size','mark','custom_delta','delta','gamma','theta','vega','bid','ask'].includes(field.key)){const vals=pairs.map((p,i)=>({v:Number(p[side]?.[field.key]),i})).filter(x=>Number.isFinite(x.v));const max=Math.max(0,...vals.map(x=>Math.abs(x.v)));ranks[side][field.key]={pct:new Map(vals.map(x=>[x.i,max?Math.abs(x.v)/max*100:0]))};}}
  const renderSide=(pair,index,side,fieldList)=>fieldList.map(c=>{const row=pair[side],rank=ranks[side][c.key],pct=rank?.pct.get(index),otm=side==='Call'?pair.strike>underlying:pair.strike<underlying,tone=rank&&pct>=75?(pct>=99&&otm?'pct-blue':`pct-yellow pct-${Math.floor(pct/5)*5}`):'';const title=c.key==='custom_delta'?'Displayed index price change ÷ displayed option LTP change':'';return `<td class="${side==='Call'?'call-cell':'put-cell'} field-${c.key} ${tone}" ${title?`title="${title}"`:''}>${row?`${value(row,c.key)}${pct!=null?`<small class="cell-pct">${fmt(pct,0)}%</small>`:''}`:'—'}</td>`}).join('');
  body.innerHTML=shown.map(p=>{const i=pairs.indexOf(p);return `<tr class="strike-row ${p===spotPair?'spot-row':''}">${renderSide(p,i,'Call',calls)}<td class="strike-cell">${fmt(p.strike,0)}${p===spotPair?'<span class="spot-tag">SPOT</span>':''}</td>${renderSide(p,i,'Put',puts)}</tr>`}).join('');
  const sums=new Set(['oi','volume','bid_size','ask_size']);
  const total=(side,key)=>{const scoped=key==='ltp_change'?pairs.filter(p=>p[side]?.ltp_change_basis==='previous_utc_close'):pairs,values=scoped.map(p=>Number(p[side]?.[key])).filter(Number.isFinite);if(!values.length)return '—';if(sums.has(key))return qtyFmt(values.reduce((a,b)=>a+b,0));if(key==='iv')return `${fmt(ivPct(values.reduce((a,b)=>a+b,0)/values.length),1)}%`;if(key==='ltp_change'){const avg=values.reduce((a,b)=>a+b,0)/values.length,pcts=scoped.map(p=>Number(p[side]?.ltp_change_pct)).filter(Number.isFinite),pct=pcts.length?pcts.reduce((a,b)=>a+b,0)/pcts.length:null;return `<span>${avg>0?'+':avg<0?'−':''}${fmt(Math.abs(avg),2)}<small>${pct==null?'':`${pct>0?'+':pct<0?'−':''}${fmt(Math.abs(pct),2)}%`}</small></span>`}if(key==='custom_delta'||key==='delta'||key==='gamma')return fmt(values.reduce((a,b)=>a+b,0)/values.length,4);if(key==='theta'||key==='vega')return fmt(values.reduce((a,b)=>a+b,0)/values.length,3);return fmt(values.reduce((a,b)=>a+b,0)/values.length,2)};
  // Put each side's totals directly below its matching columns.
  $('chainTable').querySelector('tfoot').innerHTML=`<tr>${calls.map(c=>`<td class="total-cell">${total('Call',c.key)}</td>`).join('')}<td class="strike-cell total-label">TOTAL / AVG</td>${puts.map(c=>`<td class="total-cell">${total('Put',c.key)}</td>`).join('')}</tr>`;
  $('rowCount').textContent=`${rows.length} contracts · ${pairs.length} strikes`;
}
function updateSummary(data){
  underlying=data.underlying;
  $('underlying').textContent=underlying==null?'—':fmt(underlying,2);
  const change=data.index_change,amount=underlying!=null&&data.index_previous_close!=null?underlying-data.index_previous_close:null,changeEl=$('indexChange');changeEl.className=`price-change ${change>0?'positive':change<0?'negative':''}`;if(change==null||amount==null){changeEl.textContent='Prev. UTC close unavailable';changeEl.removeAttribute('title')}else{const sign=amount>0?'+':amount<0?'−':'',pctSign=change>0?'+':change<0?'−':'';changeEl.textContent=`${sign}${fmt(Math.abs(amount),2)} (${pctSign}${fmt(Math.abs(change),2)}%)`;changeEl.title=`Compared with previous UTC close ${fmt(data.index_previous_close,2)}`}
  $('updated').textContent=`Updated ${new Date(data.updated).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit',second:'2-digit'})}`;
  $('expiryBadge').textContent=data.expiry;
  $('callCount').textContent=rows.filter(r=>r.type==='Call').length;
  $('putCount').textContent=rows.filter(r=>r.type==='Put').length;
  $('openInterest').textContent=qtyFmt(rows.reduce((s,r)=>s+(r.oi||0),0));
  const atm=rows.filter(r=>r.iv!=null&&r.strike!=null&&underlying!=null).sort((a,b)=>Math.abs(a.strike-underlying)-Math.abs(b.strike-underlying))[0];
  $('atmIv').textContent=atm?`${fmt(ivPct(atm.iv),1)}%`:'—';
}
async function loadExpiries(keep=false){
  const sel=$('expiry');sel.innerHTML='<option>Loading…</option>';
  try{const res=await fetch(`${API}/expiries?asset=${asset}`),data=await res.json();if(!res.ok)throw Error(data.error);if(!data.expiries.length)throw Error('No listed expiries found.');sel.innerHTML=data.expiries.map(e=>`<option value="${e}">${e}</option>`).join('');if(keep&&[...sel.options].some(o=>o.value===window.currentExpiry))sel.value=window.currentExpiry;preloadTotals();await loadMarket(true)}catch(err){showError(err.message)}
}
async function loadMarket(initial=false){
  const expiry=$('expiry').value;if(!expiry||expiry==='Loading…'||loading)return;loading=true;window.currentExpiry=expiry;$('refresh').classList.add('is-loading');$('refreshTop').classList.add('is-loading');
  if(initial&&!hasLoaded)$('chainTable').querySelector('tbody').innerHTML=`<tr><td colspan="${visible.size*2+1}" class="empty-state"><span class="loader"></span><br>Loading live option chain…</td></tr>`;
  try{
    const res=await fetch(`${API}/market?asset=${asset}&expiry=${encodeURIComponent(expiry)}`,{cache:'no-store'}),data=await res.json();if(!res.ok)throw Error(data.error);
    const nextRows=data.rows||[];
    const displayedIndexMove=data.underlying!=null&&data.index_previous_close!=null?data.underlying-data.index_previous_close:null;
    for(const row of nextRows){row.custom_delta=row.ltp_change!=null&&row.ltp_change!==0&&displayedIndexMove!=null?displayedIndexMove/row.ltp_change:null;}
    rows=nextRows;updateSummary(data);renderTable();hasLoaded=true;$('chainTable').classList.remove('feed-stale');
  }catch(err){if(hasLoaded){$('chainTable').classList.add('feed-stale');$('updated').textContent='Refresh failed · showing last received data'}else showError(err.message)}
  finally{loading=false;$('refresh').classList.remove('is-loading');$('refreshTop').classList.remove('is-loading')}
}
let totalsLoading=false;async function preloadTotals(){if(totalsLoading)return;totalsLoading=true;try{const r=await fetch(`${API}/totals?asset=${asset}`,{cache:'no-store'}),d=await r.json();if(r.ok)localStorage.setItem(`delta-totals-${asset}`,JSON.stringify(d))}catch(e){}finally{totalsLoading=false}}
function showError(message){$('updated').textContent='Market feed unavailable';$('chainTable').querySelector('tbody').innerHTML=`<tr><td colspan="${visible.size*2+1}"><div class="error-banner">${message} Check your connection and refresh.</div></td></tr>`;}
function applyTheme(theme){document.body.classList.toggle('light',theme==='light');localStorage.setItem('delta-theme',theme);$('themeToggle').innerHTML=theme==='light'?'◐ <span>Dark</span>':'☼ <span>Light</span>';}
document.querySelectorAll('.asset').forEach(b=>b.addEventListener('click',()=>{if(asset===b.dataset.asset)return;asset=b.dataset.asset;hasLoaded=false;document.querySelectorAll('.asset').forEach(x=>x.classList.toggle('active',x===b));loadExpiries()}));
$('expiry').addEventListener('change',()=>{hasLoaded=false;loadMarket(true)});
$('refresh').addEventListener('click',()=>loadMarket(false));$('refreshTop').addEventListener('click',()=>loadMarket(false));
$('columnsBtn').addEventListener('click',e=>{e.stopPropagation();$('columnMenu').classList.toggle('hidden')});document.addEventListener('click',e=>{if(!$('columnMenu').contains(e.target))$('columnMenu').classList.add('hidden')});
$('strikeCount').addEventListener('change',e=>{strikeLimit=e.target.value;renderTable()});
$('themeToggle').addEventListener('click',()=>applyTheme(document.body.classList.contains('light')?'dark':'light'));
applyTheme(localStorage.getItem('delta-theme')||'dark');renderColumnMenu();loadExpiries();refreshTimer=setInterval(()=>loadMarket(false),15000);
