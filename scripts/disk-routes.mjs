import { createReadStream } from "node:fs";
import {runPythonGraph} from "./python-graph.mjs";
import { readFile, stat } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { createResumableUploads } from "./resumable-uploads.mjs";

/** JUUNIBI Disk HTTP contract, isolated from the rest of Tsukimera.
 * The source disk's LocalDisk methods enforce name, folder, size and data-integrity limits.
 * Only loopback calls are accepted by the parent server.
 */
export function createDiskRouter({disk,zipStream,zipLength,collectLife,uploadDir,automation=null,database=null,graphRoot=null,graphDbPath=null}) {
  const uploads=createResumableUploads({disk,dir:uploadDir});
  const zipTokens=new Map();
  const verified=new Map();
  let lastTrashSweep=0;
  const HEADERS={"Cache-Control":"no-store","X-Content-Type-Options":"nosniff",
    "X-Frame-Options":"DENY","Referrer-Policy":"no-referrer"};
  function send(res,status,value,additional={}){
    if(res.headersSent||res.destroyed)return;
    res.writeHead(status,{...HEADERS,"Content-Type":"application/json; charset=utf-8",...additional});
    res.end(JSON.stringify(value));
  }
  async function body(req,limit=65536){
    const type=String(req.headers["content-type"]||"");
    if(!type.startsWith("application/json"))throw Object.assign(new Error("Требуется application/json"),{status:415});
    let bytes=0,parts=[];
    for await(const chunk of req){
      bytes+=chunk.length;
      if(bytes>limit)throw Object.assign(new Error("Слишком большой запрос"),{status:413});
      parts.push(chunk);
    }
    try {
      const parsed=JSON.parse(Buffer.concat(parts).toString("utf8"));
      if(!parsed||typeof parsed!=="object"||Array.isArray(parsed))throw Error();
      return parsed;
    }catch{throw Object.assign(new Error("Некорректный JSON"),{status:400});}
  }
  async function validObject(file,entry,info){
    if(info.size!==entry.size)return false;
    const key=info.size+":"+info.mtimeMs+":"+entry.sha256;
    if(verified.get(file)===key)return true;
    const hash=createHash("sha256");
    for await(const chunk of createReadStream(file,{highWaterMark:256*1024}))hash.update(chunk);
    if(hash.digest("hex")!==entry.sha256)return false;
    if(verified.size>2000)verified.clear();
    verified.set(file,key);
    return true;
  }
  const INLINE_TYPES={
    png:"image/png",jpg:"image/jpeg",jpeg:"image/jpeg",gif:"image/gif",webp:"image/webp",avif:"image/avif",bmp:"image/bmp",ico:"image/x-icon",
    mp4:"video/mp4",webm:"video/webm",m4v:"video/mp4",mp3:"audio/mpeg",wav:"audio/wav",ogg:"audio/ogg",m4a:"audio/mp4",
    pdf:"application/pdf",txt:"text/plain; charset=utf-8",md:"text/plain; charset=utf-8",
    csv:"text/plain; charset=utf-8",json:"text/plain; charset=utf-8",log:"text/plain; charset=utf-8"
  };
  async function raw(req,res,id,download){
    const {entry,path:file}=disk.rawFile(id);
    const ext=entry.name.toLowerCase().split(".").pop()||"";
    const type=(!download&&INLINE_TYPES[ext])||"application/octet-stream";
    const etag='"'+entry.sha256+'-'+createHash("sha256").update(entry.name).digest("hex").slice(0,12)+'"';
    const headers={
      "content-type":type,etag,"cache-control":"private, max-age=86400",
      "x-content-type-options":"nosniff","accept-ranges":"bytes",
      "content-security-policy":"default-src 'none'; img-src 'self'; media-src 'self'; style-src 'unsafe-inline'; sandbox",
      "content-disposition":(download||!INLINE_TYPES[ext]?"attachment":"inline")+"; filename*=UTF-8''"+encodeURIComponent(entry.name)
    };
    if(ext==="pdf")delete headers["content-security-policy"];
    if(req.headers["if-none-match"]===etag){res.writeHead(304,headers);res.end();return;}
    const info=await stat(file);
    if(!(await validObject(file,entry,info))){send(res,409,{error:"Файл изменён или повреждён на диске"});return;}
    const size=info.size;
    const match=/^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range||""));
    let start=0,end=size-1;
    if(match&&(match[1]||match[2])){
      start=match[1]?Number(match[1]):Math.max(0,size-Number(match[2]));
      end=match[1]&&match[2]?Math.min(size-1,Number(match[2])):size-1;
      if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start>end||start>=size||start<0){
        res.writeHead(416,{"content-range":"bytes */"+size});res.end();return;
      }
      res.writeHead(206,{...headers,"content-range":"bytes "+start+"-"+end+"/"+size,"content-length":String(end-start+1)});
    }else res.writeHead(200,{...headers,"content-length":String(size)});
    if(req.method==="HEAD"){res.end();return;}
    const stream=createReadStream(file,size?{start,end}:undefined);
    stream.on("error",error=>res.destroy(error));stream.pipe(res);
  }
  async function* backupLines(req){
    const decoder=new TextDecoder("utf-8",{fatal:true});let buffer="";
    for await(const chunk of req){
      buffer+=decoder.decode(chunk,{stream:true});
      if(buffer.length>17*1024*1024&&!buffer.includes("\n"))throw Object.assign(new Error("Слишком длинная запись архива"),{status:413});
      let index;
      while((index=buffer.indexOf("\n"))>=0){
        const line=buffer.slice(0,index);buffer=buffer.slice(index+1);
        if(line)yield line;
        if(buffer.length>17*1024*1024)throw Object.assign(new Error("Слишком длинная запись архива"),{status:413});
      }
    }
    buffer+=decoder.decode();
    if(buffer.trim())yield buffer;
  }
  const objId="([0-9a-f-]{36})";
  const uuidExpr=new RegExp("^/api/disk/files/"+objId+"/(raw|text|thumb|preview|versions|versions/binary|versions/restore)$");
  async function handle(req,res,url) {
    const p=url.pathname;
    const method=req.method;
    try{
      if(p.startsWith("/api/disk/uploads")){
        const result=await uploads.handle(req,url);
        return send(res,result.status,result.value);
      }
      if(method==="GET"&&p==="/api/disk"){
        if(Date.now()-lastTrashSweep>3600000){
          lastTrashSweep=Date.now();
          await disk.purgeExpired().catch(()=>undefined);
        }
        return send(res,200,disk.list(url.searchParams.get("folder")??undefined));
      }
      if(method==="GET"&&p==="/api/disk/life")return send(res,200,await collectLife(disk));
      if(method==="GET"&&p==="/api/disk/automation")
        return send(res,200,automation?.status()??{running:false});
      if(method==="GET"&&p==="/api/disk/knowledge/status")
        return send(res,200,database?.knowledgeStats()??{analyzed:0,pending:0});
      // Stage 1 of the Python API migration: only NEW read-only graph
      // routes use Python; all existing disk operations keep their contract.
      if(method==="GET"&&p.startsWith("/api/disk/graph22/")){
        const action=p.slice("/api/disk/graph22/".length);
        if(!["view","path","impact","timeline","diagnose","contradictions"].includes(action))
          return send(res,404,{error:"Неизвестная операция графа"});
        if(!graphRoot||!graphDbPath)return send(res,503,{error:"Python Graph API не настроен"});
        const params=Object.fromEntries(url.searchParams);
        const result=await runPythonGraph({root:graphRoot,dbPath:graphDbPath,action,params});
        return send(res,result.ok?200:503,result.ok?result.data:
          {error:result.error,available:false,mode:"legacy-fallback"});
      }
      if(method==="GET"&&p==="/api/disk/knowledge/graph")
        return send(res,200,database?.knowledgeGraph(240)??{nodes:[],links:[]});
      if(method==="GET"&&p==="/api/disk/knowledge/tiles"){
        const ids=(url.searchParams.get("ids")||"").split(",").slice(0,150);
        return send(res,200,database?.diskTileInsights(ids)??{items:[],coverage:"requested-files"});
      }
      if(method==="GET"&&p==="/api/disk/knowledge"){
        const id=url.searchParams.get("fileId")||"";
        if(!/^[0-9a-f-]{36}$/.test(id))
          return send(res,400,{error:"Некорректный идентификатор документа"});
        return send(res,200,database?.knowledgeForFile(id)??{ready:false});
      }
      if(method==="POST"&&p==="/api/disk/automation/run"){
        automation?.wake();
        return send(res,202,{scheduled:!!automation,details:automation?.status()??null});
      }
      if(method==="GET"&&p==="/api/disk/trash")return send(res,200,disk.trashSettings());
      if(method==="POST"&&p==="/api/disk/trash")return send(res,200,await disk.setTrashDays((await body(req)).days));
      if(method==="POST"&&p==="/api/disk/trash/empty")return send(res,200,await disk.emptyTrash());
      if(method==="POST"&&p==="/api/disk/zip"){
        const plan=disk.zipPlan(await body(req,512*1024));
        const token=randomUUID();
        zipTokens.set(token,{...plan,until:Date.now()+10*60_000});
        for(const [key,val] of zipTokens)if(val.until<Date.now())zipTokens.delete(key);
        return send(res,200,{url:"/api/disk/zip/"+token,name:plan.name+".zip",files:plan.files.length,bytes:plan.files.reduce((n,f)=>n+f.size,0)});
      }
      const zipMatch=/^\/api\/disk\/zip\/([0-9a-f-]{36})$/.exec(p);
      if(method==="GET"&&zipMatch){
        const plan=zipTokens.get(zipMatch[1]);
        if(!plan||plan.until<Date.now())return send(res,404,{error:"Ссылка на архив устарела. Нажмите «Скачать ZIP» ещё раз"});
        // The URL is single use to avoid cached archive links persisting.
        zipTokens.delete(zipMatch[1]);
        res.writeHead(200,{"content-type":"application/zip","content-length":String(zipLength(plan.files)),
          "cache-control":"no-store","x-content-type-options":"nosniff",
          "content-disposition":"attachment; filename*=UTF-8''"+encodeURIComponent(plan.name+".zip")});
        const out=Readable.from(zipStream(plan.files));
        out.on("error",err=>res.destroy(err));out.pipe(res);return;
      }
      const fileMatch=uuidExpr.exec(p);
      if(fileMatch){
        const [,id,action]=fileMatch;
        if((method==="GET"||method==="HEAD")&&action==="raw")return raw(req,res,id,url.searchParams.has("download"));
        if(method==="GET"&&action==="text")return send(res,200,await disk.readText(id));
        if(method==="GET"&&action==="preview")return send(res,200,await disk.preview(id));
        if(method==="GET"&&action==="versions")return send(res,200,{versions:disk.fileVersions(id)});
        if(method==="POST"&&action==="versions/restore")return send(res,200,await disk.restoreFileVersion(id,(await body(req)).revision));
        if(method==="POST"&&action==="versions/binary"){
          const declared=Number(req.headers["content-length"]??0);
          if(declared>500*1024*1024)return send(res,413,{error:"Редакция превышает 500 МБ"});
          return send(res,200,await disk.replaceStream(id,req,url.searchParams.get("expected")));
        }
        if(method==="POST"&&action==="thumb"){
          let n=0;const chunks=[];
          for await(const c of req){
            n+=c.length;if(n>400*1024)return send(res,413,{error:"Миниатюра больше 400 КБ"});
            chunks.push(c);
          }
          return send(res,200,await disk.saveThumb(id,Buffer.concat(chunks)));
        }
        if(method==="GET"&&action==="thumb"){
          const t=disk.thumbOf(id);
          if(req.headers["if-none-match"]===t.etag){res.writeHead(304,{etag:t.etag});res.end();return;}
          const data=await readFile(t.path);
          res.writeHead(200,{"content-type":t.type,etag:t.etag,"cache-control":"private, max-age=86400",
            "x-content-type-options":"nosniff","content-length":String(data.length)});
          res.end(data);return;
        }
      }
      if(method==="GET"&&p==="/api/disk/audit")return send(res,200,await disk.audit());
      if(method==="GET"&&p==="/api/disk/duplicates")return send(res,200,{groups:disk.duplicates()});
      if(method==="GET"&&p==="/api/disk/files/history")return send(res,200,{actions:disk.fileHistory()});
      if(method==="POST"&&p==="/api/disk/files/undo")return send(res,200,await disk.undoFileChange());
      if(method==="POST"&&p==="/api/disk/files/copy"){const b=await body(req);return send(res,201,await disk.copyFile(String(b.id??""),b.folder));}
      if(method==="POST"&&p==="/api/disk/folders/sync"){const b=await body(req);return send(res,200,await disk.syncFolders(b.from,b.to,b.apply??false));}
      if(method==="GET"&&p==="/api/disk/backup"){
        res.writeHead(200,{"content-type":"application/x-ndjson; charset=utf-8","content-disposition":'attachment; filename="Tsukimera-backup.ndjson"',
          "cache-control":"no-store","x-content-type-options":"nosniff"});
        try {
          for await(const line of disk.exportBackup()){
            if(res.destroyed)throw new Error("Загрузка архива прервана");
            if(!res.write(line))await new Promise((resolve,reject)=>{
              const done=()=>{res.off("drain",drained);res.off("error",failed);res.off("close",closed);};
              const drained=()=>{done();resolve();};
              const failed=e=>{done();reject(e);};
              const closed=()=>{done();reject(new Error("Загрузка архива прервана"));};
              res.once("drain",drained);res.once("error",failed);res.once("close",closed);
            });
          }
          res.end();
        }catch(error){res.destroy(error);}
        return;
      }
      if(method==="POST"&&p==="/api/disk/backup/restore")return send(res,200,await disk.importBackup(backupLines(req)));
      if(method==="GET"&&p==="/api/disk/snapshot")return send(res,200,disk.snapshot());
      if(method==="POST"&&p==="/api/disk/metadata"){const b=await body(req);return send(res,200,await disk.setMetadata(String(b.id??""),b));}
      if(method==="POST"&&p==="/api/disk/folders"){const b=await body(req);return send(res,201,await disk.createFolder(b.name));}
      if(method==="POST"&&p==="/api/disk/folders/rename"){const b=await body(req);return send(res,200,await disk.renameFolder(b.from,b.to));}
      if(method==="GET"&&p==="/api/disk/folders/styles")return send(res,200,disk.folderDecorations());
      if(method==="GET"&&p==="/api/disk/folders/history")return send(res,200,{actions:disk.folderHistory()});
      if(method==="POST"&&p==="/api/disk/folders/style"){const b=await body(req);return send(res,200,await disk.setFolderStyle(b.name,b.color,b.pinned,b.cover));}
      if(method==="POST"&&p==="/api/disk/folders/move"){const b=await body(req);return send(res,200,await disk.moveFolder(b.from,b.parent));}
      if(method==="POST"&&p==="/api/disk/folders/copy"){const b=await body(req);return send(res,201,await disk.copyFolder(b.from,b.parent));}
      if(method==="POST"&&p==="/api/disk/folders/trash"){const b=await body(req);return send(res,200,await disk.trashFolder(b.name));}
      if(method==="GET"&&p==="/api/disk/folders/deleted")return send(res,200,{folders:disk.listDeletedFolders()});
      if(method==="POST"&&p==="/api/disk/folders/restore"){const b=await body(req);return send(res,200,await disk.restoreFolder(b.name));}
      if(method==="POST"&&p==="/api/disk/files/binary"){
        const declared=Number(req.headers["content-length"]??0);
        if(declared>500*1024*1024)return send(res,413,{error:"Файл превышает 500 МБ"});
        const entry=await disk.uploadStream(url.searchParams.get("name"),url.searchParams.get("folder")??"",req);
        return send(res,201,{...entry,duplicates:disk.sameContent(entry.id)});
      }
      if(method==="POST"&&p==="/api/disk/files"){
        const b=await body(req,14*1024*1024);
        return send(res,201,await disk.upload(b.name,b.folder,b.base64));
      }
      if(method==="GET"&&p==="/api/disk/search"){
        const query=url.searchParams.get("q")??"";
        const ids=await disk.searchContent(query);
        // Results retain original id shape; enriched snippets are optional
        // and always text-only, with no HTML or user-supplied SQL operators.
        const matches=database?.rankedSearch(query)??[];
        return send(res,200,{ids,index:automation?.status().index??{indexed:0,pending:0},
          matches,knowledge:database?.knowledgeStats()??null});
      }
      if(method==="POST"&&p==="/api/disk/bulk"){const b=await body(req);return send(res,200,await disk.bulk(b.ids,b.action,b.folder));}
      if(method==="POST"&&p==="/api/disk/restore")return send(res,200,await disk.restore(String((await body(req)).id??"")));
      if(method==="POST"&&p==="/api/disk/purge")return send(res,200,await disk.purge(String((await body(req)).id??"")));
      if(method==="POST"&&p==="/api/disk/move"){const b=await body(req);return send(res,200,await disk.moveFile(String(b.id??""),b.folder));}
      if(method==="POST"&&p==="/api/disk/favorite"){const b=await body(req);return send(res,200,await disk.toggleFavorite(String(b.id??""),b.favorite));}
      const entry=/^\/api\/disk\/files\/([0-9a-f-]{36})$/.exec(p);
      if(entry){
        if(method==="GET")return send(res,200,await disk.download(entry[1]));
        if(method==="PATCH")return send(res,200,await disk.renameFile(entry[1],(await body(req)).name));
        if(method==="DELETE")return send(res,200,await disk.remove(entry[1]));
      }
      return send(res,404,{error:"Не найдено"});
    }catch(error){
      if(res.headersSent){res.destroy(error);return;}
      const status=error?.status>=400&&error?.status<600?error.status:500;
      return send(res,status,{error:status===500?"Внутренняя ошибка Диска":error.message});
    }
  }
  return {handle,initUploads:()=>uploads.init()};
}
