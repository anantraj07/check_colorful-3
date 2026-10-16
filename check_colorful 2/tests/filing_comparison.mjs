// Pure JavaScript chart and request lifecycle contracts (not browser automation).
import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';

class Node {
 constructor(id=''){this.id=id;this.children=[];this.parts=new Map();this.listeners={};this.parentElement={innerHTML:''};}
 set innerHTML(value){this.html=value;this.children=[];this.parts=new Map();}
 get innerHTML(){return this.html||'';}
 replaceChildren(){this.innerHTML='';}
 append(...items){this.children.push(...items);}
 querySelector(selector){if(!this.parts.has(selector))this.parts.set(selector,new Node());return this.parts.get(selector);}
 querySelectorAll(selector){return this.children.flatMap(label=>label.children).filter(input=>input.type==='checkbox'&&(selector!=='input:checked'||input.checked));}
 addEventListener(event,listener){this.listeners[event]=listener;}
}
const nodes=new Map();
const node=id=>{if(!nodes.has(id))nodes.set(id,new Node(id));return nodes.get(id);};
const series=[
 {case_type:'Alpha',filings:[3,0],disposals:[2,1],baseline:0,cumulative_load:[1,0]},
 {case_type:'Beta',filings:[2,0],disposals:[1,0],baseline:0,cumulative_load:[1,1]},
 {case_type:'Gamma',filings:[null,null],disposals:[null,null],baseline:null,cumulative_load:[null,null]},
 {case_type:'Delta',filings:[1,3],disposals:[0,1],baseline:0,cumulative_load:[1,3]},
];
const fixture={labels:['2017-01','2017-02'],a:{label:'Primary · CJM',start:'2017-01',end:'2017-02',series},
 b:{label:'Other · CJM',start:'2017-01',end:'2017-02',series:series.map(r=>({...r,filings:[1,0],disposals:[2,1],baseline:0,cumulative_load:[-1,-2]}))},
 selected:['Alpha','Beta','Gamma'],case_type_options:['Alpha','Beta','Gamma','Delta'].map(case_type=>({case_type,in_both:true})),comparison_cutoff:'2017-01-01',notes:['Common comparison period: 2017-01–2017-02.']};
const charts={},requests=[];
let response=fixture;
let fetchImpl=async()=>({ok:true,json:async()=>response});
const sandbox={console,URLSearchParams,AbortController,charts,
 esc:String,fmt:value=>value==null?'—':String(value),
 document:{getElementById:node,createElement:()=>new Node(),createTextNode:text=>({text})},
 destroy:key=>{charts[key]?.destroy();delete charts[key];},
 fetch:async(url,options)=>{requests.push({url,options});return fetchImpl(url,options);},
 Chart:function(canvas,config){this.canvas=canvas;this.config=config;this.destroyed=false;this.destroy=()=>{this.destroyed=true;};},
};
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync('app/static/js/filingComparison.js','utf8').replace(/^import .*;\n/gm,'').replaceAll('export ',''),sandbox);
const host=new Node();
sandbox.renderFilingQuadrants(host,fixture);
assert.equal(Object.keys(charts).length,4);
assert.ok(host.innerHTML.indexOf('filing-flow-q2')<host.innerHTML.indexOf('filing-flow-q1'));
assert.ok(host.innerHTML.indexOf('filing-flow-q3')<host.innerHTML.indexOf('filing-flow-q4'));
const q1=charts['filing-flow:q1'].config,q2=charts['filing-flow:q2'].config,q3=charts['filing-flow:q3'].config,q4=charts['filing-flow:q4'].config;
assert.deepEqual(Array.from(q1.data.datasets[0].data),[null,...fixture.a.series[0].filings]);
assert.deepEqual(Array.from(q2.data.datasets[0].data),[null,...fixture.b.series[0].filings]);
assert.deepEqual(Array.from(q3.data.datasets[0].data),[0,...fixture.b.series[0].cumulative_load]);
assert.deepEqual(Array.from(q4.data.datasets[0].data),[0,...fixture.a.series[0].cumulative_load]);
assert.equal(q4.data.labels[0],'Start (0)');
assert.equal(q1.data.datasets[1].borderDash,undefined,'disposals should be solid lines');
assert.equal(q1.data.datasets[0].borderColor,'#c62828','filings should use red');
assert.equal(q1.data.datasets[1].borderColor,'#2e7d32','disposals should use green');
assert.equal(q1.data.datasets[0].borderColor,q2.data.datasets[0].borderColor);
assert.equal(q1.data.datasets[0].borderWidth,2);
assert.equal(q4.data.datasets[0].borderColor,'#2563eb','cumulative case-type colors remain unchanged');
assert.equal(q1.options.scales.y.max,q2.options.scales.y.max);
assert.equal(q3.options.scales.y.max,q4.options.scales.y.max);
assert.ok(q4.options.scales.y.min<0,'Do not clip negative cumulative changes');
assert.equal(q3.options.scales.y.min,q4.options.scales.y.min);
assert.equal(q1.data.datasets[0].spanGaps,false);

const view=sandbox.mountFilingComparison(host);
const req={start:'2017-01',end:'2017-02',a_district:'Primary',a_court:'CJM',b_district:'Other',b_court:'CJM'};
await view.load(req);
assert.equal(new URL(requests.at(-1).url,'http://test').searchParams.get('b_district'),'Other');
assert.match(host.innerHTML,/Data timeline · common comparison period 2017-01–2017-02/);
assert.match(host.innerHTML,/Monthly filing and disposal counts are not cutoff-filtered/);
assert.doesNotMatch(host.innerHTML,/later court cutoff 2017-01-01 applied/);
let choices=host.querySelector('.filing-flow-select');
assert.equal(choices.children.length,4,'the menu keeps every available case type');
assert.equal(choices.value,'Alpha','the default highest-ranked type is selected');
assert.equal(charts['filing-flow:q1'].config.data.datasets.length,2,'only one case type is plotted at a time');
assert.match(host.innerHTML,/solid red lines are filings; solid green lines are disposals/);
assert.match(host.innerHTML,/cumulative sum\(filings − disposals\), starting at 0/);

// Selecting a different menu item requests and renders only that case type.
choices.value='Delta';
response={...fixture,selected:['Delta']};
await choices.listeners.change();
// The listener launches a fetch; let its promise continuation render.
await new Promise(resolve=>setImmediate(resolve));
assert.deepEqual(new URL(requests.at(-1).url,'http://test').searchParams.getAll('type'),['Delta']);
choices=host.querySelector('.filing-flow-select');
assert.equal(choices.value,'Delta');
assert.equal(charts['filing-flow:q1'].config.data.datasets.length,2);

response={...fixture,selected:['Alpha']};
await view.load(req,['Alpha']);
assert.equal(host.querySelector('.filing-flow-select').value,'Alpha');
const stylesheet=fs.readFileSync('app/static/css/intelligence.css','utf8');
assert.match(stylesheet,/\.filing-flow-select\s*\{[^}]*width:\s*100%/s,'case-type menu should be styled and easy to use');
const rendered=Object.values(charts);
const pendingSignal=requests.at(-1).options.signal;
view.clear();
assert.equal(pendingSignal.aborted,true);
assert.equal(Object.keys(charts).length,0);
assert.ok(rendered.every(chart=>chart.destroyed));

// Disabling or changing the comparison must discard late responses.
let release;
fetchImpl=()=>new Promise(resolve=>{release=resolve;});
const old=view.load(req);
view.clear();
release({ok:true,json:async()=>fixture});
await old;
assert.equal(host.innerHTML,'');
assert.equal(Object.keys(charts).length,0);

fetchImpl=async()=>({ok:false,json:async()=>({detail:'Unavailable'})});
await view.load(req);
assert.match(host.innerHTML,/Retry monthly comparison/);
fetchImpl=async()=>({ok:true,json:async()=>({...fixture,selected:[],case_type_options:[]})});
await view.load(req);
assert.match(host.querySelector('.filing-quadrants').innerHTML,/No Civil or Criminal/);
console.log('PASS: quadrant order, monthly vs cumulative series, solid filing/disposal colors, single-type selection, full case-type menu, lifecycle and empty/error states.');
