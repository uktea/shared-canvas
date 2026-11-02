/* Paste Core.gs (generated from web/core.js) alongside this file. */
const CANVAS_SHEET_='Canvas1024',TILE_SIZE_=256;
function canvasSize_(){return 1024;}
function markerRow_(){return PixelCore.SIZE+2;}
function setup() {
  PixelCore.setSize(canvasSize_());
  if(!PixelCore.raster||!PixelCore.dirtyRegions)throw Error('Core.gsも最新版に更新してください');
  const lock=LockService.getScriptLock(); lock.waitLock(25000);
  try {
    const ss=book_();
    let canvas=ss.getSheetByName(CANVAS_SHEET_);
    if(!canvas)canvas=ss.insertSheet(CANVAS_SHEET_);
    const size=PixelCore.SIZE;
    if(canvas.getMaxColumns()<size)canvas.insertColumnsAfter(canvas.getMaxColumns(),size-canvas.getMaxColumns());
    if(canvas.getMaxRows()<markerRow_())canvas.insertRowsAfter(canvas.getMaxRows(),markerRow_()-canvas.getMaxRows());
    let history=ss.getSheetByName('履歴');
    if(!history){history=ss.insertSheet('履歴');history.appendRow(['更新番号','操作ID','作者ID','種類','対象ID','操作JSON','受付日時']);}
    materialize_(ss,load_(ss));
  } finally {lock.releaseLock();}
}
function book_(){
  const id=PropertiesService.getScriptProperties().getProperty('SPREADSHEET_ID');
  if(!id)throw Error('SPREADSHEET_IDを設定してください');
  return SpreadsheetApp.openById(id);
}
function load_(ss,since,total){
  since=since || 0;
  const sheet=ss.getSheetByName('履歴');
  if(!sheet || !ss.getSheetByName(CANVAS_SHEET_))throw Error('setupを実行してください');
  const count=(total===undefined?sheet.getLastRow()-1:total)-since;
  if(count<=0)return [];
  return sheet.getRange(since+2,1,count,6).getValues().map((row,i)=>{
    if(Number(row[0])!==since+i+1)throw Error('履歴の更新番号が連続していません');
    return Object.assign(JSON.parse(row[5]),{version:Number(row[0])});
  });
}
function materialize_(ss,events,regions){
  const canvas=ss.getSheetByName(CANVAS_SHEET_),size=PixelCore.SIZE,strokes=PixelCore.reduce(events);
  const boxes=regions || [{left:0,top:0,right:size-1,bottom:size-1}];
  const timing={renderMs:0,rgbWriteMs:0,cells:0,ranges:0};
  console.log(JSON.stringify({stage:'rgb_render_write',version:events.length,regions:boxes.length}));
  for(const box of boxes){
    const width=box.right-box.left+1,stripe=Math.max(1,Math.floor(65536/width));
    let started=Date.now();const pixels=PixelCore.raster(strokes,box);timing.renderMs+=Date.now()-started;
    for(let top=box.top;top<=box.bottom;top+=stripe){
      const rows=[];
      for(let y=top;y<=Math.min(box.bottom,top+stripe-1);y++){
        const row=[];for(let x=box.left;x<=box.right;x++)row.push('#'+pixels[(y-box.top)*width+x-box.left].toString(16).padStart(6,'0').toUpperCase());rows.push(row);
      }
      started=Date.now();canvas.getRange(top+1,box.left+1,rows.length,width).setValues(rows);
      timing.rgbWriteMs+=Date.now()-started;timing.cells+=rows.length*width;timing.ranges++;
    }
  }
  console.log(JSON.stringify({stage:'rgb_flush',version:events.length,cells:timing.cells,ranges:timing.ranges}));
  const started=Date.now();SpreadsheetApp.flush();
  canvas.getRange(markerRow_(),1,1,2).setValues([['反映済み更新番号',events.length]]);SpreadsheetApp.flush();
  timing.rgbWriteMs+=Date.now()-started;
  return timing;
}
function applied_(canvas,total){
  const version=canvas.getRange(markerRow_(),2).getValue();
  if(!Number.isInteger(version)||version<0||version>total)throw Error('RGBの初期化が必要です。setupを実行してください');
  return version;
}
function json_(obj){
  return ContentService.createTextOutput(JSON.stringify(Object.assign({protocol:3,revision:4,canvasSize:PixelCore.SIZE,maxBatchOperations:50,maxBatchBytes:256000},obj))).setMimeType(ContentService.MimeType.JSON);
}
function regions_(events,added){
  const strokes=new Map(events.filter(op=>op.type==='stroke').map(op=>[op.target,op]));
  return PixelCore.dirtyRegions(Array.from(new Set(added.map(op=>op.target)),target=>strokes.get(target)));
}
function manifest_(events){
  const tiles=new Map();
  for(const stroke of PixelCore.reduce(events))if(stroke.active){
    const box=PixelCore.bounds(stroke);
    for(let y=Math.floor(box.top/TILE_SIZE_)*TILE_SIZE_;y<=box.bottom;y+=TILE_SIZE_)
      for(let x=Math.floor(box.left/TILE_SIZE_)*TILE_SIZE_;x<=box.right;x+=TILE_SIZE_)tiles.set(x+','+y,[x,y]);
  }
  return {ok:true,kind:'snapshot-manifest',version:events.length,events:events,tileSize:TILE_SIZE_,tiles:Array.from(tiles.values())};
}
function tile_(ss,total,params){
  const version=Number(params.version),x=Number(params.x),y=Number(params.y),size=PixelCore.SIZE;
  if(!Number.isInteger(version)||version<0||version>total||!Number.isInteger(x)||!Number.isInteger(y)||x<0||y<0||x>=size||y>=size||x%TILE_SIZE_||y%TILE_SIZE_)throw Error('タイル指定が不正です');
  const width=Math.min(TILE_SIZE_,size-x),height=Math.min(TILE_SIZE_,size-y);
  // History rows are immutable: GET never waits for a writer or reads half-written RGB.
  const pixels=Array.from(PixelCore.raster(PixelCore.reduce(load_(ss,0,version)),{left:x,top:y,right:x+width-1,bottom:y+height-1}));
  const runs=[];
  for(const color of pixels){if(runs.length&&runs[runs.length-2]===color)runs[runs.length-1]++;else runs.push(color,1);}
  return Object.assign({ok:true,kind:'tile',version:version,x:x,y:y,width:width,height:height},runs.length<pixels.length?{runs:runs}:{pixels:pixels});
}
function accept_(events,payload){
  const operations=payload && Object.prototype.hasOwnProperty.call(payload,'operations')?payload.operations:[payload];
  if(!Array.isArray(operations)||!operations.length||operations.length>50)throw Error('一括送信は1〜50操作にしてください');
  const byId=new Map(events.map(op=>[op.id,op])),added=[];
  for(const op of operations){
    PixelCore.validate(op);
    // Strip client-supplied fields, including version and active state.
    const clean={id:op.id,author:op.author,type:op.type,target:op.target};
    if(op.type==='stroke'){
      Object.assign(clean,{points:op.points,color:op.color.toUpperCase(),size:op.size});
      if(op.canvasSize!==undefined)clean.canvasSize=op.canvasSize;
    }
    if(JSON.stringify(clean).length>45000)throw Error('操作データが大きすぎます');
    const existing=byId.get(clean.id);
    if(existing){
      // Old GAS stripped canvasSize; an explicit 256 is the same legacy stroke.
      const same=['id','author','type','target'].every(key=>existing[key]===clean[key]) &&
        (clean.type!=='stroke'||(String(existing.color).toUpperCase()===clean.color&&existing.size===clean.size&&
          (existing.canvasSize || 256)===(clean.canvasSize || 256)&&JSON.stringify(existing.points)===JSON.stringify(clean.points)));
      if(!same)throw Error('操作IDの内容が一致しません');
    }else{
      const accepted=Object.assign({},clean,{version:events.length+added.length+1});
      added.push(accepted);byId.set(clean.id,accepted);
    }
  }
  // Validate the entire batch before writing any of its operations.
  if(added.length)PixelCore.reduce(events.concat(added));
  return added;
}
function delta_(events,since){
  if(!Number.isInteger(since)||since<0||since>events.length||events.length-since>500)return {ok:true,kind:'reset'};
  return {ok:true,kind:'delta',version:events.length,events:events.slice(since)};
}
function doGet(e){return handle_(e,false);}
function doPost(e){return handle_(e,true);}
function handle_(e,write){
  PixelCore.setSize(canvasSize_());
  const started=Date.now();let lock,acquired=false;
  try{
    if(!PixelCore.raster||!PixelCore.dirtyRegions)throw Error('Core.gsも最新版に更新してください');
    if(PixelCore.SIZE>256&&e.parameter.client!=='3')throw Error('ページを再読み込みしてください');
    if(write){
      lock=LockService.getScriptLock();
      if(!lock.tryLock(100))return json_({ok:false,code:'BUSY',retryAfterMs:2000,error:'書き込み中です。少し待って再送します'});
      acquired=true;
    }
    const lockWaitMs=Date.now()-started,ss=book_(),canvas=ss.getSheetByName(CANVAS_SHEET_),history=ss.getSheetByName('履歴');
    if(!canvas || !history)throw Error('setupを実行してください');
    const total=Math.max(0,history.getLastRow()-1),since=Number(e.parameter.since);
    if(!write){
      if(e.parameter.action==='tile')return json_(tile_(ss,total,e.parameter));
      const appliedVersion=canvas.getRange(markerRow_(),2).getValue();
      if(e.parameter.action==='status')return json_({ok:true,kind:'status',version:total,appliedVersion:appliedVersion});
      if(e.parameter.action==='updates'){
        if(!Number.isInteger(since)||since<0||since>total||total-since>500)return json_({ok:true,kind:'reset'});
        return json_({ok:true,kind:'delta',version:total,appliedVersion:appliedVersion,events:load_(ss,since,total)});
      }
      return json_(Object.assign(manifest_(load_(ss,0,total)),{appliedVersion:appliedVersion}));
    }
    console.log(JSON.stringify({stage:'history_read',version:total}));
    let phase=Date.now();const events=load_(ss,0,total),applied=applied_(canvas,total),historyMs=Date.now()-phase;
    if(!e.postData || e.postData.contents.length>256000)throw Error('送信データが大きすぎます');
    phase=Date.now();const added=accept_(events,JSON.parse(e.postData.contents)),validateMs=Date.now()-phase;
    let logMs=0;
    if(added.length){
      console.log(JSON.stringify({stage:'history_write',operations:added.length}));
      const rows=added.map(op=>{
        const clean=Object.assign({},op);delete clean.version;
        return [op.version,op.id,op.author,op.type,op.target,JSON.stringify(clean),new Date().toISOString()];
      });
      phase=Date.now();const needed=total+1+rows.length,maxRows=history.getMaxRows();
      if(needed>maxRows)history.insertRowsAfter(maxRows,needed-maxRows);
      history.getRange(total+2,1,rows.length,7).setValues(rows);SpreadsheetApp.flush();
      events.push(...added);logMs=Date.now()-phase;
    }
    // Repair only the accepted operations missing from RGB, together with this batch.
    const missing=events.slice(applied);
    phase=Date.now();const regions=missing.length?regions_(events,missing):[],regionMs=Date.now()-phase;
    const rgb=missing.length?materialize_(ss,events,regions):{renderMs:0,rgbWriteMs:0,cells:0,ranges:0};
    const timing=Object.assign({stage:'complete',lockWaitMs,historyMs,validateMs,logMs,regionMs,operations:added.length,totalMs:Date.now()-started},rgb);
    console.log(JSON.stringify(timing));
    return json_(Object.assign(delta_(events,since),{appliedVersion:events.length,timing:timing}));
  }catch(err){return json_({ok:false,error:String(err.message || err)});}
  finally{if(acquired)lock.releaseLock();}
}
