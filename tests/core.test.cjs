const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
require('../web/core.js');
const C=globalThis.PixelCore;
const stroke=(name,author='author-a',color='#FF0000',points=[[10,10]],size=1)=>({id:'op-'+name,target:'stroke-'+name,author,type:'stroke',color,points,size});
const action=(type,target,author='author-a',suffix=type)=>({id:'operation-'+suffix,target,author,type});
test('browser and GAS rasterizers are identical source and results',()=>{
  assert.equal(fs.readFileSync('web/core.js','utf8'),fs.readFileSync('gas/Core.gs','utf8'));
  const context=vm.createContext({});vm.runInContext(fs.readFileSync('gas/Core.gs','utf8'),context);
  let seed=19;const random=()=>{seed=(seed*1664525+1013904223)>>>0;return seed%256;};
  const events=Array.from({length:20},(_,i)=>stroke('random-'+i,'author-a','#18AB42',Array.from({length:30},()=>[random(),random()]),i%64+1));
  assert.deepEqual(Array.from(C.render(events)),Array.from(context.PixelCore.render(events)));
});
test('single point, clipping, and interpolated diagonal have deterministic coverage',()=>{
  const pixels=C.render([stroke('one-point')]);assert.equal(pixels[10*256+10],0xFF0000);assert.equal(pixels[10*256+11],C.WHITE);
  const diagonal=C.render([stroke('diagonal','author-a','#333333',[[0,0],[255,255]])]);
  for(let i=0;i<256;i++)assert.equal(diagonal[i*256+i],0x333333);
  const edge=C.render([stroke('edge-case','author-a','#000000',[[0,0]],64)]);
  assert.equal(edge[0],0);assert.equal(edge[32],0);assert.equal(edge[33],C.WHITE);assert.equal(edge[255],C.WHITE);
});
test('Undo/Redo of older author preserves later overlapping stroke',()=>{
  const a=stroke('red-line'),b=stroke('blue-line','author-b','#0000FF');
  const undo=action('undo',a.target),redo=action('redo',a.target);
  for(const events of [[a,b],[a,b,undo],[a,b,undo,redo]])assert.equal(C.render(events)[2570],0x0000FF);
  assert.equal(C.reduce([a,b,undo,redo])[0].order,1);
});
test('Redo stack uses Undo order, and new stroke discards only own Redo',()=>{
  const a=stroke('first-one'),b=stroke('second-one'),other=stroke('other-one','author-b');
  const events=[a,b,other,action('undo',b.target),action('undo',a.target,'author-a','undo-second'),action('undo',other.target,'author-b','undo-other')];
  assert.equal(C.targets(events,'author-a').redo,a.target);
  events.push(action('redo',a.target));assert.equal(C.targets(events,'author-a').redo,b.target);
  events.push(stroke('new-stroke'));assert.equal(C.targets(events,'author-a').redo,undefined);
  assert.equal(C.targets(events,'author-b').redo,other.target);
});
test('other authors, stale Undo, reused stroke IDs, and abandoned Redo are rejected',()=>{
  const a=stroke('first-one'),b=stroke('second-one');
  assert.throws(()=>C.reduce([a,action('undo',a.target,'author-b')]));
  assert.throws(()=>C.reduce([a,b,action('undo',a.target)]));
  assert.throws(()=>C.reduce([a,a]));
  assert.throws(()=>C.reduce([a,action('undo',a.target),b,action('redo',a.target)]));
});
test('invalid and oversized data is rejected before rasterization',()=>{
  C.validate(stroke('valid-one'));
  for(const patch of [{points:[]},{points:[[256,0]]},{points:[[0.5,2]]},{size:0},{size:65},{color:'red'},{type:'erase'},{points:Array(2001).fill([1,1])}])assert.throws(()=>C.validate({...stroke('invalid-one'),...patch}));
});
test('1024 browser and GAS renderers match at distant edges while legacy strokes stay clipped',()=>{
  const browser=vm.createContext({}),gas=vm.createContext({});
  vm.runInContext(fs.readFileSync('web/core.js','utf8'),browser);vm.runInContext(fs.readFileSync('gas/Core.gs','utf8'),gas);
  for(const context of [browser,gas])context.PixelCore.setSize(1024);
  const events=[stroke('legacy-edge','author-a','#FF0000',[[255,255]],64),
    {...stroke('large-diagonal','author-b','#123456',[[300,700],[1023,1023]],5),canvasSize:1024}];
  for(const event of events)browser.PixelCore.validate(event);
  const pixels=browser.PixelCore.render(events);
  assert.equal(pixels.length,1048576);assert.equal(pixels[255*1024+255],0xff0000);
  assert.equal(pixels[255*1024+256],C.WHITE);assert.equal(pixels.at(-1),0x123456);
  assert.deepEqual(Array.from(pixels),Array.from(gas.PixelCore.render(events)));
  assert.throws(()=>browser.PixelCore.setSize(2048));
  assert.throws(()=>browser.PixelCore.validate({...events[1],points:[[1024,0]]}));
});
test('tile decoding accepts compact runs and rejects corrupt, overflowing and incomplete data',()=>{
  assert.deepEqual(Array.from(C.unpack({runs:[0xffffff,3,0x123456,2]},5)),[0xffffff,0xffffff,0xffffff,0x123456,0x123456]);
  assert.deepEqual(Array.from(C.unpack({pixels:[0,1,2]},3)),[0,1,2]);
  for(const data of [{runs:[0,6]},{runs:[0,-1]},{runs:[0,0]},{runs:[0,4]},{runs:[0,5,1]},
    {runs:[-1,5]},{runs:[0x1000000,5]},{pixels:[0,1]},{pixels:[0,1,2,3,-1]}])assert.throws(()=>C.unpack(data,5));
});
