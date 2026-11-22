import {test} from "node:test";
import assert from "node:assert/strict";
import {mkdtemp,readFile,rm,readdir} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join,resolve} from "node:path";
import {fileURLToPath} from "node:url";
import {DatabaseSync} from "node:sqlite";
import {createAppServer} from "../scripts/server.mjs";
import {parseCloudModels,cloudFailure} from "../scripts/cloudru.mjs";

const root=resolve(fileURLToPath(new URL("../",import.meta.url)));
const H={"Content-Type":"application/json","X-Tsukimera-Request":"1"};
async function start(dir,opts={}){
  const app=createAppServer({root,dataDir:dir,...opts});
  await app.load();
  await new Promise(done=>app.server.listen(0,"127.0.0.1",done));
  return {url:"http://127.0.0.1:"+app.server.address().port,
    close:()=>new Promise(done=>app.server.close(done))};
}
async function call(url,path,method="GET",value){
  const response=await fetch(url+path,{method,headers:H,
    body:value===undefined?undefined:JSON.stringify(value)});
  return {status:response.status,data:await response.json()};
}

test("Cloud.ru discovery uses official read-only endpoint, never calls inference or persists secrets",async()=>{
  const dir=await mkdtemp(join(tmpdir(),"tsukimera-cloud-"));
  const seen=[],secret="TEST_CLOUD_SECRET_SHOULD_NOT_LEAK_987";
  const server=await start(dir,{cloudKey:"",cloudRequest:async(url,options)=>{
    seen.push({url,method:options.method,bearer:options.headers.Authorization});
    return new Response(JSON.stringify({object:"list",data:[
      {id:"deepseek-ai/DeepSeek-V4-Flash"},{id:"ai-sage/GigaChat3-10B-A1.8B"},
      {id:"deepseek-ai/DeepSeek-V4-Flash"},{id:"../../bad"}]}),{
      status:200,headers:{"content-type":"application/json"}});
  }});
  try{
    let response=await call(server.url,"/api/cloud/models");
    assert.equal(response.status,409,"No key must reject model discovery before network access");
    assert.equal(seen.length,0);
    response=await call(server.url,"/api/cloud/key","POST",{key:secret});
    assert.equal(response.status,200);
    assert.equal(response.data.configured,true);
    assert.ok(!JSON.stringify(response.data).includes(secret),"Key must never appear in status");
    response=await call(server.url,"/api/cloud/models");
    assert.equal(response.status,200);
    assert.deepEqual(response.data.models,["ai-sage/GigaChat3-10B-A1.8B","deepseek-ai/DeepSeek-V4-Flash"]);
    assert.equal(seen.length,1);
    assert.equal(seen[0].url,"https://foundation-models.api.cloud.ru/v1/models");
    assert.equal(seen[0].method,"GET");
    assert.equal(seen[0].bearer,"Bearer "+secret);
    const status=await call(server.url,"/api/cloud/status");
    assert.equal(status.data.verified,true);
    assert.equal(status.data.inferenceEnabled,false);
    const db=await readFile(join(dir,"tsukimera.db"));
    assert.equal(db.includes(Buffer.from(secret)),false,"Credential must never reach SQLite");
    assert.equal((await readFile(join(dir,"settings.json")).catch(()=>Buffer.from(""))).includes(secret),false);
    response=await call(server.url,"/api/cloud/clear","POST",{});
    assert.equal(response.data.configured,false);
    assert.equal((await call(server.url,"/api/cloud/models")).status,409);
  }finally{await server.close();await rm(dir,{recursive:true,force:true});}
});

test("Cloud.ru API failures distinguish 401/402/429/5xx without retries or paid requests",async()=>{
  for(const code of [401,402,403,429,502,503,504]){
    const dir=await mkdtemp(join(tmpdir(),"tsukimera-cloud-errors-"));
    let requests=0;
    const server=await start(dir,{cloudKey:"secret",cloudRequest:async()=>{
      requests++;return new Response("denied",{status:code});
    }});
    try{
      const result=await call(server.url,"/api/cloud/models");
      assert.equal(result.status,code);
      assert.ok(result.data.error.length>10);
      const state=await call(server.url,"/api/cloud/status");
      assert.equal(state.data.lastError.code,"cloud_"+code);
      assert.equal(state.data.lastError.retryable,[429,502,503,504].includes(code));
      assert.equal(requests,1,"No automatic retries");
    }finally{await server.close();await rm(dir,{recursive:true,force:true});}
  }
  assert.equal(cloudFailure(524).retryable,true);
  assert.deepEqual(parseCloudModels({data:[{id:"test/model"}]}),["test/model"]);
  assert.throws(()=>parseCloudModels({bogus:[]}),/неожиданный формат/);
});

test("settings restore is atomic across config, notes, preferences; saves a recoverable SQLite snapshot",async()=>{
  const dir=await mkdtemp(join(tmpdir(),"tsukimera-settings-restore-"));
  const server=await start(dir,{cloudKey:"",cloudRequest:async()=>new Response("{}")});
  try{
    const p0=await call(server.url,"/api/preferences/initialize","POST",{preferences:{
      "juunibi.disk.mdRaw":"1","tsukimera.disk.tiles.v1":"240"}});
    assert.equal(p0.status,200);
    assert.equal(p0.data.preferences["tsukimera.disk.mdRaw"],"1");
    const n0=await call(server.url,"/api/notes","POST",{id:"initial-note",text:"Keep before restore"});
    assert.equal(n0.status,201);
    assert.equal((await call(server.url,"/api/settings","PUT",{model:{primary:"before/model"}})).status,200);
    const bundle={kind:"tsukimera-settings-v1",version:1,
      settings:{model:{primary:"after/model",fallback:"backup/model"},
        instructions:{about:"Импортировано",style:"Кратко"},
        memory:{embeddings:false,summaries:false,suggestions:"off"},
        tools:{web:false,writeFiles:false},quickCommands:[]},
      menu:{order:["disk","settings"],collapsed:true,hidden:[]},
      ui:{theme:"dark",accent:"gold",radius:"normal",scale:"md"},
      sections:{collapsed:["memory"]},
      diskPrefs:{"tsukimera.disk.tiles.v1":"300","tsukimera.disk.mdRaw":"1"},
      notes:[{id:"restored-note",text:"Restored",kind:"note",files:[]}],
    };
    const ok=await call(server.url,"/api/settings/restore","POST",bundle);
    assert.equal(ok.status,200,JSON.stringify(ok.data));
    assert.match(ok.data.backup,/^data\/backups\/settings-restore-/);
    assert.equal(ok.data.settings.model.primary,"after/model");
    assert.equal((await call(server.url,"/api/notes")).data.notes[0].id,"restored-note");
    assert.equal((await call(server.url,"/api/preferences")).data.preferences["tsukimera.disk.tiles.v1"],"300");
    const backups=await readdir(join(dir,"backups"));
    const filename=backups.find(x=>x.startsWith("settings-restore-"));
    assert.ok(filename);
    const snapshot=new DatabaseSync(join(dir,"backups",filename),{readOnly:true});
    try{
      assert.equal(JSON.parse(snapshot.prepare("SELECT data FROM app_settings WHERE id=1").get().data).model.primary,
        "before/model");
      assert.equal(snapshot.prepare("SELECT count(*) AS n FROM notes").get().n,1);
      assert.equal(snapshot.prepare("SELECT data FROM notes").get().data.includes("Keep before restore"),true);
    }finally{snapshot.close();}
    const bad={...bundle,diskPrefs:{"tsukimera.disk.tiles.v1":"350"},notes:[
      {id:"valid-note",text:"Good"},{id:"not valid/id",text:"Bad"}]};
    const denied=await call(server.url,"/api/settings/restore","POST",bad);
    assert.equal(denied.status,400);
    assert.equal((await call(server.url,"/api/notes")).data.notes[0].id,"restored-note");
    assert.equal((await call(server.url,"/api/preferences")).data.preferences["tsukimera.disk.tiles.v1"],"300");
    assert.equal((await call(server.url,"/api/settings")).data.settings.model.primary,"after/model");
    const forbidden=await call(server.url,"/api/settings/restore","POST",{
      ...bundle,diskPrefs:{"cloud_api_key":"SECRET"}});
    assert.equal(forbidden.status,400);
    const report=await call(server.url,"/api/storage/diagnostics");
    assert.equal(report.status,200);
    assert.equal(report.data.integrity,"ok");
    assert.equal(report.data.schema,"2");
    assert.equal(report.data.counts.notes,1);
    assert.ok(report.data.backups.some(x=>x.startsWith("settings-restore-")));
    const policy=await call(server.url,"/api/capabilities");
    assert.equal(policy.data.notes.available,true);
    assert.equal(policy.data.vectorSearch.available,false);
    assert.equal(policy.data.aiTools.available,false);
    assert.equal(policy.data.policies.effectiveWriteFiles,false);
  }finally{await server.close();await rm(dir,{recursive:true,force:true});}
});

test("new preferences respect all legitimate Tsukimera keys and normalize JUUNIBI aliases",async()=>{
  const dir=await mkdtemp(join(tmpdir(),"tsukimera-prefs-3-"));
  const first=await start(dir);
  try{
    const imported=await call(first.url,"/api/preferences/initialize","POST",{preferences:{
      "juunibi.disk.view":"tiles","juunibi.disk.mdRaw":"1",
      "tsukimera.disk.view":"table","tsukimera.disk.mdRaw":"0",
      "tsukimera.disk.life.group":"core"}});
    assert.equal(imported.status,200);
    assert.equal(imported.data.preferences["tsukimera.disk.view"],"table");
    assert.equal(imported.data.preferences["tsukimera.disk.mdRaw"],"0");
    assert.equal(imported.data.preferences["juunibi.disk.view"],undefined);
    const changed=await call(first.url,"/api/preferences","PUT",{changes:{
      "juunibi.disk.mdRaw":"1","tsukimera.disk.tiles.v1":"330"}});
    assert.equal(changed.status,200);
    const updated=await call(first.url,"/api/preferences");
    assert.equal(updated.data.preferences["tsukimera.disk.mdRaw"],"1");
    assert.equal(updated.data.preferences["tsukimera.disk.tiles.v1"],"330");
  }finally{await first.close();}
  const second=await start(dir);
  try{
    const state=await call(second.url,"/api/preferences");
    assert.equal(state.data.preferences["tsukimera.disk.mdRaw"],"1");
    assert.equal(state.data.preferences["tsukimera.disk.view"],"table");
  }finally{await second.close();await rm(dir,{recursive:true,force:true});}
});
