import {test} from "node:test";
import assert from "node:assert/strict";
import {mkdtemp,rm,readFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join,resolve} from "node:path";
import {pathToFileURL,fileURLToPath} from "node:url";
import {prepareDisk} from "../scripts/build-disk.mjs";
import {createAppServer} from "../scripts/server.mjs";

const root=resolve(fileURLToPath(new URL("../",import.meta.url)));

test("The fifteen unchanged source groups map exactly once to five areas, preserving 150 metrics",async()=>{
  const compiled=await prepareDisk(root);
  const layout=await import(pathToFileURL(join(compiled.outputRoot,"web/pages/disk-life-layout.js")).href);
  const backend=await import(pathToFileURL(join(compiled.outputRoot,"server/disk-life.js")).href);
  const names=backend.LIFE_GROUPS.map(x=>x.id);
  const indexed=layout.allGroupIds();
  assert.equal(layout.LIFE_AREAS.length,5);
  assert.equal(indexed.length,15);
  assert.equal(new Set(indexed).size,15);
  assert.deepEqual([...indexed].sort(),[...names].sort(),"No source group may be dropped or duplicated");
  for(const id of names)assert.notEqual(layout.areaForGroup(id),undefined);
  assert.equal(layout.areaForGroup("style"),"content");
  assert.equal(layout.areaForGroup("links"),"relations");
  assert.equal(layout.tileClass({kind:"list",value:"a"}),"large");
  assert.equal(layout.tileClass({kind:"spark",value:"5"}),"medium");
  assert.equal(layout.tileClass({kind:"dots",value:"5"}),"small");
  const sample=[
    {id:"one",group:"core",title:"Занято всего",hint:"сумма",value:"42",empty:false},
    {id:"two",group:"style",title:"Разнообразие слов",hint:"нет данных",value:"—",empty:true},
    {id:"three",group:"style",title:"Частые слова",hint:"общее число",value:"5",empty:false}
  ];
  assert.deepEqual(layout.searchLifeMetrics(sample,backend.LIFE_GROUPS,"слова").map(m=>m.id),["three"]);
  assert.deepEqual(layout.searchLifeMetrics(sample,backend.LIFE_GROUPS,"ЯЗЫК","empty").map(m=>m.id),["two"]);
  assert.deepEqual(layout.searchLifeMetrics(sample,backend.LIFE_GROUPS,"","ready").map(m=>m.id),["one","three"]);
  assert.equal(sample.length,3,"UI filtering must not mutate the source metrics");
  const metric={id:"files",group:"core",hint:"столько лежит сейчас, без корзины",value:"2"};
  const method=layout.methodology(metric);
  assert.equal(method.verified,true);
  assert.match(method.method,/без корзины/);
  const unknown=layout.methodology({...metric,id:"not-existing"});
  assert.equal(unknown.verified,false);
  assert.equal(unknown.method,metric.hint,"Unknown formula should not be invented");
});

test("Full Disk Life API still returns exactly 150 metrics, 15 groups and six highlights, with verified file references",async()=>{
  const tmp=await mkdtemp(join(tmpdir(),"tsukimera-life-"));
  const app=createAppServer({root,dataDir:tmp});
  await app.load();
  await new Promise(done=>app.server.listen(0,"127.0.0.1",done));
  const origin="http://127.0.0.1:"+app.server.address().port;
  try{
    const payload=Buffer.from(("Документ Tsukimera хранит слова и предложения. Это локальный текст для анализа. ").repeat(35),"utf8");
    const upload=await fetch(origin+"/api/disk/files/binary?name="+encodeURIComponent("Аналитика.txt")+"&folder=",{
      method:"POST",headers:{"X-Tsukimera-Request":"1","Content-Type":"application/octet-stream"},body:payload
    });
    assert.equal(upload.status,201,await upload.text().catch(()=>""));
    const saved=(await(await fetch(origin+"/api/disk")).json()).files[0];
    const response=await fetch(origin+"/api/disk/life");
    assert.equal(response.status,200);
    const stats=await response.json();
    assert.equal(stats.groups.length,15);
    assert.equal(stats.metrics.length,150);
    assert.equal(stats.highlights.length,6);
    assert.equal(new Set(stats.groups.map(g=>g.id)).size,15);
    for(const id of stats.highlights){
      assert.ok(stats.metrics.some(m=>m.id===id),"Missing highlight "+id);
    }
    for(const id of ["biggest","smallest"]){
      const m=stats.metrics.find(m=>m.group==="core"&&m.id===id);
      assert.equal(m.sourceFileId,saved.id);
    }
    for(const metric of stats.metrics){
      if(metric.sourceFileId)assert.equal(metric.sourceFileId,saved.id,
        "Metrics must never reference untracked files");
    }
    assert.ok(stats.analysis.documents>=1);
    const raw=await readFile(join(root,"disk-src/web/pages/disk-life.ts"),"utf8");
    assert.match(raw,/openSheet/);
    assert.match(raw,/dkl-compact/);
    assert.match(raw,/dkl-expanded/);
    assert.match(raw,/LIFE_AREAS/);
    assert.match(raw,/IntersectionObserver/);
    assert.match(raw,/tsukimera:life-open-file/);
    assert.match(raw,/slice\(0,3\)/);
    const css=await readFile(join(root,"web/disk.css"),"utf8");
    for(const key of [".dk-life-expanded",".dkl-toolbar",".dkl-compact",".dkl-expanded",
      ".dkl-tile-small",".dkl-tile-medium",".dkl-tile-large","prefers-reduced-motion"])
      assert.ok(css.includes(key),"Missing style "+key);
  }finally{
    await new Promise(done=>app.server.close(done));
    await rm(tmp,{recursive:true,force:true});
  }
});
