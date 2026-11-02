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
function load_(ss){
  const sheet=ss.getSheetByName('履歴');
  if(!sheet || !ss.getSheetByName('Canvas'))throw Error('setupを実行してください');
  const count=sheet.getLastRow()-1;
  if(count<=0)return [];
  return sheet.getRange(2,1,count,6).getValues().map((row,i)=>{
    if(Number(row[0])!==i+1)throw Error('履歴の更新番号が連続していません');
    return Object.assign(JSON.parse(row[5]),{version:Number(row[0])});
  });
}
function materialize_(ss,events){
  const canvas=ss.getSheetByName('Canvas'),version=events.length;
  const pixels=PixelCore.render(events),rows=[];
  for(let y=0;y<256;y++){
    const row=[];for(let x=0;x<256;x++)row.push('#'+pixels[y*256+x].toString(16).padStart(6,'0').toUpperCase());rows.push(row);
  }
  // Write-ahead history is authoritative. Marker is written only after RGB flush.
  canvas.getRange(1,1,256,256).setValues(rows);SpreadsheetApp.flush();
  canvas.getRange(258,1,1,2).setValues([['反映済み更新番号',version]]);SpreadsheetApp.flush();
  return pixels;
}
function repair_(ss,events){
  if(ss.getSheetByName('Canvas').getRange(258,2).getValue()!==events.length)materialize_(ss,events);
}
function json_(obj){return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);}
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
    const ss=book_(),events=load_(ss);repair_(ss,events);
    if(write){
      if(!e.postData || e.postData.contents.length>45000)throw Error('送信データが大きすぎます');
      const op=JSON.parse(e.postData.contents);PixelCore.validate(op);
      // Strip client-supplied fields, including version and active state.
      const clean={id:op.id,author:op.author,type:op.type,target:op.target};
      if(op.type==='stroke')Object.assign(clean,{points:op.points,color:op.color.toUpperCase(),size:op.size});
      const existing=events.find(x=>x.id===op.id);
      if(existing){const comparable=Object.assign({},existing);delete comparable.version;if(JSON.stringify(comparable)!==JSON.stringify(clean))throw Error('操作IDの内容が一致しません');}
      else{
        const accepted=Object.assign({},clean,{version:events.length+1});
        PixelCore.reduce(events.concat(accepted));
        const sheet=ss.getSheetByName('履歴');
        sheet.getRange(sheet.getLastRow()+1,1,1,7).setValues([[accepted.version,accepted.id,accepted.author,accepted.type,accepted.target,JSON.stringify(clean),new Date().toISOString()]]);
        SpreadsheetApp.flush();events.push(accepted);materialize_(ss,events);
      }
      return json_(delta_(events,Number(e.parameter.since)));
    }
    if(e.parameter.action==='updates')return json_(delta_(events,Number(e.parameter.since)));
    const values=ss.getSheetByName('Canvas').getRange(1,1,256,256).getValues();
    return json_({ok:true,kind:'snapshot',version:events.length,events:events,pixels:values.flat().map(x=>parseInt(String(x).slice(1),16))});
  }catch(err){return json_({ok:false,error:String(err.message || err)});}
  finally{lock.releaseLock();}
}
