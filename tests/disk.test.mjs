import {test} from "node:test";
import assert from "node:assert/strict";
import {mkdtemp,readFile,rm,stat} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join,resolve} from "node:path";
import {fileURLToPath} from "node:url";
import {createAppServer} from "../scripts/server.mjs";
import http from "node:http";
import {prepareDisk} from "../scripts/build-disk.mjs";

const root=resolve(fileURLToPath(new URL("../",import.meta.url)));
const data=(value)=>JSON.stringify(value);
const headers={"X-Tsukimera-Request":"1","Content-Type":"application/json"};
async function withServer(fn){
  const dataDir=await mkdtemp(join(tmpdir(),"tsukimera-full-disk-"));
  const app=createAppServer({root,dataDir});
  await app.load();
  await new Promise(resolve=>app.server.listen(0,"127.0.0.1",resolve));
  const origin="http://127.0.0.1:"+app.server.address().port;
  const request=async(path,method="GET",body)=>{
    const r=await fetch(origin+path,{method,headers:headers,body:body===undefined?undefined:data(body)});
    return {status:r.status,body:await r.json()};
  };
  try{await fn({app,dataDir,origin,request});}
  finally{await new Promise(done=>app.server.close(done));await rm(dataDir,{recursive:true,force:true});}
}

test("JUUNIBI Disk TypeScript sources compile offline into Node and browser JS without npm",async()=>{
  const r=await prepareDisk(root);
  assert.ok(r.converted>=24,"all original frontend and server sources must be compiled");
  const runtime=await readFile(join(r.outputRoot,"web","pages","disk.js"),"utf8");
  assert.match(runtime,/export function diskPage/);
  assert.match(runtime,/from "\.\.\/api\.js"/);
  assert.doesNotMatch(runtime,/import "\.\/disk\.css"/);
  assert.doesNotMatch(runtime,/JUUNIBI/);
  const backend=await readFile(join(r.outputRoot,"server","local-disk.js"),"utf8");
  assert.match(backend,/class LocalDisk/);
  assert.match(backend,/office-preview\.js/);
});

test("Disk HTTP: folders, binary uploads, preview, metadata, ZIP, versions, trash, restore, audit",async()=>{
 await withServer(async({app,dataDir,origin,request})=>{
  assert.ok(app.getDisk(),"Disk startup must initialize a real local file store");
  let r=await request("/api/disk");
  assert.equal(r.status,200);assert.equal(r.body.files.length,0);
  r=await request("/api/disk/folders","POST",{name:"Документы"});
  assert.equal(r.status,201,JSON.stringify(r.body));
  const bytes=Buffer.from("Привет, Tsukimera! Это тестовый файл.\n","utf8");
  const upload=await fetch(origin+"/api/disk/files/binary?name="+encodeURIComponent("Тест.txt")+"&folder="+encodeURIComponent("Документы"),{
    method:"POST",headers:{"X-Tsukimera-Request":"1","Content-Type":"application/octet-stream"},body:bytes
  });
  assert.equal(upload.status,201,await upload.text().catch(()=>""));
  // Upload response was consumed above only for error string; read file from listing.
  r=await request("/api/disk");
  assert.equal(r.status,200);
  const entry=r.body.files.find(x=>x.name==="Тест.txt");
  assert.ok(entry);
  assert.equal(entry.folder,"Документы");
  assert.equal(entry.size,bytes.length);
  const id=entry.id;
  const raw=await fetch(origin+"/api/disk/files/"+id+"/raw");
  assert.equal(raw.status,200);assert.deepEqual(Buffer.from(await raw.arrayBuffer()),bytes);
  const ranged=await fetch(origin+"/api/disk/files/"+id+"/raw",{headers:{Range:"bytes=0-5"}});
  assert.equal(ranged.status,206);assert.equal((await ranged.arrayBuffer()).byteLength,6);
  const text=await request("/api/disk/files/"+id+"/text");
  assert.equal(text.status,200);assert.match(text.body.text,/Tsukimera/);
  r=await request("/api/disk/metadata","POST",{id,tags:["важное"],color:"#d9a441",note:"Тест"});
  assert.equal(r.status,200,JSON.stringify(r.body));
  r=await request("/api/disk/files/"+id,"PATCH",{name:"Переименован.txt"});
  assert.equal(r.status,200,JSON.stringify(r.body));
  r=await request("/api/disk/favorite","POST",{id,favorite:true});
  assert.equal(r.status,200);
  r=await request("/api/disk/files/"+id+"/versions");
  assert.equal(r.status,200);assert.ok(Array.isArray(r.body.versions));
  r=await request("/api/disk/zip","POST",{ids:[id]});
  assert.equal(r.status,200,JSON.stringify(r.body));
  const zip=await fetch(origin+r.body.url);
  assert.equal(zip.status,200);
  const zipBuf=Buffer.from(await zip.arrayBuffer());
  assert.equal(zipBuf.subarray(0,4).toString("hex"),"504b0304");
  const duplicate=await request("/api/disk/duplicates");
  assert.equal(duplicate.status,200);
  const audit=await request("/api/disk/audit");
  assert.equal(audit.status,200);
  r=await request("/api/disk/life");
  assert.equal(r.status,200,JSON.stringify(r.body).slice(0,500));
  assert.equal(r.body.metrics.length,150);
  const snapshot=await request("/api/disk/snapshot");
  assert.equal(snapshot.status,200);assert.ok(snapshot.body.files.length);
  const backup=await fetch(origin+"/api/disk/backup");
  assert.equal(backup.status,200);
  assert.match(backup.headers.get("content-type"),/x-ndjson/);
  assert.ok((await backup.text()).length>50);
  r=await request("/api/disk/files/history");
  assert.equal(r.status,200);
  r=await request("/api/disk/files/"+id,"DELETE");
  assert.equal(r.status,200,JSON.stringify(r.body));
  r=await request("/api/disk");
  assert.ok(r.body.trash.some(x=>x.id===id));
  r=await request("/api/disk/restore","POST",{id});
  assert.equal(r.status,200);
  r=await request("/api/disk");
  assert.ok(r.body.files.some(x=>x.id===id));
  const diskData=await stat(join(dataDir,"disk"));
  assert.ok(diskData.isDirectory());
 });
});

test("Disk HTTP rejects path escapes, foreign origins and hidden server runtime",async()=>{
  await withServer(async({origin,request})=>{
    let r=await request("/api/disk/folders","POST",{name:"../escape"});
    assert.equal(r.status,400);
    r=await request("/api/disk/folders","POST",{name:"../../.runtime"});
    assert.equal(r.status,400);
    const hostile=await fetch(origin+"/api/disk/folders",{
      method:"POST",headers:{"Content-Type":"application/json",Origin:"https://attacker.invalid"},
      body:data({name:"attacker"})});
    assert.equal(hostile.status,403);
    const privateFile=await fetch(origin+"/disk-built/server/local-disk.js");
    assert.equal(privateFile.status,404);
    const source=await fetch(origin+"/disk-src/server/local-disk.ts");
    assert.equal(source.status,404);
    const ui=await fetch(origin+"/disk-built/web/pages/disk.js");
    assert.equal(ui.status,200);
    assert.match(ui.headers.get("content-type"),/javascript/);
    const css=await fetch(origin+"/disk.css");
    assert.equal(css.status,200);
    assert.match(await css.text(),/dk-layout/);
    const invalid=await fetch(origin+"/api/disk/UNKNOWN");
    assert.equal(invalid.status,404);
    // Undici fetch may normalize the Host header: send a real HTTP request.
    const wrongHost=await new Promise((resolve,reject)=>{
      const req=http.get(origin+"/api/disk",{headers:{Host:"evil.example"}},response=>{
        response.resume();
        response.on("end",()=>resolve(response.statusCode));
      });
      req.on("error",reject);
    });
    assert.equal(wrongHost,403);
  });
});
