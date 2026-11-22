import {randomUUID} from "node:crypto";
import {mkdir,readFile,writeFile,rename,rm,open,readdir} from "node:fs/promises";
import {createReadStream} from "node:fs";
import {join} from "node:path";

const LIMIT=500*1024*1024;
const CHUNK=4*1024*1024;
const TTL=48*60*60*1000;
const isId=s=>/^[a-f0-9-]{36}$/.test(s||"");
const fail=(status,message)=>Object.assign(new Error(message),{status});

/** A persisted resumable transfer. A partial upload is NEVER visible in Disk
 * until LocalDisk has verified and committed all bytes atomically.
 * No third-party modules, DB or external services. */
export function createResumableUploads({disk,dir}){
  const sessions=new Map();
  const active=new Set();
  const meta=id=>join(dir,id+".json");
  const partial=id=>join(dir,id+".part");
  const persist=async row=>{
    const temp=meta(row.id)+".tmp";
    await writeFile(temp,JSON.stringify(row),{mode:0o600});
    await rename(temp,meta(row.id));
  };
  async function init(){
    await mkdir(dir,{recursive:true});
    const names=await readdir(dir);
    for(const name of names){
      if(!/^[a-f0-9-]{36}\.json$/.test(name))continue;
      const id=name.slice(0,-5);
      try{
        const s=JSON.parse(await readFile(meta(id),"utf8"));
        if(s.id!==id||!Number.isSafeInteger(s.size)||s.size<1||s.size>LIMIT||
          !Number.isSafeInteger(s.offset)||s.offset<0||s.offset>s.size||
          typeof s.name!=="string"||typeof s.folder!=="string"||
          !Number.isFinite(s.expires)||Date.now()>s.expires)throw Error();
        const fh=await open(partial(id),"r");
        const st=await fh.stat();await fh.close();
        if(st.size<s.offset)throw Error();
        sessions.set(id,s);
      }catch{
        await rm(meta(id),{force:true});
        await rm(partial(id),{force:true});
      }
    }
    // An interrupted create may have left an orphaned .part: reclaim it.
    for(const name of names){
      if(!/^[a-f0-9-]{36}\.part$/.test(name))continue;
      if(!sessions.has(name.slice(0,-5)))await rm(join(dir,name),{force:true});
    }
  }
  const validName=name=>typeof name==="string"&&name.length>0&&name.length<=180&&
    name!== "."&&name!==".."&&!/[\\\/\x00-\x1f]/.test(name);
  const validFolder=folder=>typeof folder==="string"&&folder.length<1000&&
    (folder===""||folder.split("/").every(x=>x.length>0&&x.length<=180&&x!=="."&&x!==".."&&!/[\\\x00-\x1f]/.test(x)));
  function find(id){
    if(!isId(id))throw fail(404,"Загрузка не найдена");
    const s=sessions.get(id);
    if(!s)throw fail(404,"Загрузка не найдена. Выберите файл и начните заново");
    if(s.expires<Date.now())throw fail(410,"Истёк срок хранения незавершённой загрузки");
    return s;
  }
  const publicState=s=>({id:s.id,name:s.name,folder:s.folder,size:s.size,offset:s.offset,expires:s.expires});
  async function handle(req,url){
    const p=url.pathname,method=req.method;
    if(method!=="GET"&&req.headers["x-tsukimera-request"]!=="1")
      throw fail(403,"Недопустимый запрос");
    if(method==="POST"&&p==="/api/disk/uploads"){
      if(sessions.size>=30)throw fail(429,"Слишком много незавершённых загрузок");
      if(!String(req.headers["content-type"]||"").startsWith("application/json"))throw fail(415,"Требуется JSON");
      let bytes=0,parts=[];
      for await(const b of req){bytes+=b.length;if(bytes>4096)throw fail(413,"Слишком длинный запрос");parts.push(b);}
      let input;try{input=JSON.parse(Buffer.concat(parts).toString("utf8"));}catch{throw fail(400,"Неверный JSON");}
      if(!input||!validName(input.name)||!validFolder(input.folder)||!Number.isSafeInteger(input.size)||input.size<1||input.size>LIMIT)
        throw fail(400,"Некорректные параметры файла");
      const id=randomUUID(),expires=Date.now()+TTL;
      const row={id,name:input.name,folder:input.folder,size:input.size,offset:0,expires};
      const fh=await open(partial(id),"wx",0o600);
      await fh.close();
      await persist(row);
      sessions.set(id,row);
      return {status:201,value:publicState(row)};
    }
    const m=/^\/api\/disk\/uploads\/([0-9a-f-]{36})(\/complete)?$/.exec(p);
    if(!m)return {status:404,value:{error:"Не найдено"}};
    const id=m[1],s=find(id);
    if(method==="GET"&&!m[2])return {status:200,value:publicState(s)};
    if(active.has(id))throw fail(409,"Загрузка занята: повторите запрос");
    active.add(id);
    try{
      if(method==="DELETE"&&!m[2]){
        sessions.delete(id);
        await rm(meta(id),{force:true});await rm(partial(id),{force:true});
        return {status:200,value:{ok:true}};
      }
      if(method==="PATCH"&&!m[2]){
        if(!String(req.headers["content-type"]||"").startsWith("application/octet-stream"))
          throw fail(415,"Требуется application/octet-stream");
        const offset=Number(req.headers["x-upload-offset"]);
        if(!Number.isSafeInteger(offset)||offset!==s.offset)throw fail(409,"Неверная позиция загрузки");
        const declared=Number(req.headers["content-length"]);
        if(!Number.isSafeInteger(declared)||declared<1||declared>CHUNK||s.offset+declared>s.size)
          throw fail(413,"Неправильный размер фрагмента");
        let n=0;const parts=[];
        for await(const bytes of req){
          n+=bytes.length;
          if(n>declared)throw fail(413,"Фрагмент больше заявленного");
          parts.push(bytes);
        }
        if(n!==declared)throw fail(400,"Неполный фрагмент");
        const fh=await open(partial(id),"r+");
        try{
          const data=Buffer.concat(parts);
          let written=0;
          while(written<data.length){
            const r=await fh.write(data,written,data.length-written,offset+written);
            if(!r.bytesWritten)throw Error("Запись прервана");
            written+=r.bytesWritten;
          }
          await fh.sync();
        }finally{await fh.close();}
        const next={...s,offset:offset+declared,expires:Date.now()+TTL};
        await persist(next);sessions.set(id,next);
        return {status:200,value:publicState(next)};
      }
      if(method==="POST"&&m[2]){
        if(s.offset!==s.size)throw fail(409,"Файл ещё не загружен полностью");
        const entry=await disk.uploadStream(s.name,s.folder,createReadStream(partial(id)));
        const duplicates=disk.sameContent(entry.id);
        sessions.delete(id);
        await rm(meta(id),{force:true});await rm(partial(id),{force:true});
        return {status:201,value:{...entry,duplicates}};
      }
      return {status:405,value:{error:"Метод недоступен"}};
    }finally{active.delete(id);}
  }
  return {init,handle};
}
