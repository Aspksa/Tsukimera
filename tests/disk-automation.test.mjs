import {test} from "node:test";
import assert from "node:assert/strict";
import {mkdtemp,readdir,rm,readFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join,resolve} from "node:path";
import {fileURLToPath,pathToFileURL} from "node:url";
import {DatabaseSync} from "node:sqlite";
import {createAppServer} from "../scripts/server.mjs";
import {prepareDisk} from "../scripts/build-disk.mjs";

const root=resolve(fileURLToPath(new URL("../",import.meta.url)));
const H={"Content-Type":"application/json","X-Tsukimera-Request":"1"};
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function start(dir){
  const app=createAppServer({root,dataDir:dir});
  await app.load();
  await new Promise(resolve=>app.server.listen(0,"127.0.0.1",resolve));
  return {app,url:"http://127.0.0.1:"+app.server.address().port,
    close:()=>new Promise(resolve=>app.server.close(resolve))};
}
async function api(url,path,method="GET",value,headers=H){
  const res=await fetch(url+path,{method,headers,body:value===undefined?undefined:
    method==="POST"&&path.includes("binary")?value:JSON.stringify(value)});
  return {status:res.status,result:await res.json()};
}
async function upload(url,name,text,folder=""){
  const response=await fetch(url+"/api/disk/files/binary?name="+encodeURIComponent(name)+
    "&folder="+encodeURIComponent(folder),{
      method:"POST",headers:{"Content-Type":"application/octet-stream","X-Tsukimera-Request":"1"},
      body:Buffer.from(text,"utf8")});
  const value=await response.json();
  assert.equal(response.status,201,JSON.stringify(value));return value;
}
async function poll(task,timeout=9000){
  const t=Date.now();let value;
  while(Date.now()-t<timeout){
    value=await task();if(value)return value;await sleep(130);
  }
  assert.fail("Background job timeout: "+JSON.stringify(value));
}

test("SQLite v3 updates only touched files, preserves metadata and notes, survives restart",async()=>{
  const dir=await mkdtemp(join(tmpdir(),"tsukimera-delta-"));
  try{
    const s=await start(dir);let a,b;
    try{
      assert.equal((await api(s.url,"/api/disk/folders","POST",{name:"Работа"})).status,201);
      a=await upload(s.url,"Один.txt","Работа и договоры, документ первый.","Работа");
      b=await upload(s.url,"Два.txt","Отдельный текст второго документа.","Работа");
      assert.equal((await api(s.url,"/api/disk/metadata","POST",{id:a.id,tags:["важно"],note:"Исправить"})).status,200);
      const db=new DatabaseSync(join(dir,"tsukimera.db"));
      try{
        assert.equal(db.prepare("SELECT value FROM metadata WHERE key='schema_version'").get().value,"3");
        assert.equal(db.prepare("SELECT count(*) AS n FROM disk_entries").get().n,2);
        const original=db.prepare("SELECT data FROM disk_entries WHERE id=?").get(b.id).data;
        let changedCount=0;
        db.exec("CREATE TABLE temp_changes(id TEXT)");
        db.exec("CREATE TRIGGER log_touch AFTER UPDATE ON disk_entries BEGIN INSERT INTO temp_changes(id) VALUES(new.id); END");
        const renamed=await api(s.url,"/api/disk/files/"+a.id,"PATCH",{name:"Переименован.txt"});
        assert.equal(renamed.status,200,JSON.stringify(renamed.result));
        assert.equal(db.prepare("SELECT count(*) AS n FROM temp_changes").get().n,1,
          "A one-file edit must update exactly one normalized catalogue row");
        assert.equal(db.prepare("SELECT id FROM temp_changes").get().id,a.id);
        assert.equal(db.prepare("SELECT data FROM disk_entries WHERE id=?").get(b.id).data,original,
          "Untouched file metadata must not be rewritten");
        assert.equal(db.prepare("SELECT name FROM disk_files WHERE id=?").get(a.id).name,"Переименован.txt");
        assert.equal(db.prepare("SELECT json_extract(data,'$.tags[0]') AS tag FROM disk_entries WHERE id=?").get(a.id).tag,"важно");
        const snapshot=db.prepare("SELECT data FROM disk_state WHERE id=1").get();
        assert.equal(snapshot,undefined,"A fresh v3 database must not accumulate full-index JSON copies");
      }finally{db.close();}
    }finally{await s.close();}
    const reopened=await start(dir);
    try{
      const listed=(await api(reopened.url,"/api/disk")).result;
      assert.equal(listed.files.length,2);
      assert.equal(listed.files.find(x=>x.id===a.id).name,"Переименован.txt");
      assert.equal(listed.files.find(x=>x.id===b.id).name,"Два.txt");
      assert.deepEqual(listed.files.find(x=>x.id===a.id).tags,["важно"]);
      assert.ok(listed.folders.includes("Работа"));
      const diagnose=(await api(reopened.url,"/api/storage/diagnostics")).result;
      assert.equal(diagnose.integrity,"ok");
      assert.equal(diagnose.schema,"3");
    }finally{await reopened.close();}
  }finally{await rm(dir,{recursive:true,force:true});}
});

test("existing v2 disk_state migrates safely to indexed v3 and backs up original SQLite",async()=>{
  const dir=await mkdtemp(join(tmpdir(),"tsukimera-v2migration-"));
  try{
    let s=await start(dir);
    let doc;
    try{
      assert.equal((await api(s.url,"/api/disk/folders","POST",{name:"Архив"})).status,201);
      doc=await upload(s.url,"Старый.txt","История сохранена","Архив");
      const settings=await api(s.url,"/api/disk/metadata","POST",{id:doc.id,tags:["история"]});
      assert.equal(settings.status,200);
      const state=s.app.getDisk().lifeSource();
      // Use the full catalogue shape rather than the analytics-only projection.
      const exported=(await api(s.url,"/api/disk/snapshot")).result;
      const current=new DatabaseSync(join(dir,"tsukimera.db"),{readOnly:true});
      let legacy;
      try{
        const normalized=current.prepare("SELECT data FROM disk_meta WHERE id=1").get();
        legacy={...JSON.parse(normalized.data),
          entries:current.prepare("SELECT data FROM disk_entries").all().map(x=>JSON.parse(x.data)),versions:{}};
        for(const r of current.prepare("SELECT * FROM disk_versions").all()){
          (legacy.versions[r.file_id]??=[]).push({
            revision:r.revision,objectId:r.object_id,size:r.size,sha256:r.sha256,at:r.at});
        }
      }finally{current.close();}
      await s.close();
      const old=new DatabaseSync(join(dir,"tsukimera.db"));
      try{
        old.prepare("INSERT INTO disk_state(id,data) VALUES(1,?)").run(JSON.stringify(legacy));
        old.exec("DROP TABLE disk_meta; DROP TABLE disk_entries;");
        old.prepare("UPDATE metadata SET value='2' WHERE key='schema_version'").run();
      }finally{old.close();}
    }finally{if(s.app.server.listening)await s.close();}
    s=await start(dir);
    try{
      const listed=(await api(s.url,"/api/disk")).result;
      assert.equal(listed.files.find(x=>x.id===doc.id).name,"Старый.txt");
      assert.deepEqual(listed.files.find(x=>x.id===doc.id).tags,["история"]);
      assert.ok(listed.folders.includes("Архив"));
      const backups=await readdir(join(dir,"backups"));
      assert.equal(backups.filter(x=>x.startsWith("before-disk-index-")).length,1);
      const backup=new DatabaseSync(join(dir,"backups",backups.find(x=>x.startsWith("before-disk-index-"))),{readOnly:true});
      try{
        assert.equal(backup.prepare("SELECT name FROM sqlite_master WHERE name='disk_meta'").get(),undefined);
        assert.ok(backup.prepare("SELECT data FROM disk_state WHERE id=1").get());
      }finally{backup.close();}
    }finally{await s.close();}
  }finally{await rm(dir,{recursive:true,force:true});}
});

test("FTS5 indexes extracted text once per SHA and invalidates revision on change; queue audits files",async()=>{
  const dir=await mkdtemp(join(tmpdir(),"tsukimera-fts5-"));
  try{
    const s=await start(dir);
    try{
      const a=await upload(s.url,"Пример.txt","Солнечная долина. Первоначальные сведения.");
      const initial=await api(s.url,"/api/disk/search?q="+encodeURIComponent("солнеч"));
      assert.equal(initial.status,200);
      // Indexing is intentionally asynchronous, not a full re-scan per query.
      await poll(async()=>{
        const state=(await api(s.url,"/api/disk/automation")).result;
        return state.index.indexed>=1&&state.index.pending===0;
      });
      const found=await api(s.url,"/api/disk/search?q="+encodeURIComponent("СОЛНЕЧ"));
      assert.ok(found.result.ids.includes(a.id),"Cyrillic prefix should be FTS5-indexed");
      const db=new DatabaseSync(join(dir,"tsukimera.db"),{readOnly:true});
      const oldSha=a.sha256;
      try{
        assert.equal(db.prepare("SELECT length(body) AS n FROM disk_text_cache WHERE sha=?").get(oldSha).n>10,true);
      }finally{db.close();}
      const replacement=Buffer.from("Туманная равнина. Новая редакция.","utf8");
      const uploadResult=await fetch(s.url+"/api/disk/files/"+a.id+"/versions/binary?expected="+a.sha256,{
        method:"POST",headers:{"Content-Type":"application/octet-stream","X-Tsukimera-Request":"1"},
        body:replacement});
      assert.equal(uploadResult.status,200,await uploadResult.text());
      const stale=await api(s.url,"/api/disk/search?q="+encodeURIComponent("солнеч"));
      assert.ok(!stale.result.ids.includes(a.id),"Old file text must disappear immediately after revision change");
      await poll(async()=>{
        const state=(await api(s.url,"/api/disk/automation")).result;
        return state.index.indexed>=1&&state.index.pending===0;
      });
      assert.ok((await api(s.url,"/api/disk/search?q="+encodeURIComponent("туман"))).result.ids.includes(a.id));
      await poll(async()=>((await api(s.url,"/api/disk/automation")).result.audit.checked>=1),10000);
      const automated=(await api(s.url,"/api/disk/automation")).result;
      assert.equal(automated.audit.corrupt??0,0);
      assert.equal(automated.audit.missing??0,0);
      assert.ok(automated.counts.indexed>=2);
      assert.equal((await api(s.url,"/api/storage/diagnostics")).result.integrity,"ok");
    }finally{await s.close();}
  }finally{await rm(dir,{recursive:true,force:true});}
});

test("Smart Folders 3.0 support verified AND/OR multi-conditions and bounded viewport windows",async()=>{
  const {outputRoot}=await prepareDisk(root);
  const {matchesSmartRule,isConditionValid}=await import(pathToFileURL(join(outputRoot,"web/pages/disk-extras.js")).href);
  const {fileWindow}=await import(pathToFileURL(join(outputRoot,"web/pages/disk-window.js")).href);
  const f={id:"1",name:"Договор.pdf",folder:"Работа/2026",size:6*1024*1024,
    favorite:true,uploadedAt:"2026-11-23T09:00:00Z",sha256:"a".repeat(64),tags:["важно"]};
  const conditions=[
    {field:"extension",operator:"equals",value:"pdf"},
    {field:"folder",operator:"contains",value:"Работа"},
    {field:"size",operator:"min",value:"5"},
    {field:"date",operator:"after",value:"2026-01-01"},
    {field:"favorite",operator:"is",value:"yes"}
  ];
  const rule={id:"x",name:"Мои документы",mode:"all",conditions:conditions.slice(0,4)};
  assert.equal(matchesSmartRule(f,rule),true);
  assert.equal(matchesSmartRule(f,{...rule,conditions:[...rule.conditions,
    {field:"favorite",operator:"is",value:"no"}]}),false);
  assert.equal(matchesSmartRule(f,{...rule,mode:"any",conditions:[
    {field:"name",operator:"equals",value:"Не найдено"},
    {field:"tag",operator:"contains",value:"ВАЖНО"}]}),true);
  assert.equal(matchesSmartRule(f,{id:"legacy",name:"Старое правило",field:"extension",pattern:"pdf"}),true);
  assert.equal(isConditionValid({field:"size",operator:"min",value:"-200"}),false);
  assert.equal(isConditionValid({field:"date",operator:"after",value:"2026-11-23"}),true);
  const start=fileWindow(10000,0,900,64);
  assert.ok(start.end<=100);
  assert.equal(start.start,0);
  const end=fileWindow(10000,640000,900,64);
  assert.ok(end.start>=9900);
  assert.ok(end.end-end.start<=100);
  assert.ok(end.before>0);
  const middle=fileWindow(10000,200000,900,64);
  assert.ok(middle.start>0&&middle.after>0);
  assert.equal(middle.end-middle.start<=100,true);
});
