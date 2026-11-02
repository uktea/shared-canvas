const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const {randomUUID}=require('node:crypto');
require('../web/core.js');
const C=globalThis.PixelCore;
const stroke=i=>({id:'operation-'+i,target:'stroke-id-'+i,author:'author-one',type:'stroke',color:'#333333',size:1,points:[[10,10],[11,11]]});
const settle=async()=>{for(let i=0;i<8;i++)await new Promise(resolve=>setImmediate(resolve));};
function deferred(){let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};}

// Run the actual app with asynchronous IndexedDB and a controllable network.
async function browser({pending=[],modern=true,initialized=false,intercept,size=256,tiled=false,storedState,endpoint}={}){
  let stored=storedState===null?undefined:storedState || {author:'author-one',events:[],pending:structuredClone(pending),version:0,initialized};
  const serverContext=vm.createContext({});vm.runInContext(fs.readFileSync('web/core.js','utf8'),serverContext);
  const serverCore=serverContext.PixelCore;serverCore.setSize(size);
  const elements=new Map(),requests=[],serverEvents=[],timers=new Map();
  let poll,timerId=0;
  function element(id){
    if(!elements.has(id))elements.set(id,{
      value:({color:'#333333',size:'1',zoom:'fit'})[id]||'',style:{},clientWidth:800,clientHeight:600,
      listeners:{},addEventListener(name,callback){this.listeners[name]=callback;},
      getContext(){return {createImageData:(width,height)=>({data:new Uint8ClampedArray(width*height*4)}),putImageData(data){element('canvas').imageData=data;}};},
      getBoundingClientRect:()=>({left:0,top:0,width:256,height:256}),setPointerCapture(){},
      showModal(){this.open=true;},close(){this.open=false;}
    });
    return elements.get(id);
  }
  const db={transaction(){
    const transaction={objectStore:()=>({
      get(){const request={};queueMicrotask(()=>{request.result=structuredClone(stored);request.onsuccess();});return request;},
      put(value){const copy=structuredClone(value);queueMicrotask(()=>{stored=copy;transaction.oncomplete();});}
    })};return transaction;
  }};
  function server(request){
    if(request.body){
      if(!modern)assert.equal(request.body.operations,undefined,'legacy server requires single operations');
      const operations=request.body.operations || [request.body];
      for(const op of operations){
        if(serverEvents.some(event=>event.id===op.id))continue;
        const accepted={...op,version:serverEvents.length+1};
        serverCore.validate(accepted);serverCore.reduce(serverEvents.concat(accepted));serverEvents.push(accepted);
      }
    }
    const capabilities=modern?{protocol:tiled?3:2,canvasSize:size,maxBatchOperations:50,maxBatchBytes:256000}:{};
    const action=request.url.searchParams.get('action');
    if(tiled && action==='snapshot'){
      const tiles=new Map();
      for(const stroke of serverCore.reduce(serverEvents))if(stroke.active){
        const box=serverCore.bounds(stroke);
        for(let y=Math.floor(box.top/256)*256;y<=box.bottom;y+=256)for(let x=Math.floor(box.left/256)*256;x<=box.right;x+=256)tiles.set(x+','+y,[x,y]);
      }
      return {ok:true,...capabilities,kind:'snapshot-manifest',version:serverEvents.length,events:structuredClone(serverEvents),tileSize:256,tiles:[...tiles.values()]};
    }
    if(tiled && action==='tile'){
      const version=Number(request.url.searchParams.get('version')),x=Number(request.url.searchParams.get('x')),y=Number(request.url.searchParams.get('y'));
      const image=serverCore.render(serverEvents.slice(0,version)),pixels=[];
      for(let row=0;row<256;row++)for(let column=0;column<256;column++)pixels.push(image[(y+row)*size+x+column]);
      const runs=[];for(const color of pixels){if(runs.length&&runs.at(-2)===color)runs[runs.length-1]++;else runs.push(color,1);}
      return {ok:true,...capabilities,kind:'tile',version,x,y,width:256,height:256,...(runs.length<pixels.length?{runs}:{pixels})};
    }
    return request.url.searchParams.get('action')==='snapshot'
      ?{ok:true,...capabilities,kind:'snapshot',version:serverEvents.length,events:structuredClone(serverEvents),pixels:Array.from(serverCore.render(serverEvents))}
      :{ok:true,...capabilities,kind:'delta',version:serverEvents.length,events:structuredClone(serverEvents.slice(Number(request.url.searchParams.get('since'))))};
  }
  const context=vm.createContext({
    crypto:{randomUUID},structuredClone,URL,AbortSignal,TextEncoder,Uint8ClampedArray,
    document:{getElementById:element,addEventListener(){},hidden:false},
    window:{CANVAS_ENDPOINT:endpoint===undefined?'https://script.google.com/macros/s/test/exec':endpoint,addEventListener(){}},
    localStorage:{getItem:()=>null},ResizeObserver:class{observe(){}},
    indexedDB:{open(){const request={};queueMicrotask(()=>{request.result=db;request.onsuccess();});return request;}},
    setInterval(callback){poll=callback;},
    setTimeout(callback){timers.set(++timerId,callback);return timerId;},
    async fetch(url,options){
      const request={url:new URL(url),method:options.method,body:options.body?JSON.parse(options.body):undefined};
      requests.push(request);
      const data=intercept?await intercept(request,server):server(request);
      return {ok:true,json:async()=>data};
    }
  });
  vm.runInContext(fs.readFileSync('web/core.js','utf8'),context);
  await vm.runInContext(fs.readFileSync('web/app.js','utf8'),context);await settle();
  return {
    requests,serverEvents,elements,get stored(){return structuredClone(stored);},
    async poll(){poll();await settle();},
    async flush(){const callbacks=[...timers.values()];timers.clear();for(const callback of callbacks)callback();await settle();},
    async draw(x=15,y=15){
      const canvas=element('canvas');
      canvas.listeners.pointerdown({button:0,preventDefault(){},pointerId:1,clientX:x,clientY:y});
      canvas.listeners.pointerup({pointerId:1,clientX:x+1,clientY:y});await settle();
    }
  };
}

test('queued strokes are sent in ordered batches of 50 after one initial snapshot',async()=>{
  const b=await browser({pending:Array.from({length:120},(_,i)=>stroke(i))});
  assert.deepEqual(b.requests.map(request=>request.method),['GET','POST','POST','POST']);
  assert.deepEqual(b.requests.slice(1).map(request=>request.body.operations.length),[50,50,20]);
  assert.equal(b.serverEvents.length,120);assert.equal(b.stored.pending.length,0);assert.equal(b.stored.version,120);
});
test('operations collected while a request is in flight are sent together immediately afterwards',async()=>{
  const gate=deferred();let first=true;
  const b=await browser({pending:[stroke('initial')],intercept:async(request,server)=>{
    if(request.method==='POST'&&first){first=false;await gate.promise;}return server(request);
  }});
  await b.draw(15);await b.draw(20);await b.draw(25);
  gate.resolve();await settle();
  assert.deepEqual(b.requests.map(request=>request.method),['GET','POST','POST']);
  assert.deepEqual(b.requests.filter(request=>request.body).map(request=>request.body.operations.length),[1,3]);
  assert.equal(b.stored.pending.length,0);assert.equal(b.stored.version,4);
});
test('drawing after sync posts directly and the short collection window groups new strokes',async()=>{
  const b=await browser();b.requests.length=0;
  await b.draw(15);await b.draw(20);await b.draw(25);
  assert.equal(b.requests.length,0);
  await b.flush();
  assert.deepEqual(b.requests.map(request=>request.method),['POST']);
  assert.equal(b.requests[0].body.operations.length,3);assert.equal(b.stored.pending.length,0);
});
test('batch bodies stay within the byte limit without dropping long strokes',async()=>{
  const pending=Array.from({length:40},(_,i)=>({...stroke(i),points:Array.from({length:2000},()=>[255,255])}));
  const b=await browser({pending});
  const posts=b.requests.filter(request=>request.body);
  assert.ok(posts.length>1);
  for(const request of posts)assert.ok(Buffer.byteLength(JSON.stringify(request.body))<=256000);
  assert.equal(b.serverEvents.length,40);assert.equal(b.stored.pending.length,0);
});
test('failed and lost responses preserve pending IDs and retries accept every operation only once',async()=>{
  let fail=true;
  const pending=[stroke('retry-first'),stroke('retry-second')];
  const b=await browser({pending,intercept:async(request,server)=>{
    const result=server(request);
    if(request.method==='POST'&&fail){fail=false;throw Error('response lost');}return result;
  }});
  assert.deepEqual(b.stored.pending.map(op=>op.id),pending.map(op=>op.id));
  assert.equal(b.serverEvents.length,2);
  await b.poll();
  const bodies=b.requests.filter(request=>request.body).map(request=>request.body);
  assert.deepEqual(bodies[0],bodies[1]);
  assert.equal(b.stored.pending.length,0);assert.equal(b.serverEvents.length,2);
});
test('an old GAS deployment continues receiving single operations without extra preflight reads',async()=>{
  const b=await browser({modern:false,pending:[stroke('legacy-first'),stroke('legacy-second')]});
  assert.deepEqual(b.requests.map(request=>request.method),['GET','POST','POST']);
  assert.equal(b.stored.pending.length,0);
  b.requests.length=0;await b.draw();await b.flush();
  assert.deepEqual(b.requests.map(request=>request.method),['POST']);
  assert.equal(b.stored.version,3);
});

test('1024 tiled snapshot expands cached 256 data and maps pointer coordinates to the far edge',async()=>{
  const pending=[stroke('before-expand')];
  const b=await browser({pending,size:1024,tiled:true});
  assert.equal(b.stored.canvasSize,1024);assert.equal(b.elements.get('canvas').width,1024);
  assert.equal(b.elements.get('resolution').textContent,'1024 × 1024');
  assert.equal(b.stored.pending.length,0);assert.equal(b.stored.events[0].id,pending[0].id);
  await b.draw(256,256);await b.flush();
  const last=b.serverEvents.at(-1);assert.equal(last.canvasSize,1024);assert.deepEqual(last.points,[[1023,1023]]);
  assert.equal(b.elements.get('canvas').imageData.data.length,1048576*4);
  for(const request of b.requests)assert.equal(request.url.searchParams.get('client'),'3');
});
test('tiled loading checks all pixels and rejects a mismatched tile version without losing pending data',async()=>{
  const pending=[stroke('unsent-keep')];
  let seeded=false;
  const b=await browser({pending,size:1024,tiled:true,intercept:async(request,server)=>{
    if(!seeded){
      seeded=true;
      server({url:new URL('https://test/?since=0'),body:{...stroke('remote-seed'),author:'author-other',canvasSize:1024,points:[[700,700]]}});
    }
    const result=server(request);
    if(result.kind==='tile')return {...result,version:result.version+1};
    return result;
  }});
  assert.deepEqual(b.stored.pending,pending);assert.equal(b.stored.version,0);assert.equal(b.stored.events.length,0);
  assert.match(b.elements.get('status').textContent,/タイルの更新番号/);
});
test('a reload reconstructs an occupied 1024 tile and keeps a legacy brush clipped to its original area',async()=>{
  let seeded=false;
  const b=await browser({size:1024,tiled:true,intercept:async(request,server)=>{
    if(!seeded){
      seeded=true;
      server({url:new URL('https://test/?since=0'),body:{operations:[
        {...stroke('legacy-edge'),points:[[255,255]],size:64},
        {...stroke('new-edge'),canvasSize:1024,points:[[1023,1023]]}
      ]}});
    }
    return server(request);
  }});
  assert.equal(b.stored.version,2);assert.equal(b.stored.canvasSize,1024);
  assert.equal(b.requests.filter(request=>request.url.searchParams.get('action')==='tile').length,2);
  const image=b.elements.get('canvas').imageData.data;
  assert.equal(image[(255*1024+255)*4],0x33);assert.equal(image[(255*1024+256)*4],0xff);
  assert.equal(image[(1023*1024+1023)*4],0x33);
});
test('a fresh browser-local canvas starts at 1024 while existing 256 data retains its size',async()=>{
  const fresh=await browser({endpoint:'',storedState:null});
  assert.equal(fresh.elements.get('canvas').width,1024);assert.equal(fresh.stored.canvasSize,1024);
  const existing=await browser({endpoint:'',storedState:{author:'author-one',events:[{...stroke('local-old'),version:1}],pending:[],version:1,initialized:false}});
  assert.equal(existing.elements.get('canvas').width,256);
  assert.equal(existing.stored.events[0].id,'operation-local-old');assert.equal(existing.requests.length,0);
});
