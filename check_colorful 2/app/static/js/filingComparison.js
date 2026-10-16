import {charts,destroy,esc,fmt} from './visuals.js?v=20261014-gaussian-contours';

const COLORS=['#2563eb','#b45309','#7c3aed'];
const FILING_COLORS=['#c62828','#d84343','#ef5350'];
const DISPOSAL_COLORS=['#2e7d32','#388e3c','#66bb6a'];
const QUADRANTS=[
 {id:'q2',side:'b',flow:true,title:'II · Monthly filings and disposals'},
 {id:'q1',side:'a',flow:true,title:'I · Monthly filings and disposals'},
 {id:'q3',side:'b',flow:false,title:'III · Cumulative case-load change (from 0)'},
 {id:'q4',side:'a',flow:false,title:'IV · Cumulative case-load change (from 0)'},
];
function destroyQuadrants(){QUADRANTS.forEach(q=>destroy('filing-flow:'+q.id));}

export function renderFilingQuadrants(host,data){
 destroyQuadrants();
 const flows=[data.a,data.b].flatMap(s=>s.series.flatMap(r=>[...r.filings,...r.disposals])).filter(Number.isFinite);
 const cumulative=[data.a,data.b].flatMap(s=>s.series.flatMap(r=>r.cumulative_load)).filter(Number.isFinite);
 const flowMax=Math.max(1,...flows)*1.1;
 const loadMax=Math.max(1,...cumulative)*1.1,loadMin=Math.min(0,...cumulative)*1.1;
 host.innerHTML=QUADRANTS.map(q=>`<section class="filing-quadrant">
  <h5>${esc(q.title)}</h5><p class="chart-subtitle">${esc(data[q.side].label)}</p>
  <div class="filing-quadrant-canvas"><canvas id="filing-flow-${q.id}" role="img" aria-label="${esc(q.title+' — '+data[q.side].label)}"></canvas></div>
 </section>`).join('');
 for(const q of QUADRANTS){
  const side=data[q.side];
  const datasets=side.series.flatMap((row,i)=>{
   const common={borderWidth:2,pointRadius:0,pointHoverRadius:4,tension:0,spanGaps:false,fill:false};
   return q.flow?[
    {...common,label:row.case_type+' · Filings',data:[null,...row.filings],borderColor:FILING_COLORS[i],backgroundColor:FILING_COLORS[i]},
    {...common,label:row.case_type+' · Disposals',data:[null,...row.disposals],borderColor:DISPOSAL_COLORS[i],backgroundColor:DISPOSAL_COLORS[i]},
   ]:[{...common,label:row.case_type+' · Cumulative change',data:[row.baseline,...row.cumulative_load],borderColor:COLORS[i],backgroundColor:COLORS[i]}];
  });
  const canvas=document.getElementById('filing-flow-'+q.id);
  if(!datasets.some(ds=>ds.data.some(Number.isFinite))){
   canvas.parentElement.innerHTML='<p class="component-status">No data for these types in the selected months at this court.</p>';
   continue;
  }
  charts['filing-flow:'+q.id]=new Chart(canvas,{
   type:'line',data:{labels:['Start (0)',...data.labels],datasets},
   options:{responsive:true,maintainAspectRatio:false,interaction:{mode:'index',intersect:false},
    plugins:{legend:{display:false},tooltip:{callbacks:{label:c=>`${c.dataset.label}: ${fmt(c.parsed.y)} cases`}}},
    scales:{
     x:{title:{display:true,text:'Calendar month'},ticks:{maxTicksLimit:6,maxRotation:35}},
     y:{min:q.flow?0:loadMin,max:q.flow?flowMax:loadMax,
      title:{display:true,text:q.flow?'Cases / month':'Cumulative change in cases'},ticks:{precision:0},
      grid:{color:context=>context.tick.value===0?'#5b4636':'rgba(112,88,65,0.15)',lineWidth:context=>context.tick.value===0?2:1}},
    }},
  });
 }
}

export function mountFilingComparison(host){
 let controller=null,request=null,selected=[];
 function clear(){
  controller?.abort();controller=null;destroyQuadrants();host.replaceChildren();
 }
 async function load(nextRequest,names=[]){
  clear();request={...nextRequest};
  const pending=controller=new AbortController();
  host.innerHTML='<p class="component-status" role="status">Loading monthly filings, disposals and case load…</p>';
  try{
   const query=new URLSearchParams(request);
   names.forEach(name=>query.append('type',name));
   const response=await fetch('/api/v1/compare/filing-flow?'+query,{signal:pending.signal});
   const data=await response.json();
   if(controller!==pending)return;
   if(!response.ok)throw new Error(typeof data.detail==='string'?data.detail:'Unable to load monthly comparison.');
   selected=names.length?data.selected.filter(name=>names.includes(name)).slice(0,1):data.selected.slice(0,1);
   const chartData={...data,selected};
   for(const side of ['a','b'])chartData[side]={...data[side],series:data[side].series.filter(row=>selected.includes(row.case_type))};
   host.innerHTML=`<h4 class="pair-title">Monthly filings, disposals &amp; cumulative case load</h4>
    <p class="chart-subtitle">Current district on the right (I, IV); comparison district on the left (II, III). Both columns use the same months and scales. Monthly filing and disposal counts are not cutoff-filtered; they include valid events within this shared window.</p>
    <p class="pair-timeline">Data timeline · common comparison period ${esc(data.labels[0]||'—')}–${esc(data.labels.at(-1)||'—')} · ${esc(data.a.label)}: ${esc(data.a.start)}–${esc(data.a.end)} · ${esc(data.b.label)}: ${esc(data.b.start)}–${esc(data.b.end)}.</p>
    <div class="filing-flow-type-picker"><label for="filingFlowCaseType">Case type</label><select id="filingFlowCaseType" class="filter-select filing-flow-select" aria-label="Choose one case type"></select><span>All available Civil and Criminal types are listed. Type a name to jump to it.</span></div>
    <p class="chart-subtitle" role="status">Showing one case type. The default favours a shared type, ranked by combined filing and disposal volume.</p>
    <div class="filing-flow-legend"></div>
    <p class="chart-subtitle">Top panels: solid red lines are filings; solid green lines are disposals. Shades distinguish selected case types. Lower panels: cumulative sum(filings − disposals), starting at 0; this shows backlog change, not the actual pending total.</p>
    <div class="filing-quadrants"></div>
    <details class="formula-note"><summary>How this is calculated</summary><ul class="compare-notes">${data.notes.map(note=>`<li>${esc(note)}</li>`).join('')}</ul></details>`;
   const choices=host.querySelector('.filing-flow-select');
   for(const option of data.case_type_options){
    const item=document.createElement('option');
    item.value=option.case_type;item.textContent=option.case_type+(option.in_both?'':' · one court only');
    choices.append(item);
   }
   choices.value=selected[0]||'';
   choices.addEventListener('change',()=>{
    if(choices.value)load(request,[choices.value]);
   });
   host.querySelector('.filing-flow-legend').innerHTML=selected.map((name,i)=>`<span><i style="background:${FILING_COLORS[i]}"></i><i style="background:${DISPOSAL_COLORS[i]}"></i>${esc(name)}</span>`).join('');
   if(!selected.length){host.querySelector('.filing-quadrants').innerHTML='<p class="component-status">No Civil or Criminal filing/disposal events in this selection.</p>';return;}
   renderFilingQuadrants(host.querySelector('.filing-quadrants'),chartData);
  }catch(error){
   if(error.name!=='AbortError'&&controller===pending){
    host.innerHTML=`<p class="component-status error" role="status">${esc(error.message)}</p><button type="button" class="chart-tool-btn">Retry monthly comparison</button>`;
    host.querySelector('button').addEventListener('click',()=>load(request,names));
   }
  }
 }
 return {load,clear};
}
