/**
 * Settings 4.0: automatic SQLite-only snapshots while Tsukimera is running.
 * No copy of data/disk/objects is implied. Only settings-auto-* files are
 * pruned; manual, restore and migration backups are never touched.
 */
import {DatabaseSync,backup as sqliteBackup} from "node:sqlite";
import {stat,statfs,mkdir,readdir,rename,rm} from "node:fs/promises";
import {join} from "node:path";
import {randomUUID} from "node:crypto";

const DAY=24*60*60*1000;
const MiB=1024*1024;
const PREFIX="settings-auto-";
const AUTO_NAME=/^settings-auto-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-[0-9a-f]{8}\.db$/;
const timeName=(time,id)=>PREFIX+new Date(time).toISOString()
  .replace(/:/g,"-").replace(/\./g,"-")+"-"+id+".db";
const isMissing=error=>error?.code==="ENOENT";

export function createSettingsBackupService({
  dataDir,clock=()=>Date.now(),intervalMs=DAY,maxCopies=7,
  maxTotalBytes=512*MiB,maxSnapshotBytes=256*MiB,
  initialDelayMs=12000,
}={}){
  if(!dataDir)throw Error("Backups require local data directory");
  const file=join(dataDir,"tsukimera.db"),directory=join(dataDir,"backups");
  let timer=null,periodic=null,stopped=false,busy=null;
  let lastError="",lastOutcome="Ожидание первой проверки";
  async function entries(){
    let names=[];
    try{names=await readdir(directory);}
    catch(error){if(isMissing(error))return [];throw error;}
    const safe=names.filter(name=>AUTO_NAME.test(name));
    const rows=await Promise.all(safe.map(async name=>{
      try{
        const info=await stat(join(directory,name));
        return info.isFile()?{name,bytes:info.size,at:info.mtimeMs}:null;
      }catch(error){if(isMissing(error))return null;throw error;}
    }));
    return rows.filter(Boolean).sort((a,b)=>b.at-a.at||b.name.localeCompare(a.name));
  }
  async function status(){
    const saved=await entries();
    const sizeBytes=saved.reduce((a,b)=>a+b.bytes,0);
    const last=saved[0]||null;
    return {enabled:true,scope:"sqlite-only",frequencyHours:intervalMs/3600000,
      retain:maxCopies,maxTotalBytes,maxSnapshotBytes,stored:saved.length,sizeBytes,
      lastBackup:last?{name:last.name,at:new Date(last.at).toISOString(),bytes:last.bytes}:null,
      nextDue:last?new Date(last.at+intervalMs).toISOString():null,
      lastOutcome,lastError};
  }
  async function runIfDue({force=false}={}){
    if(busy)return busy;
    busy=(async()=>{
      if(stopped)return {created:false,reason:"stopped"};
      const saved=await entries();
      if(!force&&saved[0]&&clock()-saved[0].at<intervalMs)
        return {created:false,reason:"not-due"};
      const size=(await stat(file)).size;
      if(size<=0||size>maxSnapshotBytes){
        lastOutcome="Пропущено: SQLite превышает ограничение размера снимка";
        return {created:false,reason:"size-limit"};
      }
      // Without a trustworthy free-space measurement it is safer not to
      // create a backup. Headroom covers the SQLite snapshot and OS activity.
      let freeBytes=0;
      try{
        const disk=await statfs(dataDir);
        freeBytes=Number(disk.bavail)*Number(disk.bsize);
      }catch(error){
        lastOutcome="Пропущено: свободное место проверить не удалось";
        lastError=String(error.message||error);
        return {created:false,reason:"space-unknown"};
      }
      if(freeBytes<size*2+32*MiB){
        lastOutcome="Пропущено: недостаточно свободного места";
        return {created:false,reason:"low-space"};
      }
      await mkdir(directory,{recursive:true});
      const name=timeName(clock(),randomUUID().slice(0,8));
      const destination=join(directory,name),temp=destination+".tmp";
      const db=new DatabaseSync(file,{readOnly:true});
      try{
        await sqliteBackup(db,temp);
      }finally{
        db.close();
      }
      try{
        const snapshot=await stat(temp);
        if(!snapshot.size)throw Error("SQLite backup is empty");
        await rename(temp,destination);
      }catch(error){
        await rm(temp,{force:true}).catch(()=>{});
        throw error;
      }
      const latest=await entries();
      let total=latest.reduce((sum,row)=>sum+row.bytes,0);
      let retained=latest.length;
      // Keep at least the just-created newest copy even when it alone is near
      // the budget. Remove only our own old automatic snapshots.
      for(const row of latest.slice(1).reverse()){
        if(retained<=maxCopies&&total<=maxTotalBytes)break;
        await rm(join(directory,row.name),{force:true});
        retained--;total-=row.bytes;
      }
      lastError="";
      lastOutcome="Автоматический снимок SQLite создан";
      return {created:true,name,bytes:(await stat(destination)).size};
    })().catch(error=>{
      lastError=String(error.message||error);
      lastOutcome="Не удалось создать автоматический снимок";
      throw error;
    }).finally(()=>{busy=null;});
    return busy;
  }
  function start(){
    if(timer||periodic||stopped)return;
    const check=()=>{void runIfDue().catch(error=>
      console.error("Tsukimera automatic SQLite backup:",error.message));};
    timer=setTimeout(()=>{
      timer=null;if(stopped)return;
      check();
      periodic=setInterval(check,Math.min(intervalMs,60*60*1000));
      periodic.unref?.();
    },initialDelayMs);
    timer.unref?.();
  }
  function stop(){
    stopped=true;
    if(timer)clearTimeout(timer);
    if(periodic)clearInterval(periodic);
    timer=null;periodic=null;
  }
  return {start,stop,status,runIfDue};
}
