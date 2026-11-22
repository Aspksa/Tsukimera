import {test} from "node:test";
import assert from "node:assert/strict";
import {join,resolve} from "node:path";
import {pathToFileURL,fileURLToPath} from "node:url";
import {createAppServer} from "../scripts/server.mjs";
import {prepareDisk} from "../scripts/build-disk.mjs";
import {mkdtemp,rm,readFile,stat} from "node:fs/promises";
import {tmpdir} from "node:os";

const root=resolve(fileURLToPath(new URL("../",import.meta.url)));
const headers={"X-Tsukimera-Request":"1"};
function mock(name,id,folder="",size=12){
  return {name,id,folder,size,uploadedAt:"2026-11-22T00:00:00.000Z",sha256:"a".repeat(64),tags:[]};
}
test("Disk smart folders, rename preview, column preferences and safe file links build offline",async()=>{
  const result=await prepareDisk(root);
  const module=await import(pathToFileURL(join(result.outputRoot,"web/pages/disk-extras.js")).href);
  const files=[mock("a.txt","1"),mock("b.txt","2"),mock("record.pdf","3","Документы")];
  const plan=module.renamePlan(files.slice(0,2),files,"{name}_{n}.{ext}",7);
  assert.deepEqual(plan.map(x=>x.to),["a_07.txt","b_08.txt"]);
  assert.ok(plan.every(x=>x.valid));
  const collide=module.renamePlan(files.slice(0,1),files,"b.txt",1);
  assert.equal(collide[0].valid,false);
  const invalid=module.renamePlan(files.slice(0,1),files,"../oops",1);
  assert.equal(invalid[0].valid,false);
  const rule={id:"r",name:"Договоры",field:"extension",pattern:"pdf"};
  assert.equal(module.matchesSmartRule(files[2],rule),true);
  assert.equal(module.matchesSmartRule(files[0],rule),false);
  assert.equal(module.matchesSmartRule(files[0],{...rule,field:"name",pattern:"A.TXT"}),true);
  const view=await readFile(join(root,"disk-src/web/pages/disk.ts"),"utf8");
  assert.match(view,/openDiskCommands/);
  assert.match(view,/openDiskMap/);
  assert.match(view,/openBatchRename/);
  assert.match(view,/openSmartManager/);
  assert.match(view,/dkx-quick-preview/);
  assert.match(view,/openInfo\(f.id\)/);
  const css=await readFile(join(root,"web/disk.css"),"utf8");
  assert.match(css,/Tsukimera Disk Experience/);
  assert.match(css,/prefers-reduced-motion/);
  assert.match(css,/dkx-col-folder/);
});

test("Resumable disk uploads survive service restart and commit only after the full file",async()=>{
  const dir=await mkdtemp(join(tmpdir(),"tsukimera-resume-"));
  const app1=createAppServer({root,dataDir:dir});
  await app1.load();
  await new Promise(done=>app1.server.listen(0,"127.0.0.1",done));
  let base="http://127.0.0.1:"+app1.server.address().port;
  const json=async(method,path,data,more={})=>{
    const r=await fetch(base+path,{method,
      headers:{...headers,"Content-Type":"application/json",...more},
      body:data===undefined?undefined:JSON.stringify(data)});
    return {status:r.status,value:await r.json()};
  };
  let app2;
  try{
    let r=await json("POST","/api/disk/uploads",{name:"Большой.txt",folder:"",size:14});
    assert.equal(r.status,201,JSON.stringify(r.value));
    const id=r.value.id;
    const put=async(offset,body)=>{
      const response=await fetch(base+"/api/disk/uploads/"+id,{method:"PATCH",
        headers:{...headers,"Content-Type":"application/octet-stream","X-Upload-Offset":String(offset)},body});
      return {status:response.status,value:await response.json()};
    };
    r=await put(0,Buffer.from("Привет","utf8"));
    assert.equal(r.status,200,JSON.stringify(r.value));
    assert.equal(r.value.offset,12);
    r=await json("GET","/api/disk/uploads/"+id);
    assert.equal(r.value.offset,12);
    r=await json("POST","/api/disk/uploads/"+id+"/complete");
    assert.equal(r.status,409,"Incomplete transfer must not be committed");
    let disk=await json("GET","/api/disk");
    assert.equal(disk.value.files.length,0);
    await new Promise(done=>app1.server.close(done));
    app2=createAppServer({root,dataDir:dir});
    await app2.load();await new Promise(done=>app2.server.listen(0,"127.0.0.1",done));
    base="http://127.0.0.1:"+app2.server.address().port;
    r=await json("GET","/api/disk/uploads/"+id);
    assert.equal(r.status,200);
    assert.equal(r.value.offset,12);
    const wrong=await put(0,Buffer.from("!!"));
    assert.equal(wrong.status,409);
    r=await put(12,Buffer.from("!!"));
    assert.equal(r.status,200,JSON.stringify(r.value));
    assert.equal(r.value.offset,14);
    r=await json("POST","/api/disk/uploads/"+id+"/complete");
    assert.equal(r.status,201,JSON.stringify(r.value));
    assert.equal(r.value.name,"Большой.txt");
    disk=await json("GET","/api/disk");
    assert.equal(disk.value.files.length,1);
    const bytes=await fetch(base+"/api/disk/files/"+r.value.id+"/raw");
    assert.equal(await bytes.text(),"Привет!!");
    const gone=await json("GET","/api/disk/uploads/"+id);
    assert.equal(gone.status,404);
    const meta=join(dir,"uploads",id+".json");
    await assert.rejects(()=>stat(meta));
    const bad=await json("POST","/api/disk/uploads",{name:"../no.txt",folder:"",size:5});
    assert.equal(bad.status,400);
  }finally{
    if(app1.server.listening)await new Promise(done=>app1.server.close(done));
    if(app2?.server.listening)await new Promise(done=>app2.server.close(done));
    await rm(dir,{recursive:true,force:true});
  }
});
