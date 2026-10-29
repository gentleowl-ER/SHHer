/**
 * SHHer 班表自動同步（Google Apps Script）
 * 設定步驟見 automation/README.md。
 *
 * 每小時觸發一次 hourly()：到了管理員設定的時間（config/cfg 的 schedHour，台北時間）
 * 且今天還沒同步，就讀「本月」與「下個月」的試算表（config/cfg 的 schedSrc），
 * 只更新試算表上出現的日期（config/schedule 的 data.<日期>），並在 config/schedLog 留紀錄。
 * 管理員頁的「立即同步」經由 doPost() 呼叫，需要通關碼（指令碼屬性 SYNC_TOKEN）。
 *
 * 只讀 Shiftcard 分頁的住院醫師欄與「班表」分頁的「醫師姓名」表（代碼、姓名兩欄），
 * 不讀電話欄，也不用 Shiftcard 右側的舊代碼表。主治醫師一律以姓名對應系統，絕不以代碼猜。
 */

// ==SCHED-CORE-BEGIN== (identical copy in index.html and automation/schedule_sync.gs; smoke_test checks they match)
// Monthly roster parsing shared by the web page and the Apps Script sync.
// Residents: Shiftcard row 2 = name (identity), row 1 = code (fallback, active residents only).
// Attendings: the month's own code→name table, then matched to the system BY NAME; never by code.
function ssNorm(s){return String(s==null?'':s).normalize('NFKC').replace(/\s+/g,'').toLowerCase();}
function ssStripParen(s){return ssNorm(s).replace(/\([^)]*\)/g,'');}
// One person by name: exact (normalized) match first, then ignoring "(…)" — e.g. 王鎮珄(西園) = 王鎮珄.
function ssMatchName(name,list){
  const k=ssNorm(name);if(!k)return{why:'無姓名'};
  let hit=list.filter(p=>ssNorm(p.n)===k);
  if(!hit.length){const k2=ssStripParen(name);hit=k2?list.filter(p=>ssStripParen(p.n)===k2):[];}
  if(hit.length===1)return{hit:hit[0]};
  return{why:hit.length?'同時符合 '+hit.map(p=>p.n).join('、'):'系統內找不到「'+String(name).trim()+'」'};
}
// Code→name table. Accepts the 班表 tab (finds the 「醫師姓名」 header: names in that column,
// codes in the column to its left, until the first blank row) or plain "code<TAB>name" rows.
function ssParseNameTable(rows){
  const out={};let hr=-1,nc=-1;
  for(let r=0;r<Math.min(rows.length,8)&&hr<0;r++)(rows[r]||[]).forEach((c,i)=>{if(hr<0&&ssNorm(c)==='醫師姓名'){hr=r;nc=i;}});
  if(hr>=0&&nc<1)return out;
  const start=hr>=0?hr+1:0,cc=hr>=0?nc-1:0,ncol=hr>=0?nc:1;
  for(let r=start;r<rows.length;r++){
    const code=String((rows[r]||[])[cc]==null?'':rows[r][cc]).normalize('NFKC').replace(/\s+/g,'').toUpperCase();
    const name=String((rows[r]||[])[ncol]==null?'':rows[r][ncol]).trim();
    if(!code&&!name)break;          // table ends at the first blank row
    if(code&&name)out[code]=name;   // sub-headers such as 「主治醫師」 have no code
  }
  return out;
}
// "M/D" belongs to the source month's year; a December sheet's 1/x rows are next year.
function ssYearFor(month,m){const y=+month.slice(0,4),sm=+month.slice(5,7);return m-sm>6?y-1:sm-m>6?y+1:y;}
function buildMonthSchedule(o){
  const grid=o.grid||[],month=o.month,nt=o.nameTable||{};
  const active=(o.residents||[]).filter(r=>!r.grad);
  const codes=grid[0]||[],names=grid[1]||[];
  const dateRows=[];
  for(let r=2;r<grid.length;r++){const m=String((grid[r]||[])[0]||'').trim().match(/^(\d{1,2})[\/\-](\d{1,2})$/);
    if(m&&+m[1]>=1&&+m[1]<=12&&+m[2]>=1&&+m[2]<=31)dateRows.push({r,m:+m[1],d:+m[2]});else if(dateRows.length)break;}
  const hasData=c=>dateRows.some(x=>{const v=String((grid[x.r]||[])[c]||'').trim();return v&&v!=='-';});
  const cols=[],skippedRes=[];
  for(let c=1;c<Math.max(codes.length,names.length);c++){
    const nm=String(names[c]||'').trim(),cd=String(codes[c]||'').normalize('NFKC').replace(/\s+/g,'').toUpperCase();
    if(!nm&&!cd)break;                                   // resident block ends at the first empty column
    if(nm){const h=ssMatchName(nm,active);
      if(h.hit)cols.push({c,resId:h.hit.id});
      else{const g=ssMatchName(nm,(o.residents||[]).filter(r=>r.grad)).hit;skippedRes.push({col:c,label:nm,why:g?'已畢業':h.why});}
      continue;}
    if(!/^[A-Z]$/.test(cd)||!hasData(c))continue;        // code-only columns: letters with data only
    const byCode=active.filter(r=>String(r.no||'').normalize('NFKC').replace(/\s+/g,'').toUpperCase()===cd);
    if(byCode.length===1)cols.push({c,resId:byCode[0].id});
    else skippedRes.push({col:c,label:cd,why:byCode.length?'代碼重複':'找不到在職學員'});
  }
  const dates={},skipped={};let entries=0;
  dateRows.forEach(x=>{
    const ds=ssYearFor(month,x.m)+'-'+String(x.m).padStart(2,'0')+'-'+String(x.d).padStart(2,'0');
    const list=dates[ds]=dates[ds]||[];
    cols.forEach(col=>{
      const cell=String((grid[x.r]||[])[col.c]||'').normalize('NFKC').replace(/\s+/g,'').toUpperCase();
      if(!cell||cell==='-'||cell==='0'||cell==='S')return;
      const name=nt[cell];let why='';let att=null;
      if(!name)why='代碼不在醫師姓名表';else{const h=ssMatchName(name,o.attendings||[]);att=h.hit;why=h.why||'';}
      if(!att){const k=cell+(name?'='+name:'');(skipped[k]=skipped[k]||{code:cell,name:name||'',why,n:0}).n++;return;}
      if(!list.some(e=>e.attId===att.id&&e.resId===col.resId)){list.push({attId:att.id,resId:col.resId});entries++;}
    });
  });
  const ds=Object.keys(dates).sort();
  return{dates,days:ds.length,entries,first:ds[0]||'',last:ds[ds.length-1]||'',skippedCodes:Object.values(skipped),skippedRes};
}
// Sheet titles such as 「雙和115-10急診值班表」 carry the ROC year-month: 115-10 → 2026-10.
function ssTitleMonth(title){const m=String(title||'').match(/(1\d\d)\s*[-年\/.]\s*(\d{1,2})/);return m?(+m[1]+1911)+'-'+String(+m[2]).padStart(2,'0'):'';}
// ==SCHED-CORE-END==

// ── settings (Project Settings → Script properties) ──
function cfgProp(k){return PropertiesService.getScriptProperties().getProperty(k)||'';}
function fsBase(){return 'https://firestore.googleapis.com/v1/projects/'+cfgProp('FB_PROJECT')+'/databases/(default)/documents';}

// ── Firestore REST (same value encoding as the web page) ──
function fsEnc(v){
  if(v===null||v===undefined)return{nullValue:null};
  if(typeof v==='boolean')return{booleanValue:v};
  if(typeof v==='number')return Number.isInteger(v)?{integerValue:String(v)}:{doubleValue:v};
  if(typeof v==='string')return{stringValue:v};
  if(Array.isArray(v))return{arrayValue:{values:v.map(fsEnc)}};
  const f={};Object.keys(v).forEach(k=>{f[k]=fsEnc(v[k]);});return{mapValue:{fields:f}};
}
function fsDec(val){
  if(!val||'nullValue' in val)return null;
  if('booleanValue' in val)return val.booleanValue;
  if('integerValue' in val)return parseInt(val.integerValue,10);
  if('doubleValue' in val)return val.doubleValue;
  if('stringValue' in val)return val.stringValue;
  if('arrayValue' in val)return(val.arrayValue.values||[]).map(fsDec);
  if('mapValue' in val)return fsDecFields(val.mapValue.fields||{});
  return null;
}
function fsDecFields(f){const o={};Object.keys(f||{}).forEach(k=>{o[k]=fsDec(f[k]);});return o;}
function fsCall(path,method,body){
  const url=fsBase()+path+(path.indexOf('?')<0?'?':'&')+'key='+cfgProp('FB_API_KEY');
  const opt={method:method||'get',muteHttpExceptions:true,contentType:'application/json'};
  if(body)opt.payload=JSON.stringify(body);
  const res=UrlFetchApp.fetch(url,opt);const code=res.getResponseCode();
  if(code===404&&(method||'get')==='get')return null;
  if(code<200||code>=300)throw new Error('Firestore '+code+'：'+String(res.getContentText()).slice(0,150));
  return JSON.parse(res.getContentText()||'{}');
}
function fsGet(col,id){const d=fsCall('/'+col+'/'+encodeURIComponent(id));return d?fsDecFields(d.fields):null;}
function fsList(col){
  let out=[],tok='';
  do{const d=fsCall('/'+col+'?pageSize=300'+(tok?'&pageToken='+encodeURIComponent(tok):''))||{};
    (d.documents||[]).forEach(x=>out.push(fsDecFields(x.fields)));tok=d.nextPageToken||'';}while(tok);
  return out;
}
function fsSeg(k){return /^[A-Za-z_][A-Za-z0-9_]*$/.test(k)?k:'`'+String(k).replace(/\\/g,'\\\\').replace(/`/g,'\\`')+'`';}
// Update only the listed field paths; everything else in the document is left alone.
function fsPatch(col,id,data,paths){
  if(!paths.length)return;
  const q=paths.map(p=>'updateMask.fieldPaths='+encodeURIComponent(p)).join('&');
  fsCall('/'+col+'/'+encodeURIComponent(id)+'?'+q,'patch',{fields:fsEnc(data).mapValue.fields});
}

// ── time (Asia/Taipei) ──
function nowTpe(){const d=new Date();return{ymd:Utilities.formatDate(d,'Asia/Taipei','yyyy-MM-dd'),hour:+Utilities.formatDate(d,'Asia/Taipei','H'),stamp:Utilities.formatDate(d,'Asia/Taipei','yyyy-MM-dd HH:mm')};}
function monthAdd(ym,n){const y=+ym.slice(0,4),m=+ym.slice(5,7)-1+n;const yy=y+Math.floor(m/12),mm=((m%12)+12)%12+1;return yy+'-'+String(mm).padStart(2,'0');}

// ── reading one month's spreadsheet (two tabs, no phone column) ──
function readSource(url){
  let ss;
  try{ss=SpreadsheetApp.openByUrl(url);}
  catch(e){throw new Error('試算表無法開啟：沒有共用給執行同步的 Google 帳號，或網址錯誤');}
  const sc=ss.getSheetByName('Shiftcard');if(!sc)throw new Error('找不到「Shiftcard」分頁');
  const bt=ss.getSheetByName('班表');if(!bt)throw new Error('找不到「班表」分頁');
  const grid=sc.getDataRange().getDisplayValues();
  // Locate the 「醫師姓名」 header in the header rows (1–3, no data there), then read ONLY its
  // code and name columns — never the phone column next to them.
  const lastCol=bt.getLastColumn(),top=bt.getRange(1,1,Math.min(3,bt.getLastRow()),lastCol).getDisplayValues();
  let hr=-1,nc=-1;
  top.forEach((row,r)=>row.forEach((c,i)=>{if(hr<0&&ssNorm(c)==='醫師姓名'){hr=r;nc=i;}}));
  if(hr<0||nc<1)throw new Error('「班表」分頁找不到「醫師姓名」表');
  const n=Math.max(0,bt.getLastRow()-(hr+1));
  const pairs=n?bt.getRange(hr+2,nc,n,2).getDisplayValues():[]; // columns: code, name
  return{title:ss.getName(),grid,nameTable:ssParseNameTable(pairs)};
}

// ── one sync run ──
// months: ['2026-10','2026-11']; trigger: 'auto' | 'manual'. Returns the log entries.
function syncMonths(months,trigger){
  const cfg=fsGet('config','cfg')||{};const src=cfg.schedSrc||{};const t=nowTpe();
  let residents=null,attendings=null;const logs=[];
  months.forEach(month=>{
    const entry={at:t.stamp,trigger,month,ok:false};
    try{
      const url=src[month];
      if(!url)throw new Error(month+' 尚未設定班表來源網址');
      const s=readSource(url);
      if(!residents){residents=fsList('residents');attendings=fsList('attendings');}
      const r=buildMonthSchedule({month,grid:s.grid,nameTable:s.nameTable,residents,attendings});
      const paths=Object.keys(r.dates).map(ds=>'data.'+fsSeg(ds));
      fsPatch('config','schedule',{data:r.dates},paths);
      Object.assign(entry,{ok:true,title:s.title,titleMonth:ssTitleMonth(s.title),first:r.first,last:r.last,days:r.days,entries:r.entries,
        skippedCodes:r.skippedCodes,skippedRes:r.skippedRes.map(x=>({label:x.label,why:x.why}))});
    }catch(e){entry.error=month+'：'+(e&&e.message||e);}
    logs.push(entry);
  });
  appendLog(logs);
  return logs;
}
function appendLog(entries){
  const cur=(fsGet('config','schedLog')||{}).entries||[];
  fsPatch('config','schedLog',{entries:entries.concat(cur).slice(0,60)},['entries']);
}

// ── hourly trigger: run once a day at the configured hour (this month + next month) ──
function hourly(){
  const cfg=fsGet('config','cfg')||{};const t=nowTpe();
  const hour=cfg.schedHour==null?5:+cfg.schedHour;
  const props=PropertiesService.getScriptProperties();
  if(t.hour!==hour||props.getProperty('LAST_RUN')===t.ymd)return null;
  props.setProperty('LAST_RUN',t.ymd);
  const cur=t.ymd.slice(0,7),next=monthAdd(cur,1);
  const months=[cur];if((cfg.schedSrc||{})[next])months.push(next); // next month only once its URL is in
  return syncMonths(months,'auto');
}

// ── web app for the admin page (立即同步 / 貼上網址後同步 / 測試連線) ──
function doPost(e){
  let req={};try{req=JSON.parse(e&&e.postData&&e.postData.contents||'{}');}catch(err){}
  const out=o=>ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
  if(!cfgProp('SYNC_TOKEN')||req.token!==cfgProp('SYNC_TOKEN'))return out({ok:false,error:'通關碼錯誤'});
  if(req.action==='ping')return out({ok:true,now:nowTpe().stamp});
  const cur=nowTpe().ymd.slice(0,7);
  const months=req.month?[String(req.month)]:[cur,monthAdd(cur,1)];
  return out({ok:true,logs:syncMonths(months,'manual')});
}

// ── run once from the editor: installs the hourly trigger ──
function setup(){
  ScriptApp.getProjectTriggers().forEach(tr=>{if(tr.getHandlerFunction()==='hourly')ScriptApp.deleteTrigger(tr);});
  ScriptApp.newTrigger('hourly').timeBased().everyHours(1).create();
  Logger.log('✅ 已建立觸發器：每小時檢查一次，到了管理員頁設定的時間就同步');
}
