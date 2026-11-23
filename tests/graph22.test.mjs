import {test} from "node:test";
import assert from "node:assert/strict";
import {mkdtemp,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join,resolve} from "node:path";
import {fileURLToPath} from "node:url";
import {spawnSync} from "node:child_process";
import {createAppServer} from "../scripts/server.mjs";
import {runPythonGraph} from "../scripts/python-graph.mjs";
const root=resolve(fileURLToPath(new URL("../",import.meta.url)));
function python(){
  const configured=process.env.TSUKIMERA_PYTHON||process.env.PYTHON;
  const options=[...(configured?[[configured,[]]]:[]),
    ...(process.platform==="win32"?[["py",["-3"]]]:[]),
    ["python3",[]],["python",[]]];
  for(const [exe,prefix] of options){
    const result=spawnSync(exe,[...prefix,"--version"],{encoding:"utf8",timeout:2000});
    if(result.status===0)return {exe,prefix};
  }
  return null;
}
test("Disk 22 Python engine passes stdlib SQLite source+queue integration suite",t=>{
  const p=python();if(!p)return t.skip("Optional Python is not installed");
  const run=spawnSync(p.exe,[...p.prefix,"python/test_graph22.py","-v"],{
    cwd:root,encoding:"utf8",timeout:18000});
  assert.equal(run.status,0,run.stdout+"\n"+run.stderr);
  assert.match(run.stderr,/Ran 3 tests/);
});
test("Disk 22 read-only Python Graph API is additive and cannot alter files",async t=>{
  if(!python())return t.skip("Optional Python is not installed");
  const dir=await mkdtemp(join(tmpdir(),"tsukimera-python22-"));
  const app=createAppServer({root,dataDir:dir});
  try{
    await app.load();
    await new Promise(ok=>app.server.listen(0,"127.0.0.1",ok));
    const origin="http://127.0.0.1:"+app.server.address().port;
    const request=async endpoint=>{
      const response=await fetch(origin+endpoint);
      return {status:response.status,data:await response.json()};
    };
    const view=await request("/api/disk/graph22/view?limit=18&level=far");
    assert.equal(view.status,200,JSON.stringify(view.data));
    assert.equal(view.data.source,"sqlite-python-22");
    assert.ok(view.data.nodes.some(node=>node.id==="folder:"));
    assert.equal(view.data.level,"far");
    assert.ok(view.data.visible<=18);
    assert.ok(Array.isArray(view.data.clusters));
    const path=await request("/api/disk/graph22/path?source=file:unknown&target=project:unknown");
    assert.equal(path.status,200,JSON.stringify(path.data));
    assert.equal(path.data.found,false);
    const diag=await request("/api/disk/graph22/diagnose");
    assert.equal(diag.status,200,JSON.stringify(diag.data));
    assert.equal(diag.data.danglingEdges,0);
    const timeline=await request("/api/disk/graph22/timeline");
    assert.equal(timeline.status,200,JSON.stringify(timeline.data));
    assert.ok(Array.isArray(timeline.data.events));
    const unknown=await request("/api/disk/graph22/delete");
    assert.equal(unknown.status,404);
    // All established Disk endpoints must remain reachable.
    const catalog=await request("/api/disk");
    assert.equal(catalog.status,200);
    assert.ok(Array.isArray(catalog.data.files));
  }finally{
    if(app.server.listening)await new Promise(ok=>app.server.close(ok));
    await rm(dir,{recursive:true,force:true});
  }
});
test("Disk 22 has one reusable Canvas, real route parallax and fallback",async()=>{
  const {readFile}=await import("node:fs/promises");
  const [app,disk,map,css,api]=await Promise.all([
    readFile(join(root,"web/app.js"),"utf8"),
    readFile(join(root,"disk-src/web/pages/disk.ts"),"utf8"),
    readFile(join(root,"disk-src/web/pages/disk-map-mini.ts"),"utf8"),
    readFile(join(root,"web/tsukimera.css"),"utf8"),
    readFile(join(root,"disk-src/web/api.ts"),"utf8")]);
  for(const marker of ["window.__tsukimeraGraph22?.park?.()",
    "window.__tsukimeraDisk22Page","tsukimera:disk-resume",
    "--ts22-shift"])assert.ok(app.includes(marker),marker);
  for(const marker of ["universeHost.append(miniMap.root)","miniMap.root.parentElement!==side",
    "miniMap.centerFile(f.id)","tsukimera-universe-stage"])
    assert.ok(disk.includes(marker),marker);
  assert.ok(map.includes("graph22ToSemantic(python.value)"));
  assert.ok(map.includes("api.diskKnowledgeGraph()"),"No regression without Python");
  assert.ok(map.includes("ctx.fillStyle=\"#09090c\""));
  assert.ok(css.includes("pointer-events:none!important"));
  assert.ok(api.includes("diskGraph22View:"));
});
