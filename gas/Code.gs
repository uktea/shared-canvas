/* Paste Core.gs (generated from web/core.js) alongside this file. */
function setup() {
  const lock=LockService.getScriptLock(); lock.waitLock(25000);
  try {
    const ss=book_();
    let canvas=ss.getSheetByName('Canvas');
    if(!canvas)canvas=ss.insertSheet('Canvas');
    if(canvas.getMaxColumns()<256)canvas.insertColumnsAfter(canvas.getMaxColumns(),256-canvas.getMaxColumns());
    if(canvas.getMaxRows()<258)canvas.insertRowsAfter(canvas.getMaxRows(),258-canvas.getMaxRows());
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
  if(!sheet || !ss.getSheetByName('Canvas'))throw Error('setupを実行してください');
  const count=(total===undefined?sheet.getLastRow()-1:total)-since;
  if(count<=0)return [];
  return sheet.getRange(since+2,1,count,6).getValues().map((row,i)=>{
    if(Number(row[0])!==since+i+1)throw Error('履歴の更新番号が連続していません');
    return Object.assign(JSON.parse(row[5]),{version:Number(row[0])});
  });
}
function materialize_(ss,events,region){
  const canvas=ss.getSheetByName('Canvas'),version=events.length;
  const pixels=PixelCore.render(events),rows=[];
  const box=region || {left:0,top:0,right:255,bottom:255};
  for(let y=box.top;y<=box.bottom;y++){
    const row=[];for(let x=box.left;x<=box.right;x++)row.push('#'+pixels[y*256+x].toString(16).padStart(6,'0').toUpperCase());rows.push(row);
  }
  // Write-ahead history is authoritative. Marker is written only after RGB flush.
  canvas.getRange(box.top+1,box.left+1,box.bottom-box.top+1,box.right-box.left+1).setValues(rows);SpreadsheetApp.flush();
  canvas.getRange(258,1,1,2).setValues([['反映済み更新番号',version]]);SpreadsheetApp.flush();
  return pixels;
}
function repair_(ss,events){
  if(ss.getSheetByName('Canvas').getRange(258,2).getValue()!==events.length)materialize_(ss,events);
}
function json_(obj){
  return ContentService.createTextOutput(JSON.stringify(Object.assign({protocol:2,maxBatchOperations:50,maxBatchBytes:256000},obj))).setMimeType(ContentService.MimeType.JSON);
}
function region_(events,added){
  const strokes=new Map(events.filter(op=>op.type==='stroke').map(op=>[op.target,op]));
  const box={left:255,top:255,right:0,bottom:0};
  for(const op of added){
    const stroke=strokes.get(op.target),radius=Math.floor(stroke.size/2);
    for(const point of stroke.points){
      box.left=Math.min(box.left,Math.max(0,point[0]-radius));
      box.top=Math.min(box.top,Math.max(0,point[1]-radius));
      box.right=Math.max(box.right,Math.min(255,point[0]+radius));
      box.bottom=Math.max(box.bottom,Math.min(255,point[1]+radius));
    }
  }
  return box;
}
function accept_(events,payload){
  const operations=payload && Object.prototype.hasOwnProperty.call(payload,'operations')?payload.operations:[payload];
  if(!Array.isArray(operations)||!operations.length||operations.length>50)throw Error('一括送信は1〜50操作にしてください');
  const byId=new Map(events.map(op=>[op.id,op])),added=[];
  for(const op of operations){
    PixelCore.validate(op);
    // Strip client-supplied fields, including version and active state.
    const clean={id:op.id,author:op.author,type:op.type,target:op.target};
    if(op.type==='stroke')Object.assign(clean,{points:op.points,color:op.color.toUpperCase(),size:op.size});
    if(JSON.stringify(clean).length>45000)throw Error('操作データが大きすぎます');
    const existing=byId.get(clean.id);
    if(existing){
      const comparable=Object.assign({},existing);delete comparable.version;
      if(JSON.stringify(comparable)!==JSON.stringify(clean))throw Error('操作IDの内容が一致しません');
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
  const lock=LockService.getScriptLock();
  if(!lock.tryLock(25000))return json_({ok:false,error:'混雑しています。再送します'});
  try{
    const ss=book_(),canvas=ss.getSheetByName('Canvas'),history=ss.getSheetByName('履歴');
    if(!canvas || !history)throw Error('setupを実行してください');
    const total=Math.max(0,history.getLastRow()-1),since=Number(e.parameter.since);
    // Up-to-date polling reads only the requested history tail, never the RGB grid.
    if(!write && e.parameter.action==='updates' && canvas.getRange(258,2).getValue()===total){
      if(!Number.isInteger(since)||since<0||since>total||total-since>500)return json_({ok:true,kind:'reset'});
      return json_({ok:true,kind:'delta',version:total,events:load_(ss,since,total)});
    }
    const events=load_(ss,0,total);repair_(ss,events);
    if(write){
      if(!e.postData || e.postData.contents.length>256000)throw Error('送信データが大きすぎます');
      const added=accept_(events,JSON.parse(e.postData.contents));
      if(added.length){
        const rows=added.map(op=>{
          const clean=Object.assign({},op);delete clean.version;
          return [op.version,op.id,op.author,op.type,op.target,JSON.stringify(clean),new Date().toISOString()];
        });
        const needed=total+1+rows.length,maxRows=history.getMaxRows();
        if(needed>maxRows)history.insertRowsAfter(maxRows,needed-maxRows);
        history.getRange(total+2,1,rows.length,7).setValues(rows);
        SpreadsheetApp.flush();events.push(...added);
        materialize_(ss,events,region_(events,added));
      }
      return json_(delta_(events,since));
    }
    if(e.parameter.action==='updates')return json_(delta_(events,Number(e.parameter.since)));
    const values=ss.getSheetByName('Canvas').getRange(1,1,256,256).getValues();
    return json_({ok:true,kind:'snapshot',version:events.length,events:events,pixels:values.flat().map(x=>parseInt(String(x).slice(1),16))});
  }catch(err){return json_({ok:false,error:String(err.message || err)});}
  finally{lock.releaseLock();}
}
