/* Side-by-side court comparison: one graph per court, each showing the median and the 90th
   percentile together. Used by the compare panel in every tab and by level 2 of the Comparison tab.
   Numbers come from the comparison API and the existing complexity component API. */
import {charts,destroy,esc,fmt,text} from './visuals.js?v=20261014-gaussian-contours';
import {render as renderComplexity} from './components/complexity.js?v=20261014-gaussian-contours';
import {mountFilingComparison} from './filingComparison.js?v=20261014-gaussian-contours';
const $=id=>document.getElementById(id);
const LABELS={filings:'Monthly filings',arrival_rate:'Monthly arrival rate',disposal:'Time to disposal',gap:'Filing-to-first-listing gap',hearings:'Hearings per disposed case',monthly_rate:'Monthly hearing rate',case_rate_mo:'Case-wise hearing rate'};
const TAB_METRICS={overview:['hearings','filings'],trends:['filings','arrival_rate'],timeliness:['disposal','gap'],hearingRates:['monthly_rate','case_rate_mo'],complexity:['hearings','case_rate_mo'],register:['filings','disposal']};
const COLORS={a:['#2563eb','rgba(37,99,235,0.35)'],b:['#b45309','rgba(180,83,9,0.35)']};
const MAX_TYPES=12;
let districts=[],current=()=>({}),target=null,enabled=false;
const courtCache=new Map(),panels=new Map();
const same=(x,y)=>x&&y&&x.district===y.district&&x.court===y.court;
async function courtsOf(district){
 if(!courtCache.has(district))courtCache.set(district,fetch('/api/v1/metadata?district='+encodeURIComponent(district)).then(r=>r.json()).then(m=>m.courts));
 return courtCache.get(district);
}
const fill=(sel,items,value)=>sel.replaceChildren(...items.map(([v,l])=>new Option(l,v,v===value,v===value)));
async function defaultTarget(a){
 const district=districts.find(d=>d!==a.district)||a.district,courts=await courtsOf(district);
 const court=courts.some(c=>c.id===a.court)?a.court:courts.find(c=>!(district===a.district&&c.id===a.court))?.id||courts[0].id;
 return {district,court};
}
async function pickCourt(district,wanted){const courts=await courtsOf(district);return courts.some(c=>c.id===wanted)?wanted:courts[0].id;}

/* ---------- fetching and drawing ---------- */
async function fetchPair(metric,req,signal){
 const q=new URLSearchParams({metric,start:req.start,end:req.end,a_district:req.a.district,a_court:req.a.court,b_district:req.b.district,b_court:req.b.court,side:req.side||'all',limit:req.limit||6});
 (req.names||[]).forEach(n=>q.append('type',n));
 const r=await fetch('/api/v1/compare/measure?'+q,{signal}),d=await r.json();
 if(!r.ok)throw new Error(typeof d.detail==='string'?d.detail:'Unable to load comparison');
 return d;
}
function destroyGroup(key){Object.keys(charts).filter(k=>k.startsWith('pair:'+key+':')).forEach(destroy);}
function block(d){
 const el=document.createElement('div');el.className='pair-block';
 const cutoff=d.metric==='gap'||d.metric==='hearings'||d.metric==='case_rate_mo';
 const sideTimeline=s=>{
  if(!s.available)return 'no data in this period';
  if(!cutoff||!s.cutoff||`${s.start}-01`>=s.cutoff)return `cases filed ${s.start}–${s.end}`;
  const eligibleStart=s.cutoff.slice(0,7)>s.start?s.cutoff.slice(0,7):s.start;
  return eligibleStart>s.end?`no eligible cases; cutoff ${s.cutoff} applied due to bulk-digitisation artefacts`:`eligible filings ${eligibleStart}–${s.end}; cutoff ${s.cutoff} applied due to bulk-digitisation artefacts`;
 };
 const timeline=`Data timeline · common comparison period ${d.start}–${d.end} · ${d.a.label}: ${sideTimeline(d.a)} · ${d.b.label}: ${sideTimeline(d.b)}`;
 el.innerHTML=`<h4 class="pair-title">${esc(d.label)}<span>${esc(d.about)} · ${esc(d.unit)}</span></h4><p class="pair-timeline">${esc(timeline)}</p><p class="pair-chart-note">Bars end at the 90th percentile; the marker on each bar shows the median. Districts share one scale.</p><div class="pair-chart"><canvas role="img" aria-label="${esc(d.label)} comparison between ${esc(d.a.label)} and ${esc(d.b.label)}"></canvas></div>${d.notes.length?`<ul class="compare-notes">${d.notes.map(n=>`<li>${esc(n)}</li>`).join('')}</ul>`:''}`;
 return el;
}
function paint(el,d,key){
 const canvas=el.querySelector('.pair-chart canvas');
 const labels=[...new Set([...d.a.rows,...d.b.rows].map(r=>r.case_type))];
 const lookup=Object.fromEntries(['a','b'].map(s=>[s,Object.fromEntries(d[s].rows.map(r=>[r.case_type,r]))]));
 const values=['a','b'].flatMap(s=>d[s].rows.map(r=>r.p90).filter(v=>Number.isFinite(v)));
 if(!values.length){
  el.querySelector('.pair-chart').innerHTML=`<p class="component-status">${d.a.available||d.b.available?'No eligible observations for this selection.':'No data in the selected months.'}</p>`;
  return;
 }
 const maximum=Math.max(...values)||1,k=`pair:${key}:${d.metric}`;
 destroy(k);
 const datasets=['a','b'].map(s=>({
  label:d[s].label,
  data:labels.map(name=>lookup[s][name]?.p90??null),
  medianValues:labels.map(name=>lookup[s][name]?.median??null),
  observationCounts:labels.map(name=>lookup[s][name]?.n??0),
  backgroundColor:COLORS[s][1],borderColor:COLORS[s][0],borderWidth:1,
  borderRadius:3,maxBarThickness:20,
 }));
 const medianMarkers={id:`pairMedianMarkers-${key}-${d.metric}`,afterDatasetsDraw(chart){
  const {ctx,scales}=chart;ctx.save();
  chart.data.datasets.forEach((dataset,index)=>{
   const bars=chart.getDatasetMeta(index).data;
   bars.forEach((bar,dataIndex)=>{
    const median=dataset.medianValues[dataIndex];if(!bar||!Number.isFinite(median))return;
    const y=scales.y.getPixelForValue(median),halfWidth=Math.max(4,bar.width*0.32);
    ctx.strokeStyle=COLORS[index===0?'a':'b'][0];ctx.lineWidth=3;
    ctx.beginPath();ctx.moveTo(bar.x-halfWidth,y);ctx.lineTo(bar.x+halfWidth,y);ctx.stroke();
   });
  });ctx.restore();
 }};
 charts[k]=new Chart(canvas,{type:'bar',data:{labels,datasets},
  options:{responsive:true,maintainAspectRatio:false,interaction:{mode:'index',intersect:false},
   plugins:{legend:{position:'bottom',labels:{boxWidth:12}},tooltip:{callbacks:{
    title:items=>labels[items[0]?.dataIndex]||'',
    label:item=>{const dataset=item.dataset,median=dataset.medianValues[item.dataIndex],p90=dataset.data[item.dataIndex];
     return `${dataset.label} — median ${fmt(median)}, 90th ${fmt(p90)} ${d.unit}`;},
    footer:items=>items.map(item=>{const n=item.dataset.observationCounts[item.dataIndex];return n?`${item.dataset.label}: ${fmt(n)} observations`:'';}).filter(Boolean),
   }}},
   scales:{x:{ticks:{autoSkip:false,maxRotation:35,minRotation:35,callback(value){const label=this.getLabelForValue(value);return label.length>16?label.slice(0,15)+'…':label;}},grid:{display:false}},
    y:{beginAtZero:true,max:maximum*1.08||1,title:{display:true,text:d.unit}}}},
  plugins:[medianMarkers]});
}
async function drawPairs(host,metrics,req,key,holder){
 holder.ctrl?.abort();const ctrl=holder.ctrl=new AbortController();
 destroyGroup(key);host.innerHTML='<p class="component-status">Loading comparison…</p>';
 try{
  const data=await Promise.all(metrics.map(m=>fetchPair(m,req,ctrl.signal)));
  if(holder.ctrl!==ctrl)return null;
  const blocks=data.map(block);host.replaceChildren(...blocks);blocks.forEach((el,i)=>paint(el,data[i],key));
  return data;
 }catch(e){if(e.name!=='AbortError'){host.innerHTML=`<p class="component-status error">${esc(e.message)}</p>`;}return null;}
}
const activeTab=()=>document.querySelector('.tab-pane.active')?.id;

/* ---------- compare panel inside every tab ---------- */
const COMPLEXITY_KEY='pair:tab-complexity:bubble:b';
function clearComplexity(p){
 if(!p.bubbleHost)return;
 p.bubbleController?.abort();p.bubbleController=null;
 destroy(COMPLEXITY_KEY);p.bubbleHost.replaceChildren();
}
async function drawComparisonComplexity(p,other,range){
 clearComplexity(p);
 const controller=p.bubbleController=new AbortController();
 const host=p.bubbleHost;
 host.innerHTML='<p class="component-status" role="status">Loading other court’s case complexity…</p>';
 try{
  const metaResponse=await fetch('/api/v1/metadata?district='+encodeURIComponent(other.district),{signal:controller.signal});
  if(!metaResponse.ok)throw new Error('Unable to load the comparison court.');
  const meta=await metaResponse.json();
  if(p.bubbleController!==controller)return;
  const start=range.start>meta.start?range.start:meta.start,end=range.end<meta.end?range.end:meta.end;
  if(start>end){host.innerHTML='<p class="component-status" role="status">No data for the other court in the selected months.</p>';return;}
  // Court-local type codes must not be copied from the primary court. Use the same
  // default as its standalone chart: the top four eligible types by filing volume.
  const q=new URLSearchParams({district:other.district,court:other.court,start,end});
  const response=await fetch('/api/v1/components/complexity?'+q,{signal:controller.signal});
  const data=await response.json();
  if(p.bubbleController!==controller)return;
  if(!response.ok)throw new Error(typeof data.detail==='string'?data.detail:'Unable to load case complexity.');
  const court=meta.courts.find(c=>c.id===other.court);
  const title=other.district+' · '+(court?.name||other.court);
  const comparisonCutoff=range.comparison_cutoff;
  const cutoffTimeline=comparisonCutoff?` · shared period begins after later court cutoff ${comparisonCutoff} (bulk-digitisation artefacts)`:'';
  host.innerHTML=`<h4 class="pair-title">Case complexity — ${esc(title)}</h4>
   <p class="pair-timeline">Data timeline · cases filed ${esc(start)}–${esc(end)}${esc(cutoffTimeline)} · events through ${esc(data.meta?.observation_end||end)}.</p>
   <p class="chart-subtitle">Top four eligible case types by filing volume at this court. Axis, colour and bubble-size scales are specific to each court; compare values using the axes, legends and tooltips.</p>
   <p class="chart-subtitle" id="comparisonComplexitySubtitle"></p>`;
  const notes=[...(data.meta?.data_quality_warnings||[])];
  if(comparisonCutoff)notes.push(`The shared comparison period begins after the later court cutoff (${comparisonCutoff}) because bulk-digitised histories may be incomplete.`);
  if(start!==range.start||end!==range.end)notes.push('Date range limited to the other district’s available data.');
  if(notes.length)host.insertAdjacentHTML('beforeend',`<ul class="compare-notes">${notes.map(note=>`<li>${esc(note)}</li>`).join('')}</ul>`);
  if(!data.points.length){host.insertAdjacentHTML('beforeend','<p class="component-status" role="status">Not enough eligible hearing, rate and disposal observations for a bubble chart.</p>');return;}
  host.insertAdjacentHTML('beforeend',`<div class="contour-controls">
   <label for="comparisonComplexityContourMode">Equal-disposal-time contours
    <select id="comparisonComplexityContourMode" class="filter-select">
     <option value="none">No contours</option><option value="empirical">Fixed-duration contours</option>
    </select>
   </label>
   <p id="comparisonComplexityContourStatus" class="side-panel-note">Fitted duration levels: 6 months, 1 year, 2 years, 2.5 years, 3 years and 5 years. Month/year labels use 21 working days per month.</p>
   <div id="comparisonComplexityContourLegend" class="contour-legend" aria-label="Visible contour durations"></div>
  </div><div class="complexity-layout">
   <div><div class="complexity-plot"><canvas id="comparisonComplexityChart" role="img" aria-label="Case complexity for ${esc(title)}"></canvas></div>
    <div class="complexity-takeaways"><h4>Key takeaways</h4><ul id="comparisonComplexityTakeawaysList"></ul></div></div>
   <div class="complexity-side-panels">
    <div class="side-panel"><h4>Mean time to disposal (working days)</h4><div class="color-scale-bar"></div><div class="color-scale-labels" id="comparisonComplexityColorLabels"></div></div>
    <div class="side-panel"><h4>Throughput (hearings / working day)</h4><div class="bubble-size-legend" id="comparisonComplexityBubbleLegend"></div><p class="side-panel-note">Bubble area is proportional to throughput.</p></div>
    <div class="side-panel"><h4>Optional contours</h4><p class="side-panel-note">Fitted equal-disposal curves are available for 6 months, 1 year, 2 years, 2.5 years, 3 years and 5 years. Disposal time uses a case-count-weighted Gaussian smoother: each type's weight combines its disposed-case count and Gaussian distance from the grid location. Smoothing width is 16% of the observed range, with a 2.5% chart-axis minimum. Duration labels use 21 working days per month.</p></div>
   </div></div>`);
  renderComplexity(data,{prefix:'comparisonComplexity',key:COMPLEXITY_KEY});
 }catch(error){
  if(error.name!=='AbortError'&&p.bubbleController===controller)host.innerHTML=`<p class="component-status error" role="status">${esc(error.message)} — change the comparison selection or toggle Show comparison to retry.</p>`;
 }
}
function drawPanel(tab){
 const p=panels.get(tab);if(!enabled||!p||!target)return;
 p.stale=false;const a=current();
 if(same(a,target)){p.holder.ctrl?.abort();p.filingView?.clear();clearComplexity(p);destroyGroup('tab-'+tab);p.host.innerHTML='<p class="component-status">Choose a different district or court to compare with.</p>';return;}
 const comparison=drawPairs(p.host,TAB_METRICS[tab],{start:a.start,end:a.end,a:{district:a.district,court:a.court},b:target},'tab-'+tab,p.holder);
 if(tab==='complexity')comparison.then(data=>{if(data?.[0])drawComparisonComplexity(p,{...target},{...a,start:data[0].start,end:data[0].end,comparison_cutoff:data[0].comparison_cutoff});});
 if(tab==='trends')p.filingView.load({start:a.start,end:a.end,a_district:a.district,a_court:a.court,b_district:target.district,b_court:target.court});
}
let bar=null;
async function fillPicks(){
 const courts=await courtsOf(target.district);
 fill(bar.selD,districts.map(d=>[d,d]),target.district);fill(bar.selC,courts.map(c=>[c.id,c.name]),target.court);
}
function setEnabled(on){
 enabled=on;bar.toggle.checked=on;bar.picks.hidden=!on;
 panels.forEach((p,tab)=>{p.stale=true;p.sec.hidden=!on;if(!on){p.holder.ctrl?.abort();p.filingView?.clear();clearComplexity(p);destroyGroup('tab-'+tab);p.host.innerHTML='';}});
 if(on)drawPanel(activeTab());
}
function refreshPanels(){panels.forEach((p,tab)=>{p.stale=true;if(enabled){p.holder.ctrl?.abort();p.filingView?.clear();clearComplexity(p);destroyGroup('tab-'+tab);p.host.innerHTML='';}});if(enabled)drawPanel(activeTab());}
function mountPanels(){
 // One shared bar above the tabs' content; each tab gets its own results section at the end of its pane.
 const bs=document.createElement('section');bs.className='chart-card pair-panel pair-bar';
 bs.innerHTML='<div class="pair-panel-head"><h3 class="chart-title">Compare with another court</h3><label class="pair-toggle"><input type="checkbox"> Show comparison</label><span class="pair-picks" hidden><label>District <select class="filter-select" data-role="d"></select></label><label>Court <select class="filter-select" data-role="c"></select></label><a href="#" class="pair-jump">Jump to comparison ↓</a></span></div>';
 document.querySelector('.tab-content').prepend(bs);
 bar={sec:bs,picks:bs.querySelector('.pair-picks'),toggle:bs.querySelector('input'),selD:bs.querySelector('[data-role=d]'),selC:bs.querySelector('[data-role=c]')};
 bar.toggle.addEventListener('change',()=>setEnabled(bar.toggle.checked));
 bar.selD.addEventListener('change',async()=>{target={district:bar.selD.value,court:await pickCourt(bar.selD.value,target.court)};await fillPicks();refreshPanels();});
 bar.selC.addEventListener('change',()=>{target={...target,court:bar.selC.value};refreshPanels();});
 bs.querySelector('.pair-jump').addEventListener('click',e=>{e.preventDefault();panels.get(activeTab())?.sec.scrollIntoView({behavior:'smooth',block:'start'});});
 for(const tab of Object.keys(TAB_METRICS)){
  const pane=$(tab);if(!pane)continue;
  const sec=document.createElement('section');sec.className='chart-card pair-panel pair-results';sec.hidden=true;
  sec.innerHTML='<h3 class="chart-title">Side-by-side comparison</h3><div class="pair-host"></div>';
  let bubbleHost=null;
  let filingView=null;
  if(tab==='trends'){
   const filingHost=document.createElement('div');filingHost.className='pair-block filing-flow-comparison';
   sec.insertBefore(filingHost,sec.querySelector('.pair-host'));
   filingView=mountFilingComparison(filingHost);
  }
  if(tab==='complexity'){
   bubbleHost=document.createElement('div');bubbleHost.className='pair-block comparison-complexity';
   sec.insertBefore(bubbleHost,sec.querySelector('.pair-host'));
  }
  pane.append(sec);
  panels.set(tab,{sec,host:sec.querySelector('.pair-host'),bubbleHost,filingView,stale:true,holder:{}});
 }
}

/* ---------- Comparison tab, level 2: cases within the chosen courts ---------- */
const cs={a:null,b:null,metric:'disposal',side:'all',names:[],stale:true,holder:{},data:null};
const holderKey='cases';
function crumb(){
 if(!cs.a||!cs.b)return;
 const l=s=>`${s.district} · ${(courtCache.get(s.district)&&cs._courts?.[s.district]?.find(c=>c.id===s.court)?.label)||s.court}`;
 text('casePairCrumb',`${l(cs.a)}  vs  ${l(cs.b)} · ${LABELS[cs.metric]} · matched by case-type name`);
}
async function fillCaseSelectors(){
 cs._courts={};
 for(const d of new Set([cs.a.district,cs.b.district]))cs._courts[d]=await courtsOf(d);
 for(const s of ['a','b']){
  const k=s.toUpperCase();
  fill($('case'+k+'_district'),districts.map(d=>[d,d]),cs[s].district);
  fill($('case'+k+'_court'),cs._courts[cs[s].district].map(c=>[c.id,c.name]),cs[s].court);
 }
 fill($('caseMetric'),Object.entries(LABELS),cs.metric);
 $('caseSide').value=cs.side;
 crumb();
}
function caseTypesUI(d){
 const shown=new Set([...d.a.rows,...d.b.rows].map(r=>r.case_type)),box=$('caseTypesList');
 box.replaceChildren(...d.case_type_options.map(o=>{
  const label=document.createElement('label'),input=document.createElement('input');
  input.type='checkbox';input.value=o.case_type;input.checked=shown.has(o.case_type);
  label.append(input,document.createTextNode(`${o.case_type} (${o.a_filings??'—'} / ${o.b_filings??'—'})`));
  if(!o.in_both)label.classList.add('one-sided');
  return label;
 }));
 const n=shown.size;
 text('caseTypesSummary',`Case types · ${cs.names.length?'custom selection':'top matched'} · ${n} shown (filings A / B in brackets)`);
 limitTypes();
}
function limitTypes(){const boxes=[...$('caseTypesList').querySelectorAll('input')],n=boxes.filter(i=>i.checked).length;boxes.forEach(i=>{i.disabled=!i.checked&&n>=MAX_TYPES;});}
function caseTable(d){
 const a=Object.fromEntries(d.a.rows.map(r=>[r.case_type,r])),b=Object.fromEntries(d.b.rows.map(r=>[r.case_type,r]));
 const order=[...new Set([...d.a.rows,...d.b.rows].map(r=>r.case_type))];
 const diff=(x,y)=>x==null||y==null||x===0?'—':(Math.abs((y-x)/x)<0.005?'No difference':((y>x?'+':'−')+Math.abs((y-x)/x*100).toFixed(0)+'%'));
 $('casePairHead').innerHTML=`<tr><th rowspan="2">Case type</th><th colspan="2">${esc(d.a.label)}</th><th colspan="2">${esc(d.b.label)}</th><th colspan="2">B vs A</th></tr><tr><th>Median</th><th>90th</th><th>Median</th><th>90th</th><th>Median</th><th>90th</th></tr>`;
 $('casePairBody').innerHTML=order.map(n=>{const x=a[n]||{},y=b[n]||{};return `<tr><td>${esc(n)}</td><td>${fmt(x.median)}</td><td>${fmt(x.p90)}</td><td>${fmt(y.median)}</td><td>${fmt(y.p90)}</td><td>${diff(x.median,y.median)}</td><td>${diff(x.p90,y.p90)}</td></tr>`;}).join('');
}
async function loadCases(){
 if(!cs.a||!cs.b)return;
 cs.stale=false;const cur=current();
 const host=$('casePairHost');
 if(same(cs.a,cs.b)){destroyGroup(holderKey);host.innerHTML='<p class="component-status">Side A and Side B are the same court — pick a different district or court for one side.</p>';$('casePairHead').innerHTML='';$('casePairBody').innerHTML='';return;}
 const data=await drawPairs(host,[cs.metric],{start:cur.start,end:cur.end,a:cs.a,b:cs.b,side:cs.side,names:cs.names,limit:6},holderKey,cs.holder);
 if(!data)return;
 cs.data=data[0];caseTypesUI(cs.data);caseTable(cs.data);crumb();
}
async function setCases(a,b,{load=true}={}){
 cs.a=a;cs.b=b;cs.names=[];await fillCaseSelectors();
 if(load)loadCases();else cs.stale=true;
}
function bindCases(){
 for(const s of ['a','b']){
  const k=s.toUpperCase();
  $('case'+k+'_district').addEventListener('change',async e=>{cs[s]={district:e.target.value,court:await pickCourt(e.target.value,cs[s].court)};cs.names=[];await fillCaseSelectors();loadCases();});
  $('case'+k+'_court').addEventListener('change',e=>{cs[s]={...cs[s],court:e.target.value};cs.names=[];crumb();loadCases();});
 }
 $('caseMetric').addEventListener('change',e=>{cs.metric=e.target.value;crumb();loadCases();});
 $('caseSide').addEventListener('change',e=>{cs.side=e.target.value;cs.names=[];loadCases();});
 $('caseTypesList').addEventListener('change',()=>{limitTypes();const picked=[...$('caseTypesList').querySelectorAll('input:checked')].map(i=>i.value);cs.names=picked;loadCases();});
 $('caseTypesReset').addEventListener('click',()=>{cs.names=[];loadCases();});
}

/* ---------- public API ---------- */
export async function init(options){
 districts=options.districts;current=options.current;
 target=await defaultTarget(current());
 mountPanels();await fillPicks();bindCases();
 await setCases(current(),target,{load:false});
}
/** The sidebar selection changed: refresh every comparison that depends on it. */
export async function invalidate(){
 if(!target)return;
 const a=current();
 if(same(a,target))target=await defaultTarget(a);
 await fillPicks();refreshPanels();
 const b=cs.b&&!same(cs.b,a)?cs.b:target;
 await setCases(a,b,{load:activeTab()==='comparison'});
}
export function onTab(tab){
 if(bar)bar.sec.hidden=!panels.has(tab);
 if(panels.get(tab)?.stale)drawPanel(tab);
 if(tab==='comparison'&&cs.stale)loadCases();
}
/** Drill-down from the courts overview: same court in each chosen district. */
export async function drillInto(court,pair){
 const [a,b]=[pair[0],pair[1]||pair[0]];
 await setCases({district:a,court},{district:b,court});
 $('casePairCard').scrollIntoView({behavior:'smooth',block:'start'});
}
