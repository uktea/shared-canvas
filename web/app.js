(async function () {
  'use strict';
  const $=id=>document.getElementById(id), C=PixelCore, uuid=()=>crypto.randomUUID();
  let endpoint=localStorage.getItem('canvas-endpoint') ?? window.CANVAS_ENDPOINT ?? '';
  const key=endpoint || 'local';
  let db, state, drawing=null, pixels, busy=false, editQueue=Promise.resolve(), storageFailed=false, syncTimer=null;
  let batchLimit=1, batchBytes=45000,imageData=null,renderDirty=true,historyTargets={};
  let failures=0,nextSyncAt=0,needsReceiptCheck=false;
  const ctx=$('canvas').getContext('2d',{alpha:false});
  function status(message){$('status').textContent=message;}
  function edit(fn){const next=editQueue.then(fn);editQueue=next.catch(e=>status(e.message));return next;}
  function openDB(){return new Promise((resolve,reject)=>{const r=indexedDB.open('shared-canvas-v1',1);r.onupgradeneeded=()=>r.result.createObjectStore('state');r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});}
  function read(){return new Promise((resolve,reject)=>{const r=db.transaction('state').objectStore('state').get(key);r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});}
  function save(){return new Promise((resolve,reject)=>{const t=db.transaction('state','readwrite');t.objectStore('state').put(state,key);t.oncomplete=()=>resolve();t.onerror=()=>reject(t.error);t.onabort=()=>reject(t.error || Error('ローカル保存に失敗しました'));});}
  function events(){const ids=new Set(state.events.map(e=>e.id));return state.events.concat(state.pending.filter(e=>!ids.has(e.id)));}
  function show(p){const data=imageData || (imageData=ctx.createImageData(C.SIZE,C.SIZE));for(let i=0;i<p.length;i++){const n=p[i],j=i*4;data.data[j]=n>>>16;data.data[j+1]=(n>>>8)&255;data.data[j+2]=n&255;data.data[j+3]=255;}ctx.putImageData(data,0,0);}
  function refresh(){
    if(renderDirty){pixels=C.render(events());historyTargets=C.targets(events(),state.author);renderDirty=false;}
    if(drawing){const p=pixels.slice();C.paint(p,drawing);show(p);}else show(pixels);
    const t=historyTargets;$('undo').disabled=!t.undo || !!drawing || storageFailed;$('redo').disabled=!t.redo || !!drawing || storageFailed;
    $('version').textContent='更新 '+state.version;
  }
  async function commit(op){
    C.validate(op);C.reduce(events().concat(op));
    const old=structuredClone(state);
    if(endpoint) state.pending.push(op);else{op.version=++state.version;state.events.push(op);}
    try{await save();renderDirty=true;refresh();if(endpoint)status('未送信 '+state.pending.length+'件');}
    catch(e){state=old;storageFailed=true;renderDirty=true;refresh();throw Error('ローカル保存に失敗しました。描画を停止しました');}
  }
  function scheduleSync(){if(syncTimer!==null)return;syncTimer=setTimeout(()=>{syncTimer=null;sync();},200);}
  function targetOp(type){return edit(async()=>{const target=C.targets(events(),state.author)[type];if(target)await commit({id:uuid(),target,author:state.author,type});}).then(scheduleSync).catch(e=>status(e.message));}
  async function request(params,op){
    const url=new URL(endpoint);url.searchParams.set('client','3');for(const [k,v] of Object.entries(params))url.searchParams.set(k,v);
    const response=await fetch(url,{method:op?'POST':'GET',redirect:'follow',credentials:'omit',cache:'no-store',signal:AbortSignal.timeout(45000),...(op?{headers:{'Content-Type':'text/plain;charset=UTF-8'},body:JSON.stringify(op)}:{})});
    if(!response.ok)throw Error('通信エラー '+response.status);
    const result=await response.json();
    if(!result.ok)throw Object.assign(Error(result.error || 'サーバーエラー'),{code:result.code,retryAfterMs:result.retryAfterMs});
    // Old deployments keep accepting individual operations until GAS is updated.
    if(result.protocol>=2){batchLimit=Math.max(1,Math.min(50,result.maxBatchOperations||50));batchBytes=Math.max(45000,Math.min(256000,result.maxBatchBytes||256000));}
    return result;
  }
  function pendingBatch(){
    if(batchLimit===1)return state.pending.slice(0,1);
    const batch=[];let bytes=18; // JSON envelope, including separators.
    for(const op of state.pending){
      const length=new TextEncoder().encode(JSON.stringify(op)).length+1;
      if(batch.length>=batchLimit || (batch.length && bytes+length>batchBytes))break;
      batch.push(op);bytes+=length;
    }
    return batch;
  }
  function canvasSize(size){
    if(size===C.SIZE&&$('canvas').width===size)return;
    C.setSize(size);$('canvas').width=size;$('canvas').height=size;imageData=null;renderDirty=true;
    $('resolution').textContent=size+' × '+size;resize();
  }
  async function snapshot(){
    const manifest=await request({action:'snapshot'});
    if(manifest.kind!=='snapshot-manifest')return manifest;
    const size=manifest.canvasSize;
    if(![256,512,1024].includes(size)||manifest.tileSize!==256||!Array.isArray(manifest.tiles)||manifest.tiles.length>(size/256)**2)throw Error('スナップショット形式が不正です');
    const pixels=new Uint32Array(size*size);pixels.fill(C.WHITE);
    const seen=new Set();
    for(const [x,y] of manifest.tiles){
      if(!Number.isInteger(x)||!Number.isInteger(y)||x<0||y<0||x>=size||y>=size||x%256||y%256||seen.has(x+','+y))throw Error('タイル一覧が不正です');
      seen.add(x+','+y);
      status('読込中 · '+seen.size+' / '+manifest.tiles.length);
      const tile=await request({action:'tile',version:manifest.version,x,y});
      if(tile.kind!=='tile'||tile.version!==manifest.version||tile.canvasSize!==size||tile.x!==x||tile.y!==y||tile.width!==256||tile.height!==256)throw Error('タイルの更新番号が一致しません');
      const data=C.unpack(tile,256*256);
      for(let row=0;row<256;row++)pixels.set(data.subarray(row*256,(row+1)*256),(y+row)*size+x);
    }
    return {...manifest,kind:'snapshot',pixels};
  }
  async function absorb(result){
    const old=structuredClone(state),oldSize=C.SIZE;
    try{
      const size=result.canvasSize || 256;
      if(size<oldSize)throw Error('接続先のキャンバスサイズが小さくなっています');
      if(size!==oldSize&&drawing)finish();
      canvasSize(size);state.canvasSize=size;
      if(result.kind==='snapshot'){
        if(result.version<state.version)throw Error('古いスナップショットです');
        state.events=result.events;state.version=result.version;
        const check=C.render(state.events);
        if(!(Array.isArray(result.pixels)||ArrayBuffer.isView(result.pixels))||result.pixels.length!==C.SIZE*C.SIZE||check.some((v,i)=>v!==result.pixels[i]))throw Error('描画データが一致しません');
      }else{
        for(const e of result.events){if(e.version<=state.version)continue;if(e.version!==state.version+1)throw Error('差分が連続していません');state.events.push(e);state.version=e.version;}
        if(state.version!==result.version)throw Error('差分が不足しています');
      }
      const applied=result.appliedVersion===undefined?state.version:
        (Number.isInteger(result.appliedVersion)?Math.min(result.appliedVersion,state.version):-1);
      const ids=new Set(state.events.filter(e=>e.version<=applied).map(e=>e.id));
      state.pending=state.pending.filter(e=>!ids.has(e.id));
      C.reduce(events());await save();renderDirty=true;refresh();
    }catch(e){state=old;canvasSize(oldSize);renderDirty=true;refresh();throw e;}
  }
  async function pull(){
    let result=state.initialized?await request({action:'updates',since:state.version}):await snapshot();
    if(result.kind==='reset')result=await snapshot();
    try{await edit(()=>absorb(result));}
    catch(e){if(result.kind==='snapshot')throw e;const full=await snapshot();await edit(()=>absorb(full));}
    await edit(async()=>{state.initialized=true;await save();});
  }
  async function sync(){
    if(!endpoint || busy || storageFailed || Date.now()<nextSyncAt)return;busy=true;
    try{
      await editQueue;
      if(!state.initialized || !state.pending.length || needsReceiptCheck){await pull();needsReceiptCheck=false;}
      // One outstanding batch; retries retain every individual operation ID.
      for(let count=0;count<8;count++){
        await editQueue;const batch=pendingBatch();if(!batch.length)break;
        status('送信中 · '+batch.length+'件 / 未送信 '+state.pending.length+'件');
        needsReceiptCheck=true;
        const result=await request({since:state.version},batchLimit>1?{operations:batch}:batch[0]);
        if(result.kind==='reset')await pull();else await edit(()=>absorb(result));
        needsReceiptCheck=false;
      }
      failures=0;nextSyncAt=0;
      status(state.pending.length?'未送信 '+state.pending.length+'件':'');
    }catch(e){
      failures=Math.min(failures+1,6);
      const base=e.code==='BUSY'?2000:5000;
      const delay=Math.min(60000,Math.max(Number(e.retryAfterMs)||0,base*2**(failures-1))*(1+Math.random()*.2));
      nextSyncAt=Date.now()+delay;
      status('未同期 · '+e.message+' · '+Math.ceil(delay/1000)+'秒後に再試行');
    }
    finally{busy=false;}
  }
  function position(e){const r=$('canvas').getBoundingClientRect();return [Math.max(0,Math.min(C.SIZE-1,Math.floor((e.clientX-r.left)*C.SIZE/r.width))),Math.max(0,Math.min(C.SIZE-1,Math.floor((e.clientY-r.top)*C.SIZE/r.height)))];}
  function append(e){const p=position(e),last=drawing.points.at(-1);if(!last||last[0]!==p[0]||last[1]!==p[1]){if(drawing.points.length>=2000){finish();return;}drawing.points.push(p);}}
  function moveCursor(e){const r=$('canvas').getBoundingClientRect(),n=+$('size').value*r.width/C.SIZE;$('cursor').hidden=e.pointerType==='touch';$('cursor').style.cssText=`left:${e.clientX-r.left}px;top:${e.clientY-r.top}px;width:${n}px;height:${n}px`;}
  function finish(){if(!drawing)return;const op=drawing;drawing=null;$('cursor').hidden=true;edit(()=>commit(op)).then(scheduleSync).catch(e=>status(e.message));}
  try{db=await openDB();state=await read() || {author:uuid(),events:[],pending:[],version:0,initialized:false,canvasSize:endpoint?256:1024};canvasSize(state.canvasSize || 256);await save();refresh();}
  catch(e){status('ローカル保存を利用できません');return;}
  $('mode').textContent=endpoint?'共有':'ローカル';
  $('canvas').addEventListener('pointerdown',e=>{if(e.button!==0||drawing||storageFailed)return;e.preventDefault();$('canvas').setPointerCapture(e.pointerId);drawing={id:uuid(),target:uuid(),author:state.author,type:'stroke',canvasSize:C.SIZE,color:$('color').value,size:+$('size').value,points:[],pointerId:e.pointerId};append(e);refresh();});
  $('canvas').addEventListener('pointermove',e=>{moveCursor(e);if(!drawing||e.pointerId!==drawing.pointerId)return;for(const sample of e.getCoalescedEvents?.() || [e]){if(!drawing)break;append(sample);}refresh();});
  $('canvas').addEventListener('pointerup',e=>{if(drawing&&e.pointerId===drawing.pointerId){append(e);finish();}});
  $('canvas').addEventListener('pointercancel',finish);$('canvas').addEventListener('lostpointercapture',finish);
  $('canvas').addEventListener('pointerleave',()=>{$('cursor').hidden=true;});
  $('color').oninput=()=>{$('hex').textContent=$('color').value.toUpperCase();};$('size').oninput=()=>{$('size-value').value=$('size').value+' px';};
  $('undo').onclick=()=>targetOp('undo');$('redo').onclick=()=>targetOp('redo');
  document.addEventListener('keydown',e=>{if($('connection').open||['INPUT','SELECT','TEXTAREA'].includes(e.target.tagName)||drawing)return;if((e.ctrlKey||e.metaKey)&&['z','y'].includes(e.key.toLowerCase())){e.preventDefault();targetOp(e.shiftKey||e.key.toLowerCase()==='y'?'redo':'undo');}});
  function resize(){const stage=$('stage'),zoom=$('zoom').value;const size=zoom==='fit'?Math.max(128,Math.min(stage.clientWidth-64,stage.clientHeight-64)):C.SIZE*Number(zoom);$('paper').style.width=size+'px';$('paper').style.height=size+'px';}
  $('zoom').onchange=resize;new ResizeObserver(resize).observe($('stage'));resize();
  $('settings').onclick=()=>{$('endpoint').value=endpoint;$('connection').showModal();};$('close-settings').onclick=()=>$('connection').close();
  $('connection-form').onsubmit=e=>{e.preventDefault();const value=$('endpoint').value.trim();if(value&&!/^https:\/\/script\.google\.com\/macros\/s\/[A-Za-z0-9_-]+\/exec$/.test(value)){$('endpoint').setCustomValidity('GASの /exec URLを入力してください');$('endpoint').reportValidity();return;}localStorage.setItem('canvas-endpoint',value);location.reload();};$('endpoint').oninput=()=>$('endpoint').setCustomValidity('');
  window.addEventListener('online',()=>{nextSyncAt=0;sync();});document.addEventListener('visibilitychange',()=>{if(!document.hidden)sync();});setInterval(()=>{if(!document.hidden)sync();},4000);sync();
})();
