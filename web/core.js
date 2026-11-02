/* Shared verbatim with Apps Script. Coordinates are integer pixel centers. */
(function (root) {
  'use strict';
  let SIZE = 256;
  const WHITE = 0xffffff;
  function setSize(size){
    if(![256,512,1024].includes(size))throw Error('キャンバスサイズが不正です');
    SIZE=size;
  }
  function validate(op) {
    const id = x => typeof x === 'string' && /^[a-zA-Z0-9_-]{8,100}$/.test(x);
    if (!op || !id(op.id) || !id(op.author) || !id(op.target)) throw Error('操作IDが不正です');
    if (!['stroke','undo','redo'].includes(op.type)) throw Error('操作の種類が不正です');
    if (op.type === 'stroke') {
      const extent=op.canvasSize===undefined?256:op.canvasSize;
      if(![256,512,1024].includes(extent)||extent>SIZE)throw Error('ストロークの描画範囲が不正です');
      if (!/^#[0-9a-fA-F]{6}$/.test(op.color) || !Number.isInteger(op.size) || op.size < 1 || op.size > 64) throw Error('ブラシ設定が不正です');
      if (!Array.isArray(op.points) || !op.points.length || op.points.length > 2000) throw Error('座標数が不正です');
      for (const xy of op.points) if (!Array.isArray(xy) || xy.length !== 2 || !xy.every(n => Number.isInteger(n) && n >= 0 && n < extent)) throw Error('座標が不正です');
    }
  }
  function reduce(events) {
    const strokes = [], byId = new Map();
    for (const e of events) {
      if (e.type === 'stroke') {
        if (byId.has(e.target)) throw Error('ストロークIDが重複しています');
        for (const s of strokes) if (s.author === e.author && !s.active) s.redoable = false;
        const s = {...e, active:true, redoable:false, order:e.version || strokes.length + 1};
        strokes.push(s); byId.set(s.target,s);
      } else {
        const s = byId.get(e.target);
        if (!s || s.author !== e.author) throw Error('自分のストロークだけを操作できます');
        if (e.type === 'undo') {
          const last = strokes.filter(x => x.author === e.author && x.active).at(-1);
          if (s !== last) throw Error('Undo対象が最新ではありません');
          s.active = false; s.redoable = true; s.undoOrder = e.version || events.indexOf(e) + 1;
        } else if (e.type === 'redo') {
          const last = strokes.filter(x => x.author === e.author && !x.active && x.redoable).sort((a,b)=>b.undoOrder-a.undoOrder)[0];
          if (s !== last) throw Error('Redo対象が有効ではありません');
          s.active = true; s.redoable = false;
        }
      }
    }
    return strokes;
  }
  function paint(pixels, s) {
    const color = parseInt(s.color.slice(1),16), radius = s.size / 2, r = Math.floor(radius);
    const extent=Math.min(SIZE,s.canvasSize || 256);
    function stamp(x,y) {
      for (let dy=-r;dy<=r;dy++) for (let dx=-r;dx<=r;dx++) {
        if (dx*dx+dy*dy > radius*radius) continue;
        const px=x+dx, py=y+dy;
        if (px>=0 && px<extent && py>=0 && py<extent) pixels[py*SIZE+px]=color;
      }
    }
    stamp(...s.points[0]);
    for (let i=1;i<s.points.length;i++) {
      let [x,y]=s.points[i-1]; const [tx,ty]=s.points[i];
      const dx=Math.abs(tx-x), dy=-Math.abs(ty-y), sx=x<tx?1:-1, sy=y<ty?1:-1;
      let err=dx+dy;
      while(x!==tx || y!==ty) {
        const twice=2*err;
        if(twice>=dy){err+=dy;x+=sx;}
        if(twice<=dx){err+=dx;y+=sy;}
        stamp(x,y);
      }
    }
  }
  function render(events) {
    const pixels=new Uint32Array(SIZE*SIZE); pixels.fill(WHITE);
    for(const s of reduce(events)) if(s.active) paint(pixels,s);
    return pixels;
  }
  function targets(events,author) {
    const mine=reduce(events).filter(s=>s.author===author);
    return {undo:mine.filter(s=>s.active).at(-1)?.target,
      redo:mine.filter(s=>!s.active && s.redoable).sort((a,b)=>b.undoOrder-a.undoOrder)[0]?.target};
  }
  function bounds(s){
    const extent=Math.min(SIZE,s.canvasSize || 256),r=Math.floor(s.size/2);
    const xs=s.points.map(p=>p[0]),ys=s.points.map(p=>p[1]);
    return {left:Math.max(0,Math.min(...xs)-r),top:Math.max(0,Math.min(...ys)-r),
      right:Math.min(extent-1,Math.max(...xs)+r),bottom:Math.min(extent-1,Math.max(...ys)+r)};
  }
  function unpack(data,length){
    if(Array.isArray(data.pixels)){
      if(data.pixels.length!==length||data.pixels.some(p=>!Number.isInteger(p)||p<0||p>WHITE))throw Error('画素データが不正です');
      return Uint32Array.from(data.pixels);
    }
    if(!Array.isArray(data.runs)||data.runs.length%2)throw Error('圧縮画素データが不正です');
    const pixels=new Uint32Array(length);let offset=0;
    for(let i=0;i<data.runs.length;i+=2){
      const color=data.runs[i],count=data.runs[i+1];
      if(!Number.isInteger(color)||color<0||color>WHITE||!Number.isInteger(count)||count<=0||offset+count>length)throw Error('圧縮画素データが不正です');
      pixels.fill(color,offset,offset+count);offset+=count;
    }
    if(offset!==length)throw Error('画素データが不足しています');
    return pixels;
  }
  root.PixelCore={get SIZE(){return SIZE},WHITE,setSize,validate,reduce,paint,render,targets,bounds,unpack};
})(globalThis);
