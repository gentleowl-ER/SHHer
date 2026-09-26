// Regression tests for the CBME assessment system (v5.21+)
// Usage: node smoke_test.js index.html
// Runs the page's own JavaScript against a fake browser and an in-memory
// Firestore REST emulator, then replays multi-device sync scenarios.
// Run in Taiwan time on a controllable clock so date logic is deterministic
// (default "now" = 2026-09-26 12:00 Taipei; each call advances 1 ms so ids stay unique).
process.env.TZ = 'Asia/Taipei';
const RealDate = Date; let NOW = RealDate.UTC(2026, 8, 26, 4, 0), TICK = 0;
global.Date = class extends RealDate { constructor(...a) { a.length ? super(...a) : super(NOW + (TICK++)); } static now() { return NOW + (TICK++); } };
const fs = require('fs');
const file = process.argv[2] || 'index.html';
const html = fs.readFileSync(file, 'utf8');
let js = '';
(html.match(/<script[^>]*>([\s\S]*?)<\/script>/g) || []).forEach(s => { js += s.replace(/<\/?script[^>]*>/g, '') + '\n'; });

// ── Fake browser ──
const LS = {};
global.localStorage = { getItem: k => (k in LS ? LS[k] : null), setItem: (k, v) => { LS[k] = String(v); }, removeItem: k => { delete LS[k]; } };
const els = {};
function mkEl(id) {
  const cls = new Set();
  return { id, value: '', innerHTML: '', textContent: '', checked: false, style: {}, className: '', dataset: {},
    classList: { add: c => cls.add(c), remove: c => cls.delete(c), toggle: (c, f) => { (f === undefined ? !cls.has(c) : f) ? cls.add(c) : cls.delete(c); }, contains: c => cls.has(c) },
    querySelectorAll: () => [], querySelector: () => null, appendChild() {}, addEventListener() {}, closest: () => null, focus() {},
    getContext: () => ({}), insertBefore() {}, remove() {} };
}
global.document = { getElementById: id => (els[id] = els[id] || mkEl(id)), querySelector: () => null, querySelectorAll: () => [],
  addEventListener() {}, createElement: () => mkEl('tmp'), body: { style: {}, classList: { add() {}, remove() {} } }, visibilityState: 'visible', head: { appendChild() {} }, documentElement: { style: { setProperty() {} } } };
global.window = { addEventListener() {}, innerWidth: 1200, scrollTo() {}, open() {} };
global.navigator = { userAgent: 'node' };
global.location = { hostname: 'x', host: 'x', protocol: 'https:' };
global.Chart = function () { return { destroy() {} }; };
global.ALERTS = []; global.CONFIRM = true;
global.alert = m => ALERTS.push(String(m));
global.confirm = () => CONFIRM;

// ── In-memory Firestore REST emulator ──
const STORE = {}; const LOG = []; let FAIL_NEXT = 0;
function segs(p) { const out = []; let i = 0; while (i < p.length) { if (p[i] === '`') { let j = i + 1, s = ''; while (j < p.length && p[j] !== '`') { if (p[j] === '\\') { s += p[j + 1]; j += 2; } else { s += p[j]; j++; } } out.push(s); i = j + 1; if (p[i] === '.') i++; } else { let j = p.indexOf('.', i); if (j < 0) j = p.length; out.push(p.slice(i, j)); i = j + 1; } } return out; }
const resp = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body) });
global.fetch = async (url, opts = {}) => {
  const u = new URL(url); const m = (opts.method || 'GET').toUpperCase();
  const rel = decodeURIComponent(u.pathname.split('/documents/')[1] || '');
  const masks = u.searchParams.getAll('updateMask.fieldPaths');
  if (m !== 'GET') LOG.push(m + ' ' + rel + (masks.length ? ' [' + masks.join(',') + ']' : ''));
  if (FAIL_NEXT > 0) { FAIL_NEXT--; return resp(503, { error: 'simulated outage' }); }
  const parts = rel.split('/');
  if (m === 'GET' && parts.length === 1) return resp(200, { documents: Object.entries(STORE).filter(([k]) => k.split('/')[0] === parts[0] && k.split('/').length === 2).map(([k, f]) => ({ name: k, fields: f })) });
  if (m === 'GET') return STORE[rel] ? resp(200, { fields: STORE[rel] }) : resp(404, {});
  if (m === 'DELETE') { delete STORE[rel]; return resp(200, {}); }
  if (m === 'PATCH') {
    const body = JSON.parse(opts.body);
    if (!masks.length) STORE[rel] = body.fields;
    else {
      const doc = STORE[rel] = STORE[rel] || {};
      masks.forEach(p => {
        const sg = segs(p);
        let src = { mapValue: { fields: body.fields } };
        for (const s of sg) src = src && src.mapValue && src.mapValue.fields ? src.mapValue.fields[s] : undefined;
        let tgt = doc;
        for (let k = 0; k < sg.length - 1; k++) { if (!tgt[sg[k]] || !tgt[sg[k]].mapValue) tgt[sg[k]] = { mapValue: { fields: {} } }; tgt = tgt[sg[k]].mapValue.fields; }
        if (src === undefined) delete tgt[sg[sg.length - 1]]; else tgt[sg[sg.length - 1]] = src;
      });
    }
    return resp(200, { fields: STORE[rel] });
  }
  return resp(400, {});
};
global.__H = { STORE, LOG, LS, setFail: n => { FAIL_NEXT = n; }, setNow: ms => { NOW = ms; TICK = 0; } };

// ── Scenarios (appended so they share the page's scope) ──
js = js.replace(/\ninit\(\);\s*$/, '\n') + `
;(async function(){
  let pass=0,fail=0;
  const T=(name,cond)=>{if(cond){pass++;}else{fail++;console.log('FAIL  '+name);}};
  autoSyncDebounced=function(){}; scheduleSyncRetry=function(){};
  const {STORE,LOG,setFail}=__H;
  const put=(col,id,obj)=>{STORE[col+'/'+id]=fsEncodeFields(obj);};
  const get=(col,id)=>STORE[col+'/'+id]?fsDecodeFields(STORE[col+'/'+id]):null;
  const writes=()=>LOG.splice(0);
  const nm=id=>(DEF_RES.find(r=>r.id===id)||{}).n; // names come from the page, not this file

  // Core functions must exist
  ['openM','closeM','toggleMode','applyMode'].forEach(f=>T('core '+f,typeof eval(f)==='function'));

  // ── Seed the cloud as another device left it ──
  DEF_RES.forEach(r=>{
    if(r.id==='RM')return;                                    // deleted earlier → must not come back
    const c=JSON.parse(JSON.stringify(r));
    if(r.id==='RA'){c.grad=true;c.no='';}                     // graduated, code released
    if(r.id==='RB'){c.grad=true;c.no='';}                     // graduated
    if(r.id==='RC')c.no='A';
    if(r.id==='RD')c.no='B';
    if(r.id==='RF')c.no='D';
    if(r.id==='RH')c.no='F';
    put('residents',r.id,c);
  });
  put('residents','NEW1',{id:'NEW1',no:'M',n:'新學員',y:'R1',grad:false,ward:{ind:'',obs:'',er:''},cccLevels:{},cccHistory:[],itemLocks:{}});
  DEF_ATT.forEach(a=>put('attendings',a.id,a));
  put('config','schedule',{data:{'2026-09-01':[{attId:'A99',resId:'RC'}]}});
  put('config','cfg',{...JSON.parse(JSON.stringify(CFG)),pw:'secret'});

  // ── 1. Load: cloud is the truth, nothing resurrected ──
  initSyncBase(); await syncDown(true); writes();
  T('deleted RM not resurrected',!RES.some(r=>r.id==='RM'));
  T('graduate code stays blank',getRes('RA').no===''&&getRes('RA').grad===true);
  T('cloud code F for RH',getRes('RH').no==='F');
  T('UI-added resident kept',!!getRes('NEW1'));
  T('cfg from cloud',CFG.pw==='secret');
  T('nothing pending after load',pendingSyncCount()===0);
  await autoSync(); T('idle autoSync writes nothing',writes().length===0);

  // ── 2. A stale device saving an evaluation must not clobber newer cloud data ──
  const rc=get('residents','RC');rc.itemLocks={'PC1-L1-1':true};put('residents','RC',rc);   // admin elsewhere
  const sd=get('config','schedule');sd.data['2026-09-02']=[{attId:'A88',resId:'RF'}];put('config','schedule',sd);
  const cf=get('config','cfg');cf.qEpaM=5;put('config','cfg',cf);
  const rec={id:1001,type:'ms',date:'2026-09-02',resId:'RC',resName:nm('RC'),attId:'A99'};
  ASSESS.unshift(rec);save();await saveCloud(rec);await autoSync();
  const w2=writes();
  T('evaluation save writes only the evaluation',w2.length===1&&w2[0]==='PATCH assessments/1001');
  T('admin locks survived',get('residents','RC').itemLocks['PC1-L1-1']===true);
  T('other date survived',!!get('config','schedule').data['2026-09-02']);
  T('other cfg change survived',get('config','cfg').qEpaM===5);

  // ── 3. Editing one resident writes one document ──
  getRes('RH').y='R4';save();await autoSync();
  const w3=writes();
  T('one resident edit = one write',w3.length===1&&w3[0]==='PATCH residents/RH');
  T('stale local RC not pushed',get('residents','RC').itemLocks['PC1-L1-1']===true);

  // ── 4. Schedule writes only the changed dates ──
  SCHED['2026-09-03']=[{attId:'A99',resId:'RH'}];delete SCHED['2026-09-01'];save();await autoSync();
  const w4=writes();
  T('schedule patch is per-date',w4.length===1&&w4[0].includes('data.\`2026-09-03\`')&&w4[0].includes('data.\`2026-09-01\`'));
  const cs=get('config','schedule').data;
  T('schedule: added / removed / others kept',!!cs['2026-09-03']&&!cs['2026-09-01']&&!!cs['2026-09-02']);

  // ── 5. Deleting a resident sticks ──
  RES=RES.filter(r=>r.id!=='NEW1');save();await autoSync();
  T('delete reaches cloud',writes().some(x=>x==='DELETE residents/NEW1')&&!get('residents','NEW1'));
  await syncDown(true);writes();
  T('deleted resident stays deleted',!getRes('NEW1')&&!getRes('RM'));

  // ── 6. 3-way merge: unsent local edit + remote edit both survive ──
  getRes('RF').y='R4';save();                                   // unsent
  const rd=get('residents','RD');rd.itemLocks={'PC2-L1-1':true};put('residents','RD',rd);   // remote
  await syncDown(true);writes();
  T('unsent local edit kept',getRes('RF').y==='R4');
  T('remote edit adopted',getRes('RD').itemLocks['PC2-L1-1']===true);
  T('remote cfg adopted',CFG.qEpaM===5);
  T('exactly one pending',pendingSyncCount()===1);
  const baseBefore=JSON.stringify(SYNC_BASE);SYNC_BASE=null;initSyncBase();
  T('sync snapshot survives reload',JSON.stringify(SYNC_BASE)===baseBefore&&pendingSyncCount()===1);
  await autoSync();const w6=writes();
  T('only the pending record uploaded',w6.length===1&&w6[0]==='PATCH residents/RF');

  // ── 7. Evaluation saved during an outage is not lost ──
  const rec2={id:1002,type:'ms',date:'2026-09-04',resId:'RH',resName:nm('RH'),attId:'A99'};
  ASSESS.unshift(rec2);save();setFail(1);
  T('failed upload reported',(await saveCloud(rec2))===false&&PENDING_ASSESS.includes('1002'));
  await syncDown(true);
  T('queued evaluation survives download',ASSESS.some(a=>a.id===1002));
  await autoSync();
  T('queued evaluation uploaded on retry',!!get('assessments','1002')&&PENDING_ASSESS.length===0);
  writes();

  // ── 8. Undefined fields don't cause endless re-uploads ──
  getRes('RC').tmpField=undefined;save();await autoSync();writes();await syncDown(true);writes();
  T('undefined/null round-trip stable',pendingSyncCount()===0);

  // ── 9. Schedule header: name first, active codes only, never guess ──
  const yr=new Date().getFullYear();
  getRes('RA').no='A';                                          // a graduate still holding A
  const a3=ATT[2].no;
  document.getElementById('sched-paste').value=['日期\\tA\\tD\\tＦ\\t'+nm('RE'),'9/5\\t99\\t88\\t'+a3+'\\t-'].join('\\n');
  parsePaste();
  const d5=SCHED[yr+'-09-05']||[];
  T('A → active RC, not the graduate',d5.some(e=>e.resId==='RC')&&!d5.some(e=>e.resId==='RA'));
  T('D → RF',d5.some(e=>e.resId==='RF'));
  T('full-width Ｆ → RH',d5.some(e=>e.resId==='RH'));
  getRes('RA').no='';
  const saveSched=JSON.stringify(SCHED);ALERTS.length=0;
  document.getElementById('sched-paste').value=['日期\\tX\\tY\\tZ','9/6\\t99\\t88\\t99'].join('\\n');
  parsePaste();
  T('unresolvable header → stop, no guessing',ALERTS.some(m=>m.includes('不會用猜的'))&&JSON.stringify(SCHED)===saveSched);
  RES.push({id:'TMP2',no:'D',n:'撞代碼',y:'R1',grad:false});
  document.getElementById('sched-paste').value=['日期\\tA\\tD\\tF\\t'+nm('RE'),'9/7\\t99\\t88\\t99\\t88'].join('\\n');
  parsePaste();
  const d7=SCHED[yr+'-09-07']||[];
  T('duplicate active code → column skipped + reported',!d7.some(e=>e.resId==='RF'||e.resId==='TMP2')&&d7.some(e=>e.resId==='RE')&&document.getElementById('paste-result').innerHTML.includes('同時符合'));
  RES=RES.filter(r=>r.id!=='TMP2');

  // ── 10. Adding/editing residents: name is the identity ──
  const n0=RES.length;ALERTS.length=0;
  openResM();document.getElementById('r-n').value=nm('RH');saveRes();
  T('duplicate active name blocked',RES.length===n0&&ALERTS.some(m=>m.includes('同名')));
  openResM();document.getElementById('r-n').value='新人甲';document.getElementById('r-no').value=' f ';saveRes();
  T('code clash blocked (" f " = F)',RES.length===n0&&ALERTS.some(m=>m.includes('已被在職學員')));
  openResM();document.getElementById('r-n').value='新人甲';document.getElementById('r-no').value='ｐ ';saveRes();
  const np=findResByName('新人甲')[0];
  T('new resident saved with normalized code',RES.length===n0+1&&np&&np.no==='P');
  editRes('RH');document.getElementById('r-grad').checked=true;saveRes();
  T('graduation releases code',getRes('RH').grad===true&&getRes('RH').no==='');
  editRes('RH');document.getElementById('r-grad').checked=false;document.getElementById('r-no').value='F';saveRes();

  // ── 11. Merging same-name duplicates keeps everything attached ──
  RES.push({id:'DUPX',no:'',n:' '+nm('RC')+' ',y:'R3',grad:false,cccHistory:[{date:'2025/12',levels:{PC1:3}}],itemLocks:{'X1':true},cccLevels:{},ward:{ind:'',obs:'',er:''}});
  ASSESS.unshift({id:1003,type:'ms',date:'2026-09-08',resId:'DUPX',resName:nm('RC')});
  SCHED['2026-09-08']=[{attId:'A99',resId:'DUPX'}];save();await autoSync();writes();
  T('same-name duplicate detected',findDuplicateNameGroups().some(g=>g.length===2));
  mergeDupResidents(normName(nm('RC')));
  const keep=findResByName(nm('RC'));
  T('one record remains',keep.length===1);
  const k=keep[0];
  T('evaluations re-pointed',ASSESS.filter(a=>a.resName===nm('RC')||a.resId==='DUPX'||a.resId==='RC').every(a=>a.resId===k.id));
  T('schedule re-pointed',SCHED['2026-09-08'].every(e=>e.resId===k.id));
  T('locks + CCC merged, code kept',k.itemLocks['X1']===true&&k.itemLocks['PC1-L1-1']===true&&k.cccHistory.some(h=>h.date==='2025/12')&&k.no==='A');
  await new Promise(r=>setTimeout(r,20));await autoSync();
  const gone=k.id==='RC'?'DUPX':'RC';
  T('merge synced (dup deleted in cloud)',!get('residents',gone)&&!!get('residents',k.id));

  // ── 12. Health check normalizes codes without touching membership ──
  const cnt=RES.length;getRes('RE').no=' e ';CONFIRM=true;await repairRoster();
  T('health check normalizes code',getRes('RE').no==='E'&&RES.length===cnt);

  // ── 13. CCC item codes: alias table, unknown codes reported, never stored ──
  T('alias PBLI → PBLI1',normalizeCCCCode('PBLI')==='PBLI1');
  T('alias pbl2 → PBLI2',normalizeCCCCode(' pbl2 ')==='PBLI2');
  T('full-width ＰＣ１ → PC1',normalizeCCCCode('ＰＣ１')==='PC1');
  T('unknown code → null',normalizeCCCCode('XYZ9')===null);
  const rg=getRes('RG');rg.cccHistory=[];
  document.getElementById('ccc-paste-area').value=[
    '1\\t'+nm('RG')+'\\tR3\\t2026/06\\tPBL2\\t3',
    '2\\t'+nm('RG')+'\\tR3\\t2026/06\\tXYZ9\\t2',
    '3\\t'+nm('RG')+'\\tR3\\t2026/06\\tEPA1\\t3c',
    '4\\t'+nm('RG')+'\\tR3\\t2026/06\\tPC1\\t3a',
    '5\\t'+nm('RG')+'\\tR3\\t2026/06\\tEPA2\\t2.5'].join('\\n');
  parseCCCPaste();
  const pr=document.getElementById('ccc-paste-result').innerHTML;
  const lv=(rg.cccHistory[0]||{}).levels||{};
  T('alias imported as PBLI2',lv.PBLI2===3&&!('PBL2' in lv));
  T('unknown code listed with line no., not stored',pr.includes('第 2 行')&&pr.includes('XYZ9')&&!Object.keys(lv).some(k=>k.includes('XYZ')));
  T('3c kept as "3c"',lv.EPA1==='3c');
  T('letter level on Milestone rejected + listed',!('PC1' in lv)&&pr.includes('第 4 行'));
  T('half level on EPA rejected + listed',!('EPA2' in lv)&&pr.includes('第 5 行'));
  await autoSync();writes();

  // ── 14. Legacy codes in stored CCC data are fixed once ──
  rg.cccHistory=[{date:'2025/06',levels:{PBLI:2,PBL2:2.5,XX9:1}},{date:'2025/12',levels:{PBLI:2,PBLI1:3}}];save();await autoSync();writes();
  T('migration reports a change',migrateCCCCodes()===true);
  T('legacy keys renamed',rg.cccHistory[0].levels.PBLI1===2&&rg.cccHistory[0].levels.PBLI2===2.5&&!('PBLI' in rg.cccHistory[0].levels));
  T('clash keeps correct key + noted',rg.cccHistory[1].levels.PBLI1===3&&!('PBLI' in rg.cccHistory[1].levels)&&CCC_MIGRATE_NOTES.length===1);
  T('leftover unknown code surfaced',findUnknownCCCCodes().some(u=>u.key==='XX9'));
  await autoSync();const w14=writes();
  T('migration = one write per resident',w14.length===1&&w14[0]==='PATCH residents/RG');
  T('second run is a no-op',migrateCCCCodes()===false);
  await autoSync();T('no further writes',writes().length===0);

  // ── 15. Growth-chart scales and matrix Milestone source ──
  T('EPA 3 plotted as 3a',epaLevelToY('3')===epaLevelToY('3a')&&epaLevelToY('3a')===3);
  T('EPA axis 1,2,3a,3b,3c,4,5 evenly',['1','2','3a','3b','3c','4','5'].map(epaLevelToY).join()==='1,2,3,4,5,6,7');
  T('MS 2.5 stays 2.5 (no 3a/3b mapping)',msScoreToY(2.5)===2.5&&msScoreToY('3')===3&&msScoreToY('3a')===null);
  rg.cccHistory=[{date:'2025/06',levels:{PC1:2}},{date:'2025/12',levels:{PC1:3.5}},{date:'2026/06',levels:{EPA1:'4'}}];
  T('matrix MS = latest CCC score',getCCCMsScore(rg,'PC1')===3.5);
  T('matrix MS without CCC = null',getCCCMsScore(rg,'PC6')===null);
  rg.cccHistory.push({date:'2026/07',levels:{EPA3:'3'}});
  T('matrix EPA plain "3" read from CCC',getCCCScore(rg,'EPA3',0)===3);
  let crash='';
  try{renderShher();document.getElementById('growth-res').value='RG';
    ['epa','ms'].forEach(c=>{document.getElementById('growth-cat').value=c;renderGrowthChart();});}catch(e){crash=e.message;}
  T('matrix + growth chart render ('+crash+')',!crash&&document.getElementById('shher-table').innerHTML.includes('可呈現'));

  // ── 16. Whole-database upload is gone ──
  T('no syncUp button or function',typeof syncUp==='undefined'&&!html.includes('syncUp('));

  // ── 17. EPA time charts: every EPA, own points only, real dates ──
  const g=getRes('RG');g.grad=false;g.y='R3';
  const EV=[
    {id:2001,type:'ms',date:'2025-11-20',resId:'RG',resYear:'R2',attName:'甲醫師',epaScores:{EPA1:2},epaFb:{EPA1:'第一次'},overallFb:'整體'},
    {id:2002,type:'ms',date:'2026-02-03',resId:'RG',resYear:'R3',attName:'乙醫師',epaScores:{EPA3:3},overallFb:'x'.repeat(60)},
    {id:2003,type:'ms',date:'2026-02-10',resId:'RG',resYear:'R3',attName:'丙醫師',epaScores:{EPA1:3}},
    {id:2004,type:'ms',date:'2026-02-25',resId:'RC',resYear:'R3',attName:'丙醫師',epaScores:{EPA1:5}},
    {id:2005,type:'ms',date:'2026-03-01',resId:'RG',resYear:'R3',attName:'甲醫師',epaScores:{EPA7:4}}];
  const ser=buildEpaSeries(EV.filter(a=>a.resId==='RG'));
  T('all 7 EPAs built',ser.length===EPA.length&&EPA.length>=7);
  const e1=ser.find(s=>s.id==='EPA1').pts;
  T('EPA1 has only its own points, no gaps',e1.length===2&&e1.every(p=>p.y!=null));
  T('x is real time, ascending, across years',e1[0].x===Date.UTC(2025,10,20)&&e1[1].x===Date.UTC(2026,1,10)&&tsToYM(e1[0].x)==='2025/11');
  T('point carries teacher + per-EPA feedback',e1[0].att==='甲醫師'&&e1[0].fb==='第一次');
  const e3=ser.find(s=>s.id==='EPA3').pts[0];
  T('falls back to overall feedback, cut to 40',e3.fb.length===41&&e3.fb.endsWith('…'));
  const gm=buildGradeMonthly(EV);
  const r3=gm.find(x=>x.yr==='R3');
  T('grade monthly: same grade+month averaged',r3.pts.find(p=>tsToYM(p.x)==='2026/02').y===3.67&&r3.pts.find(p=>tsToYM(p.x)==='2026/02').cnt===3);
  T('grade monthly: grades kept apart (evaluation-time grade)',gm.find(x=>x.yr==='R2').pts.length===1);
  const row1=SHHER_EPA.find(r=>r[0]==='EPA1');
  T('expectation = matrix column',shherExpected(row1,'R3')===row1[6]&&shherExpected(row1,'R1')===row1[2]);
  const CFGS=[];const RealChart=Chart;Chart=function(ctx,cfg){CFGS.push(cfg);return{destroy(){}};};
  const keepA=ASSESS;ASSESS=[...EV,...keepA];
  let crash17='';
  try{
    document.getElementById('ana-r').value='RG';renderAnalytics();
    const c1=CFGS.find(c=>c.type==='line');CFGS.length=0;
    const main=c1.data.datasets.filter(d=>!d._exp),exp=c1.data.datasets.filter(d=>d._exp);
    T('resident chart: each scored EPA one line + dashed expectation',main.length===3&&exp.length===3&&exp.every(d=>d.borderDash));
    T('resident chart: time axis',c1.options.scales.x.type==='linear');
    T('expectation line at current-grade value',exp.find(d=>d._epa==='EPA1').data[0].y===row1[6]);
    T('legend hides dashed entries',c1.options.plugins.legend.labels.filter({datasetIndex:c1.data.datasets.indexOf(exp[0])})===false);
    document.getElementById('ana-r').value='';renderAnalytics();
    const c2=CFGS.find(c=>c.type==='line');CFGS.length=0;
    T('no resident → grade lines',c2.data.datasets.every(d=>/^R[1-4]$/.test(d.label))&&c2.data.datasets.length>=2);
    renderDashCharts();
    const c3=CFGS.find(c=>c.type==='line');
    T('dashboard → grade lines, not first 6 residents',c3&&c3.data.datasets.every(d=>/^R[1-4]$/.test(d.label)));
    CFGS.length=0;showGrad('RG');
    T('graduate chart uses per-EPA series, no expectation',CFGS.some(c=>c.data.datasets.some(d=>d._epa)&&!c.data.datasets.some(d=>d._exp)));
  }catch(e){crash17=e.stack||e.message;}
  T('charts render ('+crash17+')',!crash17);
  Chart=RealChart;ASSESS=keepA;

  // ── 18. v5.24 analytics: heatmap, scope, coverage, CCC radar ──
  const pc1=MS.find(m=>m.id==='PC1').items.map(i=>i.id);
  const HE=[
    {id:3001,type:'ms',date:'2025-12-05',resId:'T1',attName:'甲',selMs:['PC1'],msItems:{[pc1[0]]:'stable',[pc1[1]]:'unstable',[pc1[2]]:'notobserved'}},
    {id:3002,type:'ms',date:'2025-12-20',resId:'T1',attName:'乙',selMs:['PC1','ICS2'],msItems:{[pc1[0]]:'stable'}},
    {id:3003,type:'ms',date:'2026-01-08',resId:'T2',attName:'甲',selMs:['PC1'],msItems:{[pc1[0]]:'notobserved'}},
    {id:3004,type:'ms',date:'2026-01-09',resId:'T3',attName:'丙',selMs:['PC6'],epaScores:{EPA1:3}}];
  const hm=buildMsHeatmap(HE,['2025/12','2026/01']);
  const hPC1=hm.rows.find(r=>r.id==='PC1');
  T('heatmap: stable/unstable summed, not-observed ignored',hPC1.cells[0].s===2&&hPC1.cells[0].u===1&&hPC1.cells[0].pct===67&&hPC1.cells[0].n===2);
  T('heatmap: only-not-observed month → null, not 0%',hPC1.cells[1].pct===null&&hPC1.cells[1].n===1);
  T('heatmap: unassessed cell n=0, pct null',hm.rows.find(r=>r.id==='SBP3').cells[0].n===0&&hm.rows.find(r=>r.id==='SBP3').cells[0].pct===null);
  T('heatmap: 27 rows in MS order, teachers kept',hm.rows.length===MS.length&&hm.rows[0].id===MS[0].id&&hPC1.cells[0].atts.join()==='甲,乙');
  T('lastMonths spans years in order',lastMonths(3,new Date(2026,0,10)).join()==='2025/11,2025/12,2026/01');
  RES.push({id:'T1',no:'',n:'測一',y:'R2',grad:false,cccHistory:[{date:'2026/06',levels:{PC1:2,PC6:3,MK1:4,ICS2:2}}]},
           {id:'T2',no:'',n:'測二',y:'R2',grad:false,cccHistory:[{date:'2026/06',levels:{PC1:3,MK1:2}}]},
           {id:'T3',no:'',n:'測三',y:'R2',grad:true,cccHistory:[{date:'2026/06',levels:{PC1:5,MK1:5}}]});
  const keepA18=ASSESS;ASSESS=[...HE,...keepA18];
  document.getElementById('ana-r').value='';document.getElementById('ana-y').value='R2';
  let sc=anaScope();
  T('scope by grade = current, non-graduated cohort',sc.residents.every(r=>r.y==='R2'&&!r.grad)&&sc.list.some(a=>a.resId==='T1')&&!sc.list.some(a=>a.resId==='T3'));
  document.getElementById('ana-r').value='T3';sc=anaScope();
  T('resident overrides grade',sc.res.id==='T3'&&sc.list.length===1);
  const cov=buildCoverage(HE);
  const cv=id=>[...cov.epa,...cov.ms].find(x=>x.id===id);
  T('coverage: never assessed → none',cv('SBP3').flag==='none'&&cv('EPA2').flag==='none');
  T('coverage: counts per item',cv('PC1').n===3&&cv('ICS2').n===1&&cv('EPA1').n===1);
  const cov2=buildCoverage([...Array(6)].map((_,i)=>({type:'ms',date:'2026-01-0'+(i+1),selMs:MS.map(m=>m.id).filter(id=>id!=='PC2'||i===0)})));
  T('coverage: under half the median → low (own group median)',cov2.ms.find(x=>x.id==='PC2').flag==='low'&&cov2.medMs===6&&cov2.medEpa===0);
  const rdr=buildCatRadar(getRes('T1'));
  const iPC=MS_CATS.indexOf('PC'),iMK=MS_CATS.indexOf('MK'),iSBP=MS_CATS.indexOf('SBP');
  T('radar: competency mean + n/total',rdr.mine[iPC].v===2.5&&rdr.mine[iPC].n===2&&rdr.mine[iPC].total===MS.filter(m=>m.cat==='PC').length);
  T('radar: no CCC for a competency → null',rdr.mine[iSBP].v===null&&rdr.mine[iSBP].n===0);
  T('radar: peer average excludes graduates',rdr.peer[iMK].v===3&&rdr.peer[iMK].n===2);
  T('radar: graduate has no peer line',buildCatRadar(getRes('T3')).peer===null);
  const CF=[];const RC2=Chart;Chart=function(ctx,cfg){CF.push(cfg);return{destroy(){}};};
  const jsErr=[];const keepErr=showJsError;showJsError=m=>jsErr.push(m);
  let crash18='';
  try{
    document.getElementById('ana-r').value='T1';document.getElementById('ana-y').value='';renderAnalytics();
    const rc=CF.find(c=>c.type==='radar'&&c.data.datasets.some(d=>d._n));
    T('CCC radar drawn with peer line + n labels',rc&&rc.data.datasets.length===2&&rc.data.labels[iPC].includes('(2/')&&rc.data.labels[iSBP].includes('—'));
    T('CCC radar: low-n points hollow',rc.data.datasets[0].pointBackgroundColor[iPC]==='transparent');
    const bars=CF.filter(c=>c.type==='bar'&&c.options.indexAxis==='y');
    T('coverage: two horizontal bar charts',bars.length===2&&bars[1].data.labels.length===MS.length);
    T('coverage: base colour for ok, flag colour + text for flagged',bars[1].data.labels.some(l=>l.includes('⚠未評'))&&new Set(bars[1].data.datasets[0].backgroundColor.filter((c,i)=>!bars[1].data.labels[i].includes('⚠')&&!bars[1].data.labels[i].includes('▼'))).size<=1);
    CF.length=0;document.getElementById('ana-r').value='';document.getElementById('ana-y').value='R2';
    ASSESS=[...HE.map(a=>({...a,date:tsToYMD(Date.UTC(new Date().getFullYear(),new Date().getMonth(),5)).replace(/\\//g,'-')})),...keepA18];
    renderAnalytics();
    const html=document.getElementById('ms-heatmap').innerHTML;
    T('heatmap HTML: n=3 full colour, n=1 faded, unassessed hatched',/class="c" [^>]*>67%<small>n=3/.test(html)&&html.includes('class="c empty low"')&&html.includes('class="c empty"'));
    T('no resident → CCC radar hint, no chart',!CF.some(c=>c.type==='radar'&&c.data.datasets.some(d=>d._n))&&document.getElementById('ccc-radar-note').textContent.includes('請選擇'));
    const gl=CF.find(c=>c.type==='line');
    T('grade monthly: low-n points hollow',!gl||gl.data.datasets.every(d=>d.data.every((p,i)=>p.cnt>=LOW_N||d.pointBackgroundColor[i]==='transparent')));
  }catch(e){crash18=e.stack||e.message;}
  T('v5.24 charts render ('+crash18+jsErr.join()+')',!crash18&&!jsErr.length);
  Chart=RC2;showJsError=keepErr;ASSESS=keepA18;RES=RES.filter(r=>!['T1','T2','T3'].includes(r.id));
  document.getElementById('ana-r').value='';document.getElementById('ana-y').value='';

  // ── 19. v5.25: local dates, night-shift default, image block, cross-year roster ──
  const at=(y,mo,d,h,mi)=>__H.setNow(Date.UTC(y,mo-1,d,h-8,mi||0)); // Taipei wall-clock → UTC
  at(2026,9,27,7,30);
  T('07:30 Taipei is today, not yesterday (UTC)',tod()==='2026-09-27');
  T('monthStart local',monthStart('2026-09-27')==='2026-09-01');
  T('dateOffset across month/year',dateOffset('2026-12-31',1)==='2027-01-01'&&dateOffset('2026-03-01',-1)==='2026-02-28');
  at(2026,10,1,7,30);
  ASSESS.unshift({id:4001,type:'ms',date:'2026-10-01',resId:'RE',attId:'A99',selMs:['PC1'],selEpa:['EPA1']});
  T('monthly limit counts this local month at 07:30 on the 1st',mkStr()==='2026-10'&&getMsMonthCnt('RE','PC1')===1&&getEpaMonthCnt('RE','EPA1')===1);
  renderDash();
  T('"today done" uses local today',document.getElementById('st-td').textContent==1);
  ASSESS=ASSESS.filter(a=>a.id!==4001);
  // night shift
  SCHED['2026-09-26']=[{attId:'A99',resId:'RE'}];
  at(2026,9,27,8,30);
  T('before 09:00 + owed yesterday → yesterday',defaultAssessDate('A99')==='2026-09-26');
  T('someone not on shift → today',defaultAssessDate('A88')==='2026-09-27');
  at(2026,9,27,10,0);
  T('after 09:00 → today',defaultAssessDate('A99')==='2026-09-27');
  at(2026,9,27,8,30);
  document.getElementById('f-att').value='A99';fDateAuto=true;onAttChange();
  T('auto date = yesterday + night-shift hint',document.getElementById('f-date').value==='2026-09-26'&&document.getElementById('tshift').textContent.includes('🌙'));
  fDateAuto=false;document.getElementById('f-date').value='2026-09-20';onAttChange();
  T('hand-picked / quick-link date not overwritten',document.getElementById('f-date').value==='2026-09-20');
  ASSESS.unshift({id:4002,type:'ms',date:'2026-09-26',resId:'RE',attId:'A99'});
  T('already evaluated yesterday → today',defaultAssessDate('A99')==='2026-09-27');
  ASSESS=ASSESS.filter(a=>a.id!==4002);
  // image block
  const fill=(pid,cm,type)=>{document.getElementById('embed-img-enabled').checked=true;document.getElementById('eipid').value=pid;document.getElementById('eimg-comment').value=cm;embedImgType=type;};
  const trySave=()=>{const n=ASSESS.length;document.getElementById('f-res').value='RE';document.getElementById('f-att').value='A99';document.getElementById('f-overall-fb').value='回饋內容至少十個字以上';
    selEpa=[];selPcMs=[];selNpcMs=[];document.getElementById('ass-err').classList.add('hidden');['wp3','wp4'].forEach(i=>document.getElementById(i).classList.toggle('active',i==='wp4'));saveAssess();return ASSESS.length>n;};
  fill('','','');
  T('image block on but untouched → saves, no image',trySave()&&ASSESS[0].imgData==null);
  fill('A123','','');
  T('only chart number → not saved',!trySave());
  T('…back on step 4 with the field flagged',document.getElementById('wp3').classList.contains('active')&&!document.getElementById('wp4').classList.contains('active')&&!document.getElementById('eimg-type-err').classList.contains('hidden')&&document.getElementById('ass-err').textContent.includes('影像種類'));
  fill('','','CT');
  T('type only → saves with image',trySave()&&ASSESS[0].imgData&&ASSESS[0].imgData.imgType==='CT');
  T('cancel only clears embedded buttons',!/document\\.querySelectorAll\\('\\.itbtn'\\)/.test(cancelEmbedImg.toString())&&!/document\\.querySelectorAll\\('\\.itbtn'\\)/.test(selImgType.toString()));
  // cross-year roster
  let conf=0;const realConfirm=confirm;confirm=()=>{conf++;return CONFIRM;};
  const a99=getAtt('A99').no;
  const pasteRoster=row=>{document.getElementById('sched-paste').value=['日期\\t'+nm('RE')+'\\t'+nm('RF')+'\\t'+nm('RG'),row+'\\t'+a99+'\\t-\\t-'].join('\\n');parsePaste();return document.getElementById('paste-result').innerHTML;};
  at(2026,12,20,10);CONFIRM=true;conf=0;
  let out=pasteRoster('1/5');
  T('December pasting 1/5 → next year',!!(SCHED['2027-01-05']||[]).some(e=>e.resId==='RE')&&!SCHED['2026-01-05']?.some(e=>e.resId==='RE'&&e.attId==='A99'));
  T('cross-year asks first + result shows year/month',conf===1&&out.includes('2027 年 1 月'));
  CONFIRM=false;out=pasteRoster('1/6');
  T('cancel → nothing written',!SCHED['2027-01-06']&&out.includes('已取消'));
  CONFIRM=true;at(2027,1,3,10);
  pasteRoster('12/28');
  T('January pasting 12/28 → last year',!!(SCHED['2026-12-28']||[]).some(e=>e.resId==='RE'));
  at(2026,9,26,12);conf=0;out=pasteRoster('9/10');
  T('same-year paste: no prompt, year/month shown',conf===0&&(SCHED['2026-09-10']||[]).some(e=>e.resId==='RE')&&out.includes('2026 年 9 月'));
  T('inferYear picks nearest',inferYear(1,5,new Date(2026,11,20))===2027&&inferYear(12,28,new Date(2027,0,3))===2026&&inferYear(6,1,new Date(2026,8,26))===2026);
  confirm=realConfirm;

  console.log((fail?'❌':'✅')+' '+pass+' passed, '+fail+' failed');
  process.exitCode=fail?1:0;
})().catch(e=>{console.log('❌ CRASH',e&&e.stack||e);process.exitCode=1;});
`;
eval(js);
