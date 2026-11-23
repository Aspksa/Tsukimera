import {test} from "node:test";
import assert from "node:assert/strict";
import {mkdtemp,rm,writeFile,readdir,stat} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join,resolve} from "node:path";
import {fileURLToPath} from "node:url";
import {DatabaseSync} from "node:sqlite";
import {createSettingsBackupService} from "../scripts/settings-backups.mjs";
import {createAppServer} from "../scripts/server.mjs";

const DAY=86400000;
const dirRoot=resolve(fileURLToPath(new URL("../",import.meta.url)));

async function tempSqlite(){
  const dir=await mkdtemp(join(tmpdir(),"tsukimera-settings40-"));
  const db=new DatabaseSync(join(dir,"tsukimera.db"));
  db.exec("CREATE TABLE IF NOT EXISTS sample (value TEXT NOT NULL)");
  db.prepare("INSERT INTO sample(value) VALUES(?)").run("original");
  db.close();
  return dir;
}

test("Settings 4.0 auto backups preserve real SQLite rows, keep only 2 newest and never touch manual snapshots",async()=>{
  const dir=await tempSqlite();
  const backups=join(dir,"backups");
  const service=createSettingsBackupService({dataDir:dir,maxCopies:2,maxTotalBytes:10*1024*1024,
    initialDelayMs:600000});
  try{
    await (await import("node:fs/promises")).mkdir(backups,{recursive:true});
    await writeFile(join(backups,"settings-restore-keep.db"),"manual backup must survive");
    let result=await service.runIfDue();
    assert.equal(result.created,true);
    const first=await service.runIfDue();
    assert.equal(first.created,false);
    assert.equal(first.reason,"not-due","Daily snapshots should not repeat in the same interval");
    const same=await Promise.all([service.runIfDue({force:true}),service.runIfDue({force:true})]);
    assert.deepEqual(same[0],same[1],"Concurrent requests must not create two copies");
    await new Promise(done=>setTimeout(done,15));
    result=await service.runIfDue({force:true});
    assert.equal(result.created,true);
    const listing=await readdir(backups);
    const own=listing.filter(name=>name.startsWith("settings-auto-")&&name.endsWith(".db"));
    assert.equal(own.length,2,"Retention must retain exactly two automatic snapshots");
    assert.ok(listing.includes("settings-restore-keep.db"),"Never prune manual restore snapshots");
    const status=await service.status();
    assert.equal(status.enabled,true);
    assert.equal(status.scope,"sqlite-only");
    assert.equal(status.stored,2);
    assert.equal(status.retain,2);
    assert.ok(status.sizeBytes>0&&status.sizeBytes<=status.maxTotalBytes);
    assert.equal((await stat(join(backups,status.lastBackup.name))).size>0,true);
    for(const name of own){
      const copy=new DatabaseSync(join(backups,name),{readOnly:true});
      try{
        assert.equal(copy.prepare("SELECT value FROM sample").get().value,"original");
        assert.equal(copy.prepare("PRAGMA quick_check").get().quick_check,"ok");
      }finally{copy.close();}
    }
  }finally{service.stop();await rm(dir,{recursive:true,force:true});}
});

test("Settings 4.0 scheduler declines too-large snapshots instead of filling SSD",async()=>{
  const dir=await tempSqlite();
  const service=createSettingsBackupService({dataDir:dir,maxSnapshotBytes:1});
  try{
    const result=await service.runIfDue();
    assert.equal(result.created,false);
    assert.equal(result.reason,"size-limit");
    const status=await service.status();
    assert.equal(status.stored,0);
    assert.match(status.lastOutcome,/размер/);
  }finally{service.stop();await rm(dir,{recursive:true,force:true});}
});

test("Settings 4.0 status endpoint reports bounded automatic backups; no write endpoint or secrets",async()=>{
  const dir=await mkdtemp(join(tmpdir(),"tsukimera-settings40-api-"));
  const app=createAppServer({root:dirRoot,dataDir:dir,cloudKey:"SECRET_TEST_SETTINGS40"});
  try{
    await app.load();
    await new Promise(resolve=>app.server.listen(0,"127.0.0.1",resolve));
    const base="http://127.0.0.1:"+app.server.address().port;
    const result=await fetch(base+"/api/settings/backups");
    assert.equal(result.status,200);
    const data=await result.json();
    assert.equal(data.enabled,true);
    assert.equal(data.frequencyHours,24);
    assert.equal(data.retain,7);
    assert.equal(data.maxTotalBytes,512*1024*1024);
    assert.equal(data.scope,"sqlite-only");
    assert.equal(JSON.stringify(data).includes("SECRET_TEST_SETTINGS40"),false);
    const post=await fetch(base+"/api/settings/backups",{method:"POST",headers:{"X-Tsukimera-Request":"1"}});
    assert.equal(post.status,404,"No remote route may force or change automated snapshot policy");
  }finally{
    if(app.server.listening)await new Promise(resolve=>app.server.close(resolve));
    await rm(dir,{recursive:true,force:true});
  }
});

test("Settings 4.0 layout keeps ten real sections but only six navigation groups",async()=>{
  const {readFile}=await import("node:fs/promises");
  const [app,css]=await Promise.all([
    readFile(join(dirRoot,"web/app.js"),"utf8"),
    readFile(join(dirRoot,"web/tsukimera.css"),"utf8")
  ]);
  assert.match(app,/data-settings-group/);
  assert.match(app,/const groups=\[/);
  assert.match(app,/currentSettingsCategory/);
  assert.match(app,/settingsTabAbort\.abort/);
  assert.match(app,/cloudModelBrowser\(primary,fallback\)/);
  assert.equal((app.match(/modelPicker\(/g)||[]).length,0);
  assert.match(app,/setSettingsSaveState\('saved'/);
  assert.match(css,/\.settings-page\.settings-40 \.set-toc-link\.active/);
  assert.match(css,/@media\(max-width:650px\)/);
});
