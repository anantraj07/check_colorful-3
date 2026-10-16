// Same-fixture chart contract comparison against the frozen reference renderer.
// This runs JavaScript in a test sandbox, not browser automation.
import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
const reference=fs.readFileSync('docs/reference/intelligence.js','utf8');
const nodes=new Map();
function node(id){if(!nodes.has(id))nodes.set(id,{id,value:'actual',textContent:'',innerHTML:'',style:{},classList:{add(){},remove(){},contains(){return false;}},replaceChildren(){},append(){},addEventListener(){},querySelectorAll(){return [];}});return nodes.get(id);}
function sandbox(){
 const configs={};
 function Chart(canvas,config){configs[canvas.id]=config;this.config=config;this.destroy=()=>{};}
 Chart.defaults={font:{}};
 return {configs,Chart,document:{getElementById:node,addEventListener(){},querySelectorAll(){return [];},createElement:()=>node('temp')},window:{},console,fixture:null};
}
const rows=Array.from({length:8},(_,i)=>({code:String(i),case_type:'Type '+i,side:'Civil',filings:80-i*10,mean:8-i,median:7-i,p75:9-i,p90:12-i,max:20-i,n:10}));
const months=['2020-01','2020-02'];
const fixture={arrivals:rows,disposal:rows,gap:rows,hearings_per_case:rows,month_labels:months,arrival_series:Object.fromEntries(rows.map(r=>[r.case_type,[r.filings,0]])),arrival_rate_series:Object.fromEntries(rows.map(r=>[r.case_type,[r.mean,0]]))};
const old=sandbox();old.fixture=fixture;vm.createContext(old);vm.runInContext(reference,old);vm.runInContext("currentCourtData=fixture;selectedTrendTypes=fixture.arrivals.slice(0,3).map(r=>r.case_type);renderDistributionChart(fixture);renderHearingsChart(fixture);renderDisposalChart(fixture);renderGapChart(fixture);renderMeanFilingsChart(fixture);renderFilingSeries('trend','trendChart',fixture.arrival_series,'Filings',false);",old);
const fresh=sandbox();vm.createContext(fresh);
vm.runInContext(fs.readFileSync('app/static/js/visuals.js','utf8').replaceAll('export ',''),fresh);
assert.equal(vm.runInContext('fmt(1.234567)',fresh),'1.2346','numeric display should round to at most four decimals');
assert.equal(vm.runInContext('fmt(1.2)',fresh),'1.2','numeric display should not pad trailing zeros');
function render(key,data){fresh.payload=data;const code=fs.readFileSync(`app/static/js/components/${key}.js`,'utf8').replace(/^import .*;\n/gm,'').replace('export function render','function render');vm.runInContext('{'+code+'\nrender(payload);}',fresh);}
render('dist',{rows:[...rows.slice(0,7),{case_type:'Other case types',filings:10}]});
render('hearings',{rows:rows.slice(0,6),units:'hearings / disposed case'});
render('disposal',{rows:rows.slice(0,6)});render('gap',{rows:rows.slice(0,6)});
render('meanFilings',{rows:rows.slice(0,3)});
render('trend',{labels:months,series:rows.slice(0,3).map(r=>({code:r.code,label:r.case_type,values:[r.filings,0]})),units:'Filings'});
const plain=x=>JSON.parse(JSON.stringify(x));
assert.equal(fresh.configs.gapChart.options.plugins.tooltip.callbacks.label({dataset:{label:'Median'},parsed:{y:1.234567}}),'Median: 1.2346 working days');
assert.equal(fresh.configs.meanFilingsChart.options.plugins.tooltip.callbacks.label({dataset:{label:'Mean filings / month'},parsed:{y:1.234567}}),'Mean filings / month: 1.2346 cases');
assert.equal(fresh.configs.distributionChart.options.plugins.tooltip.callbacks.label({label:'GR',parsed:1.234567}),'GR: 1.2346 cases');
const zoomSource=fs.readFileSync('app/static/js/zoom.js','utf8').replace(/^import .*;\n/gm,'').replaceAll('export function','function')+'\nglobalThis.cloneChartConfigForTest=cloneChartConfig;';
vm.runInContext(zoomSource,fresh);
const zoomTooltip={callbacks:{label:()=> '1.2346'}};
fresh.zoomChartForTest={config:{type:'bar',data:{datasets:[{data:[1.234567]}]},options:{plugins:{tooltip:zoomTooltip}}}};
assert.equal(vm.runInContext('cloneChartConfigForTest(zoomChartForTest).options.plugins.tooltip',fresh),zoomTooltip,'zoomed charts should retain custom tooltip formatting');
assert.match(fs.readFileSync('app/static/js/app.js','utf8'),/rendererUrl\.searchParams\.set\('v',ASSET_VERSION\)/,'dynamic chart renderers should use a cache-busted URL');
for(const id of ['distributionChart','hearingsChart','disposalChart','gapChart','meanFilingsChart','trendChart']){
 const a=old.configs[id],b=fresh.configs[id];assert.ok(a&&b,id);
 assert.equal(a.type,b.type,id);assert.deepEqual(plain(a.data.labels),plain(b.data.labels),id);
 assert.equal(a.options.responsive,b.options.responsive,id);
 assert.equal(a.options.maintainAspectRatio,b.options.maintainAspectRatio,id);
 for(let i=0;i<a.data.datasets.length;i++){
  for(const field of ['data','backgroundColor','borderColor','borderWidth','borderRadius','tension','spanGaps','pointRadius'])assert.deepEqual(plain(a.data.datasets[i][field]??null),plain(b.data.datasets[i][field]??null),`${id}/${field}`);
 }
}
render('hearings',{units:'hearings / case-month',rows:[{case_type:'Precise test',median:1.234567,p75:1.234567,p90:1.234567}]});
const hearingLabel=fresh.configs.hearingsChart.options.plugins.tooltip.callbacks.label({dataIndex:0});
assert.deepEqual(plain(hearingLabel),['Median (50th): 1.2346 hearings / case-month','75th percentile: 1.2346 hearings / case-month','90th percentile: 1.2346 hearings / case-month'],'hearing-rate hover values should use four-decimal formatting');
fresh.hearingChartForTest={config:fresh.configs.hearingsChart,plugins:[]};
const zoomedHearingLabel=vm.runInContext('cloneChartConfigForTest(hearingChartForTest).options.plugins.tooltip.callbacks.label({dataIndex:0})',fresh);
assert.deepEqual(plain(zoomedHearingLabel),plain(hearingLabel),'zoomed hearing-rate tooltips should preserve formatted values');
// Each registry renderer is separately loadable and no renderer imports another.
const registry=JSON.parse(fs.readFileSync('app/components/registry.json','utf8'));
for(const [key,item] of Object.entries(registry)){
 const content=fs.readFileSync('app'+item.renderer,'utf8');
 assert.ok(content.includes('export function render'),key);
 assert.ok(!/^import .*from ['"]\.\//m.test(content),key+' imports another renderer');
}
console.log('PASS: six same-fixture chart contracts and all 17 independent renderer modules.');
