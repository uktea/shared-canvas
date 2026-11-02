const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
function harness({size=256,beforeSetup}={}){
  let locked=false,failRGB=null,contended=false;
  const writes=[],reads=[],lockAttempts=[];
  class Sheet {
    constructor(){this.rows=[];this.columns=26;this.maxRows=1000;}
    getMaxColumns(){return this.columns;}getMaxRows(){return this.maxRows;}
    insertColumnsAfter(a,n){this.columns+=n;}insertRowsAfter(a,n){this.maxRows+=n;}
    appendRow(row){this.rows.push(row);}
    getLastRow(){return this.rows.length;}
    getRange(row,column,height=1,width=1){const sheet=this;return {
      setValues(values){writes.push({sheet:sheet.name,row,column,height,width});if(failRGB!==null&&sheet.name==='Canvas1024'&&row<=size){if(failRGB===0){failRGB=null;throw Error('simulated RGB write failure');}failRGB--;}for(let y=0;y<height;y++){sheet.rows[row+y-1] ||= [];for(let x=0;x<width;x++)sheet.rows[row+y-1][column+x-1]=values[y][x];}return this;},
      getValues(){reads.push({sheet:sheet.name,row,column,height,width});return Array.from({length:height},(_,y)=>Array.from({length:width},(_,x)=>sheet.rows[row+y-1]?.[column+x-1] ?? ''));},
      getValue(){return this.getValues()[0][0];}
    };}
  }
  const sheets=new Map(),ss={getSheetByName:n=>sheets.get(n),insertSheet(n){const s=new Sheet();s.name=n;sheets.set(n,s);return s;}};
  const lock={waitLock(){assert.equal(locked,false);locked=true;},tryLock(timeout){lockAttempts.push(timeout);if(contended)return false;assert.equal(locked,false);locked=true;return true;},releaseLock(){locked=false;}};
  const context=vm.createContext({LockService:{getScriptLock:()=>lock},PropertiesService:{getScriptProperties:()=>({getProperty:()=> 'test-sheet-id'})},SpreadsheetApp:{openById:()=>ss,flush(){}},ContentService:{MimeType:{JSON:'json'},createTextOutput:text=>({text,setMimeType(){return this;}})}});
  vm.runInContext(fs.readFileSync('gas/Core.gs','utf8')+'\n'+fs.readFileSync('gas/Code.gs','utf8'),context);
  // Small fixtures exercise the same protocol; dedicated tests use the full grid.
  context.canvasSize_=()=>size;
  if(beforeSetup)beforeSetup(ss,context);
  context.setup();
  function rawGet(params={}){const r=JSON.parse(context.doGet({parameter:{client:'3',...params}}).text);assert.equal(locked,false);return r;}
  function get(params={}){
    const result=rawGet(params);
    if(result.kind!=='snapshot-manifest')return result;
    const pixels=new Uint32Array(size*size);pixels.fill(0xffffff);
    for(const [x,y] of result.tiles){
      const tile=rawGet({action:'tile',version:String(result.version),x:String(x),y:String(y)});
      assert.equal(tile.ok,true);
      const data=context.PixelCore.unpack(tile,tile.width*tile.height);
      for(let row=0;row<tile.height;row++)pixels.set(data.subarray(row*tile.width,(row+1)*tile.width),(y+row)*size+x);
    }
    return {...result,kind:'snapshot',pixels:Array.from(pixels)};
  }
  return {ss,context,writes,reads,rawGet,get,lockAttempts,canvasPixels(){const sheet=ss.getSheetByName('Canvas1024');return Array.from({length:size*size},(_,i)=>parseInt(String(sheet.rows[Math.floor(i/size)]?.[i%size]).slice(1),16));},setContended(value){contended=value;},failNextRGB(){failRGB=0;},failAfterRGB(count){failRGB=count;},post(op,since=0){const r=JSON.parse(context.doPost({parameter:{client:'3',since:String(since)},postData:{contents:JSON.stringify(op)}}).text);assert.equal(locked,false);return r;}};
}
const stroke=(name,author='author-a',color='#ff0000')=>({id:'operation-'+name,author,type:'stroke',target:'stroke-'+name,points:[[10,10],[12,12]],color,size:1});
const undo=(s,author=s.author)=>({id:'undo-operation-'+s.target,author,type:'undo',target:s.target});
test('setup creates white RGB and versioned snapshot; ordinary polling returns only new events',()=>{
  const h=harness(),initial=h.get();assert.equal(initial.ok,true);assert.equal(initial.pixels.length,65536);assert.equal(initial.version,0);assert.equal(initial.pixels[0],0xffffff);
  const a=stroke('first-one'),b=stroke('second-one','author-b','#0000ff');
  assert.equal(h.post(a).version,1);assert.equal(h.post(b,1).version,2);
  const diff=h.get({action:'updates',since:'1'});assert.equal(diff.events.length,1);assert.equal(diff.events[0].id,b.id);
  const snapshot=h.get();assert.equal(snapshot.version,2);assert.equal(snapshot.pixels[2570],255);
  assert.equal(h.ss.getSheetByName('Canvas1024').getRange(11,11).getValue(),'#0000FF');
  assert.equal(h.get({action:'updates',since:'999'}).kind,'reset');
});
test('retry is idempotent and an operation ID cannot be reused with different payload',()=>{
  const h=harness(),a=stroke('first-one');h.post(a);const retry=h.post(a);
  assert.equal(retry.ok,true);assert.equal(retry.version,1);assert.equal(h.ss.getSheetByName('履歴').getLastRow(),2);
  assert.equal(h.post({...a,color:'#00ff00'}).ok,false);assert.equal(h.get().version,1);
});
test('WAL repairs RGB after interrupted write without double-accepting retry',()=>{
  const h=harness(),a=stroke('first-one');h.failNextRGB();assert.equal(h.post(a).ok,false);
  assert.equal(h.ss.getSheetByName('Canvas1024').getRange(258,2).getValue(),0);
  const retry=h.post(a);assert.equal(retry.ok,true);assert.equal(retry.version,1);
  assert.equal(h.get().pixels[2570],0xff0000);assert.equal(h.ss.getSheetByName('履歴').getLastRow(),2);
  assert.equal(h.ss.getSheetByName('Canvas1024').getRange(258,2).getValue(),1);
});
test('server rejects another author Undo and maintains original ordering through Redo',()=>{
  const h=harness(),a=stroke('first-one'),b=stroke('second-one','author-b','#0000ff');h.post(a);h.post(b);
  assert.equal(h.post(undo(a,'author-b')).ok,false);assert.equal(h.get().version,2);
  assert.equal(h.post(undo(a)).ok,true);assert.equal(h.get().pixels[2570],255);
  assert.equal(h.post({id:'redo-operation-one',author:a.author,target:a.target,type:'redo'}).ok,true);
  assert.equal(h.get().pixels[2570],255);assert.equal(h.get().version,4);
});
test('invalid data has no history side effect and setup can recover without clearing history',()=>{
  const h=harness(),a=stroke('first-one');assert.equal(h.post({...a,points:[[-1,0]]}).ok,false);assert.equal(h.get().version,0);
  h.post(a);h.context.setup();assert.equal(h.get().version,1);assert.equal(h.get().pixels[2570],0xff0000);
});

test('batch saves ordered strokes and Undo/Redo in one history write and one bounded RGB write',()=>{
  const h=harness(),a=stroke('batch-first'),b=stroke('batch-second','author-b','#0000ff');
  const operations=[a,b,undo(a),{id:'redo-batch-operation',author:a.author,target:a.target,type:'redo'}];
  h.writes.length=0;
  const result=h.post({operations});
  assert.equal(result.ok,true);assert.equal(result.version,4);assert.equal(result.protocol,3);
  assert.deepEqual(result.events.map(op=>op.version),[1,2,3,4]);
  assert.equal(h.writes.filter(write=>write.sheet==='履歴').length,1);
  const rgb=h.writes.filter(write=>write.sheet==='Canvas1024'&&write.row<=256);
  assert.equal(rgb.length,1);assert.equal(rgb[0].height*rgb[0].width,9);
  assert.equal(h.get().pixels[2570],0x0000ff);
  assert.equal(h.ss.getSheetByName('Canvas1024').getRange(258,2).getValue(),4);
});
test('batch retries deduplicate an accepted prefix and duplicates inside the same request',()=>{
  const h=harness(),a=stroke('batch-first'),b=stroke('batch-second');
  h.post(a);h.writes.length=0;
  const result=h.post({operations:[a,b,b]});
  assert.equal(result.ok,true);assert.equal(result.version,2);
  assert.equal(h.ss.getSheetByName('履歴').getLastRow(),3);
  h.writes.length=0;
  assert.equal(h.post({operations:[a,b]}).version,2);
  assert.equal(h.writes.length,0);
});
test('invalid batch suffix and conflicting duplicate IDs leave the whole batch unaccepted',()=>{
  const h=harness(),a=stroke('batch-first'),b=stroke('batch-second');
  assert.equal(h.post({operations:[a,{...b,size:65}]}).ok,false);
  assert.equal(h.post({operations:[a,undo(a,'author-b')]}).ok,false);
  assert.equal(h.post({operations:[a,{...a,color:'#00ff00'}]}).ok,false);
  assert.equal(h.get().version,0);assert.equal(h.ss.getSheetByName('履歴').getLastRow(),1);
  for(const operations of [[],Array(51).fill(a),null])assert.equal(h.post({operations}).ok,false);
});
test('interrupted regional write repairs the full image before retry without duplicating a batch',()=>{
  const h=harness(),operations=[stroke('batch-first'),stroke('batch-second','author-b','#0000ff')];
  h.failNextRGB();assert.equal(h.post({operations}).ok,false);
  assert.equal(h.ss.getSheetByName('Canvas1024').getRange(258,2).getValue(),0);
  const result=h.post({operations});assert.equal(result.ok,true);assert.equal(result.version,2);
  assert.equal(h.ss.getSheetByName('履歴').getLastRow(),3);
  const snapshot=h.get();
  assert.deepEqual(h.canvasPixels(),Array.from(h.context.PixelCore.render(snapshot.events)));
});
test('regional updates equal full replay for clipped brushes, distant strokes, Undo and Redo',()=>{
  const h=harness();
  const a={...stroke('edge-first'),points:[[0,0],[25,20]],size:64};
  const b={...stroke('edge-second','author-b','#0000ff'),points:[[255,255],[5,5]],size:4};
  const c={...stroke('edge-third'),points:[[7,20],[9,40]],size:3};
  for(const operations of [[a,b],[undo(a)],[{id:'redo-edge-operation',author:a.author,target:a.target,type:'redo'},c],[undo(c)]]){
    assert.equal(h.post({operations}).ok,true);
    const snapshot=h.get();
    assert.deepEqual(h.canvasPixels(),Array.from(h.context.PixelCore.render(snapshot.events)));
  }
});
test('normal polling reads only the missing history tail and never the RGB grid',()=>{
  const h=harness();h.post({operations:[stroke('poll-first'),stroke('poll-second'),stroke('poll-third')]});
  h.reads.length=0;
  const result=h.get({action:'updates',since:'2'});
  assert.equal(result.version,3);assert.equal(result.events.length,1);assert.equal(result.events[0].version,3);
  assert.deepEqual(h.reads,[{sheet:'Canvas1024',row:258,column:2,height:1,width:1},{sheet:'履歴',row:4,column:1,height:1,width:6}]);
  h.reads.length=0;
  assert.equal(h.get({action:'updates',since:'3'}).events.length,0);
  assert.equal(h.reads.length,1);
});

test('1024 setup preserves the original sheet, history, IDs and clipped legacy picture',()=>{
  const legacy={...stroke('legacy-edge'),points:[[255,255]],size:64};
  let backup;
  const h=harness({size:1024,beforeSetup(ss){
    const original=ss.insertSheet('Canvas');original.getRange(258,1,1,2).setValues([['反映済み更新番号',1]]);
    original.getRange(1,1).setValues([['#123456']]);backup=structuredClone(original.rows);
    const history=ss.insertSheet('履歴');history.appendRow(['更新番号','操作ID','作者ID','種類','対象ID','操作JSON','受付日時']);
    history.appendRow([1,legacy.id,legacy.author,legacy.type,legacy.target,JSON.stringify(legacy),'legacy-time']);
  }});
  assert.deepEqual(h.ss.getSheetByName('Canvas').rows,backup);
  assert.equal(h.ss.getSheetByName('履歴').getLastRow(),2);
  const image=h.get();assert.equal(image.canvasSize,1024);assert.equal(image.version,1);
  assert.equal(image.pixels[255*1024+255],0xff0000);assert.equal(image.pixels[255*1024+256],0xffffff);
  assert.equal(image.pixels[256*1024+255],0xffffff);
  assert.deepEqual(h.canvasPixels(),image.pixels);
  assert.equal(h.post({...legacy,canvasSize:256}).ok,true);
  assert.equal(h.ss.getSheetByName('履歴').getLastRow(),2);
  assert.equal(h.ss.getSheetByName('Canvas1024').getRange(1026,2).getValue(),1);
  for(const write of h.writes.filter(w=>w.sheet==='Canvas1024'&&w.row<=1024))assert.ok(write.height*write.width<=65536);
});
test('1024 strokes reach the far corner, preserve overlap on Undo/Redo and load only occupied tiles',()=>{
  const h=harness({size:1024});
  const a={...stroke('large-corner'),canvasSize:1024,points:[[1000,1000],[1023,1023]],size:4};
  const b={...stroke('large-overlap','author-b','#0000ff'),canvasSize:1024,points:[[1023,1023]]};
  assert.equal(h.post({operations:[a,b,undo(a)]}).ok,true);
  assert.equal(h.post({id:'redo-large-corner',target:a.target,author:a.author,type:'redo'}).ok,true);
  h.reads.length=0;
  const manifest=h.rawGet();assert.equal(manifest.kind,'snapshot-manifest');assert.deepEqual(manifest.tiles,[[768,768]]);
  assert.ok(h.reads.every(read=>read.sheet!=='Canvas1024'||read.row>1024));
  const snapshot=h.get();assert.equal(snapshot.pixels.length,1048576);assert.equal(snapshot.pixels.at(-1),0x0000ff);
  assert.deepEqual(h.canvasPixels(),Array.from(h.context.PixelCore.render(snapshot.events)));
  assert.equal(h.post({...a,id:'invalid-large-edge',target:'invalid-large-target',points:[[1024,1023]]}).ok,false);
});
test('tiles keep the requested snapshot version during concurrent changes and validate coordinates',()=>{
  const h=harness({size:1024}),a={...stroke('tile-first'),canvasSize:1024,points:[[300,300]]};
  h.post(a);const manifest=h.rawGet();
  h.post({...stroke('tile-second','author-b','#0000ff'),canvasSize:1024,points:[[300,300]]});
  const tile=h.rawGet({action:'tile',version:String(manifest.version),x:'256',y:'256'});
  assert.equal(tile.version,1);assert.equal(h.context.PixelCore.unpack(tile,65536)[44*256+44],0xff0000);
  const current=h.rawGet({action:'tile',version:'2',x:'256',y:'256'});
  assert.equal(h.context.PixelCore.unpack(current,65536)[44*256+44],0x0000ff);
  for(const patch of [{version:'3'},{x:'1024'},{x:'-256'},{x:'1'},{y:'1.5'}]){
    assert.equal(h.rawGet({action:'tile',version:'2',x:'256',y:'256',...patch}).ok,false);
  }
  const oldClient=JSON.parse(h.context.doGet({parameter:{action:'snapshot'}}).text);
  assert.equal(oldClient.ok,false);assert.match(oldClient.error,/再読み込み/);
});

test('a partially written 1024 stripe set is repaired before a batch retry is acknowledged',()=>{
  const h=harness({size:1024}),a={...stroke('stripe-recovery'),canvasSize:1024,points:[[0,0],[1023,1023]]};
  h.failAfterRGB(2);
  assert.equal(h.post({operations:[a]}).ok,false);
  const canvas=h.ss.getSheetByName('Canvas1024');
  assert.equal(canvas.getRange(1026,2).getValue(),0);
  assert.equal(canvas.getRange(1024,1024).getValue(),'#FFFFFF');
  assert.equal(h.post({operations:[a]}).ok,true);
  assert.equal(h.ss.getSheetByName('履歴').getLastRow(),2);
  assert.equal(canvas.getRange(1026,2).getValue(),1);
  assert.equal(canvas.getRange(1024,1024).getValue(),'#FF0000');
  const snapshot=h.get();assert.deepEqual(h.canvasPixels(),Array.from(h.context.PixelCore.render(snapshot.events)));
});

test('busy writes return immediately while GETs read committed history without taking the lock',()=>{
  const h=harness(),a=stroke('busy-original');h.post(a);h.setContended(true);h.lockAttempts.length=0;
  assert.equal(h.get({action:'updates',since:'0'}).events.length,1);
  assert.equal(h.rawGet().version,1);
  assert.equal(h.rawGet({action:'tile',version:'1',x:'0',y:'0'}).ok,true);
  assert.equal(h.rawGet({action:'status'}).appliedVersion,1);
  assert.equal(h.lockAttempts.length,0);
  const result=h.post(stroke('busy-rejected'));
  assert.equal(result.ok,false);assert.equal(result.code,'BUSY');assert.equal(result.retryAfterMs,2000);
  assert.deepEqual(h.lockAttempts,[100]);assert.equal(h.ss.getSheetByName('履歴').getLastRow(),2);
});
test('unapplied history remains readable without triggering RGB repair on a GET',()=>{
  const h=harness(),a=stroke('read-during-repair');h.failNextRGB();assert.equal(h.post(a).ok,false);
  h.writes.length=0;h.lockAttempts.length=0;h.setContended(true);
  const result=h.get({action:'updates',since:'0'});
  assert.equal(result.version,1);assert.equal(result.appliedVersion,0);assert.equal(result.events[0].id,a.id);
  assert.equal(h.get().pixels[2570],0xff0000);
  assert.equal(h.writes.length,0);assert.equal(h.lockAttempts.length,0);
  h.setContended(false);const retry=h.post(a);
  assert.equal(retry.ok,true);assert.equal(retry.appliedVersion,1);
  assert.equal(h.ss.getSheetByName('履歴').getLastRow(),2);
});
test('distant strokes write two small patches instead of their million-cell bounding rectangle',()=>{
  const h=harness({size:1024});h.writes.length=0;
  const operations=[{...stroke('distant-first'),canvasSize:1024,points:[[0,0]]},
    {...stroke('distant-second','author-b','#0000ff'),canvasSize:1024,points:[[1023,1023]]}];
  const result=h.post({operations});assert.equal(result.ok,true);
  const writes=h.writes.filter(write=>write.sheet==='Canvas1024'&&write.row<=1024);
  assert.equal(writes.reduce((total,write)=>total+write.width*write.height,0),2);
  assert.equal(result.timing.cells,2);assert.equal(result.timing.ranges,2);
  const snapshot=h.get();assert.deepEqual(h.canvasPixels(),Array.from(h.context.PixelCore.render(snapshot.events)));
});
