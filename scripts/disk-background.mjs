/**
 * Cooperative maintenance queue. Lives only while the local Tsukimera server
 * is running. No external scheduler or cloud calls, bounded work per tick.
 */
import {createReadStream} from "node:fs";
import {createHash} from "node:crypto";
import {join} from "node:path";

async function verifyObject(path,expectedSize,expectedSha){
  let size=0;
  const hash=createHash("sha256");
  try{
    for await(const part of createReadStream(path)){size+=part.length;hash.update(part);}
  }catch(error){
    if(error?.code==="ENOENT")return "missing";
    throw error;
  }
  return size===expectedSize&&hash.digest("hex")===expectedSha?"ok":"corrupt";
}
export function createDiskAutomation({
  database,diskRoot,readText,initialDelayMs=4000,workDelayMs=1400,
  idleDelayMs=15000,maintenanceHours=6,logger=console,
}){
  let stopped=false,running=false,timer=null;
  let lastMaintenance=Date.now(),active=null;
  const stats={indexed:0,audited:0,failures:0,retries:0,lastError:null,lastRun:null,
    lastOptimized:null,optimization:null};
  const stop=()=>{
    stopped=true;
    if(timer!==null){clearTimeout(timer);timer=null;}
  };
  const schedule=delay=>{
    if(stopped)return;
    if(timer!==null)clearTimeout(timer);
    timer=setTimeout(()=>{timer=null;void runOne();},delay);
    timer.unref?.();
  };
  const work=async()=>{
    if(Date.now()-lastMaintenance>=maintenanceHours*3600000){
      active={type:"sqlite-optimize"};
      const out=database.optimize();
      stats.optimization=out.integrity;
      stats.lastOptimized=out.at;
      lastMaintenance=Date.now();
      return true;
    }
    const pending=database.pendingTextIndex(1);
    if(pending.length){
      active={type:"text-index",fileId:pending[0].id};
      const row=pending[0];
      let value=database.getTextCache(row.sha256);
      if(value===null){
        try{
          const result=await readText(row.id,192000);
          value=result.text||"";
        }catch(error){
          // A corrupt/unreadable source is not considered searchable; it will
          // be reindexed automatically if its SHA changes.
          value="";
        }
      }
      const out=database.putTextIndex({id:row.id,sha:row.sha256,body:value});
      if(out.indexed)stats.indexed++;
      return true;
    }
    const target=database.auditNext();
    if(target){
      active={type:"integrity-audit",fileId:target.file_id};
      const path=join(diskRoot,"objects",target.object_id);
      const status=await verifyObject(path,target.size,target.sha);
      if(database.auditRecord(target,status))stats.audited++;
      return true;
    }
    return false;
  };
  async function runOne(){
    if(stopped||running)return;
    running=true;stats.lastRun=new Date().toISOString();
    let didWork=false;
    try{
      didWork=await work();
      stats.lastError=null;
    }catch(error){
      stats.failures++;
      stats.lastError=error instanceof Error?error.message:String(error);
      logger.error("Диск: сбой фонового обслуживания:",stats.lastError);
    }finally{
      active=null;running=false;
      schedule(stopped?0:stats.lastError?Math.max(30000,idleDelayMs):
        didWork?workDelayMs:idleDelayMs);
    }
  }
  const wake=()=>{
    if(!stopped&&!running)schedule(150);
  };
  const status=()=>({
    running:!stopped,active,counts:{...stats},index:database.indexStats(),
    audit:database.auditStats(),mode:"idle-cooperative",
    note:"Задачи работают только при запущенной Tsukimera. Нет очистки или автоматического удаления оригиналов.",
  });
  return {start:()=>{if(stopped)return;schedule(initialDelayMs);},stop,wake,status,runNow:runOne};
}
