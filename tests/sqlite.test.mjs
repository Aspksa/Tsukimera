import {test} from "node:test";
import assert from "node:assert/strict";
import {mkdtemp,mkdir,readFile,writeFile,rm,readdir,unlink} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join,resolve} from "node:path";
import {fileURLToPath,pathToFileURL} from "node:url";
import {DatabaseSync} from "node:sqlite";
import {createAppServer,DEFAULTS} from "../scripts/server.mjs";
import {prepareDisk} from "../scripts/build-disk.mjs";

const root=resolve(fileURLToPath(new URL("../",import.meta.url)));
const headers={"X-Tsukimera-Request":"1","Content-Type":"application/json"};
async function start(dir){
  const app=createAppServer({root,dataDir:dir});
  await app.load();
  await new Promise(done=>app.server.listen(0,"127.0.0.1",done));
  return {app,origin:"http://127.0.0.1:"+app.server.address().port,
    stop:()=>new Promise(done=>app.server.close(done))};
}
async function api(origin,path,method="GET",data){
  const response=await fetch(origin+path,{method,headers,
    body:data===undefined?undefined:JSON.stringify(data)});
  return {status:response.status,value:await response.json()};
}

test("first start creates SQLite and retains original interface and 150 metrics",async()=>{
  const dir=await mkdtemp(join(tmpdir(),"tsukimera-sqlite-fresh-"));
  try{
    const {app,origin,stop}=await start(dir);
    try{
      const status=await api(origin,"/api/storage");
      assert.equal(status.status,200);
      assert.equal(status.value.engine,"sqlite");
      assert.equal(status.value.file,"data/tsukimera.db");
      assert.deepEqual(status.value.counts,{files:0,notes:0,versions:0});
      assert.equal(status.value.backupCreated,null);
      const db=new DatabaseSync(join(dir,"tsukimera.db"));
      try{
        assert.equal(db.prepare("PRAGMA quick_check").get().quick_check,"ok");
        assert.equal(db.prepare("SELECT value FROM metadata WHERE key='schema_version'").get().value,"1");
        assert.equal(db.prepare("SELECT count(*) AS n FROM disk_files").get().n,0);
      }finally{db.close();}
      const life=await api(origin,"/api/disk/life");
      assert.equal(life.status,200);
      assert.equal(life.value.metrics.length,150);
      assert.equal(life.value.groups.length,15);
      assert.ok(app.getDisk());
    }finally{await stop();}
  }finally{await rm(dir,{recursive:true,force:true});}
});

test("legacy JSON and every Disk object are backed up BEFORE SQLite migration, with SQLite authoritative after restart",async()=>{
  const dir=await mkdtemp(join(tmpdir(),"tsukimera-sqlite-upgrade-"));
  try{
    const built=await prepareDisk(root);
    const {LocalDisk}=await import(pathToFileURL(join(built.outputRoot,"server/local-disk.js")).href);
    const disk=new LocalDisk(join(dir,"disk"));
    await disk.load();
    const payload=Buffer.from("Старое содержимое, которое нельзя терять","utf8");
    const entry=await disk.uploadBytes("Прежний документ.txt","",payload);
    await writeFile(join(dir,"settings.json"),JSON.stringify({
      ...DEFAULTS,instructions:{about:"Владелец",style:"Русский язык"},
    }));
    const originalIndex=await readFile(join(dir,"disk","index.json"));
    const object=await readFile(join(dir,"disk","objects",entry.objectId??entry.id));
    const first=await start(dir);
    const status=await api(first.origin,"/api/storage");
    assert.equal(status.status,200);
    assert.equal(status.value.counts.files,1);
    assert.match(status.value.backupCreated,/^data\/backups\/before-sqlite-/);
    const backups=await readdir(join(dir,"backups"));
    assert.equal(backups.length,1,"The migration must make one pre-migration backup");
    const archive=join(dir,"backups",backups[0]);
    assert.deepEqual(await readFile(join(archive,"disk","index.json")),originalIndex);
    assert.deepEqual(await readFile(join(archive,"disk","objects",entry.objectId??entry.id)),object);
    assert.equal(JSON.parse(await readFile(join(archive,"settings.json"),"utf8")).instructions.style,"Русский язык");
    assert.equal(first.app.getSettings().instructions.about,"Владелец");
    const renamed=await api(first.origin,"/api/disk/files/"+entry.id,"PATCH",{name:"Новое имя.txt"});
    assert.equal(renamed.status,200);
    const options=await api(first.origin,"/api/settings","PUT",{model:{primary:"cloud/model"}});
    assert.equal(options.status,200);
    await first.stop();
    // Delete the compatibility indices in this synthetic fixture. Real users
    // keep them; this deliberately proves the database is the source of truth.
    await unlink(join(dir,"disk","index.json"));
    await unlink(join(dir,"settings.json"));
    const second=await start(dir);
    try{
      const files=(await api(second.origin,"/api/disk")).value.files;
      assert.equal(files.length,1);
      assert.equal(files[0].id,entry.id);
      assert.equal(files[0].name,"Новое имя.txt");
      assert.equal(second.app.getSettings().model.primary,"cloud/model");
      const raw=await fetch(second.origin+"/api/disk/files/"+entry.id+"/raw");
      assert.deepEqual(Buffer.from(await raw.arrayBuffer()),payload);
      assert.equal((await readdir(join(dir,"backups"))).length,1,"No repeated migration backup");
      const db=new DatabaseSync(join(dir,"tsukimera.db"));
      try{
        assert.equal(db.prepare("SELECT name FROM disk_files WHERE id=?").get(entry.id).name,"Новое имя.txt");
        assert.equal(db.prepare("PRAGMA quick_check").get().quick_check,"ok");
      }finally{db.close();}
    }finally{await second.stop();}
  }finally{await rm(dir,{recursive:true,force:true});}
});

test("browser notes import idempotently, links survive restart, CRUD remains in SQLite",async()=>{
  const dir=await mkdtemp(join(tmpdir(),"tsukimera-sqlite-notes-"));
  try{
    const first=await start(dir);
    const id="550e8400-e29b-41d4-a716-446655440000";
    const fileId="550e8400-e29b-41d4-a716-446655440001";
    let instanceId;
    try{
      let r=await api(first.origin,"/api/notes");
      instanceId=r.value.instanceId;
      assert.deepEqual(r.value.notes,[]);
      const old=[{id,text:"Старая заметка",files:[{id:fileId,name:"Старая подпись.txt"}]},
        {id:"1690000000000-1",text:"Ещё одна",kind:"todo"}];
      r=await api(first.origin,"/api/notes/import","POST",{notes:old});
      assert.equal(r.status,200);
      assert.equal(r.value.notes.length,2);
      r=await api(first.origin,"/api/notes/import","POST",{notes:old});
      assert.equal(r.value.notes.length,2,"Import must not duplicate existing notes");
      r=await api(first.origin,"/api/notes/"+encodeURIComponent(id)+"/files","PATCH",{
        files:[{id:fileId,name:"Актуальное имя.txt"}]});
      assert.equal(r.status,200);
      assert.equal(r.value.note.files[0].name,"Актуальное имя.txt");
      r=await api(first.origin,"/api/notes","POST",{
        id:"another-uuid",text:"Новая заметка из браузера"});
      assert.equal(r.status,201);
      r=await api(first.origin,"/api/notes","POST",{
        id:"another-uuid",text:"Повторное создание"});
      assert.equal(r.status,409);
      r=await api(first.origin,"/api/notes/import","POST",{
        notes:[{id:"valid",text:"Сохранить"},{id:"bad/id",text:"Отказать"}]});
      assert.equal(r.status,400);
      assert.equal((await api(first.origin,"/api/notes")).value.notes.length,3,
        "Malformed bulk imports must not partially commit");
      const db=new DatabaseSync(join(dir,"tsukimera.db"));
      try{
        const row=db.prepare("SELECT name FROM note_file_links WHERE note_id=? AND file_id=?")
          .get(id,fileId);
        assert.equal(row.name,"Актуальное имя.txt");
        assert.equal(db.prepare("PRAGMA quick_check").get().quick_check,"ok");
      }finally{db.close();}
    }finally{await first.stop();}
    const second=await start(dir);
    try{
      const result=await api(second.origin,"/api/notes");
      assert.equal(result.value.instanceId,instanceId);
      assert.equal(result.value.notes.length,3);
      assert.equal(result.value.notes.find(x=>x.id===id).files[0].id,fileId);
      const removed=await api(second.origin,"/api/notes/another-uuid","DELETE");
      assert.equal(removed.status,200);
      assert.equal((await api(second.origin,"/api/notes")).value.notes.length,2);
      const unchanged=await api(second.origin,"/api/disk/life");
      assert.equal(unchanged.value.metrics.length,150);
    }finally{await second.stop();}
  }finally{await rm(dir,{recursive:true,force:true});}
});
