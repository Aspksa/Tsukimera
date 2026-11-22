import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { createAppServer, patchSettings, DEFAULTS } from "../scripts/server.mjs";

const root = resolve(fileURLToPath(new URL("../", import.meta.url)));
function headers() { return { "X-Tsukimera-Request": "1", "Content-Type": "application/json" }; }

test("JUUNIBI shell assets, all menu items and 10 settings are available", async () => {
  const dir=await mkdtemp(join(tmpdir(),"tsukimera-css-"));
  const app=createAppServer({root,dataDir:dir});await app.load();
  await new Promise(done => app.server.listen(0,"127.0.0.1",done));
  const url="http://127.0.0.1:"+app.server.address().port;
  try {
    for(const [route,type,needle] of [
      ["/","text/html","Tsukimera"],
      ["/app.js","text/javascript","Подключение"],
      ["/juunibi-style.css","text/css",".set-layout"],
      ["/juunibi-nav.css","text/css",".nav-edit-row"],
      ["/juunibi-design.css","text/css","--page-wide"],
      ["/tsukimera.css","text/css",".set-card"]
    ]) {
      const response=await fetch(url+route);
      assert.equal(response.status,200,route);
      assert.match(response.headers.get("content-type"),new RegExp(type));
      assert.match(await response.text(),new RegExp(needle));
      assert.equal(response.headers.get("x-content-type-options"),"nosniff");
    }
    const js=await (await fetch(url+"/app.js")).text();
    for(const label of ["Беседа","Дела","Диск","Мозг","Модули","Телефон","Обновление","Настройки",
      "Подключение","Модель","Инструкции","Память","Инструменты","Быстрые команды",
      "Внешний вид","Чат","Данные","О программе"])
      assert.ok(js.includes(label),label);
    assert.match(js,/tsukimera:nav:v1/);
    assert.match(js,/Ctrl\+K/);
    assert.match(js,/nav-edit-row/);
    assert.match(js,/aria-expanded/);
    assert.match(js,/downloadBackup/);
    assert.match(js,/restoreBackup/);
    assert.match(js,/readLocal/);
    assert.doesNotMatch(js,/localStorage\.setItem\([^)]*api.?key/i);
    assert.equal((await fetch(url+"/../../package.json")).status,404);
    assert.equal((await fetch(url+"/api/unknown")).status,404);
    const head=await fetch(url+"/",{method:"HEAD"});assert.equal(head.status,200);
    assert.equal(await head.text(),"");
  }finally{
    await new Promise(done=>app.server.close(done));
    await rm(dir,{recursive:true,force:true});
  }
});

test("settings API saves only allowlisted local preferences, safely reloads, and never accepts secrets",async()=>{
  const dir=await mkdtemp(join(tmpdir(),"tsukimera-settings-"));
  const app=createAppServer({root,dataDir:dir});await app.load();
  await new Promise(done=>app.server.listen(0,"127.0.0.1",done));
  const url="http://127.0.0.1:"+app.server.address().port;
  try{
    let r=await fetch(url+"/api/status");
    const status=await r.json();assert.equal(status.project,"Tsukimera");
    assert.equal(status.aiConnected,false,"No invented cloud availability");
    r=await fetch(url+"/api/settings");
    assert.equal((await r.json()).settings.model.primary,"");
    r=await fetch(url+"/api/settings",{method:"PUT",headers:{"Content-Type":"application/json"},body:"{}"});
    assert.equal(r.status,403);
    r=await fetch(url+"/api/settings",{method:"PUT",headers:headers(),body:JSON.stringify({cloudKey:"SECRET"})});
    assert.equal(r.status,400);
    r=await fetch(url+"/api/settings",{method:"PUT",headers:headers(),body:JSON.stringify({model:{primary:"../../evil"}})});
    assert.equal(r.status,400);
    r=await fetch(url+"/api/settings",{method:"PUT",headers:headers(),body:JSON.stringify({model:{primary:"acme/Test",fallback:"acme/Test"}})});
    assert.equal(r.status,400);
    r=await fetch(url+"/api/settings",{method:"PUT",headers:headers(),body:JSON.stringify({
      model:{primary:"deepseek-ai/DeepSeek-V4-Flash",fallback:"backup/model",reasoning:true},
      instructions:{about:"Владелец",style:"Ответы по-русски"},
      memory:{summaries:true},quickCommands:[{name:"план",text:"Составь план"}]
    })});
    assert.equal(r.status,200,await r.text().catch(()=>'')); // note: body already consumed if error only
    const persisted=app.getSettings();
    assert.equal(persisted.model.reasoning,true);
    assert.equal(persisted.instructions.style,"Ответы по-русски");
    assert.equal(persisted.quickCommands[0].name,"план");
    const raw=await readFile(join(dir,"settings.json"),"utf8");
    assert.equal(raw.includes("SECRET"),false);
    assert.equal(raw.includes("Cloud.ru key"),false);
    await new Promise(done=>app.server.close(done));
    const reopened=createAppServer({root,dataDir:dir});await reopened.load();
    assert.equal(reopened.getSettings().model.primary,"deepseek-ai/DeepSeek-V4-Flash");
    assert.equal(reopened.getSettings().quickCommands.length,1);
  }finally{
    if(app.server.listening)await new Promise(done=>app.server.close(done));
    await rm(dir,{recursive:true,force:true});
  }
});

test("settings validation and code syntax support stock Node without packages",async()=>{
  assert.deepEqual(patchSettings(DEFAULTS,{}),DEFAULTS);
  assert.throws(()=>patchSettings(DEFAULTS,{tools:{writeFiles:"true"}}),/Неверный переключатель/);
  assert.throws(()=>patchSettings(DEFAULTS,{quickCommands:[{name:"wrong!",text:"bad"}]}),/быстрая команда/);
  assert.throws(()=>patchSettings(DEFAULTS,{instructions:{style:"x".repeat(1501)}}),/1500/);
  for(const file of ["web/app.js","scripts/launch.mjs","scripts/server.mjs"])
    execFileSync(process.execPath,["--check",join(root,file)],{stdio:"pipe"});
  const bat=await readFile(join(root,"Tsukimera.bat"),"utf8");
  assert.match(bat,/scripts\\launch\.mjs/);
  assert.match(bat,/DisableDelayedExpansion/);
  assert.match(bat,/bootstrap-node\.ps1/);
});
