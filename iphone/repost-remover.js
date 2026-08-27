javascript:(function(){
"use strict";
if(window.__ttrr){window.__ttrr.show();return;}

/* ---------------------------------------------------------------------
   iPhone repost remover - a bookmarklet.

   Runs entirely inside the TikTok tab you are already logged into, on
   your own phone. No password, no server, no network calls of its own.

   Deliberate source rules, because this whole file becomes ONE bookmark
   URL: no line comments, no percent signs, no hash characters. That
   means rgb() colours instead of hex, and transform:scaleX() instead of
   percentage widths. Keep it that way or the bookmark breaks.
   ------------------------------------------------------------------ */

/* TikTok's DOM changes often. Everything selector-shaped lives here, and
   each entry is a list of candidates tried in order. Add new ones at the
   top and leave the old ones as fallbacks. */
var S={
  repostTab:['[data-e2e="repost-tab"]','p[data-e2e="repost-tab"]','span[data-e2e="repost-tab"]'],
  tile:['[data-e2e="user-post-item"] a[href*="/video/"]','[data-e2e="user-post-item-list"] a[href*="/video/"]','a[href*="/video/"]'],
  modal:['[data-e2e="browse-video"]','div[role="dialog"]','[class*="ModalContainer"]','[id^="tux-portal"] div[role="dialog"]'],
  repostBtn:['[data-e2e="repost-icon"]','button[data-e2e="repost-icon"]','div[data-e2e="repost-icon"]','[data-e2e="browse-repost"]','button[aria-label*="epost"]','div[aria-label*="epost"]'],
  shareBtn:['[data-e2e="share-icon"]','[data-e2e="browse-share"]','[data-e2e="undefined-share"]','button[aria-label*="hare"]','div[aria-label*="hare"]'],
  confirmBtn:['button[data-e2e="repost-remove-confirm"]','div[role="dialog"] button','[class*="Modal"] button'],
  closeModal:['[data-e2e="browse-close"]','[data-e2e="modal-close-inner-button"]','button[aria-label*="lose"]','div[aria-label*="lose"]']
};
var ACTIVE=['undo','remove','reposted','cancel'];
var LEDGER_KEY='ttrr_removed_v1';
/* Pace between removals. Slower is gentler on TikTok's rate limiting; faster
   is what you want when there are hundreds to clear. Pick in the panel. */
var SPEEDS={safe:[3000,8000],fast:[800,1600],turbo:[200,500]};
var speed='fast';
var ATTEMPTS=3,DEFAULT_CAP=500;
/* How many tiles to work through before scrolling for more. */
var WINDOW=12;
/* iOS Safari kills the tab when memory runs out, and every tile the feed
   loads holds a video decoder. So scan a batch, clear it, reload, repeat -
   never the whole feed at once. */
var MAX_TILES=40;

var stopped=false,running=false,found=[],stats={done:0,ok:0,fail:0,skip:0,total:0};
/* Failures stay out of the ledger so a later run retries them, but within
   this session we step past them, or Remove 1 would jam on the same one. */
var failedHere={};

/* ---- tiny helpers ---- */
function vis(el){if(!el)return false;var r=el.getBoundingClientRect();return r.width>0&&r.height>0;}
function pick(list,root){
  root=root||document;
  for(var i=0;i<list.length;i++){
    var els=root.querySelectorAll(list[i]);
    for(var j=0;j<els.length;j++){if(vis(els[j]))return els[j];}
  }
  return null;
}
function pickAll(list,root){
  root=root||document;
  for(var i=0;i<list.length;i++){
    var els=root.querySelectorAll(list[i]);
    if(els.length)return Array.prototype.slice.call(els);
  }
  return [];
}
function sleep(ms){return new Promise(function(r){setTimeout(r,ms);});}
async function wait(ms){
  var step=200,waited=0;
  while(waited<ms){
    if(stopped)return false;
    await sleep(Math.min(step,ms-waited));
    waited+=step;
  }
  return true;
}
function rnd(a,b){return Math.floor(a+Math.random()*(b-a));}
/* Wait for a thing to be true rather than for a fixed number of seconds.
   This is where nearly all the speed comes from: the old code slept 1.8s for
   a modal that usually appears in 200ms, on every single repost. */
async function until(fn,ms,step){
  step=step||120;
  var waited=0;
  while(waited<ms){
    if(stopped)return null;
    var v=null;
    try{v=fn();}catch(e){}
    if(v)return v;
    await sleep(step);
    waited+=step;
  }
  return null;
}
function pace(){var s=SPEEDS[speed]||SPEEDS.fast;return rnd(s[0],s[1]);}
/* The single biggest memory win on iOS: drop the decoder behind every video
   the feed has loaded. TikTok reattaches a source when one is actually
   played, so this only reclaims what is sitting idle in the grid. */
function freeVideos(){
  var v=document.querySelectorAll('video'),n=0;
  for(var i=0;i<v.length;i++){
    try{
      if(!v[i].paused)v[i].pause();
      if(v[i].getAttribute('src')){v[i].removeAttribute('src');v[i].load();n++;}
    }catch(e){}
  }
  return n;
}
function tap(el){
  if(!el)return;
  el.scrollIntoView({block:'center'});
  ['pointerdown','mousedown','pointerup','mouseup','click'].forEach(function(t){
    el.dispatchEvent(new MouseEvent(t,{bubbles:true,cancelable:true,view:window}));
  });
}

/* ---- finding the repost control the hard way -------------------------
   Fixed selectors keep missing, because TikTok ships several video layouts
   and renames data-e2e values freely. So instead of naming the button, look
   for any visible control that says "repost" in its data-e2e, aria-label,
   title or text, and take the most specific one - the smallest matching
   element, so we click the button and not the panel wrapping it. */
function candidates(root){
  root=root||document;
  var sel='button,[role="button"],[data-e2e],a,span[class],div[class]';
  var nodes=root.querySelectorAll(sel),out=[];
  for(var i=0;i<nodes.length;i++){
    var n=nodes[i];
    if(ui.wrap&&ui.wrap.contains(n))continue;
    if(!vis(n))continue;
    /* Must plausibly BE a control, not merely contain one. Without this a
       whole modal matches on the text of something buried inside it, and we
       end up clicking the container and reading its state - which silently
       reports success while nothing happened. */
    var control=n.tagName==='BUTTON'||n.tagName==='A'||
                n.getAttribute('role')==='button'||n.hasAttribute('data-e2e');
    if(!control)continue;
    if(n.querySelectorAll('*').length>8)continue;
    /* The profile's own Reposts TAB says "repost" too. Clicking it and then
       reading "repost" back off it looks exactly like a successful removal,
       so tabs and grid tiles are never candidates. */
    var e2e=(n.getAttribute('data-e2e')||'').toLowerCase();
    if(e2e.indexOf('tab')>=0)continue;
    if(n.getAttribute('role')==='tab')continue;
    if(n.tagName==='A'&&(n.getAttribute('href')||'').indexOf('/video/')>=0)continue;
    out.push(n);
  }
  return out;
}
function describe(n){
  return [n.tagName.toLowerCase(),
    n.getAttribute('data-e2e')||'',
    n.getAttribute('aria-label')||'',
    n.getAttribute('title')||'',
    (n.textContent||'').slice(0,40)].join(' | ');
}
function matches(n,word){
  /* innerText, not textContent: it excludes text inside hidden panels, which
     would otherwise match a control that is not on screen yet. */
  var txt='';
  try{txt=n.innerText||'';}catch(e){txt=n.textContent||'';}
  var hay=((n.getAttribute('data-e2e')||'')+' '+
           (n.getAttribute('aria-label')||'')+' '+
           (n.getAttribute('title')||'')+' '+txt).toLowerCase();
  return hay.indexOf(word)>=0;
}
/* The Reposts TAB is deliberately excluded from candidates(), because
   clicking it and reading "repost" back off it fakes a successful removal.
   But we do need to find it once, to switch the grid to reposts - so look
   for it separately and only among things that are actually tabs. */
function findRepostTab(){
  var named=pick(S.repostTab);
  if(named)return named;
  var nodes=document.querySelectorAll('[role="tab"],[data-e2e*="tab"],p,span,h2,div[class]');
  for(var i=0;i<nodes.length;i++){
    var n=nodes[i];
    if(ui.wrap&&ui.wrap.contains(n))continue;
    if(!vis(n))continue;
    if(n.querySelectorAll('*').length>3)continue;
    var t='';
    try{t=(n.innerText||'').trim().toLowerCase();}catch(e){}
    if(t==='reposts'||t==='repost')return n;
  }
  return null;
}
function findByWord(word,root){
  var list=candidates(root).filter(function(n){return matches(n,word);});
  if(!list.length)return null;
  list.sort(function(a,b){
    return a.querySelectorAll('*').length-b.querySelectorAll('*').length;
  });
  return list[0];
}

/* ---- ledger, kept in this device's localStorage ---- */
function ledger(){
  try{return JSON.parse(localStorage.getItem(LEDGER_KEY)||'[]');}catch(e){return [];}
}
function remember(url){
  try{
    var l=ledger();
    if(l.indexOf(url)<0){l.push(url);localStorage.setItem(LEDGER_KEY,JSON.stringify(l));}
  }catch(e){}
}

/* ---- the panel ---- */
var ui={};
function build(){
  var wrap=document.createElement('div');
  wrap.setAttribute('style',[
    'position:fixed','left:0','right:0','bottom:0','z-index:2147483647',
    'background:rgb(15,16,20)','color:rgb(232,234,239)',
    'font:14px/1.45 -apple-system,system-ui,sans-serif',
    'border-top:1px solid rgb(48,52,66)',
    'box-shadow:0 -8px 30px rgba(0,0,0,0.5)',
    'padding:12px 14px calc(12px + env(safe-area-inset-bottom,0px))',
    'max-height:62vh','overflow:auto','-webkit-overflow-scrolling:touch'
  ].join(';'));

  var head=document.createElement('div');
  head.setAttribute('style','display:flex;align-items:center;gap:8px;margin-bottom:10px');
  var title=document.createElement('b');
  title.textContent='Repost remover';
  title.setAttribute('style','font-size:14px;flex:1');
  var probe=document.createElement('button');
  probe.textContent='Probe';
  var hide=document.createElement('button');
  hide.textContent='Hide';
  head.appendChild(title);head.appendChild(probe);head.appendChild(hide);

  var stat=document.createElement('div');
  stat.setAttribute('style','font-variant-numeric:tabular-nums;color:rgb(154,161,177);margin-bottom:8px');

  var barOuter=document.createElement('div');
  barOuter.setAttribute('style','height:6px;background:rgb(28,30,38);border-radius:99px;overflow:hidden;margin-bottom:10px');
  var barInner=document.createElement('i');
  barInner.setAttribute('style','display:block;height:6px;width:100vw;transform:scaleX(0);transform-origin:left;background:linear-gradient(90deg,rgb(37,244,238),rgb(254,44,85));transition:transform .25s');
  barOuter.appendChild(barInner);

  var row=document.createElement('div');
  row.setAttribute('style','display:flex;gap:8px;flex-wrap:wrap;margin-bottom:10px');

  function mk(label,bg,fg){
    var b=document.createElement('button');
    b.textContent=label;
    b.setAttribute('style',[
      'flex:1 1 auto','min-height:46px','min-width:96px','padding:0 14px',
      'border-radius:10px','border:1px solid rgb(48,52,66)','font:inherit',
      'font-weight:600','background:'+bg,'color:'+fg,'touch-action:manipulation'
    ].join(';'));
    return b;
  }
  var bScan=mk('Scan','rgb(34,38,52)','rgb(232,234,239)');
  var bOne=mk('Remove 1','rgb(34,38,52)','rgb(232,234,239)');
  var bRun=mk('Remove all','rgb(254,44,85)','rgb(255,255,255)');
  var bStop=mk('Stop','transparent','rgb(232,234,239)');
  bOne.style.borderColor='rgb(254,44,85)';
  var smallBtn='min-height:34px;padding:0 12px;border-radius:8px;border:1px solid rgb(48,52,66);background:transparent;color:rgb(154,161,177);font:inherit';
  hide.setAttribute('style',smallBtn);
  probe.setAttribute('style',smallBtn);
  probe.onclick=function(){doProbe();};
  row.appendChild(bScan);row.appendChild(bOne);row.appendChild(bRun);row.appendChild(bStop);

  var capRow=document.createElement('div');
  capRow.setAttribute('style','display:flex;align-items:center;gap:8px;margin-bottom:10px;color:rgb(154,161,177);flex-wrap:wrap');
  var capLbl=document.createElement('span');capLbl.textContent='Max';
  var cap=document.createElement('input');
  cap.type='number';cap.value=String(DEFAULT_CAP);cap.min='1';
  var fieldCss='min-height:42px;padding:0 10px;border-radius:9px;border:1px solid rgb(48,52,66);background:rgb(20,22,28);color:inherit;font-size:16px';
  cap.setAttribute('style','width:84px;'+fieldCss);
  var spdLbl=document.createElement('span');spdLbl.textContent='Pace';
  var spd=document.createElement('select');
  spd.setAttribute('style','width:126px;'+fieldCss);
  [['turbo','Turbo 0.2-0.5s'],['fast','Fast 0.8-1.6s'],['safe','Safe 3-8s']].forEach(function(o){
    var op=document.createElement('option');op.value=o[0];op.textContent=o[1];spd.appendChild(op);
  });
  spd.value=speed;
  spd.onchange=function(){speed=spd.value;say('Pace: '+speed);};
  capRow.appendChild(capLbl);capRow.appendChild(cap);
  capRow.appendChild(spdLbl);capRow.appendChild(spd);

  var logBox=document.createElement('div');
  logBox.setAttribute('style','height:132px;overflow:auto;background:rgb(10,11,15);border:1px solid rgb(38,42,54);border-radius:9px;padding:8px;font:11.5px/1.4 ui-monospace,Menlo,monospace;-webkit-overflow-scrolling:touch');

  wrap.appendChild(head);wrap.appendChild(stat);wrap.appendChild(barOuter);
  wrap.appendChild(row);wrap.appendChild(capRow);wrap.appendChild(logBox);
  document.body.appendChild(wrap);

  ui={wrap:wrap,stat:stat,bar:barInner,log:logBox,cap:cap,spd:spd,
      scan:bScan,one:bOne,run:bRun,stop:bStop,hide:hide};

  bScan.onclick=function(){doScan();};
  bOne.onclick=function(){doOne();};
  bRun.onclick=function(){doAll();};
  bStop.onclick=function(){stopped=true;say('Stopping after this one.','warn');};
  hide.onclick=function(){
    var body=[stat,barOuter,row,capRow,logBox];
    var hidden=logBox.style.display==='none';
    body.forEach(function(n){n.style.display=hidden?'':'none';});
    hide.textContent=hidden?'Hide':'Show';
  };
}

function say(msg,level){
  var c=level==='ok'?'rgb(74,222,128)':level==='err'?'rgb(248,113,113)':level==='warn'?'rgb(251,191,36)':'rgb(199,204,218)';
  var d=document.createElement('div');
  d.setAttribute('style','color:'+c+';white-space:pre-wrap;word-break:break-word');
  d.textContent=new Date().toLocaleTimeString()+'  '+msg;
  ui.log.appendChild(d);
  while(ui.log.childNodes.length>400)ui.log.removeChild(ui.log.firstChild);
  ui.log.scrollTop=ui.log.scrollHeight;
}
function refresh(){
  var left=found.length?pending().length:0;
  ui.stat.textContent=stats.done+' done   ok '+stats.ok+'   failed '+stats.fail+'   left '+left;
  var f=stats.total?stats.done/stats.total:0;
  ui.bar.style.transform='scaleX('+f+')';
  /* Remove all collects its own tiles, so it never waits on a scan. */
  ui.run.disabled=running;
  ui.one.disabled=running;
  ui.scan.disabled=running;
  [ui.run,ui.one,ui.scan].forEach(function(b){b.style.opacity=b.disabled?'0.45':'1';});
}

/* Everything scanned that this phone has not already taken off, and that has
   not failed since the panel was opened. */
function pending(){
  var already=ledger();
  return found.filter(function(f){return already.indexOf(f.url)<0&&!failedHere[f.url];});
}
function shortId(url){var p=url.split('/video/');return p[1]||url;}

/* One attempt at one repost, shared by both buttons. */
async function attempt(item){
  var err='';
  for(var a=1;a<=ATTEMPTS;a++){
    if(stopped)break;
    try{return {res:await removeOne(item),err:''};}
    catch(e){
      err=e.message;
      say('  try '+a+' of '+ATTEMPTS+': '+err,'warn');
      if(a<ATTEMPTS)await wait(rnd(700,1500));
    }
  }
  return {res:null,err:err};
}
function record(item,out){
  stats.done++;
  if(out.res==='ok'||out.res==='already'){stats.ok++;remember(item.url);say('  removed','ok');}
  else{stats.fail++;failedHere[item.url]=true;say('  failed: '+out.err,'err');}
  freeVideos();
  refresh();
}

/* Opens the first repost and reports what controls the page actually has, so
   the selectors can be corrected from a screenshot of this log. */
async function doProbe(){
  if(running)return;
  homePath=location.pathname;
  var q=pending();
  if(!q.length){say('Scan first.','warn');return;}
  running=true;stopped=false;refresh();
  try{
    say('Probe: opening '+shortId(q[0].url));
    var before=location.pathname;
    tap(q[0].el);
    await wait(2200);
    var modal=pick(S.modal);
    var scope=videoOpen();
    say('named modal: '+(modal?'yes':'no'));
    say('url changed: '+(location.pathname!==before?'yes, now '+location.pathname.slice(0,40):'no'));
    say('video view detected: '+(scope?scope.tagName.toLowerCase()+
        (scope.getAttribute&&scope.getAttribute('data-e2e')?' data-e2e='+scope.getAttribute('data-e2e'):''):'NO'));
    say('videos in page: '+document.querySelectorAll('video').length+
        ' (a feed shows several at once)');
    say('scope has its own share: '+(hasShare(scope)?'yes':'no'));
    var hits=candidates(scope||document).filter(function(n){
      return matches(n,'repost')||matches(n,'share')||matches(n,'like')||matches(n,'favorite');
    });
    hits.sort(function(a,b){return a.querySelectorAll('*').length-b.querySelectorAll('*').length;});
    say('controls matched: '+hits.length);
    for(var i=0;i<Math.min(hits.length,10);i++)say('  '+describe(hits[i]));
    if(!hits.length){
      var all=candidates(scope||document).filter(function(n){return n.getAttribute('data-e2e');});
      say('no matches. data-e2e values present: '+all.length);
      for(var j=0;j<Math.min(all.length,14);j++)say('  '+all[j].getAttribute('data-e2e'));
    }
    /* The repost control is usually not on the video view at all - it lives
       in the share sheet. Open it and list what is really in there, since
       that is the half that decides whether removal can work. */
    var share=pick(S.shareBtn,scope||document)||findByWord('share',scope||document);
    if(share){
      say('opening share sheet...');
      tap(share);
      await wait(1800);
      var sheet=candidates(document);
      say('after share, controls: '+sheet.length);
      var rp=[];
      for(var k=0;k<sheet.length;k++)if(matches(sheet[k],'repost'))rp.push(sheet[k]);
      say('saying repost: '+rp.length);
      for(var m=0;m<Math.min(rp.length,6);m++)say('  R '+describe(rp[m]));
      if(!rp.length){
        for(var z=0;z<Math.min(sheet.length,12);z++)say('  '+describe(sheet[z]));
      }
    }else{
      say('no share control found either','err');
    }
    say('Screenshot this and send it back.','ok');
    await closeModal();
  }catch(e){say('Probe failed: '+e.message,'err');}
  running=false;refresh();
}

/* Remove exactly one and stop. Lightest possible on memory, and you decide
   the pace - the safest mode on a phone that has been crashing. */
async function doOne(){
  if(running)return;
  homePath=location.pathname;
  var q=pending();
  if(!q.length)q=collect(1);
  if(!q.length){say('Nothing found. Open your Reposts tab, or reload.','warn');return;}
  running=true;stopped=false;refresh();
  var item=q[0];
  say('Removing '+shortId(item.url));
  try{
    var out=await attempt(item);
    record(item,out);
    if(out.res)pruneTile(item);
  }
  catch(e){say('Failed: '+e.message,'err');}
  running=false;refresh();
}

/* ---- is this repost currently on ---- */
function isReposted(btn){
  if(!btn)return null;
  var p=btn.getAttribute('aria-pressed');
  if(p==='true')return true;
  if(p==='false')return false;
  var probes=[btn.getAttribute('aria-label'),btn.getAttribute('title'),btn.textContent];
  for(var i=0;i<probes.length;i++){
    var t=(probes[i]||'').toLowerCase();
    if(!t)continue;
    for(var j=0;j<ACTIVE.length;j++){if(t.indexOf(ACTIVE[j])>=0)return true;}
    if(t.indexOf('repost')>=0)return false;
  }
  var cls=(btn.className&&btn.className.baseVal!==undefined?btn.className.baseVal:btn.className||'').toString().toLowerCase();
  if(cls.indexOf('active')>=0||cls.indexOf('reposted')>=0)return true;
  return null;
}

/* ---- scan ---- */
async function doScan(){
  if(running)return;
  running=true;found=[];stats={done:0,ok:0,fail:0,skip:0,total:0};stopped=false;refresh();
  try{
    if(location.pathname.indexOf('/@')!==0){
      say('Open YOUR profile first (the Profile tab), then Scan.','err');
      return;
    }
    var tab=findRepostTab();
    if(tab){tap(tab);say('Opened the Reposts tab.');await wait(2500);}
    else say('No Reposts tab found - scanning whatever grid is showing.','warn');

    var seen={},stagnant=0,capped=false;
    while(stagnant<4&&!stopped&&!capped){
      var links=pickAll(S.tile);
      var added=0;
      for(var i=0;i<links.length;i++){
        var href=(links[i].href||'').split('?')[0];
        if(href&&href.indexOf('/video/')>0&&!seen[href]){
          seen[href]=true;found.push({url:href,el:links[i]});added++;
          if(found.length>=MAX_TILES){capped=true;break;}
        }
      }
      if(added){stagnant=0;say('Found '+found.length+' so far.');}
      else stagnant++;
      stats.total=found.length;refresh();
      if(capped)break;
      window.scrollBy(0,window.innerHeight*2);
      await wait(1400);
      freeVideos();
    }
    freeVideos();
    if(capped)say('Stopped at '+MAX_TILES+' to keep Safari alive. Clear these, reload, scan again.','warn');
    say('Scan done: '+found.length+' reposts.','ok');
  }catch(e){say('Scan failed: '+e.message,'err');}
  finally{running=false;stats.total=found.length;refresh();}
}

/* ---- remove one, using the in-page modal so we never navigate away ---- */
/* Named selectors first, then the search by meaning, then the share menu -
   on some layouts Repost only exists inside the share sheet. */
/* Where the profile grid lives, so we can tell "a video is open" from "we are
   still looking at the profile". Set when a run starts. */
var homePath=location.pathname;

/* TikTok opens a repost in one of two shapes, and which one you get depends
   on the layout it served you:
     1. an overlay/modal on top of the profile, or
     2. a pushState navigation to /video/<id> with no page reload.
   Neither is reliably identifiable by a class name, so detect the video view
   by what is true of it rather than by what it is called. */
function hasShare(n){
  if(!n||!n.querySelector)return false;
  return !!(n.querySelector('[data-e2e*="share"]')||n.querySelector('[aria-label*="hare"]'));
}
function videoOpen(){
  var m=pick(S.modal);
  if(m)return m;
  /* Opening a repost lands on a page that is a scrollable FEED, not a single
     video: several videos' action rails are in the DOM at once. Scope to the
     player actually on screen, or we risk un-reposting somebody else's video
     whose share button merely happened to match first. */
  var best=null,bestTop=1e9;
  var vids=document.querySelectorAll('video');
  for(var i=0;i<vids.length;i++){
    var v=vids[i];
    if(!vis(v))continue;
    var r=v.getBoundingClientRect();
    if(r.height<200)continue;              /* a grid thumbnail, not the player */
    if(r.bottom<80||r.top>window.innerHeight-80)continue;   /* off screen */
    var d=Math.abs(r.top);
    if(d<bestTop){bestTop=d;best=v;}
  }
  if(best){
    var n=best;
    for(var k=0;k<8&&n.parentNode&&n.parentNode!==document.body;k++){
      n=n.parentNode;
      if(hasShare(n))return n;             /* the rail for THIS video */
    }
    return best.parentNode||null;
  }
  if(location.pathname.indexOf('/video/')>=0)return document.body;
  return null;
}

function repostIn(scope){
  return pick(S.repostBtn,scope)||findByWord('repost',scope);
}
async function locateRepost(scope){
  /* Search inside the opened video only. A page-wide search finds the
     profile's own controls and produces confident nonsense. */
  if(!scope)return null;
  var btn=repostIn(scope);
  if(btn)return btn;
  var share=pick(S.shareBtn,scope)||findByWord('share',scope);
  if(share){
    tap(share);
    btn=await until(function(){return repostIn(videoOpen()||scope);},2500);
    if(btn)return btn;
  }
  return null;
}

async function removeOne(item){
  tap(item.el);
  var scope=await until(videoOpen,6000);
  if(!scope)throw new Error('video view did not open');
  /* Landing on a feed means the wrong video can be under the controls. If the
     URL names a video, it must be the one we opened - refuse rather than
     un-repost a stranger's video. */
  var id=shortId(item.url);
  if(location.pathname.indexOf('/video/')>=0&&location.pathname.indexOf(id)<0){
    await closeModal();
    throw new Error('landed on a different video');
  }
  var btn=await locateRepost(scope);
  if(!btn)throw new Error('repost button not found');
  if(isReposted(btn)===false){await closeModal();return 'already';}

  tap(btn);
  /* Some layouts ask to confirm. Look briefly, and only click something that
     actually reads like a confirmation. */
  var dlg=await until(function(){
    var d=pick(S.confirmBtn);
    if(!d)return null;
    var t=((d.textContent||'')+' '+(d.getAttribute('aria-label')||'')).toLowerCase();
    return (t.indexOf('remove')>=0||t.indexOf('undo')>=0||t.indexOf('confirm')>=0)?d:null;
  },900);
  if(dlg)tap(dlg);

  /* Success is the state flipping, nothing else. */
  var flipped=await until(function(){
    var b=repostIn(videoOpen()||scope);
    return (b&&isReposted(b)===false)?b:null;
  },2500);
  await closeModal();
  if(flipped)return 'ok';
  var last=repostIn(videoOpen()||scope);
  if(!last||isReposted(last)===null)throw new Error('could not verify it flipped');
  throw new Error('still reposted after tapping');
}
async function closeModal(){
  /* If opening the video pushed a new URL, the way back is history, not a
     close button - and we must actually get back, or every later tap lands
     on a page with no grid. */
  if(location.pathname.indexOf('/video/')>=0&&location.pathname!==homePath){
    history.back();
    await until(function(){return location.pathname.indexOf('/video/')<0;},3000);
    await until(function(){return pickAll(S.tile).length>0;},3000);
    return;
  }
  var c=pick(S.closeModal);
  if(c)tap(c);
  else document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));
  await until(function(){return !videoOpen();},2500);
}

/* ---- the run ---- */
/* Take a processed tile out of the DOM. This is what keeps a long run from
   crashing: the grid never grows, so memory stays flat and there is no need
   to stop and reload every 40. */
function pruneTile(item){
  try{
    var n=item.el;
    for(var i=0;i<4&&n&&n.parentNode;i++){
      var e2e=(n.getAttribute&&n.getAttribute('data-e2e'))||'';
      if(e2e.indexOf('user-post-item')>=0)break;
      n=n.parentNode;
    }
    if(n&&n.parentNode)n.parentNode.removeChild(n);
    else if(item.el&&item.el.parentNode)item.el.parentNode.removeChild(item.el);
  }catch(e){}
}

/* Grab the next few tiles on screen that still need doing. */
function collect(limit){
  var already=ledger(),out=[],links=pickAll(S.tile);
  for(var i=0;i<links.length&&out.length<limit;i++){
    var href=(links[i].href||'').split('?')[0];
    if(!href||href.indexOf('/video/')<0)continue;
    if(already.indexOf(href)>=0||failedHere[href])continue;
    if(out.some(function(o){return o.url===href;}))continue;
    out.push({url:href,el:links[i]});
  }
  return out;
}

/* One continuous pass: work the tiles on screen, drop them, scroll for more,
   keep going until the feed runs out or the cap is hit. */
async function doAll(){
  if(running)return;
  homePath=location.pathname;
  var cap=Math.max(1,parseInt(ui.cap.value,10)||DEFAULT_CAP);
  if(!confirm('Remove up to '+cap+' reposts from your account, as fast as the '+
              speed+' setting allows. This cannot be undone.'))return;

  running=true;stopped=false;
  stats={done:0,ok:0,fail:0,skip:0,total:cap};
  found=[];refresh();

  var tab=findRepostTab();
  if(tab){tap(tab);await wait(1500);}
  say('Running at '+speed+' pace. Keep this tab open and the screen awake.','warn');

  var idle=0,started=Date.now();
  while(!stopped&&stats.done<cap&&idle<6){
    var batch=collect(WINDOW);
    if(!batch.length){
      window.scrollBy(0,window.innerHeight*2);
      await wait(900);
      freeVideos();
      idle++;
      continue;
    }
    idle=0;
    for(var i=0;i<batch.length&&!stopped&&stats.done<cap;i++){
      var item=batch[i];
      found.push(item);
      say('['+(stats.done+1)+'] '+shortId(item.url));
      var out=await attempt(item);
      if(stopped&&!out.res)break;
      record(item,out);
      pruneTile(item);
      if(!stopped&&stats.done<cap)await wait(pace());
    }
    freeVideos();
  }

  running=false;refresh();
  var mins=(Date.now()-started)/60000;
  var rate=mins>0?Math.round(stats.ok/mins):0;
  say('Done. '+stats.ok+' removed, '+stats.fail+' failed, about '+rate+' per minute.','ok');
  if(idle>=6)say('No more reposts loading. Reload and run again to be sure.','info');
}

build();
window.__ttrr={show:function(){ui.wrap.style.display='';}};
say('Ready. Go to your profile, tap Scan.');
say('Removed before, on this phone: '+ledger().length);
refresh();
})();
