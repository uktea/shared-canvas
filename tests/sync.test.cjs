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
async function browser({pending=[],modern=true,initialized=false,intercept}={}){
  let stored={author:'author-one',events:[],pending:structuredClone(pending),version:0,initialized};
  const elements=new Map(),requests=[],serverEvents=[],timers=new Map();
  let poll,timerId=0;
  function element(id){
    if(!elements.has(id))elements.set(id,{
      value:({color:'#333333',size:'1',zoom:'fit'})[id]||'',style:{},clientWidth:800,clientHeight:600,
      listeners:{},addEventListener(name,callback){this.listeners[name]=callback;},
      getContext(){return {createImageData:()=>({data:new Uint8ClampedArray(256*256*4)}),putImageData(){}};},
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
        C.reduce(serverEvents.concat(accepted));serverEvents.push(accepted);
      }
    }
    const capabilities=modern?{protocol:2,maxBatchOperations:50,maxBatchBytes:256000}:{};
    return request.url.searchParams.get('action')==='snapshot'
      ?{ok:true,...capabilities,kind:'snapshot',version:serverEvents.length,events:structuredClone(serverEvents),pixels:Array.from(C.render(serverEvents))}
      :{ok:true,...capabilities,kind:'delta',version:serverEvents.length,events:structuredClone(serverEvents.slice(Number(request.url.searchParams.get('since'))))};
  }
  const context=vm.createContext({
    PixelCore:C,crypto:{randomUUID},structuredClone,URL,AbortSignal,TextEncoder,Uint8ClampedArray,
    document:{getElementById:element,addEventListener(){},hidden:false},
    window:{CANVAS_ENDPOINT:'https://script.google.com/macros/s/test/exec',addEventListener(){}},
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
  await vm.runInContext(fs.readFileSync('web/app.js','utf8'),context);await settle();
  return {
    requests,serverEvents,elements,get stored(){return structuredClone(stored);},
    async poll(){poll();await settle();},
    async flush(){const callbacks=[...timers.values()];timers.clear();for(const callback of callbacks)callback();await settle();},
    async draw(x=15){
      const canvas=element('canvas');
      canvas.listeners.pointerdown({button:0,preventDefault(){},pointerId:1,clientX:x,clientY:15});
      canvas.listeners.pointerup({pointerId:1,clientX:x+1,clientY:15});await settle();
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
