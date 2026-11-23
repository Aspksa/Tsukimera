/** Tsukimera adapter for the original JUUNIBI Disk user interface.
 * The storage, preview and life endpoints keep JUUNIBI's API names and shapes.
 * Tasks are mapped to Tsukimera's existing local notes. No cloud requests. */
export interface DiskFile {id:string;name:string;folder:string;size:number;uploadedAt:string;sha256:string;favorite?:boolean;deletedAt?:string;tags?:string[];color?:string;note?:string;revision?:number;thumb?:true}
export interface DiskLifeMetric {id:string;group:string;icon:string;title:string;hint:string;value:string;detail?:string;kind?:string;series?:number[];labels?:string[];list?:string[];ring?:number;empty?:boolean;sourceFileId?:string}
export interface DiskLife {generatedAt:string;groups:{id:string;title:string;icon:string;color:string;note:string}[];metrics:DiskLifeMetric[];highlights:string[];analysis:{documents:number;read:number;scans:number;unreadable:number;images:number;measured:number}}
export type DiskRun={t:string;b?:true;i?:true};
export type DiskPreview=
| {kind:"doc";blocks:({k:"h";level:number;runs:DiskRun[]}|{k:"p"|"li";runs:DiskRun[]}|{k:"table";rows:string[][]})[];truncated:boolean}
| {kind:"sheet";sheets:{name:string;rows:string[][];truncated:boolean}[];truncated:boolean}
| {kind:"slides";slides:{title:string;lines:string[]}[];truncated:boolean}
| {kind:"zip";entries:{name:string;size:number;compressed:number;dir:boolean;modified?:string}[];total:number;bytes:number;truncated:boolean};
export interface DiskUploaded extends DiskFile {duplicates:{id:string;name:string;folder:string}[]}
export interface DiskListing {folders:string[];files:DiskFile[];trash:DiskFile[];usedBytes:number;maxFileBytes:number}
export interface FileLink{id:string;name:string}
/** Stable file IDs are the single join key for notes, the Disk and future chat.
 * Cached file names are only labels, never identifiers. */
export function resolveFileLink(link:FileLink, listing:Pick<DiskListing,"files"|"trash">):
  {id:string;name:string;status:"active"|"trash"|"missing"}{
  const active=listing.files.find(f=>f.id===link.id);
  if(active)return {id:link.id,name:active.name,status:"active"};
  const removed=listing.trash.find(f=>f.id===link.id);
  if(removed)return {id:link.id,name:removed.name,status:"trash"};
  return {id:link.id,name:link.name,status:"missing"};
}
export interface Note{id:string;kind:"note"|"todo";text:string;done:boolean;createdAt:string;files?:FileLink[];project?:string;priority?:"low"|"normal"|"high"}
export interface ProjectMeta{name:string;color?:string;files?:FileLink[]}
export interface ProjectMetric{id:string;title:string;value:string;group:string;icon:string;hint:string;series?:number[];labels?:string[];kind?:string}
export interface ProjectStatsData{generatedAt:string;head:string;commits:number;groups:{id:string;title:string}[];metrics:ProjectMetric[];source?:"git"|"github"|"saved"}

async function attemptAsync<T>(fn:()=>Promise<T>):Promise<{ok:true;value:T}|{ok:false;error:Error}> {
  try{return {ok:true,value:await fn()};}catch(error){return {ok:false,error:error instanceof Error?error:new Error(String(error))};}
}
async function call<T>(route:string,init?:RequestInit):Promise<T> {
  const response=await fetch(route,{...init,headers:{
    ...(init?.body&&typeof init.body==="string"?{"Content-Type":"application/json"}:{}),
    ...(init?.method&&init.method!=="GET"?{"X-Tsukimera-Request":"1"}:{})
  }});
  const result=await response.json().catch(()=>({}));
  if(!response.ok)throw new Error((result as {error?:string}).error??"Ошибка "+response.status);
  return result as T;
}
const post=(data:unknown):RequestInit=>({method:"POST",body:JSON.stringify(data)});
const nameKey=(name:string)=>{let h=0;for(let i=0;i<name.length;i++)h=Math.imul(h^name.charCodeAt(i),16777619);return (h>>>0).toString(36);};
export const diskRawUrl=(file:{id:string;sha256:string;name:string},download=false)=>"/api/disk/files/"+encodeURIComponent(file.id)+"/raw?v="+file.sha256.slice(0,12)+"-"+nameKey(file.name)+(download?"&download=1":"");
export const diskThumbUrl=(file:{id:string;sha256:string})=>"/api/disk/files/"+encodeURIComponent(file.id)+"/thumb?v="+file.sha256.slice(0,12);

const NOTE_KEY="tsukimera:notes:v1";
const PROJECTS_KEY="tsukimera:projects:v1";
const localList=(key:string)=>{try{const x=JSON.parse(localStorage.getItem(key)||"[]");return Array.isArray(x)?x:[]}catch{return []}};
const storeList=(key:string,items:unknown[])=>{localStorage.setItem(key,JSON.stringify(items));dispatchEvent(new CustomEvent("tsukimera:notes-changed"));};
const allNotes=():Note[]=>localList(NOTE_KEY).filter((n):n is Note=>!!n&&typeof n.id==="string"&&typeof n.text==="string")
  .map(n=>({...n,kind:n.kind==="todo"?"todo":"note",done:!!n.done,createdAt:n.createdAt||new Date().toISOString()}));
const unsupported=()=>attemptAsync(async()=>{throw new Error("Функция недоступна без соответствующего модуля Tsukimera");});

export const api={
  diskLife:()=>attemptAsync(()=>call<DiskLife>("/api/disk/life")),
  // Disk 20: read-only local evidence; never a write/move/delete operation.
  diskKnowledgeGraph:()=>attemptAsync(()=>call<any>("/api/disk/knowledge/graph")),
  // Python Graph Engine 22: backwards-compatible, read-only visibility API.
  diskGraph22View:(params:{folder?:string;focus?:string;limit?:number;level?:string}={})=>
    attemptAsync(()=>call<any>("/api/disk/graph22/view?"+new URLSearchParams({
      folder:params.folder||"",focus:params.focus||"",
      limit:String(params.limit??240),level:params.level||"medium"}).toString())),
  diskGraph22Path:(source:string,target:string)=>attemptAsync(()=>
    call<any>("/api/disk/graph22/path?"+new URLSearchParams({source,target}).toString())),
  diskGraph22Diagnosis:()=>attemptAsync(()=>
    call<any>("/api/disk/graph22/diagnose")),
  diskGraph22Timeline:()=>attemptAsync(()=>
    call<any>("/api/disk/graph22/timeline")),
  diskKnowledgeStatus:()=>attemptAsync(()=>call<any>("/api/disk/knowledge/status")),
  diskTileInsights:(ids:readonly string[])=>attemptAsync(()=>call<{
    items:{id:string;links:number;state:"ready"|"text-indexed"|"waiting"}[];
    coverage:string}>("/api/disk/knowledge/tiles?ids="+encodeURIComponent(ids.slice(0,150).join(",")))),
  diskKnowledge:(id:string)=>attemptAsync(()=>call<any>(
    "/api/disk/knowledge?fileId="+encodeURIComponent(id))),
  diskAudit:()=>attemptAsync(()=>call<any>("/api/disk/audit")),
  diskDuplicates:()=>attemptAsync(()=>call<{groups:DiskFile[][]}>("/api/disk/duplicates")),
  diskSnapshot:()=>attemptAsync(()=>call<any>("/api/disk/snapshot")),
  diskMetadata:(id:string,tags:string[],color:string,note:string)=>attemptAsync(()=>call<DiskFile>("/api/disk/metadata",post({id,tags,color,note}))),
  diskList:(folder?:string)=>attemptAsync(()=>call<DiskListing>("/api/disk"+(folder!==undefined?"?folder="+encodeURIComponent(folder):""))),
  diskFolder:(name:string)=>attemptAsync(()=>call<any>("/api/disk/folders",post({name}))),
  diskRenameFolder:(from:string,to:string)=>attemptAsync(()=>call<any>("/api/disk/folders/rename",post({from,to}))),
  diskFolderStyles:()=>attemptAsync(()=>call<Record<string,{color:string;pinned:boolean;cover:string;createdAt?:string}>>("/api/disk/folders/styles")),
  diskFolderHistory:()=>attemptAsync(()=>call<any>("/api/disk/folders/history")),
  diskFolderStyle:(name:string,color:string,pinned:boolean,cover:string)=>attemptAsync(()=>call<any>("/api/disk/folders/style",post({name,color,pinned,cover}))),
  diskFolderMove:(from:string,parent:string)=>attemptAsync(()=>call<any>("/api/disk/folders/move",post({from,parent}))),
  diskFolderCopy:(from:string,parent:string)=>attemptAsync(()=>call<any>("/api/disk/folders/copy",post({from,parent}))),
  diskFolderSync:(from:string,to:string,apply:boolean)=>attemptAsync(()=>call<any>("/api/disk/folders/sync",post({from,to,apply}))),
  diskFolderTrash:(name:string)=>attemptAsync(()=>call<any>("/api/disk/folders/trash",post({name}))),
  diskDeletedFolders:()=>attemptAsync(()=>call<any>("/api/disk/folders/deleted")),
  diskFolderRestore:(name:string)=>attemptAsync(()=>call<any>("/api/disk/folders/restore",post({name}))),
  diskUpload:(name:string,folder:string,base64:string)=>attemptAsync(()=>call<DiskFile>("/api/disk/files",post({name,folder,base64}))),
  diskGet:(id:string)=>attemptAsync(()=>call<any>("/api/disk/files/"+encodeURIComponent(id))),
  diskRename:(id:string,name:string)=>attemptAsync(()=>call<DiskFile>("/api/disk/files/"+encodeURIComponent(id),{method:"PATCH",body:JSON.stringify({name})})),
  diskBulk:(ids:string[],action:"trash"|"restore"|"move"|"favorite"|"unfavorite",folder?:string)=>attemptAsync(()=>call<any>("/api/disk/bulk",post({ids,action,folder}))),
  diskMove:(id:string,folder:string)=>attemptAsync(()=>call<DiskFile>("/api/disk/move",post({id,folder}))),
  diskCopy:(id:string,folder:string)=>attemptAsync(()=>call<DiskFile>("/api/disk/files/copy",post({id,folder}))),
  diskVersions:(id:string)=>attemptAsync(()=>call<any>("/api/disk/files/"+encodeURIComponent(id)+"/versions")),
  diskRestoreVersion:(id:string,revision:number)=>attemptAsync(()=>call<DiskFile>("/api/disk/files/"+encodeURIComponent(id)+"/versions/restore",post({revision}))),
  diskUndo:()=>attemptAsync(()=>call<DiskFile>("/api/disk/files/undo",post({}))),
  diskFileHistory:()=>attemptAsync(()=>call<any>("/api/disk/files/history")),
  diskFavorite:(id:string,favorite:boolean)=>attemptAsync(()=>call<DiskFile>("/api/disk/favorite",post({id,favorite}))),
  diskRestore:(id:string)=>attemptAsync(()=>call<DiskFile>("/api/disk/restore",post({id}))),
  diskPurge:(id:string)=>attemptAsync(()=>call<any>("/api/disk/purge",post({id}))),
  diskTrash:()=>attemptAsync(()=>call<{days:number}>("/api/disk/trash")),
  diskTrashDays:(days:number)=>attemptAsync(()=>call<any>("/api/disk/trash",post({days}))),
  diskEmptyTrash:()=>attemptAsync(()=>call<any>("/api/disk/trash/empty",post({}))),
  diskPreview:(id:string)=>attemptAsync(()=>call<DiskPreview>("/api/disk/files/"+encodeURIComponent(id)+"/preview")),
  diskZip:(req:{ids:string[]}|{folder:string})=>attemptAsync(()=>call<{url:string;name:string;files:number;bytes:number}>("/api/disk/zip",post(req))),
  diskText:(id:string)=>attemptAsync(()=>call<{name:string;text:string;truncated:boolean}>("/api/disk/files/"+encodeURIComponent(id)+"/text")),
  diskDelete:(id:string)=>attemptAsync(()=>call<any>("/api/disk/files/"+encodeURIComponent(id),{method:"DELETE"})),
  // Notes and their links are stored in SQLite; localStorage is retained
  // only as a non-authoritative migration/compatibility copy.
  organizer:()=>attemptAsync(async()=>{
    const response=await call<{notes:Note[]}>("/api/notes");
    return {notes:response.notes,projects:localList(PROJECTS_KEY) as ProjectMeta[]};
  }),
  updateTask:(id:string,patch:{files?:FileLink[]|null})=>attemptAsync(async()=>{
    const response=await call<{note:Note}>("/api/notes/"+encodeURIComponent(id)+"/files",{
      method:"PATCH",body:JSON.stringify({files:patch.files??[]})});
    const items=allNotes(),index=items.findIndex(n=>n.id===id);
    if(index>=0){items[index]=response.note;storeList(NOTE_KEY,items);}
    else dispatchEvent(new CustomEvent("tsukimera:notes-changed"));
    return response.note;
  }),
  setProject:(name:string,patch:{files?:FileLink[]|null})=>attemptAsync(async()=>{
    const items=localList(PROJECTS_KEY) as ProjectMeta[];
    const entry=items.find(x=>x.name===name);
    if(!entry)throw new Error("Проект не найден");
    entry.files=patch.files||[];storeList(PROJECTS_KEY,items);
    return entry;
  }),
  projectStats:unsupported,
};
