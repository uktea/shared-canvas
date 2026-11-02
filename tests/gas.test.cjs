const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
function harness(){
  let locked=false,failRGB=false;
  class Sheet {
    constructor(){this.rows=[];this.columns=26;}
    getMaxColumns(){return this.columns;}getMaxRows(){return 1000;}
    insertColumnsAfter(a,n){this.columns+=n;}insertRowsAfter(){}
    appendRow(row){this.rows.push(row);}
    getLastRow(){return this.rows.length;}
    getRange(row,column,height=1,width=1){const sheet=this;return {
      setValues(values){if(failRGB&&height===256){failRGB=false;throw Error('simulated RGB write failure');}for(let y=0;y<height;y++){sheet.rows[row+y-1] ||= [];for(let x=0;x<width;x++)sheet.rows[row+y-1][column+x-1]=values[y][x];}return this;},
      getValues(){return Array.from({length:height},(_,y)=>Array.from({length:width},(_,x)=>sheet.rows[row+y-1]?.[column+x-1] ?? ''));},
      getValue(){return this.getValues()[0][0];}
    };}
  }
  const sheets=new Map(),ss={getSheetByName:n=>sheets.get(n),insertSheet(n){const s=new Sheet();sheets.set(n,s);return s;}};
  const lock={waitLock(){assert.equal(locked,false);locked=true;},tryLock(){assert.equal(locked,false);locked=true;return true;},releaseLock(){locked=false;}};
  const context=vm.createContext({LockService:{getScriptLock:()=>lock},PropertiesService:{getScriptProperties:()=>({getProperty:()=> 'test-sheet-id'})},SpreadsheetApp:{openById:()=>ss,flush(){}},ContentService:{MimeType:{JSON:'json'},createTextOutput:text=>({text,setMimeType(){return this;}})}});
  vm.runInContext(fs.readFileSync('gas/Core.gs','utf8')+'\n'+fs.readFileSync('gas/Code.gs','utf8'),context);
  context.setup();
  return {ss,context,failNextRGB(){failRGB=true;},get(params={}){const r=JSON.parse(context.doGet({parameter:params}).text);assert.equal(locked,false);return r;},post(op,since=0){const r=JSON.parse(context.doPost({parameter:{since:String(since)},postData:{contents:JSON.stringify(op)}}).text);assert.equal(locked,false);return r;}};
}
const stroke=(name,author='author-a',color='#ff0000')=>({id:'operation-'+name,author,type:'stroke',target:'stroke-'+name,points:[[10,10],[12,12]],color,size:1});
const undo=(s,author=s.author)=>({id:'undo-operation-'+s.target,author,type:'undo',target:s.target});
test('setup creates white RGB and versioned snapshot; ordinary polling returns only new events',()=>{
  const h=harness(),initial=h.get();assert.equal(initial.ok,true);assert.equal(initial.pixels.length,65536);assert.equal(initial.version,0);assert.equal(initial.pixels[0],0xffffff);
  const a=stroke('first-one'),b=stroke('second-one','author-b','#0000ff');
  assert.equal(h.post(a).version,1);assert.equal(h.post(b,1).version,2);
  const diff=h.get({action:'updates',since:'1'});assert.equal(diff.events.length,1);assert.equal(diff.events[0].id,b.id);
  const snapshot=h.get();assert.equal(snapshot.version,2);assert.equal(snapshot.pixels[2570],255);
  assert.equal(h.ss.getSheetByName('Canvas').getRange(11,11).getValue(),'#0000FF');
  assert.equal(h.get({action:'updates',since:'999'}).kind,'reset');
});
test('retry is idempotent and an operation ID cannot be reused with different payload',()=>{
  const h=harness(),a=stroke('first-one');h.post(a);const retry=h.post(a);
  assert.equal(retry.ok,true);assert.equal(retry.version,1);assert.equal(h.ss.getSheetByName('履歴').getLastRow(),2);
  assert.equal(h.post({...a,color:'#00ff00'}).ok,false);assert.equal(h.get().version,1);
});
test('WAL repairs RGB after interrupted write without double-accepting retry',()=>{
  const h=harness(),a=stroke('first-one');h.failNextRGB();assert.equal(h.post(a).ok,false);
  assert.equal(h.ss.getSheetByName('Canvas').getRange(258,2).getValue(),0);
  const retry=h.post(a);assert.equal(retry.ok,true);assert.equal(retry.version,1);
  assert.equal(h.get().pixels[2570],0xff0000);assert.equal(h.ss.getSheetByName('履歴').getLastRow(),2);
  assert.equal(h.ss.getSheetByName('Canvas').getRange(258,2).getValue(),1);
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
