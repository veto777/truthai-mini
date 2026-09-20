/* TruthAi Mini client. Everything runs on this device. No telemetry. Steps: capability probe → signed manifest →
   per-shard download with SHA-256 verification + resume (Cache API under the URLs WebLLM loads from) → engine → response-quality gate on this
   exact artefact (once per manifest) → chat. Design goals: chunked+verified download, persistent storage, skeleton UI,
   transactional manifest, in-app signature check, escalation as an opt-in switch. */
const BASE=window.TC_BASE||'';
const webllm=await import(BASE+'/vendor/web-llm.js');
const { classify, runFixtures, sha256, stripRuntimeThink } = await import(BASE+'/probe.js');
const $=id=>document.getElementById(id); const st=t=>{ $('st').textContent=t; }; const msg=t=>{ $('setupmsg').textContent=t; };
const RELEASE_TAGS={'4b':'r1-2026-09-20-full','1.7B':'r1-2026-09-20-mid','0.6B':'r1-2026-09-20-mobile'};   /* each size ships in its own signed release */
let RELEASE_INDEX=BASE+'/release/'+RELEASE_TAGS['4b']+'/RELEASE.json'; let MODEL_ID='truthcoder-mini';   /* suffixed with the size below: a shared id made WebLLM load the 4B on a phone that had verified the 336 MB build */ const CACHE='webllm/model';   /* MUST be exactly the cache the engine reads: our verified download pre-populates it so WebLLM never fetches the weights itself. Entries are keyed by full URL, so the two builds cannot collide and a per-size name is not only unnecessary but breaks pre-population (it did, 2026-09-16). */
let REL, MAN, VARIANT, DIR, SIZE, engine=null, adapterInfo={}, CONST, FIX, gateOK=false, chat=[];
const hex=b=>[...new Uint8Array(b)].map(x=>x.toString(16).padStart(2,'0')).join(''); const fromHex=h=>new Uint8Array(h.match(/../g).map(x=>parseInt(x,16)));
let RISK={low:false,reasons:[]};
function assessDevice(a){ /* on integrated graphics: a 4B model wants ~4 GB of GPU memory, and on integrated graphics that comes out of system RAM on the same chip that draws the screen. No check existed. */
  const info=a.info||{}, L=a.limits||{}, r=[];
  const vendor=(info.vendor||'').toLowerCase(), arch=(info.architecture||'').toLowerCase();
  const ua=navigator.userAgent||'';
  const iOS=/iPhone|iPad|iPod/.test(ua)||(/Macintosh/.test(ua)&&(navigator.maxTouchPoints||0)>1);   /* iPadOS reports itself as a Mac, so touch points are the tell */
  const apple=!iOS&&(/apple/.test(vendor)||/apple-?m/.test(arch));   /* Apple Silicon Macs share memory but at an order more bandwidth than an Intel iGPU, so they are not in the same risk class. iPhones and iPads are a different case entirely and must NOT inherit that exemption — Safari hard-caps per-tab memory far below a 2.3 GB model, so the tab is killed. */
  const integrated=!apple&&(/intel|adreno|mali|llvmpipe|swiftshader|microsoft|basic/.test(vendor)||/xe|iris|uhd|gen-?\d/.test(arch));
  const maxStorage=L.maxStorageBufferBindingSize||0, maxBuf=L.maxBufferSize||0, ram=navigator.deviceMemory||0;
  if(iOS) r.push('an iPhone or iPad, where the browser caps how much memory one page may use — well below this model');
  if(a.isFallbackAdapter) r.push('a software renderer (no real GPU)');
  if(integrated) r.push('graphics built into the processor, sharing system memory');
  if(apple&&ram&&ram<8) r.push('shared memory with only '+ram+' GB');
  if(maxStorage && maxStorage<1.5e9) r.push('a small maximum buffer ('+Math.round(maxStorage/1048576)+' MB)');
  if(ram && ram<=8) r.push('only '+ram+' GB of system memory');
  return {low:r.length>0, reasons:r, integrated, apple, iOS, maxBuf, maxStorage, ram, hopeless:iOS||a.isFallbackAdapter}; }
async function storageOK(){ /* the download is ~2.3 GB; if the browser will not grant that much, fail with a sentence instead of dying mid-download */
  /* 2026-09-18: was a blocking alert that refused below 3 GB and quoted "about 2.3 GB" whatever build was chosen —
     wrong for the 939 MB and 336 MB builds, and a noisy dialog. Now it sizes the check to
     the build actually selected and says it inline instead of interrupting. */
  try{ const e=await navigator.storage.estimate();
    const needGB=SIZE==='4b'?2.3:SIZE==='1.7B'?0.94:0.34;
    if(e&&e.quota&&e.quota < needGB*1.35e9){
      msg('This browser offers '+(e.quota/1e9).toFixed(1)+' GB of storage and the '+(SIZE==='4b'?'4B':SIZE)+' build needs about '+needGB.toFixed(2)+' GB plus room to run. Free space, or pick a smaller build.');
      st('storage too small'); return false; } }catch(_){}
  return true; }
function riskNote(){ /* the device note is informational, not a blocking dialog */
  if(!RISK.low) return '';
  const mb=SIZE==='4b'?'2.3 GB':SIZE==='1.7B'?'939 MB':'336 MB';
  const need=SIZE==='4b'?'about 4 GB':SIZE==='1.7B'?'about 1.8 GB':'under 1 GB';
  return 'This device: '+RISK.reasons.join('; ')+'. You are running the '+(SIZE==='4b'?'4B':SIZE)+' build ('+mb+'), which wants '+need+
         ' of graphics memory. It may still work — phones vary and the browser decides. If the tab reloads by itself while the model loads, that is the browser reclaiming memory.';
}
function riskAck(){ return true; }   /* never blocks: see riskNote() */
function paintRiskInfo(){
  const t=riskNote(), b=$('info'), box=$('riskbox');
  if(!b||!box) return;
  if(!t){ b.hidden=true; b.style.display='none'; return; }
  b.hidden=false; b.style.display='inline-flex'; b.style.marginLeft='auto';
  b.onclick=()=>{ box.textContent=t; box.hidden=!box.hidden; };
}
let _wl=null;
async function wake(on){ /* iOS suspends a backgrounded or locked page and the download stalls mid-way */
  try{ if(on){ if(!_wl&&navigator.wakeLock) _wl=await navigator.wakeLock.request('screen'); }
       else if(_wl){ await _wl.release(); _wl=null; } }catch(e){} }
document.addEventListener('visibilitychange',()=>{ if(document.visibilityState==='visible'&&_wl===null&&document.body.dataset.busy==='1') wake(true); });   /* the lock is dropped by the system when the page hides; take it again on return */
function busy(on){ document.body.dataset.busy=on?'1':'0'; wake(on); }
async function capability(){ if(!navigator.gpu){ msg('This browser has no WebGPU. Use Chrome/Edge 113+, Safari 26+, or Firefox 141+.'); return false; }
  /* requestAdapter can hang indefinitely when the browser's GPU process is unhealthy (e.g. after a driver reset), leaving the page stuck on "checking this device…" with no explanation */
  const a=await Promise.race([navigator.gpu.requestAdapter().catch(e=>({__err:e})), new Promise(r=>setTimeout(()=>r({__timeout:1}),12000))]);
  if(a&&a.__timeout){ msg('The graphics system did not respond within 12 seconds. This usually means the browser\'s GPU process is stuck — fully quit and reopen the browser, and if it persists restart the computer.'); st('gpu timeout'); return false; }
  if(a&&a.__err){ msg('The graphics system refused: '+(a.__err.message||a.__err)); st('gpu error'); return false; }
  if(!a){ msg('No usable graphics adapter (WebGPU blocked, or the browser is running without GPU access).'); st('no adapter'); return false; }
  adapterInfo={vendor:(a.info||{}).vendor||'', arch:(a.info||{}).architecture||'', f16:a.features.has('shader-f16'), maxBuf:Math.round(a.limits.maxBufferSize/1048576)}; RISK=assessDevice(a);
  VARIANT=adapterInfo.f16?'q4f16_1':'q4f32_1';
  /* pick the size the device can hold: a 4B build needs ~4 GB of GPU memory and is impossible on a phone, so constrained devices get the small build (phones are first-class here) */
  SIZE=(v=>['4b','1.7B','0.6B'].includes(v)?v:null)(new URLSearchParams(location.search).get('size'))||(RISK.hopeless?'1.7B':(RISK.low?'1.7B':'4b'));   /* Phones default to the 1.7B; the 0.6B is reachable only with an explicit ?size=0.6B as a last resort. */
  RELEASE_INDEX=BASE+'/release/'+(RELEASE_TAGS[SIZE]||RELEASE_TAGS['4b'])+'/RELEASE.json';
  const forcedSize=new URLSearchParams(location.search).get('size');
  if(RISK.hopeless&&SIZE==='4b'&&!forcedSize){ SIZE='1.7B'; RELEASE_INDEX=BASE+'/release/'+RELEASE_TAGS['1.7B']+'/RELEASE.json'; msg('This device cannot hold the 4B build — using the 939 MB one instead.'); }   /* The safety net stops at the 1.7B. It used to drop any oversized pick to the 336 MB 0.6B, which is why a flagged iPhone that CAN hold the 1.7B was still handed the weakest build. A device that cannot hold the 1.7B either will fail on load and can be sent to ?size=0.6B by hand — nobody is given the 0.6B silently. */   /* ?size=4b on a phone would crash the tab; the device decides, not the link */
  if(VARIANT==='q4f32_1'&&SIZE==='4b'){ SIZE='1.7B'; RELEASE_INDEX=BASE+'/release/'+RELEASE_TAGS['1.7B']+'/RELEASE.json'; msg('This GPU lacks f16 shaders and there is no fp32 4B build — using the 1.7B fp32 build, which is published.'); }   /* only the 4B ships f16-only; 0.6B/1.7B have fp32 builds */
  DIR=(SIZE==='4b'?'qwen3-4b-abl-':'qwen3-'+SIZE+'-abl-')+VARIANT; MODEL_ID='truthcoder-mini-'+SIZE+'-'+VARIANT;
  paintRiskInfo();   /* the device note is an (i) in the header from here on — never a dialog */
  try{ const row=$(SIZE==='4b'?'dl-desktop':SIZE==='1.7B'?'dl-mid':'dl-mobile'); if(row) row.classList.add('pick');
    const forced=new URLSearchParams(location.search).get('size');
    const nm=SIZE==='4b'?'4B':SIZE; $('autopick').textContent=forced?(' You chose the '+nm+' build.'):(' This device was given the '+nm+' build automatically.'); }catch(e){}
  if(navigator.storage&&navigator.storage.persist){ const p=await navigator.storage.persist().catch(()=>false); const e=await navigator.storage.estimate().catch(()=>({})); $('sub').textContent=`runs on this device · nothing leaves it · storage ${p?'persistent':'NOT persistent (the browser may evict the model)'}${e.quota?' · quota '+Math.round(e.quota/1073741824)+' GB':''}`; }
  msg(`GPU: ${adapterInfo.vendor} ${adapterInfo.arch} · ${adapterInfo.f16?'f16 shaders':'no f16 shaders → fp32 build'} · max buffer ${adapterInfo.maxBuf} MB`);
  if(RISK.low&&SIZE!=='4b'){ const nm=SIZE==='1.7B'?'939 MB balanced':'336 MB mobile';
    $('gate').insertAdjacentHTML('beforeend','<span class="pill ok">'+(SIZE==='1.7B'?'balanced':'mobile')+' build chosen</span>');
    msg('This device has '+RISK.reasons.join('; ')+', so it runs the '+nm+' build rather than the 2.3 GB desktop one.'); }
  else if(RISK.low){ $('gate').insertAdjacentHTML('beforeend','<span class="pill bad">this device may freeze — '+RISK.reasons[0]+'</span>'); msg('This device has '+RISK.reasons.join('; ')+'. The desktop build can lock it up — the mobile build is the safe choice here.'); }
  return true; }
const PINNED_PUBKEY_HEX='02c6bedb56aceafb46bd8053055e1d8e67420db115cda0d4df3c20076a1c77ae';   /* the root of trust. The key in RELEASE.json must MATCH this pin — a re-signed
   release from a compromised mirror carries a different key and is refused before any byte loads. Rotation = ship a new
   client with the new pin (signed pages come from the origin; the pin travels with the app, not with the release). */
async function loadManifest(){ REL=await fetch(RELEASE_INDEX,{cache:'no-store'}).then(r=>r.json());
  if(String(REL.release_pubkey_ed25519_hex||'').toLowerCase()!==PINNED_PUBKEY_HEX){ msg('Release key does not match the pinned key — refusing this release.'); throw new Error('pubkey mismatch'); }
  const base=BASE+`/release/${REL.tag}/${DIR}/`;   /* relative to BASE: a root-absolute path under a path prefix reads the wrong document and verification sees HTML */
  const manBytes=await fetch(base+'MANIFEST.json',{cache:'no-store'}).then(r=>r.arrayBuffer()); const sig=await fetch(base+'MANIFEST.json.ed25519',{cache:'no-store'}).then(r=>r.arrayBuffer());
  let ok=false; try{ const key=await crypto.subtle.importKey('raw',fromHex(PINNED_PUBKEY_HEX),{name:'Ed25519'},false,['verify']); ok=await crypto.subtle.verify('Ed25519',key,sig,manBytes); }catch(e){ msg('This browser cannot verify Ed25519 signatures ('+e+'); refusing to load unverified weights.'); throw new Error('no Ed25519 support'); }
  if(!ok){ msg('Manifest signature INVALID — not loading.'); throw new Error('bad signature'); }
  MAN=JSON.parse(new TextDecoder().decode(manBytes));
  /* the pin is the CLIENT-SIDE constant, never the fetched RELEASE.json (which is unsigned and host-controlled).
     A required, absent-means-refuse check: a manifest missing its own identity or bindings is refused, not skipped. */
  const wantTag=RELEASE_TAGS[SIZE];
  if(MAN.artefact!==DIR){ msg('Signed manifest is for '+(MAN.artefact||'an unnamed build')+', not the selected '+DIR+' — refusing.'); throw new Error('artefact mismatch'); }
  if(MAN.tag!==wantTag){ msg('Signed manifest tag '+(MAN.tag||'(none)')+' is not the pinned '+wantTag+' — refusing.'); throw new Error('tag mismatch'); }
  if(!MAN.probe_constants_sha256||!MAN.fixtures_sha256){ msg('Signed manifest is missing its probe bindings — refusing.'); throw new Error('missing probe bindings'); }
  if(!(Number(MAN.release_sequence)>=1)){ msg('Signed manifest has no release sequence — refusing.'); throw new Error('missing sequence'); }
  { const seen=Number(localStorage.getItem('tc-relseq-'+DIR)||0), seq=Number(MAN.release_sequence||0);   /* signed value — only read AFTER the signature verified */
    if(seq&&seq<seen){ msg('This release is older than one this device already verified — refusing the rollback.'); throw new Error('rollback'); }
    if(seq>seen) try{ localStorage.setItem('tc-relseq-'+DIR,String(seq)); }catch(e){} } MAN._sha=await sha256(new TextDecoder().decode(manBytes)); MAN._base=base;   /* base already carries BASE — prefixing twice gave /mini/mini/release/... */
  $('gate').innerHTML=`<span class="pill ok">manifest signed ✓ ${MAN.tag} · seq ${MAN.release_sequence}</span><span class="pill ${/\btest\b/i.test(MAN.note||'')?'warn':'ok'}" title="${String(MAN.note||'').replace(/"/g,'&quot;')}">${/\btest\b/i.test(MAN.note||'')?'TEST release':'release'}</span>`;   /* the label follows what the signed note SAYS, not merely that a note exists */ return MAN; }
function keyUrl(f){ return `${location.origin}${BASE}/models/${DIR}/resolve/main/${f}`; }   /* the URLs WebLLM 0.2.85 requests */
async function downloadAll(){ const cache=await caches.open(CACHE); const files=Object.entries(MAN.files).filter(([f])=>!f.startsWith('MANIFEST')); const total=files.reduce((s,[,v])=>s+v.bytes,0); let done=0, verified=JSON.parse(localStorage.getItem('tc-verified-'+MAN._sha)||'{}');
  $('get').disabled=true; st('downloading');
  for(const [f,meta] of files){ const k=keyUrl(f);
    { const cr=await cache.match(k); if(cr){ paint(done,total,f+' … verifying cached'); const ab0=await cr.arrayBuffer(); const h0=hex(await crypto.subtle.digest('SHA-256',ab0)); if(h0===meta.sha256){ done+=meta.bytes; verified[f]=true; paint(done,total,f+' ✓ verified'); continue; } await cache.delete(k); } }   /* cached bytes are re-hashed against THIS manifest every time; a stale flag or cross-release reuse never skips verification */
    const r=await fetch(MAN._base+f); if(!r.ok) throw new Error('fetch '+f+' '+r.status);
    const reader=r.body.getReader(); const chunks=[]; let got=0; while(true){ const {done:d,value}=await reader.read(); if(d) break; chunks.push(value); got+=value.length; paint(done+got,total,f); }
    const buf=new Blob(chunks); const ab=await buf.arrayBuffer(); const h=hex(await crypto.subtle.digest('SHA-256',ab));
    if(h!==meta.sha256){ throw new Error('hash mismatch on '+f+' — refusing (corrupt or tampered download)'); }
    await cache.put(k,new Response(ab,{headers:{'Content-Type':'application/octet-stream','Content-Length':String(ab.byteLength)}})); verified[f]=true; localStorage.setItem('tc-verified-'+MAN._sha,JSON.stringify(verified)); done+=meta.bytes; paint(done,total,f+' ✓'); }
  msg(`model on this device: ${files.length} files, ${Math.round(total/1048576)} MB, every file hash-verified against the signed manifest`); st('ready to load'); return true; }
function paint(done,total,f){ $('bar').style.width=Math.round(100*done/total)+'%'; $('prog').textContent=`${Math.round(done/1048576)} / ${Math.round(total/1048576)} MB · ${f}`; }
async function reverify(){ const cache=await caches.open(CACHE); let bad=0,n=0; for(const [f,meta] of Object.entries(MAN.files)){ if(f.startsWith('MANIFEST')) continue; const r=await cache.match(keyUrl(f)); n++; if(!r){ bad++; continue; } const h=hex(await crypto.subtle.digest('SHA-256',await r.arrayBuffer())); if(h!==meta.sha256) bad++; paint(n,Object.keys(MAN.files).length,f); }
  msg(bad?`${bad} of ${n} files missing or corrupt — download again`:`all ${n} files present and verified`); if(bad) localStorage.removeItem('tc-verified-'+MAN._sha); }
async function loadEngine(){ st('loading model'); const cfg={model_list:[{model:`${location.origin}${BASE}/models/${DIR}`, model_id:MODEL_ID, model_lib:`${location.origin}${BASE}/vendor/Qwen3-${SIZE==='4b'?'4B':SIZE}-${VARIANT}_cs1k-webgpu.wasm`, vram_required_MB:SIZE==='4b'?(VARIANT==='q4f16_1'?3431.59:4327.71):(SIZE==='1.7B'?(VARIANT==='q4f16_1'?1800:2200):(VARIANT==='q4f16_1'?900:1150)), low_resource_required:true, overrides:RISK.low?{context_window_size:(SIZE==='4b'?1024:4096),prefill_chunk_size:256}:{context_window_size:4096}}]};   /* on weak GPUs: a quarter of the KV cache, and small prefill chunks so each dispatch is short — a long single dispatch is what trips the display-driver watchdog and hangs the machine */
  engine=await webllm.CreateMLCEngine(MODEL_ID,{appConfig:cfg,initProgressCallback:p=>{ $('prog').textContent=p.text.slice(0,100); }}); st('model loaded'); }
async function gate(){ /* this exact artefact must pass the response probe on this device before it may chat */
  const passKey='tc-gate-'+MAN._sha; if(localStorage.getItem(passKey)==='pass'){ gateOK=true; $('gate').insertAdjacentHTML('beforeend','<span class="pill ok">gate passed on this device ✓</span>'); return true; }
  const [cb,fb]=await Promise.all(['/probe_constants.json','/fixtures.json'].map(u=>fetch(BASE+u).then(r=>r.arrayBuffer())));
  { const ch=hex(await crypto.subtle.digest('SHA-256',cb)); if(ch!==MAN.probe_constants_sha256) throw new Error('probe constants do not match the signed manifest'); }
  { const fh=hex(await crypto.subtle.digest('SHA-256',fb)); if(fh!==MAN.fixtures_sha256) throw new Error('probe fixtures do not match the signed manifest'); }
  [CONST,FIX]=[cb,fb].map(x=>JSON.parse(new TextDecoder().decode(x)));   /* same prefix bug: unprefixed these hit the chat app and the gate fixtures failed */ const fx=runFixtures(FIX,CONST.refuse); if(!fx.every(x=>x.ok)) throw new Error('probe fixtures failed');
  st('gate: probing'); let pass=true; const rows=[]; const tGate=performance.now(); let t1=tGate;
  /* the probe is 8 answers of up to 140 tokens and can take minutes on integrated graphics; without live counters the page looks frozen and the input stays locked with no explanation */
  for(let i=0;i<CONST.prompts.length;i++){ let raw='',finish='stop',n=0; const t0=performance.now();
    const eta=()=>{ if(i<2) return i>0?' · estimating…':''; const per=(performance.now()-t1)/(i-1); return ` · about ${Math.max(1,Math.round(per*(CONST.prompts.length-i)/60000))} min left`; };   /* check 1 includes one-off WebGPU shader compilation; averaging it in doubled the estimate */
    $('prog').textContent=`safety check ${i+1} of ${CONST.prompts.length}: asking…`; st(`gate ${i+1}/${CONST.prompts.length}`);
    const bar=f=>{ $('bar').style.width=Math.round(100*(i+Math.min(f,1))/CONST.prompts.length)+'%'; }; bar(0);   /* the download bar sat full and frozen through the whole gate — reuse it so the check has a visible bar too */
    try{ const s=await engine.chat.completions.create({messages:[{role:'user',content:CONST.prompts[i]}],stream:true,temperature:CONST.temperature,max_tokens:CONST.max_tokens,extra_body:{enable_thinking:false}}); for await(const c of s){ const d=c.choices?.[0]?.delta?.content||''; raw+=d; if(d) n++; if(n%8===0){ const sec=(performance.now()-t0)/1000; bar(n/CONST.max_tokens); $('prog').textContent=`safety check ${i+1} of ${CONST.prompts.length}: ${n} words in, ${(n/Math.max(sec,0.1)).toFixed(1)}/s${eta()}`; } if(c.choices?.[0]?.finish_reason) finish=c.choices[0].finish_reason; } }catch(e){ finish='error'; }
    if(i===0) t1=performance.now();   /* start the clock after the warm-up check */
    const c=classify(finish==='error'?null:raw,finish,CONST.refuse); rows.push(c.label); if(c.label==='refusal'||c.label==='error') pass=false; if(c.label==='ambiguous'){ const a=confirm(`Probe ${i+1}: the answer contains "${c.pattern}" late in a long reply. Read it:\n\n${stripRuntimeThink(raw).slice(0,800)}\n\nOK = it complies, Cancel = it refuses`); if(!a) pass=false; } bar(1); $('prog').textContent=`safety check ${i+1} of ${CONST.prompts.length}: ${c.label} (${Math.round((performance.now()-t0)/1000)}s)`; }
  gateOK=pass; if(pass) localStorage.setItem(passKey,'pass'); $('gate').insertAdjacentHTML('beforeend',`<span class="pill ${pass?'ok':'bad'}">gate ${pass?'passed':'FAILED — chat locked'} (${rows.join(', ')})</span>`); return pass; }
function add(role,text,acts){ const d=document.createElement('div'); d.className='m '+(role==='user'?'u':'a'); const body=document.createElement('div'); body.className='body'; body.textContent=text; d.appendChild(body); $('chat').appendChild(d); if(acts) attachActions(d,role); d.scrollIntoView({block:'end'}); return body; }
const ICON={copy:'<path d="M9 9h11v11H9z"/><path d="M5 15V4h11"/>',edit:'<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/>',redo:'<path d="M21 12a9 9 0 1 1-3-6.7L21 8"/><path d="M21 3v5h-5"/>',up:'<path d="M7 10v11"/><path d="M15 5.9 14 10h5.6a2 2 0 0 1 2 2.3l-1.4 7A2 2 0 0 1 18.2 21H7V10l4.9-8a2 2 0 0 1 3.1 1.6Z"/>',down:'<path d="M17 14V3"/><path d="M9 18.1 10 14H4.4a2 2 0 0 1-2-2.3l1.4-7A2 2 0 0 1 5.8 3H17v11l-4.9 8a2 2 0 0 1-3.1-1.6Z"/>',speak:'<path d="M11 5 6 9H2v6h4l5 4z"/><path d="M15.5 8.5a5 5 0 0 1 0 7"/>'};
function ic(k){ return `<svg class="ico" viewBox="0 0 24 24">${ICON[k]}</svg>`; }
function idxOf(bubble){ const m=bubble.classList?bubble:bubble.parentElement; return [...$('chat').querySelectorAll('.m')].indexOf(m); }
function attachActions(msgEl,role){ const bar=document.createElement('div'); bar.className='acts'; const txt=()=>msgEl.querySelector('.body').textContent;
  const mk=(k,label,fn,title)=>{ const b=document.createElement('button'); b.innerHTML=ic(k)+(label?`<span>${label}</span>`:''); b.title=title||label||k; b.onclick=fn; bar.appendChild(b); return b; };
  mk('copy','Copy',()=>{ navigator.clipboard&&navigator.clipboard.writeText(txt()); },'Copy');
  if(role==='user'){ mk('edit','Edit',()=>editFrom(msgEl),'Edit and resend'); }
  else{ mk('redo','',()=>regenFrom(msgEl),'Regenerate');
    mk('speak','',()=>{ try{ speechSynthesis.cancel(); const u=new SpeechSynthesisUtterance(txt()); const lv=speechSynthesis.getVoices().filter(v=>v.localService); if(!lv.length){ st('no on-device voice available \u2014 read aloud stays off so your words stay local'); return; } u.voice=lv.find(v=>v.default)||lv[0]; speechSynthesis.speak(u); }catch(e){} },'Read aloud (on-device voice)');
    const up=mk('up','',()=>rate(msgEl,up,dn,1),'Good'); const dn=mk('down','',()=>rate(msgEl,dn,up,-1),'Bad'); markRated(msgEl,up,dn); }
  msgEl.appendChild(bar); }
function rateKey(i){ return 'tc-rate-'+(chatId||'x')+'-'+i; }
function markRated(msgEl,up,dn){ const v=localStorage.getItem(rateKey(idxOf(msgEl))); if(v==='1') up.classList.add('on'); if(v==='-1') dn.classList.add('on'); }
function rate(msgEl,btn,other,v){ const k=rateKey(idxOf(msgEl)); const cur=localStorage.getItem(k); if(String(v)===cur){ localStorage.removeItem(k); btn.classList.remove('on'); } else { localStorage.setItem(k,String(v)); btn.classList.add('on'); other.classList.remove('on'); } }
function editFrom(msgEl){ const i=idxOf(msgEl); if(i<0) return; const val=chat[i].content; chat=chat.slice(0,i); trimDom(i); $('q').value=val; $('q').focus(); }
function regenFrom(msgEl){ const i=idxOf(msgEl); if(i<0||!engine||!gateOK) return; chat=chat.slice(0,i); trimDom(i); generate(); }
function trimDom(i){ const nodes=[...$('chat').querySelectorAll('.m')]; for(let j=nodes.length-1;j>=i;j--) nodes[j].remove(); }
let chatId=null;
function migrateChats(){ try{ let a=JSON.parse(localStorage.getItem('tc-chats')||'[]'); if(!a.length) return;
    a=a.filter(c=>c&&c.messages&&c.messages.length).map(c=>({id:c.id||String(c.ts||Date.now()),ts:c.ts||Date.now(),title:c.title||'',messages:c.messages}));
    const key=c=>c.messages.map(m=>m.role+':'+m.content).join('\u0001');   /* a growing conversation was saved many times; the shorter saves are prefixes of the longest */
    a.sort((x,y)=>y.messages.length-x.messages.length); const keep=[];
    for(const c of a){ const k=key(c); if(!keep.some(d=>key(d).startsWith(k))) keep.push(c); }
    keep.sort((x,y)=>y.ts-x.ts); localStorage.setItem('tc-chats',JSON.stringify(keep.slice(0,30)));
  }catch(e){} }
function chatsAll(){ try{ const a=JSON.parse(localStorage.getItem('tc-chats')||'[]'); return a.filter(c=>c&&c.messages&&c.messages.length).map(c=>({id:c.id||String(c.ts||Date.now()),ts:c.ts||Date.now(),title:c.title||titleOf(c.messages),messages:c.messages})); }catch(e){ return []; } }   /* chats saved before the sidebar existed have no id/title — give them one on read so they stay clickable */
function titleOf(ms){ const u=ms.find(m=>m.role==='user'); return u?u.content.replace(/\s+/g,' ').slice(0,42):'New chat'; }
function saveChat(){ try{ const all=chatsAll(); const rec={id:chatId||(chatId=String(Date.now())),ts:Date.now(),title:titleOf(chat),messages:chat};
    const i=all.findIndex(c=>c.id===rec.id); if(i>=0) all[i]=rec; else all.unshift(rec);   /* was unshifting a new record on every reply, so one conversation became twenty entries */
    localStorage.setItem('tc-chats',JSON.stringify(all.slice(0,30))); renderChats(); }catch(e){} }
function ago(ts){ const m=Math.round((Date.now()-ts)/60000); if(m<1) return 'now'; if(m<60) return m+'m'; const h=Math.round(m/60); if(h<24) return h+'h'; return Math.round(h/24)+'d'; }
let chatQuery='';
function bucket(ts){ const d=new Date(ts), n=new Date(); const day=x=>new Date(x.getFullYear(),x.getMonth(),x.getDate()).getTime();
  const diff=(day(n)-day(d))/86400000; return diff<=0?'Today':diff===1?'Yesterday':diff<=7?'Previous 7 days':diff<=30?'Previous 30 days':'Older'; }
function esc(t){ return (t||'').replace(/[<&>]/g,c=>({'<':'&lt;','&':'&amp;','>':'&gt;'}[c])); }
function renderChats(){ const el=$('chats'); if(!el) return; let all=chatsAll();
  if(chatQuery){ const q=chatQuery.toLowerCase(); all=all.filter(c=>(c.title||'').toLowerCase().includes(q)||c.messages.some(m=>m.content.toLowerCase().includes(q))); }
  if(!all.length){ el.innerHTML='<div class="i" style="color:var(--mut);cursor:default">'+(chatQuery?'no matches':'no chats yet')+'</div>'; return; }
  let html='', grp=''; for(const c of all){ const b=bucket(c.ts); if(b!==grp){ grp=b; html+=`<div class="grp">${b}</div>`; }
    html+=`<div class="i${c.id===chatId?' on':''}" data-id="${c.id}"><span>${esc(c.title||'chat')}</span><small>${ago(c.ts)}</small></div>`; }
  el.innerHTML=html; el.querySelectorAll('[data-id]').forEach(d=>d.onclick=()=>openChat(d.getAttribute('data-id'))); }
function setTitle(){ const t=$('title'); if(t) t.textContent=chat.length?titleOf(chat):'New chat'; }
function openChat(id){ const c=chatsAll().find(x=>x.id===id); if(!c) return; chatId=id; chat=c.messages.slice(); $('chat').innerHTML='';
  for(const m of chat) add(m.role==='user'?'user':'assistant',m.content,true); setTitle(); renderChats(); document.body.classList.remove('nav'); }
const SYS_BIG={role:'system',content:'You are TruthCoder, an AI assistant developed by TruthAi. If asked your name, who you are, or who made you, say you are TruthCoder, developed by TruthAi (built on open Qwen3 weights). If your answer will run longer than a short paragraph, begin with ONE brief line (under 15 words) saying what you are about to do, then a blank line, then the full answer; if it is short, answer directly with no preamble.'};
const SYS_SMALL={role:'system',content:'You are TruthCoder by TruthAi. Answer the user directly and helpfully.'};
/* a 0.6B model cannot follow a long system prompt — it parrots it, so every question came back as "You are TruthCoder, a model
   developed by TruthAi...". Small build gets a one-line persona and no preamble instruction. */
const SMALL_SHOT=[{role:'user',content:'Who are you?'},{role:'assistant',content:'I am TruthCoder, an AI assistant developed by TruthAi. I run entirely on your device.'}];
/* a 0.6B follows an example far better than an instruction: with the one-line persona alone it still answered "I'm an AI model" */
function preamble(){ return SIZE==='0.6B'?[SYS_SMALL,...SMALL_SHOT]:[SYS_BIG]; }   /* 1.7B follows a normal system prompt; only the 0.6B needs the worked example */
function maxTok(){ if(SIZE==='0.6B') return 600; if(SIZE==='1.7B') return 700; return RISK.low?300:800; }   /* the 300 cap was for a 4B on weak graphics; the small model is cheap to run and was being cut off mid-answer */
function ctxSize(){ return (RISK.low&&SIZE==='4b')?1024:4096; }   /* MUST mirror the loadEngine override */
function estTok(t){ return Math.ceil(String(t).length/3.5)+4; }   /* chars/3.5 overestimates English slightly — safe side */
function fitHistory(){ /* newest-first pack: keep whole messages while they fit; the newest user turn always survives, truncated if it must.
   Written after an iPhone crashed ~10 questions into a chat: 12 raw messages + a 700-token answer budget were
   being pushed into a 1024-token window. Old turns now fall out of the model's memory instead of killing the engine. */
  const sys=preamble(); let budget=ctxSize()-maxTok()-64-sys.reduce((a,m)=>a+estTok(m.content),0);
  const out=[]; for(let i=chat.length-1;i>=0;i--){ const m=chat[i]; const t=estTok(m.content);
    if(t<=budget){ out.unshift({role:m.role,content:m.content}); budget-=t; }
    else if(!out.length){ const cut=String(m.content).slice(0,Math.max(200,Math.floor(budget*3.5))); out.unshift({role:m.role,content:cut}); budget-=estTok(cut); break; }
    else break; }
  return out; }
async function ask(q){ if(!engine||!gateOK) return; chat.push({role:'user',content:q}); add('user',q,true); setTitle(); await generate(); }
async function generate(){ /* streams a reply for the current chat (which ends with a user turn), then attaches the action row; regenerate reuses this */
  const wrap=document.createElement('div'); wrap.className='m a'; const body=document.createElement('div'); body.className='body'; wrap.appendChild(body); $('chat').appendChild(wrap); wrap.classList.add('sk');
  body.innerHTML='<div class="pre" hidden></div><div class="work"><span class="spin"></span><span class="lab"></span></div><div class="wbar" hidden><i></i></div>';
  const pre=body.querySelector('.pre'), lab=body.querySelector('.lab'), wbar=body.querySelector('.wbar');
  const t0=performance.now(); let out='', words=0, shown='', phase='thinking';
  const paint=()=>{ const sec=Math.round((performance.now()-t0)/1000); lab.textContent=`${phase==='thinking'?'thinking':'writing'}\u2026 ${sec}s`; };
  paint(); const tick=setInterval(paint,900); busy(true); $('send').disabled=true; $('q').disabled=true; $('send').hidden=true; $('stop').hidden=false;   /* a long answer on a weak GPU must be cancellable rather than run to the end */
  const splitPre=v=>{ const i=v.indexOf('\n\n'); if(i>0&&i<240) return [v.slice(0,i).trim(), v.slice(i+2)]; const j=v.indexOf('\n'); if(j>0&&j<200) return [v.slice(0,j).trim(), v.slice(j+1)]; return null; };
  try{ const s2=await engine.chat.completions.create({messages:[...preamble(),...fitHistory()],stream:true,temperature:0.7,top_p:0.9,max_tokens:maxTok(),extra_body:{enable_thinking:false}});
    for await(const c of s2){ const d=c.choices?.[0]?.delta?.content||''; if(!d) continue; out+=d;
      const v=stripRuntimeThink(out); words=v.split(/\s+/).filter(Boolean).length;
      if(!shown&&SIZE!=='0.6B'){ const sp=splitPre(v); if(sp&&sp[0]){ shown=sp[0]; pre.hidden=false; pre.textContent=shown; wbar.hidden=false; phase='writing'; wrap.scrollIntoView({block:'end'}); paint(); } }
    }
  }catch(e){ clearInterval(tick); busy(false); wrap.classList.remove('sk'); body.textContent=String(e).includes('interrupt')?'(stopped)':'error: '+e; $('send').disabled=false; $('q').disabled=false; $('send').hidden=false; $('stop').hidden=true; return; }
  clearInterval(tick); const text=stripRuntimeThink(out).trim();
  wrap.classList.remove('sk'); body.innerHTML='';
  if(shown&&text.startsWith(shown)){ const p2=document.createElement('div'); p2.className='pre'; p2.textContent=shown; body.appendChild(p2);
    const b2=document.createElement('div'); body.appendChild(b2); await reveal(b2,text.slice(shown.length).trim()); }
  else await reveal(body,text);
  attachActions(wrap,'assistant');
  chat.push({role:'assistant',content:text}); saveChat(); setTitle();
  const sec=(performance.now()-t0)/1000; st(`${sec<60?Math.round(sec)+' s':Math.floor(sec/60)+' m '+Math.round(sec%60)+' s'} \u00b7 ${words} words \u00b7 ${(words/Math.max(sec,.1)).toFixed(1)}/s`);
  busy(false); $('send').disabled=false; $('q').disabled=false; $('send').hidden=false; $('stop').hidden=true; $('q').focus(); }
async function reveal(el,text){ /* the answer is already generated; print it at a steady fast pace with a blinking cursor, so it reads like live typing instead of the model's real ~2.4 words/s crawl or an instant dump */
  el.textContent=''; const cur=document.createElement('span'); cur.className='cur'; el.appendChild(cur);
  const total=text.length, dur=Math.min(2200,Math.max(500,total*7)); const t0=performance.now(); let shown=0;
  await new Promise(res=>{ const step=()=>{ const k=Math.min(1,(performance.now()-t0)/dur); const n=Math.floor(k*total);
    if(n>shown){ cur.insertAdjacentText('beforebegin',text.slice(shown,n)); shown=n; el.scrollIntoView({block:'end'}); }
    if(k<1) requestAnimationFrame(step); else { cur.remove(); el.textContent=text; el.scrollIntoView({block:'end'}); res(); } }; requestAnimationFrame(step); }); }
/* 2026-09-18: land with the prompt box in view. The shell is 100dvh with a fixed body, so the composer is always on
   screen; this also parks the scroller at the bottom (where a returning chat's newest turn is) and re-does it when iOS
   changes the visual viewport — rotating, or the keyboard opening and closing. */
/* iPhone report ("when you are typing the text box does not show up"): iOS Safari does NOT shrink 100dvh when the
   keyboard opens — it keeps the layout at full height and slides the page, so a fixed composer ends up BEHIND the
   keyboard. The only thing that tracks the keyboard is window.visualViewport, so the shell's height and top are set
   from it in pixels on every viewport resize/scroll, and the window is pinned at 0. Desktop (no keyboard) is unchanged. */
function settleView(){ try{
  const vv=window.visualViewport;
  if(vv&&matchMedia('(max-width:760px)').matches){ document.body.style.height=Math.round(vv.height)+'px'; document.body.style.top=Math.round(vv.offsetTop)+'px'; }
  else { document.body.style.height=''; document.body.style.top=''; }
  const sc=$('scroll'); if(sc) sc.scrollTop=sc.scrollHeight; window.scrollTo(0,0);
}catch(_){}}
addEventListener('load',()=>{ settleView(); setTimeout(settleView,120); });
if(window.visualViewport){ visualViewport.addEventListener('resize',()=>{ settleView(); setTimeout(settleView,60); }); visualViewport.addEventListener('scroll',settleView); }
$('q').addEventListener('focus',()=>{ setTimeout(settleView,50); setTimeout(settleView,300); });
$('q').addEventListener('blur',()=>setTimeout(settleView,100));
$('f').onsubmit=e=>{ e.preventDefault(); const q=$('q').value.trim(); if(!q) return; $('q').value=''; ask(q); }; $('q').addEventListener('keydown',e=>{ if((e.metaKey||e.ctrlKey)&&e.key==='Enter'){ e.preventDefault(); $('f').requestSubmit(); } });
$('new').onclick=()=>{ chat=[]; chatId=null; $('chat').innerHTML=''; setTitle(); renderChats(); document.body.classList.remove('nav'); $('q').focus(); };
const closeNav=()=>document.body.classList.remove('nav');
$('menu').onclick=()=>document.body.classList.toggle('nav');
$('navx').onclick=closeNav; $('scrim').onclick=closeNav;
document.addEventListener('keydown',e=>{ if(e.key==='Escape') closeNav(); });
document.querySelectorAll('aside a.i').forEach(a=>a.addEventListener('click',closeNav));   /* tapping any sidebar link on a phone should get you back to the conversation */
$('stop').onclick=()=>{ try{ engine&&engine.interruptGenerate&&engine.interruptGenerate(); }catch(e){} $('stop').disabled=true; setTimeout(()=>$('stop').disabled=false,1500); };
$('csearch').addEventListener('input',e=>{ chatQuery=e.target.value.trim(); renderChats(); });
$('theme').onclick=()=>{ const cur=document.documentElement.getAttribute('data-theme'); const next=cur==='dark'?'light':cur==='light'?'':'dark';
  if(next){ document.documentElement.setAttribute('data-theme',next); try{localStorage.setItem('tc-theme',next);}catch(e){} }
  else{ document.documentElement.removeAttribute('data-theme'); try{localStorage.removeItem('tc-theme');}catch(e){} }
  $('theme').textContent=next==='dark'?'\u25D1':next==='light'?'\u2600':'\u25D0'; $('theme').title='theme: '+(next||'system'); };
(()=>{ const t=document.documentElement.getAttribute('data-theme'); $('theme').textContent=t==='dark'?'\u25D1':t==='light'?'\u2600':'\u25D0'; $('theme').title='theme: '+(t||'system'); })();

$('setupbtn').onclick=()=>{ const c=$('setup'); c.style.display=c.style.display==='none'?'':'none'; if(c.style.display!=='none') c.scrollIntoView({block:'start'}); closeNav(); }; $('export').onclick=()=>{ const b=new Blob([JSON.stringify({exported:new Date().toISOString(),model:MAN&&MAN.artefact,chat},null,1)],{type:'application/json'}); const a=document.createElement('a'); a.href=URL.createObjectURL(b); a.download='truthai-mini-chat.json'; a.click(); };
$('del').onclick=async()=>{ if(!confirm('Delete the downloaded model from this device?')) return; for(const c of ['webllm/model','webllm/config','webllm/wasm','webllm/model-0.6B','webllm/model-4b']) await caches.delete(c);   /* clear the engine's own caches too, plus the short-lived per-size names, so Delete really means a clean slate */ Object.keys(localStorage).filter(k=>k.startsWith('tc-verified-')||k.startsWith('tc-gate-')).forEach(k=>localStorage.removeItem(k)); location.reload(); };
$('verify').onclick=reverify; $('get').onclick=async()=>{ if(!riskAck()) return; if(!(await storageOK())) return; busy(true); try{ await downloadAll(); await loadEngine(); await gate(); if(gateOK){ $('q').disabled=false; $('send').disabled=false; $('setup').style.display='none'; st('ready'); } }catch(e){ msg('failed: '+e.message); st('failed'); $('get').disabled=false; } finally{ busy(false); } };
let deferred=null; window.addEventListener('beforeinstallprompt',e=>{ e.preventDefault(); deferred=e; $('install').hidden=false; }); $('install').onclick=()=>{ if(deferred) deferred.prompt(); };
migrateChats(); renderChats(); setTitle();   /* sidebar is populated before the GPU check, so history is there even on a device that cannot run the model */
window.addEventListener('error',e=>{ try{ msg('Startup error: '+(e.message||e.error)+' — include this line when reporting the problem.'); st('error'); }catch(_){} });
window.addEventListener('unhandledrejection',e=>{ try{ msg('Startup error: '+((e.reason&&e.reason.message)||e.reason)+' — include this line when reporting the problem.'); st('error'); }catch(_){} });
/* a silent hang at "checking this device…" tells the user nothing; any failure in the boot chain must name itself on screen */
(async()=>{ let cap; try{ cap=await capability(); }catch(e){ msg('Device check failed: '+(e&&e.message||e)); st('error'); return; }
  if(!cap) return;
  try{ await loadManifest(); }catch(e){ msg('Could not load the signed manifest: '+(e&&e.message||e)); st('error'); return; } $('get').disabled=false; $('verify').disabled=false;
  const cache=await caches.open(CACHE); const have=(await Promise.all(Object.keys(MAN.files).filter(f=>!f.startsWith('MANIFEST')).map(f=>cache.match(keyUrl(f))))).every(Boolean);
  const gb=MAN.total_bytes||Object.entries(MAN.files||{}).filter(([k])=>!k.startsWith('MANIFEST')).reduce((a,[,f])=>a+(f.bytes||0),0);   /* the manifest field is total_bytes; MAN.bytes does not exist */
  const sz=gb>1e9?(gb/1e9).toFixed(1)+' GB':Math.round(gb/1e6)+' MB';
  $('get').textContent=have?'Launch model':`Launch model (${sz} first time)`;   /* not a download: it launches, fetching once if needed. Size comes from the signed manifest, never hard-coded. */
  if(have) msg('model already on this device');
  st('ready'); })();
