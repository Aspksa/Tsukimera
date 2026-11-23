import {test} from "node:test";
import assert from "node:assert/strict";
import {mkdtemp,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join,resolve} from "node:path";
import {fileURLToPath} from "node:url";
import {DatabaseSync} from "node:sqlite";
import {createAppServer} from "../scripts/server.mjs";
import {extractDiskFacts} from "../scripts/disk-knowledge.mjs";
const root=resolve(fileURLToPath(new URL("../",import.meta.url)));
const sleep=ms=>new Promise(ok=>setTimeout(ok,ms));
async function open(dir){
  const app=createAppServer({root,dataDir:dir});
  await app.load();
  await new Promise(ok=>app.server.listen(0,"127.0.0.1",ok));
  return {app,url:"http://127.0.0.1:"+app.server.address().port,
    close:()=>new Promise(ok=>app.server.close(ok))};
}
async function get(url,path){
  const r=await fetch(url+path);return {code:r.status,data:await r.json()};
}
async function upload(url,name,body,folder=""){
  const r=await fetch(url+"/api/disk/files/binary?name="+encodeURIComponent(name)+
    "&folder="+encodeURIComponent(folder),{
      method:"POST",headers:{"Content-Type":"application/octet-stream",
        "X-Tsukimera-Request":"1"},body:Buffer.from(body)});
  const data=await r.json();assert.equal(r.status,201,JSON.stringify(data));return data;
}
async function until(task,timeout=11000){
  const start=Date.now();
  while(Date.now()-start<timeout){
    const result=await task();if(result)return result;
    await sleep(140);
  }
  assert.fail("Knowledge background queue did not finish within test bound");
}
test("Disk 20 pure document analysis only extracts literal source-backed facts",()=>{
  const r=extractDiskFacts("Договор поставки.txt",
    "Договор №57/2026 заключён с ООО «Ромашка». "+
    "Стоимость 100 000 руб. Приложение №3 от 23.11.2026.");
  assert.equal(r.type,"contract");
  for(const [kind,expected] of [
    ["contract","57/2026"],["organization","Ромашка"],
    ["amount","100 000"],["appendix","3"],["date","23.11.2026"]
  ]){
    const found=r.facts.find(x=>x.kind===kind&&x.value.includes(expected));
    assert.ok(found,"Missing literal "+kind+" "+expected+" in "+JSON.stringify(r.facts));
    assert.ok(found.position>=0&&found.evidence&&found.certainty<1);
  }
  const empty=extractDiskFacts("Скан.pdf","");
  assert.equal(empty.unreadable,true);
  assert.deepEqual(empty.facts,[]);
  const noMagic=extractDiskFacts("Обычная заметка.txt","Иван и Пётр обсуждали проект.");
  assert.equal(noMagic.facts.some(x=>x.kind==="contract"),false);
});
test("Disk 20 automatically indexes, cites, ranks and persists knowledge without moving sources",async()=>{
  const dir=await mkdtemp(join(tmpdir(),"tsukimera-disk20-"));
  let s;
  try{
    s=await open(dir);
    const one=await upload(s.url,"Договор 57.txt",
      "Договор №57/2026. ООО «Ромашка». Стоимость 100 000 руб. "+
      "Приложение №3. Солнечная долина и подписанный договор.");
    const two=await upload(s.url,"Акт 57.txt",
      "Акт. По договору №57/2026 ООО «Ромашка». "+
      "Стоимость 150 000 руб. Солнечная долина.");
    await until(async()=>{
      const x=(await get(s.url,"/api/disk/knowledge/status")).data;
      return x.analyzed>=2&&x.pending===0&&x.links>=1?x:null;
    });
    const info=(await get(s.url,"/api/disk/knowledge?fileId="+one.id)).data;
    assert.equal(info.ready,true);
    assert.ok(info.facts.some(f=>f.kind==="contract"&&f.value.includes("57/2026")));
    assert.ok(info.links.some(l=>l.fileId===two.id&&l.kind==="contract"));
    assert.ok(info.links.every(l=>l.evidence&&l.confidence<=1));
    assert.ok(info.suggestions.some(x=>x.kind==="missing-attachment"));
    assert.ok(info.suggestions.some(x=>x.kind==="folder"&&!x.automatic));
    assert.ok(info.alerts.some(x=>x.kind==="potential-amount-difference"));
    const graph=(await get(s.url,"/api/disk/knowledge/graph")).data;
    assert.ok(graph.links.some(l=>l.source==="file:"+one.id&&l.target==="file:"+two.id||
      l.target==="file:"+one.id&&l.source==="file:"+two.id));
    assert.ok(graph.nodes.some(n=>n.kind==="project"&&n.name.includes("57/2026")));
    const found=(await get(s.url,"/api/disk/search?q="+encodeURIComponent("солнеч"))).data;
    assert.ok(found.ids.includes(one.id)&&found.ids.includes(two.id));
    assert.ok(found.matches.some(x=>x.id===one.id&&x.excerpt.includes("«солнеч")),
      "FTS5 query snippets should identify the actual matched text");
    assert.ok(found.matches.every(x=>Number.isFinite(x.rank)));
    const invalid=await get(s.url,"/api/disk/knowledge?fileId=../../anything");
    assert.equal(invalid.code,400);
    const duplicate=await upload(s.url,"Копия 57.txt",
      "Договор №57/2026. ООО «Ромашка». Стоимость 100 000 руб. "+
      "Приложение №3. Солнечная долина и подписанный договор.");
    await until(async()=>{
      const info=(await get(s.url,"/api/disk/knowledge?fileId="+one.id)).data;
      return info.suggestions.some(x=>x.kind==="duplicate"&&x.fileId===duplicate.id);
    });
    // Any schema changes remain purely additive; v3 disk catalog is untouched.
    const db=new DatabaseSync(join(dir,"tsukimera.db"),{readOnly:true});
    try{
      assert.equal(db.prepare("SELECT value FROM metadata WHERE key='schema_version'").get().value,"3");
      assert.ok(db.prepare("SELECT count(*) AS n FROM disk_knowledge_facts").get().n>=8);
      assert.ok(db.prepare("SELECT count(*) AS n FROM disk_knowledge_links").get().n>=1);
      assert.equal(db.prepare("SELECT count(*) AS n FROM disk_entries").get().n,3);
    }finally{db.close();}
    await s.close();s=null;
    s=await open(dir);
    assert.ok((await get(s.url,"/api/disk/knowledge/status")).data.analyzed>=3,
      "The knowledge cache must survive a whole server restart");
    assert.ok((await get(s.url,"/api/disk/knowledge?fileId="+one.id)).data.ready);
    const changed=await fetch(s.url+"/api/disk/files/"+two.id+
      "/versions/binary?expected="+two.sha256,{
        method:"POST",headers:{"Content-Type":"application/octet-stream",
          "X-Tsukimera-Request":"1"},
        body:Buffer.from("Акт №88/2026. Без ссылки на старый договор и организацию.")});
    assert.equal(changed.status,200,await changed.text());
    const withoutStale=(await get(s.url,"/api/disk/knowledge?fileId="+one.id)).data;
    assert.ok(!withoutStale.links.some(l=>l.fileId===two.id),
      "Links invalidated synchronously with the source revision");
    await until(async()=>{
      const st=(await get(s.url,"/api/disk/knowledge/status")).data;
      return st.pending===0?st:null;
    });
    const later=(await get(s.url,"/api/disk/knowledge?fileId="+one.id)).data;
    assert.ok(!later.links.some(l=>l.fileId===two.id),
      "Old links must never be resurrected from another SHA");
    assert.equal((await get(s.url,"/api/disk")).data.files.length,3,
      "Suggestions do not move, delete or replace files");
  }finally{
    if(s&&s.app.server.listening)await s.close();
    await rm(dir,{recursive:true,force:true});
  }
});
