// The paired comparison uses one plot per measure, two district bars, and median markers on p90 bars.
import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';

const charts={};
let config;
function Chart(canvas,chartConfig){this.canvas=canvas;this.config=chartConfig;this.destroy=()=>{};config=chartConfig;}
const sandbox={charts,Chart,console,esc:s=>String(s),fmt:v=>v==null?'—':String(v),text(){},destroy:key=>{delete charts[key];},document:{createElement:()=>({})}};
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync('app/static/js/pairs.js','utf8').replace(/^import .*;\n/gm,'').replaceAll('export ',''),sandbox);

const canvas={id:'paired-metric'};
const chartHost={innerHTML:''};
const element={querySelector(selector){return selector==='.pair-chart canvas'?canvas:chartHost;}};
const data={metric:'disposal',unit:'working days',a:{available:true,label:'District A · CJM',rows:[
 {case_type:'Gr Case',median:20,p90:55,n:100},{case_type:'Title Suit',median:10,p90:25,n:20},
]},b:{available:true,label:'District B · CJM',rows:[
 {case_type:'Gr Case',median:30,p90:80,n:90},{case_type:'Other',median:12,p90:40,n:15},
]}};
sandbox.paint(element,data,'tab-timeliness');
const chart=charts['pair:tab-timeliness:disposal'];
assert.ok(chart);
assert.equal(config.type,'bar');
assert.equal(config.options.indexAxis,undefined,'comparison metrics should use vertical columns');
assert.deepEqual(Array.from(config.data.labels),['Gr Case','Title Suit','Other']);
assert.equal(config.data.datasets.length,2,'one dataset per district');
assert.deepEqual(Array.from(config.data.datasets[0].data),[55,25,null]);
assert.deepEqual(Array.from(config.data.datasets[0].medianValues),[20,10,null]);
assert.deepEqual(Array.from(config.data.datasets[1].data),[80,null,40]);
assert.equal(config.data.datasets[0].label,'District A · CJM');
const comparisonBlock=sandbox.block({...data,metric:'hearings',label:'Hearings',about:'Median and p90',start:'2010-01',end:'2026-06',notes:[],
 a:{...data.a,start:'2010-01',end:'2026-06',cutoff:'2017-01-01'},
 b:{...data.b,start:'2010-01',end:'2026-06',cutoff:'2017-01-01'}});
assert.match(comparisonBlock.innerHTML,/eligible filings 2017-01–2026-06/,'cutoff-sensitive comparison timelines should show eligible filing months');
assert.match(comparisonBlock.innerHTML,/cutoff 2017-01-01 applied due to bulk-digitisation artefacts/);
const untruncatedBlock=sandbox.block({...data,metric:'hearings',label:'Hearings',about:'Median and p90',start:'2018-01',end:'2020-12',notes:[],
 a:{...data.a,start:'2018-01',end:'2020-12',cutoff:'2017-01-01'},
 b:{...data.b,start:'2018-01',end:'2020-12',cutoff:'2017-01-01'}});
assert.match(untruncatedBlock.innerHTML,/cases filed 2018-01–2020-12/);
assert.doesNotMatch(untruncatedBlock.innerHTML,/cutoff 2017-01-01/,'do not mention a cutoff that does not truncate the selected window');

const marker=config.plugins[0];
const paths=[];
const ctx={save(){},restore(){},beginPath(){},moveTo(x,y){paths.push(['move',x,y]);},lineTo(x,y){paths.push(['line',x,y]);},stroke(){}};
marker.afterDatasetsDraw({ctx,scales:{y:{getPixelForValue:v=>v*2}},data:{datasets:config.data.datasets},getDatasetMeta:i=>({data:i===0?[{width:20,x:10},{width:18,x:20},{}]:[{width:22,x:30},{},{}]})});
assert.ok(paths.some(p=>p[0]==='move'&&p[2]===40),'median marker should be drawn at the median value');
console.log('PASS: one paired district chart per metric, p90 bars, median markers, and unmatched case types.');
