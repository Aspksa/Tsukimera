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

test("JUUNIBI shell has five active menu items and 10 settings; removed modules/phone/updates stay absent", async () => {
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
    for(const label of ["Беседа","Дела","Диск","Мозг","Настройки",
      "Подключение","Модель","Инструкции","Память","Инструменты","Быстрые команды",
      "Внешний вид","Чат","Данные","О программе"])
      assert.ok(js.includes(label),label);
    // Disabled routes must not exist in the source navigation data, palette, or mobile bar.
    // Keeping these names out of NAV prevents old localStorage/backup preferences
    // from silently re-introducing them (cleanMenu filters IDs by the NAV array).
    for(const name of ["Модули","Телефон","Обновление"]){
      assert.ok(!js.includes("label:'"+name+"'"),"Removed navigation entry still present: "+name);
    }
    for(const id of ["modules","mobile","update"]){
      assert.doesNotMatch(js,new RegExp("id:'"+id+"'"));
    }
    assert.match(js,/filter\(x => IDS\.includes\(x\)\)/);
    assert.match(js,/filter\(x => IDS\.includes\(x\) && x !== 'settings'\)/);
    assert.equal((js.match(/group:'main'/g)||[]).length,3);
    assert.equal((js.match(/group:'brain'/g)||[]).length,1);
    assert.equal((js.match(/group:'system'/g)||[]).length,1);
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

test("concurrent settings writes preserve unrelated fields and survive restart",async()=>{
  const dir=await mkdtemp(join(tmpdir(),"tsukimera-parallel-"));
  const app=createAppServer({root,dataDir:dir});await app.load();
  await new Promise(done=>app.server.listen(0,"127.0.0.1",done));
  const url="http://127.0.0.1:"+app.server.address().port;
  try {
    const updates=[
      {model:{primary:"cloud/model-a"}},
      {instructions:{style:"Короткие ответы"}},
      {memory:{summaries:true}},
      {tools:{web:true}},
      {quickCommands:[{name:"важно",text:"Сохрани решение"}]}
    ];
    const statuses=await Promise.all(updates.map(async patch=>
      (await fetch(url+"/api/settings",{method:"PUT",headers:headers(),body:JSON.stringify(patch)})).status));
    assert.deepEqual(statuses,[200,200,200,200,200]);
    const expected=app.getSettings();
    assert.equal(expected.model.primary,"cloud/model-a");
    assert.equal(expected.instructions.style,"Короткие ответы");
    assert.equal(expected.memory.summaries,true);
    assert.equal(expected.tools.web,true);
    assert.equal(expected.quickCommands[0].name,"важно");
    assert.deepEqual(JSON.parse(await readFile(join(dir,"settings.json"),"utf8")),expected);
    const rejected=await fetch(url+"/api/settings",{method:"PUT",headers:headers(),body:JSON.stringify({tools:{writeFiles:"invalid"}})});
    assert.equal(rejected.status,400);
    const after=await fetch(url+"/api/settings",{method:"PUT",headers:headers(),body:JSON.stringify({model:{reasoning:true}})});
    assert.equal(after.status,200,"A rejected write must not poison the queue");
    const reopened=createAppServer({root,dataDir:dir});
    await reopened.load();
    assert.equal(reopened.getSettings().model.reasoning,true);
    assert.equal(reopened.getSettings().instructions.style,"Короткие ответы");
    assert.equal(reopened.getSettings().memory.summaries,true);
  }finally{
    await new Promise(done=>app.server.close(done));
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


test("Kiyomira typography, line-height and 4-32px spacing are ported without breaking Tsukimera settings",async()=>{
  const css=await readFile(join(root,"web/tsukimera.css"),"utf8");
  const html=await readFile(join(root,"web/index.html"),"utf8");
  // Exact source values: Kiyomira/10-Веб/02-Стиль.css.
  assert.match(css,/--mono:ui-monospace,SFMono-Regular,Menlo,Consolas/);
  assert.match(css,/--font:var\(--mono\)/);
  assert.match(css,/font-size:clamp\(14px,\.5vw \+ 8px,30px\)/);
  assert.match(css,/--gap:clamp\(12px,\.6rem \+ \.8vw,32px\)/);
  assert.match(css,/--pad:clamp\(16px,1rem \+ 2\.2vw,72px\)/);
  assert.match(css,/body\{font-family:var\(--font\);line-height:1\.5/);
  // Exact design tokens: Kiyomira/10-Веб/05-ЕдиныйИнтерфейс.css.
  assert.match(css,/--ki-space-1:4px;--ki-space-2:8px;--ki-space-3:12px/);
  assert.match(css,/--ki-space-4:16px;--ki-space-5:24px;--ki-space-6:32px/);
  assert.match(css,/--ki-type-small:clamp\(11px,\.7vw \+ 8px,13px\)/);
  assert.match(css,/--ki-type-body:clamp\(13px,\.45vw \+ 11px,16px\)/);
  assert.match(css,/--ki-type-title:clamp\(17px,\.75vw \+ 13px,22px\)/);
  for(const selector of [".nav-item{",".pg-card{",".pg-head{",".set-layout{",
      ".set-card .set-row{",".set-toc-link{",".set-card-head h2{",".set-search{",
      ".beh-field{",".quick-list li{",".content-main{"]){
    assert.ok(css.includes(selector),"Missing Kiyomira layout override "+selector);
  }
  assert.match(css,/\.nav-item\{\s*gap:var\(--ki-space-3\);\s*padding:\.75rem \.8rem/);
  assert.match(css,/\.btn\{padding:\.7em 1\.2em;line-height:1\.5\}/);
  assert.match(css,/\.set-row small\{[^}]*line-height:1\.6\}/);
  // Visual overrides must load after all JUUNIBI layers.
  const vendor=html.indexOf('href="/juunibi-design.css"');
  const custom=html.indexOf('href="/tsukimera.css"');
  assert.ok(vendor>=0&&custom>vendor);
  // Existing UI-size options and mobile layout remain functional.
  for(const scale of ["sm","md","lg"])
    assert.ok(css.includes(":root[data-scale="+scale+"]"),"Scale setting lost: "+scale);
  assert.match(css,/@media\(max-width:860px\)\{[\s\S]*?\.content-main\{padding:var\(--ki-space-4\) var\(--ki-space-3\) 95px\}/);
  assert.match(css,/@media\(max-width:450px\)\{/);
  const client=await readFile(join(root,"web/app.js"),"utf8");
  assert.match(client,/scale:pick\('scale',\['sm','md','lg'\],'md'\)/);
  assert.match(client,/html\.dataset\.scale=ui\.scale/);
});
