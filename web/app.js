(async function () {
  'use strict';
  const $=id=>document.getElementById(id), C=PixelCore, uuid=()=>crypto.randomUUID();
  let endpoint=localStorage.getItem('canvas-endpoint') ?? window.CANVAS_ENDPOINT ?? '';
  const key=endpoint || 'local';
  let db, state, drawing=null, pixels, busy=false, editQueue=Promise.resolve(), storageFailed=false;
  const ctx=$('canvas').getContext('2d',{alpha:false});
  function status(message){$('status').textContent=message;}
  function edit(fn){const next=editQueue.then(fn);editQueue=next.catch(e=>status(e.message));return next;}
  function openDB(){return new Promise((resolve,reject)=>{const r=indexedDB.open('shared-canvas-v1',1);r.onupgradeneeded=()=>r.result.createObjectStore('state');r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});}
  function read(){return new Promise((resolve,reject)=>{const r=db.transaction('state').objectStore('state').get(key);r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});}
  function save(){return new Promise((resolve,reject)=>{const t=db.transaction('state','readwrite');t.objectStore('state').put(state,key);t.oncomplete=()=>resolve();t.onerror=()=>reject(t.error);t.onabort=()=>reject(t.error || Error('ローカル保存に失敗しました'));});}
  function events(){const ids=new Set(state.events.map(e=>e.id));return state.events.concat(state.pending.filter(e=>!ids.has(e.id)));}
  function show(p){const data=ctx.createImageData(256,256);for(let i=0;i<p.length;i++){const n=p[i],j=i*4;data.data[j]=n>>>16;data.data[j+1]=(n>>>8)&255;data.data[j+2]=n&255;data.data[j+3]=255;}ctx.putImageData(data,0,0);}
  function refresh(){
    pixels=C.render(events());show(pixels);
    if(drawing){const p=pixels.slice();C.paint(p,drawing);show(p);}
    const t=C.targets(events(),state.author);$('undo').disabled=!t.undo || !!drawing || storageFailed;$('redo').disabled=!t.redo || !!drawing || storageFailed;
    $('version').textContent='更新 '+state.version;
  }
  async function commit(op){
    C.validate(op);C.reduce(events().concat(op));
    const old=structuredClone(state);
    if(endpoint) state.pending.push(op);else{op.version=++state.version;state.events.push(op);}
    try{await save();refresh();if(endpoint)status('未送信 '+state.pending.length+'件');}
    catch(e){state=old;storageFailed=true;refresh();throw Error('ローカル保存に失敗しました。描画を停止しました');}
  }
  function targetOp(type){return edit(async()=>{const target=C.targets(events(),state.author)[type];if(target)await commit({id:uuid(),target,author:state.author,type});}).then(sync).catch(e=>status(e.message));}
  async function request(params,op){
    const url=new URL(endpoint);for(const [k,v] of Object.entries(params))url.searchParams.set(k,v);
    const response=await fetch(url,{method:op?'POST':'GET',redirect:'follow',credentials:'omit',cache:'no-store',signal:AbortSignal.timeout(45000),...(op?{headers:{'Content-Type':'text/plain;charset=UTF-8'},body:JSON.stringify(op)}:{})});
    if(!response.ok)throw Error('通信エラー '+response.status);
    const result=await response.json();if(!result.ok)throw Error(result.error || 'サーバーエラー');return result;
  }
  async function absorb(result){
    const old=structuredClone(state);
    try{
      if(result.kind==='snapshot'){
        if(result.version<state.version)throw Error('古いスナップショットです');
        state.events=result.events;state.version=result.version;
        const check=C.render(state.events);
        if(!Array.isArray(result.pixels)||result.pixels.length!==65536||check.some((v,i)=>v!==result.pixels[i]))throw Error('描画データが一致しません');
      }else{
        for(const e of result.events){if(e.version<=state.version)continue;if(e.version!==state.version+1)throw Error('差分が連続していません');state.events.push(e);state.version=e.version;}
        if(state.version!==result.version)throw Error('差分が不足しています');
      }
      const ids=new Set(state.events.map(e=>e.id));state.pending=state.pending.filter(e=>!ids.has(e.id));
      C.reduce(events());await save();refresh();
    }catch(e){state=old;throw e;}
  }
  async function pull(){
    let result=await request(state.initialized?{action:'updates',since:state.version}:{action:'snapshot'});
    if(result.kind==='reset')result=await request({action:'snapshot'});
    try{await edit(()=>absorb(result));}
    catch(e){if(result.kind==='snapshot')throw e;const snapshot=await request({action:'snapshot'});await edit(()=>absorb(snapshot));}
    await edit(async()=>{state.initialized=true;await save();});
  }
  async function sync(){
    if(!endpoint || busy || storageFailed)return;busy=true;
    try{
      await pull();
      // One outstanding operation; a timed out request is retried with the same ID.
      for(let count=0;count<8;count++){
        await editQueue;const op=state.pending[0];if(!op)break;
        status('送信中 · '+state.pending.length+'件');
        const result=await request({since:state.version},op);
        if(result.kind==='reset')await pull();else await edit(()=>absorb(result));
      }
      status(state.pending.length?'未送信 '+state.pending.length+'件':'');
    }catch(e){status('未同期 · '+e.message);}
    finally{busy=false;}
  }
  function position(e){const r=$('canvas').getBoundingClientRect();return [Math.max(0,Math.min(255,Math.floor((e.clientX-r.left)*256/r.width))),Math.max(0,Math.min(255,Math.floor((e.clientY-r.top)*256/r.height)))];}
  function append(e){const p=position(e),last=drawing.points.at(-1);if(!last||last[0]!==p[0]||last[1]!==p[1]){if(drawing.points.length>=2000){finish();return;}drawing.points.push(p);}}
  function moveCursor(e){const r=$('canvas').getBoundingClientRect(),n=+$('size').value*r.width/256;$('cursor').hidden=e.pointerType==='touch';$('cursor').style.cssText=`left:${e.clientX-r.left}px;top:${e.clientY-r.top}px;width:${n}px;height:${n}px`;}
  function finish(){if(!drawing)return;const op=drawing;drawing=null;$('cursor').hidden=true;edit(()=>commit(op)).then(sync).catch(e=>status(e.message));}
  try{db=await openDB();state=await read() || {author:uuid(),events:[],pending:[],version:0,initialized:false};await save();refresh();}
  catch(e){status('ローカル保存を利用できません');return;}
  $('mode').textContent=endpoint?'共有':'ローカル';
  $('canvas').addEventListener('pointerdown',e=>{if(e.button!==0||drawing||storageFailed)return;e.preventDefault();$('canvas').setPointerCapture(e.pointerId);drawing={id:uuid(),target:uuid(),author:state.author,type:'stroke',color:$('color').value,size:+$('size').value,points:[],pointerId:e.pointerId};append(e);refresh();});
  $('canvas').addEventListener('pointermove',e=>{moveCursor(e);if(!drawing||e.pointerId!==drawing.pointerId)return;for(const sample of e.getCoalescedEvents?.() || [e]){if(!drawing)break;append(sample);}refresh();});
  $('canvas').addEventListener('pointerup',e=>{if(drawing&&e.pointerId===drawing.pointerId){append(e);finish();}});
  $('canvas').addEventListener('pointercancel',finish);$('canvas').addEventListener('lostpointercapture',finish);
  $('canvas').addEventListener('pointerleave',()=>{$('cursor').hidden=true;});
  $('color').oninput=()=>{$('hex').textContent=$('color').value.toUpperCase();};$('size').oninput=()=>{$('size-value').value=$('size').value+' px';};
  $('undo').onclick=()=>targetOp('undo');$('redo').onclick=()=>targetOp('redo');
  document.addEventListener('keydown',e=>{if($('connection').open||['INPUT','SELECT','TEXTAREA'].includes(e.target.tagName)||drawing)return;if((e.ctrlKey||e.metaKey)&&['z','y'].includes(e.key.toLowerCase())){e.preventDefault();targetOp(e.shiftKey||e.key.toLowerCase()==='y'?'redo':'undo');}});
  function resize(){const stage=$('stage'),zoom=$('zoom').value;const size=zoom==='fit'?Math.max(128,Math.min(stage.clientWidth-64,stage.clientHeight-64)):256*Number(zoom);$('paper').style.width=size+'px';$('paper').style.height=size+'px';}
  $('zoom').onchange=resize;new ResizeObserver(resize).observe($('stage'));resize();
  $('settings').onclick=()=>{$('endpoint').value=endpoint;$('connection').showModal();};$('close-settings').onclick=()=>$('connection').close();
  $('connection-form').onsubmit=e=>{e.preventDefault();const value=$('endpoint').value.trim();if(value&&!/^https:\/\/script\.google\.com\/macros\/s\/[A-Za-z0-9_-]+\/exec$/.test(value)){$('endpoint').setCustomValidity('GASの /exec URLを入力してください');$('endpoint').reportValidity();return;}localStorage.setItem('canvas-endpoint',value);location.reload();};$('endpoint').oninput=()=>$('endpoint').setCustomValidity('');
  window.addEventListener('online',sync);document.addEventListener('visibilitychange',()=>{if(!document.hidden)sync();});setInterval(()=>{if(!document.hidden)sync();},4000);sync();
})();
