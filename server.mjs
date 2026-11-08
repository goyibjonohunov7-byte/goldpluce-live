import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 3000);
const TE_KEY = process.env.TRADING_ECONOMICS_KEY || '';
const TD_KEY = process.env.TWELVE_DATA_KEY || '';
const NOW = () => new Date().toISOString();
const state = { market:{}, events:[], headlines:[], sources:{}, errors:{}, updated:{} };
const attempts = new Map(), pending = new Map();
const fallback = [];
const evTypes = { inflation:'CPI', core:'CORE', jobs:'NFP', ppi:'PPI', pce:'PCE', unemployment:'UNEMPLOYMENT' };

async function fetchText(url, timeout=10000) {
  const r = await fetch(url, { signal:AbortSignal.timeout(timeout), headers:{ 'User-Agent':'GoldPulse/3.0 economic dashboard',Accept:'application/json, text/calendar, application/rss+xml, */*' } });
  if (!r.ok) throw new Error('HTTP '+r.status+' — '+new URL(url).hostname);
  const text = await r.text();
  if (text.length>2000000) throw new Error('Response too large');
  return text;
}
function err(src, error) { state.errors[src] = String(error?.message || error).slice(0,220); }
function ok(src) { delete state.errors[src]; state.updated[src] = NOW(); }
function parseTime(raw) {
  if (!raw) return null;
  const v = String(raw).trim();
  const d = new Date(/[+-]\d\d:?\d\d$|Z$/i.test(v) ? v : v.replace(' ','T')+'Z');
  return Number.isFinite(d.valueOf()) ? d.toISOString() : null;
}
function tzConvert(date, time, zone='America/New_York') {
  try {
    let guess = Date.parse(date+'T'+time+':00Z'), target=guess;
    for (let i=0; i<3; i++) {
      const parts = new Intl.DateTimeFormat('en-US',{timeZone:zone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'}).formatToParts(new Date(target));
      const get = type => Number(parts.find(x=>x.type===type)?.value);
      const localUtc=Date.UTC(get('year'),get('month')-1,get('day'),get('hour'),get('minute'),get('second'));
      target+=guess-localUtc;
    }
    return new Date(target).toISOString();
  } catch {return null;}
}
function type(name) {
  const s=String(name||'').toLowerCase();
  if (/core.*(cpi|inflation)|cpi.*core/.test(s)) return 'core';
  if (/consumer price|cpi|inflation rate/.test(s)) return 'inflation';
  if (/non.?farm|nonfarm payroll|employment situation|payrolls/.test(s)) return 'jobs';
  if (/unemployment rate/.test(s)) return 'unemployment';
  if (/producer price|\bppi\b/.test(s)) return 'ppi';
  if (/personal consumption|core pce|pce price/.test(s)) return 'pce';
  return 'other';
}
function number(v) {
  if (v===null||v===undefined||v==='') return null;
  const s=String(v).trim().replace(/,/g,'').replace(/[−–]/g,'-');
  const m=s.match(/^([+-]?\d+(?:\.\d+)?)\s*([KMB%]?)$/i);
  return m ? Number(m[1])*({k:1e3,m:1e6,b:1e9}[m[2].toLowerCase()]||1) : null;
}
function parseIcs(ics) {
  const clean=ics.replace(/\r?\n[ \t]/g,'');
  const results=[];
  for (const b of clean.split('BEGIN:VEVENT').slice(1)) {
    const name=(b.match(/(?:^|\n)SUMMARY:(.+)/)||[])[1]?.replace(/\\,/g,',')?.trim();
    const dateLine=b.match(/(?:^|\n)DTSTART(?:;TZID=([^:;\r\n]+))?(?:;VALUE=DATE)?:(\d{8})(?:T(\d{6})(Z)?)?/);
    if (!name || !dateLine) continue;
    const day=dateLine[2], t=dateLine[3]||'083000';
    const iso=dateLine[4] ? day.slice(0,4)+'-'+day.slice(4,6)+'-'+day.slice(6,8)+'T'+t.slice(0,2)+':'+t.slice(2,4)+':'+t.slice(4)+'Z' : tzConvert(day.slice(0,4)+'-'+day.slice(4,6)+'-'+day.slice(6,8),t.slice(0,2)+':'+t.slice(2,4),dateLine[1]||'America/New_York');
    if (!iso) continue;
    const kind=type(name);
    results.push({id:'bls-'+day+'-'+name.slice(0,15),date:iso,name,type:kind,importance:kind==='other'?1:3,forecast:null,actual:null,previous:null,source:'BLS',unit:null,url:'https://www.bls.gov/schedule/news_release/bls.ics'});
  }
  return results;
}
async function getBls() {
  try {
    const events=parseIcs(await fetchText('https://www.bls.gov/schedule/news_release/bls.ics',13000));
    if (!events.length) throw Error('BLS calendar is empty');
    state.sources.bls=events;
    ok('bls');
  } catch(e) {err('bls',e);state.sources.bls=[];}
}
function parseTe(x) {
  const dt=parseTime(x.Date), name=String(x.Event||x.Category||'').trim();
  if (!dt||!name) return null;
  return {id:'te-'+(x.CalendarId||name+'-'+dt),date:dt,name,type:type(name),importance:Number(x.Importance||1),forecast:x.Forecast??null,actual:x.Actual??null,previous:x.Previous??null,unit:x.Unit||null,source:'Trading Economics',updated:x.LastUpdate||null};
}
function mergeEvents(te=[],bls=[]) {
  const d=Date.now();
  const events=te.filter(x=>x.importance>=2||x.type!=='other');
  for (const event of bls) {
    if (Date.parse(event.date)<d-7*86400000||Date.parse(event.date)>d+120*86400000) continue;
    if (!events.some(x=>x.type===event.type&&Math.abs(Date.parse(x.date)-Date.parse(event.date))<2*3600000)) events.push(event);
  }
  return events.sort((a,b)=>Date.parse(a.date)-Date.parse(b.date)).slice(0,150);
}
async function getCalendar() {
  let te=[];
  if (TE_KEY) {
    try {
      const from=new Date(Date.now()-5*86400000).toISOString().slice(0,10);
      const until=new Date(Date.now()+40*86400000).toISOString().slice(0,10);
      const url='https://api.tradingeconomics.com/calendar/country/united%20states/'+from+'/'+until+'?c='+encodeURIComponent(TE_KEY)+'&f=json';
      const data=JSON.parse(await fetchText(url,15000));
      if (!Array.isArray(data)) throw Error(data?.message||'Invalid calendar response');
      te=data.map(parseTe).filter(Boolean);
      if (!te.length) throw Error('Economic calendar is empty');
      ok('calendar');
    } catch(e) {err('calendar',e);}
  } else state.errors.calendar='TRADING_ECONOMICS_KEY hali ulanmagan';
  state.events=mergeEvents(te,state.sources.bls||[]);
  state.sources.calendar=te.length?'Trading Economics + BLS':'BLS (faqat e’lon sanalari)';
}
function getCandleTime(v, meta) {
  if (!v.datetime) return null;
  const d=v.datetime.replace('T',' ');
  if (!/^\d{4}-\d\d-\d\d \d\d:\d\d/.test(d)) return parseTime(v.datetime);
  return tzConvert(d.slice(0,10),d.slice(11,16),meta?.exchange_timezone||'UTC');
}
async function getMarket() {
  if (!TD_KEY) {state.errors.market='TWELVE_DATA_KEY hali ulanmagan';return;}
  const symbols={gold:process.env.XAU_SYMBOL||'XAU/USD',dxy:process.env.DXY_SYMBOL||'DXY',bond:process.env.US10Y_SYMBOL||'US10Y'};
  const outcomes=await Promise.allSettled(Object.entries(symbols).map(async ([kind,symbol])=>{
    const u=new URL('https://api.twelvedata.com/time_series');
    for (const [k,v] of Object.entries({symbol,interval:'5min',outputsize:'14',apikey:TD_KEY})) u.searchParams.set(k,v);
    const data=JSON.parse(await fetchText(u.toString(),13000));
    if (!Array.isArray(data.values)||data.values.length<2) throw Error(data.message||'No candles for '+symbol);
    const a=Number(data.values[0].close),b=Number(data.values[Math.min(data.values.length-1,12)].close);
    if (!(a>0&&b>0)) throw Error('Invalid quote for '+symbol);
    return [kind,{value:a,change:kind==='bond'?Number(((a-b)*100).toFixed(2)):Number(((a-b)/b*100).toFixed(3)),asOf:getCandleTime(data.values[0],data.meta),source:'Twelve Data',symbol,frequency:'intraday',unit:kind==='bond'?'%':kind==='dxy'?'index':'USD'}];
  }));
  const errors=[];
  outcomes.forEach((r,i)=>{
    const kind=Object.keys(symbols)[i];
    if (r.status==='fulfilled') state.market[r.value[0]]=r.value[1];
    else {delete state.market[kind];errors.push(kind+': '+r.reason.message);}
  });
  if (outcomes.some(x=>x.status==='fulfilled'))ok('market');
  if (errors.length)state.errors.market=errors.join(' | ').slice(0,380);
}
async function getDailyBond() {
  if (state.market.bond?.frequency==='intraday'&&fresh(state.market.bond))return;
  try {
    const csv=await fetchText('https://fred.stlouisfed.org/graph/fredgraph.csv?id=DGS10',12000);
    const rows=csv.trim().split(/\r?\n/).slice(1).map(x=>x.split(',')).filter(x=>x.length===2&&x[1]!=='.'&&Number.isFinite(Number(x[1])));
    if (rows.length<2)throw Error('No FRED observations');
    const a=rows.at(-1),b=rows.at(-2);
    state.market.bond={value:Number(a[1]),change:Number(((Number(a[1])-Number(b[1]))*100).toFixed(2)),asOf:a[0]+'T23:59:59Z',source:'FRED',frequency:'daily',unit:'%',symbol:'DGS10'};
    ok('bond');
  }catch(e){err('bond',e);}
}
function xmlText(s) {return String(s||'').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g,'$1').replace(/<[^>]+>/g,'').replace(/&amp;/g,'&').replace(/&quot;/g,'"').replace(/&lt;/g,'<').replace(/&gt;/g,'>').trim();}
async function getNews() {
  try {
    const terms='US CPI OR NFP OR Federal Reserve OR gold prices OR Treasury yields when:2d';
    const url='https://news.google.com/rss/search?q='+encodeURIComponent(terms)+'&hl=en-US&gl=US&ceid=US:en';
    const rss=await fetchText(url,13000);
    const news=[];
    for (const x of rss.matchAll(/<item>([\s\S]*?)<\/item>/gi)) {
      const grab=t=>xmlText((x[1].match(new RegExp('<'+t+'(?:\\s[^>]*)?>([\\s\\S]*?)<\\/'+t+'>','i'))||[])[1]);
      const title=grab('title'),link=grab('link'),date=parseTime(grab('pubDate'));
      if (!title||!date||!/^https:\/\//.test(link)) continue;
      news.push({title,date,url:link,source:'Google News RSS'});
    }
    if (!news.length) throw Error('RSS news unavailable');
    state.headlines=news.slice(0,16);
    ok('news');
  }catch(e){err('news',e);}
}
function fresh(item,limit=55*60000) {return !!(item?.asOf&&Date.now()-Date.parse(item.asOf)>=0&&Date.now()-Date.parse(item.asOf)<limit);}
function evaluate() {
  const current=Date.now();
  const releases=state.events.filter(e=>e.source==='Trading Economics'&&Date.parse(e.date)<=current&&Date.parse(e.date)>=current-18*3600000&&e.actual!==null&&e.actual!==undefined&&e.forecast!==null&&e.forecast!==undefined).sort((a,b)=>Date.parse(b.date)-Date.parse(a.date));
  const e=releases.find(x=>x.type!=='other')||null;
  const scores=[], reasons=[], macro=[];
  if (e) {
    let rows=[e];
    if (e.type==='inflation'||e.type==='core') {
      rows=state.events.filter(x=>x.source==='Trading Economics'&&(x.type==='inflation'||x.type==='core')&&Math.abs(Date.parse(x.date)-Date.parse(e.date))<20*60000);
      const pairKinds=new Set(rows.map(x=>x.type));
      if (pairKinds.size<2) {reasons.push('CPI va Core CPI ikkala natijasi birgalikda tasdiqlanmadi');}
    }
    for(const x of rows) {
      const diffA=number(x.actual),diffF=number(x.forecast);
      if (diffA===null||diffF===null)continue;
      const delta=diffA-diffF, inverse=x.type==='unemployment'?-1:1;
      const sign=Math.sign(-delta*inverse);
      macro.push(sign);
      reasons.push(x.name+': actual '+x.actual+', prognoz '+x.forecast+(sign>0?' → oltin uchun BUY omil':sign<0?' → oltin uchun SELL omil':' → kutilgandek'));
    }
  } else reasons.push('So‘nggi tasdiqlangan iqtisodiy natija mavjud emas; oldindan baholash faqat bozor ko‘rsatkichlariga bog‘liq');
  const a=state.market.gold,b=state.market.dxy,c=state.market.bond;
  if (fresh(a)) {scores.push([Math.sign(a.change),1,'Oltin '+(a.change>=0?'+':'')+a.change+'%']);}
  else reasons.push('XAUUSD yangi kotirovkasi yo‘q');
  if (fresh(b)) {scores.push([Math.sign(-b.change),1,'DXY '+(b.change>=0?'+':'')+b.change+'%']);}
  else reasons.push('DXY yangi kotirovkasi yo‘q');
  if (fresh(c)&&c.frequency==='intraday') scores.push([Math.sign(-c.change),1,'US10Y '+(c.change>=0?'+':'')+c.change+' bp']);
  else reasons.push('US10Y intraday tasdig‘i mavjud emas (kunlik ko‘rsatkich signalga qo‘shilmaydi)');
  const validMacro=macro.filter(x=>x!==0);
  if (macro.includes(1)&&macro.includes(-1)) return {signal:'KUTISH',strength:'CPI/Core zid',stage:'yangilikdan keyin',reasons:[...reasons,'CPI va Core CPI yo‘nalishi qarama-qarshi']};
  if (e&&(e.type==='core'||e.type==='inflation')&&new Set(state.events.filter(x=>x.source==='Trading Economics'&&(x.type==='inflation'||x.type==='core')&&Math.abs(Date.parse(x.date)-Date.parse(e.date))<20*60000&&x.forecast!=null&&x.actual!=null).map(x=>x.type)).size<2) return {signal:'KUTISH',strength:'Core tasdig‘i yetishmaydi',stage:'yangilikdan keyin',reasons};
  const macroSum=validMacro.reduce((a,b)=>a+b,0)*2;
  const marketSum=scores.reduce((a,x)=>a+x[0]*x[1],0);
  const marketConfirm=scores.filter(x=>x[0]!==0);
  for (const x of marketConfirm)reasons.push(x[2]+(x[0]>0?' → BUY tasdig‘i':' → SELL tasdig‘i'));
  const total=macroSum+marketSum, sign=Math.sign(total);
  const aligned=marketConfirm.filter(x=>x[0]===sign).length;
  const enough=fresh(a)&&fresh(b)&&aligned>=2&&Math.abs(total)>=2 && (!validMacro.length||Math.sign(macroSum)===sign);
  return {signal:enough?(sign>0?'BUYGA MOYIL':'SELLGA MOYIL'):'KUTISH',strength:enough?(validMacro.length?'Yangilik + bozor tasdig‘i':'Faqat bozorning shartli bahosi'):'Yetarli tasdiq yo‘q',stage:validMacro.length?'yangilikdan keyin':'yangilikdan oldingi baho',score:total,reasons,disclaimer:'Signal taxminiy, savdo tavsiyasi yoki kafolatli ehtimollik emas.'};
}
function payload() {return {generatedAt:NOW(),timezone:'Asia/Tashkent',connectors:{tradingEconomics:!!TE_KEY,twelveData:!!TD_KEY},market:state.market,events:state.events,news:state.headlines,updated:state.updated,errors:state.errors,sources:state.sources.calendar||'BLS',analysis:evaluate()};}
async function whenDue(key, fn, ttl,force=false) {
  const last=attempts.get(key)||0;
  if (pending.has(key))return pending.get(key);
  if (Date.now()-last<(force?60000:ttl))return;
  attempts.set(key,Date.now());
  const promise=Promise.resolve().then(fn).catch(e=>err(key,e)).finally(()=>pending.delete(key));
  pending.set(key,promise); return promise;
}
function refresh(force=false) {
  void whenDue('bls',getBls,12*3600000,force).then(()=>whenDue('calendar',getCalendar,10*60000,force));
  void whenDue('market',getMarket,7*60000,force).then(()=>whenDue('bond',getDailyBond,2*3600000,force));
  void whenDue('news',getNews,15*60000,force);
}
const server=http.createServer(async(req,res)=>{
  res.setHeader('X-Content-Type-Options','nosniff');
  res.setHeader('Cache-Control','no-store');
  if(req.method!=='GET'){res.writeHead(405).end('Method not allowed');return;}
  const path=new URL(req.url||'/', 'http://localhost:'+PORT).pathname;
  if(path==='/api/dashboard'){refresh();res.writeHead(200,{'Content-Type':'application/json; charset=utf-8'});res.end(JSON.stringify(payload()));return;}
  if(path==='/api/health'){res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({ok:true,updated:state.updated,errors:state.errors}));return;}
  if(!['/','/index.html'].includes(path)){res.writeHead(404).end('Not found');return;}
  try{const html=await readFile(join(ROOT,'index.html'));res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});res.end(html);}
  catch{res.writeHead(500).end('Index unavailable');}
});
server.listen(PORT,'0.0.0.0',()=>console.log('GoldPulse on port '+PORT));
