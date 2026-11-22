import {test} from "node:test";
import assert from "node:assert/strict";
import {mkdtemp,mkdir,readFile,rm,stat} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join,resolve} from "node:path";
import {fileURLToPath,pathToFileURL} from "node:url";
import {DatabaseSync} from "node:sqlite";
import {createAppServer} from "../scripts/server.mjs";
import {prepareDisk} from "../scripts/build-disk.mjs";

const root=resolve(fileURLToPath(new URL("../",import.meta.url)));
async function start(dir){
  const app=createAppServer({root,dataDir:dir});await app.load();
  await new Promise(resolve=>app.server.listen(0,"127.0.0.1",resolve));
  return {url:"http://127.0.0.1:"+app.server.address().port,
    close:()=>new Promise(resolve=>app.server.close(resolve))};
}
async function api(url,path,method="GET",value){
  const response=await fetch(url+path,{
    method,headers:{"X-Tsukimera-Request":"1","Content-Type":"application/json"},
    body:value===undefined?undefined:JSON.stringify(value),
  });
  return {status:response.status,value:await response.json()};
}

test("existing browser UI and Disk preferences migrate once and survive SQLite restart",async()=>{
  const dir=await mkdtemp(join(tmpdir(),"tsukimera-pref-sync-"));
  try{
    const first=await start(dir);
    let id;
    try{
      const state=await api(first.url,"/api/preferences");
      assert.equal(state.status,200);
      assert.equal(state.value.initialized,false);
      id=state.value.instanceId;
      const legacy={
        "tsukimera:ui:v1":JSON.stringify({theme:"dark",accent:"gold"}),
        "tsukimera:nav:v1":JSON.stringify({collapsed:true,order:["disk","settings"]}),
        "tsukimera.disk.smart.v1":JSON.stringify([{id:"one",name:"Работа",field:"name",pattern:"план"}]),
        "tsukimera.disk.layout.left.v1":"348",
        "tsukimera.disk.tiles.v1":"300",
        "tsukimera.disk.life.group":"words",
        "tsukimera.disk.open":JSON.stringify(["Проекты"]),
      };
      let result=await api(first.url,"/api/preferences/initialize","POST",{preferences:legacy});
      assert.equal(result.status,200);
      assert.deepEqual(result.value.preferences,legacy);
      const stale=await api(first.url,"/api/preferences/initialize","POST",{
        preferences:{"tsukimera.disk.tiles.v1":"190"}});
      assert.equal(stale.value.preferences["tsukimera.disk.tiles.v1"],"300",
        "Re-import from stale browser state must not overwrite the authoritative database");
      const edits=await Promise.all([
        api(first.url,"/api/preferences","PUT",{changes:{"tsukimera.disk.tiles.v1":"320"}}),
        api(first.url,"/api/preferences","PUT",{changes:{"tsukimera.disk.life.group":"media"}}),
        api(first.url,"/api/preferences","PUT",{changes:{"tsukimera:ui:v1":JSON.stringify({theme:"light"})}}),
      ]);
      assert.deepEqual(edits.map(x=>x.status),[200,200,200]);
      result=await api(first.url,"/api/preferences");
      assert.equal(result.value.preferences["tsukimera.disk.tiles.v1"],"320");
      assert.equal(result.value.preferences["tsukimera.disk.life.group"],"media");
      assert.equal(result.value.preferences["tsukimera:ui:v1"],JSON.stringify({theme:"light"}));
      assert.equal(result.value.preferences["tsukimera.disk.smart.v1"],legacy["tsukimera.disk.smart.v1"]);
      const forbidden=await api(first.url,"/api/preferences","PUT",{changes:{
        "tsukimera.disk.upload.private-key":"DO_NOT_STORE"}});
      assert.equal(forbidden.status,400);
      assert.equal(JSON.stringify((await api(first.url,"/api/preferences")).value.preferences).includes("DO_NOT_STORE"),false);
      const atomic=await api(first.url,"/api/preferences","PUT",{changes:{
        "tsukimera.disk.tiles.v1":"160","invalid-key":"oops"}});
      assert.equal(atomic.status,400);
      assert.equal((await api(first.url,"/api/preferences")).value.preferences["tsukimera.disk.tiles.v1"],"320");
    }finally{await first.close();}
    const second=await start(dir);
    try{
      const state=await api(second.url,"/api/preferences");
      assert.equal(state.value.instanceId,id);
      assert.equal(state.value.initialized,true);
      assert.equal(state.value.preferences["tsukimera.disk.tiles.v1"],"320");
      assert.equal(state.value.preferences["tsukimera.disk.life.group"],"media");
      const db=new DatabaseSync(join(dir,"tsukimera.db"));
      try{
        assert.equal(db.prepare("PRAGMA quick_check").get().quick_check,"ok");
        assert.equal(db.prepare("SELECT value FROM metadata WHERE key='schema_version'").get().value,"3");
        assert.equal(db.prepare("SELECT count(*) AS n FROM user_preferences").get().n,7);
      }finally{db.close();}
    }finally{await second.close();}
  }finally{await rm(dir,{recursive:true,force:true});}
});

test("old SQLite schema is backed up before adding user_preferences",async()=>{
  const dir=await mkdtemp(join(tmpdir(),"tsukimera-pref-upgrade-"));
  try{
    await mkdir(dir,{recursive:true});
    const filename=join(dir,"tsukimera.db");
    const old=new DatabaseSync(filename);
    old.exec("CREATE TABLE metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL)");
    old.prepare("INSERT INTO metadata(key,value) VALUES('instance_id', 'existing-id')").run();
    old.close();
    const app=await start(dir);
    try{
      const state=await api(app.url,"/api/preferences");
      assert.equal(state.value.instanceId,"existing-id");
      assert.equal(state.value.initialized,false);
      const backups=await import("node:fs/promises").then(fs=>fs.readdir(join(dir,"backups")));
      assert.equal(backups.filter(name=>name.startsWith("before-preferences-")).length,1);
      const backup=join(dir,"backups",backups.find(name=>name.startsWith("before-preferences-")));
      assert.ok((await stat(backup)).size>0);
      const archived=new DatabaseSync(backup,{readOnly:true});
      try{
        assert.equal(archived.prepare("SELECT name FROM sqlite_master WHERE name='user_preferences'").get(),undefined);
      }finally{archived.close();}
    }finally{await app.close();}
  }finally{await rm(dir,{recursive:true,force:true});}
});

test("Canvas graph layout is capped, deterministic and represents only verified links",async()=>{
  const {outputRoot}=await prepareDisk(root);
  const {graphFromFiles}=await import(pathToFileURL(join(outputRoot,"web","pages","disk-map-layout.js")).href);
  const example=[
    {id:"00000000-0000-4000-8000-000000000001",name:"A.txt",folder:"Работа",size:300,
      sha256:"a".repeat(64),tags:["важно"],uploadedAt:"2026-01-01"},
    {id:"00000000-0000-4000-8000-000000000002",name:"B.txt",folder:"Работа",size:120,
      sha256:"a".repeat(64),tags:["важно"],uploadedAt:"2026-01-02"},
    {id:"00000000-0000-4000-8000-000000000003",name:"C.txt",folder:"Личное",size:50,
      sha256:"b".repeat(64),tags:["личное"],uploadedAt:"2026-01-03"},
  ];
  const graph=graphFromFiles(example,["Работа","Личное","Пустая"],2,4);
  assert.equal(graph.totalFiles,3);
  assert.equal(graph.shownFiles,2);
  assert.equal(graph.totalFolders,3);
  assert.equal(graph.nodes.filter(node=>node.kind==="file").length,2);
  assert.equal(graph.edges.filter(edge=>edge.kind==="duplicate").length,1);
  assert.equal(graph.edges.filter(edge=>edge.kind==="tag").length,1);
  assert.deepEqual(graph,graphFromFiles(example,["Работа","Личное","Пустая"],2,4));
  const large=Array.from({length:1000},(_,i)=>({
    id:"00000000-0000-4000-8000-"+String(i).padStart(12,"0"),
    name:"Документ-"+i+".txt",folder:"Группа-"+i,size:i+1,
    sha256:String(i).padStart(64,"0"),uploadedAt:"2026-01-01"
  }));
  const bounded=graphFromFiles(large,[],240,110);
  assert.ok(bounded.nodes.length<=351,"Canvas must not render all 1000 files");
  assert.ok(bounded.shownFolders<=110);
  assert.ok(bounded.shownFiles<=240);
});

test("interactive chart zoom and pan keep real source indices in bounds",async()=>{
  const {outputRoot}=await prepareDisk(root);
  const {chartViewport,zoomViewport}=await import(pathToFileURL(join(outputRoot,"web","pages","life-interactive.js")).href);
  assert.deepEqual(chartViewport(0),{start:0,count:0});
  assert.deepEqual(chartViewport(10,-20,3),{start:0,count:3});
  assert.deepEqual(chartViewport(10,100,3),{start:7,count:3});
  const start=chartViewport(120,20,40);
  const inside=zoomViewport(120,start,true);
  assert.ok(inside.count<start.count);
  assert.ok(inside.start>=0&&inside.start+inside.count<=120);
  const outside=zoomViewport(120,inside,false);
  assert.ok(outside.count>inside.count);
  assert.ok(outside.start>=0&&outside.start+outside.count<=120);
});
