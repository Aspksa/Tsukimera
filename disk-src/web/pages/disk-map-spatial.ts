/**
 * Tsukimera Disk 11: local, bounded, folder-centered spatial explorer.
 * UI adaptation of the navigation ideas documented by OmniBrille (MIT).
 * No code or libraries copied from its C#/Avalonia renderer.
 */
import type {DiskFile} from "../api";

export type SpatialItem={
  id:string;kind:"folder"|"file";name:string;folder:string;size:number;count:number;
  uploadedAt?:string;sha?:string;duplicates?:number;revision?:number;
};
export type SpatialScene={
  folder:string;focusName:string;parent:string;items:SpatialItem[];
  total:number;pages:number;page:number;folders:number;files:number;bytes:number;
  filtered:boolean;
};
export const SPATIAL_PAGE_SIZE=14;
export const SPATIAL_DENSITY_KEY="tsukimera.disk.spatial.density.v1";

const sortRu=(a:string,b:string)=>a.localeCompare(b,"ru",{numeric:true,sensitivity:"base"});
const parentOf=(path:string)=>path.includes("/")?path.slice(0,path.lastIndexOf("/")):"";
const last=(path:string)=>path.split("/").pop()||"Диск";
export function spatialScene(files:DiskFile[],folderNames:string[],folder:string,
  page=0,limit=SPATIAL_PAGE_SIZE,query=""):SpatialScene{
  const focus=folder||"";
  const parents=new Map<string,{size:number;count:number}>();
  const names=new Set<string>();
  const addPath=(path:string)=>{
    if(!path)return;
    const bits=path.split("/");
    for(let i=1;i<=bits.length;i++)names.add(bits.slice(0,i).join("/"));
  };
  for(const name of folderNames)addPath(name);
  for(const file of files)if(!file.deletedAt)addPath(file.folder);
  const active=files.filter(f=>!f.deletedAt);
  for(const file of active){
    const parts=file.folder?file.folder.split("/"):[];
    for(let i=1;i<=parts.length;i++){
      const path=parts.slice(0,i).join("/");
      const value=parents.get(path)||{size:0,count:0};
      value.size+=file.size;value.count++;
      parents.set(path,value);
    }
  }
  const folders:SpatialItem[]=[...names].filter(f=>parentOf(f)===focus)
    .map(f=>({id:"folder:"+f,kind:"folder",name:last(f),folder:f,
      size:parents.get(f)?.size||0,count:parents.get(f)?.count||0}))
    .sort((a,b)=>sortRu(a.name,b.name));
  // Only same-content SHA-256 matches count as duplicates (not identical names).
  const shaCounts=new Map<string,number>();
  for(const f of active)if(/^[a-f0-9]{64}$/i.test(f.sha256||""))
    shaCounts.set(f.sha256.toLowerCase(),(shaCounts.get(f.sha256.toLowerCase())||0)+1);
  const directFiles:SpatialItem[]=active.filter(f=>f.folder===focus)
    .map(f=>({id:"file:"+f.id,kind:"file",name:f.name,folder:f.folder,
      size:f.size,count:1,uploadedAt:f.uploadedAt,sha:f.sha256,revision:f.revision,
      duplicates:/^[a-f0-9]{64}$/i.test(f.sha256||"")?Math.max(0,(shaCounts.get(f.sha256.toLowerCase())||0)-1):0
    })).sort((a,b)=>sortRu(a.name,b.name));
  const all=[...folders,...directFiles];
  const needle=query.trim().toLocaleLowerCase("ru-RU");
  const matched=needle?all.filter(i=>i.name.toLocaleLowerCase("ru-RU").includes(needle)):all;
  const take=Math.max(1,Math.min(48,Math.trunc(limit)||SPATIAL_PAGE_SIZE));
  const pages=Math.max(1,Math.ceil(matched.length/take));
  const safePage=Math.max(0,Math.min(pages-1,Math.trunc(page)||0));
  const scoped=active.filter(f=>focus===""||f.folder===focus||f.folder.startsWith(focus+"/"));
  return {folder:focus,focusName:last(focus),parent:parentOf(focus),
    items:matched.slice(safePage*take,(safePage+1)*take),
    total:matched.length,pages,page:safePage,folders:folders.length,
    files:directFiles.length,bytes:scoped.reduce((sum,f)=>sum+f.size,0),
    filtered:!!needle};
}

/** Stable, bounded radial slots with no force-simulation or hidden objects. */
export function spatialSlots(count:number):Array<{x:number;y:number}>{
  const total=Math.max(0,Math.min(48,Math.trunc(count)||0));
  if(!total)return [];
  const slots:Array<{x:number;y:number}>=[];
  // A single ellipse keeps labels from crossing the central focus.
  // Left-to-right reading starts at the 12 o'clock position.
  for(let i=0;i<total;i++){
    const angle=-Math.PI/2+(i/total)*Math.PI*2;
    slots.push({x:50+Math.cos(angle)*38,y:50+Math.sin(angle)*39});
  }
  return slots;
}

/** Only stable IDs can link catalogue snapshots; the initial scan has no "new" badge. */
export function spatialChanges(previous:readonly DiskFile[]|null,next:readonly DiskFile[]):Map<string,"added"|"modified"|"removed">{
  const result=new Map<string,"added"|"modified"|"removed">();
  if(previous===null)return result;
  const old=new Map(previous.filter(f=>!f.deletedAt).map(f=>[f.id,f]));
  const latest=new Map(next.filter(f=>!f.deletedAt).map(f=>[f.id,f]));
  for(const [id,item] of latest){
    const before=old.get(id);
    if(!before)result.set(id,"added");
    else if(before.revision!==item.revision||before.sha256!==item.sha256||
      before.size!==item.size||before.folder!==item.folder||before.name!==item.name)
      result.set(id,"modified");
  }
  for(const id of old.keys())if(!latest.has(id))result.set(id,"removed");
  return result;
}

/** Spatial, not reading-order, keyboard traversal. Reject zero-length vectors. */
export function spatialNeighbor(points:readonly {x:number;y:number}[],index:number,
  direction:"up"|"down"|"left"|"right"):number{
  if(!points.length)return -1;
  const origin=points[index]??{x:50,y:24};
  let best=-1,score=Infinity;
  for(let i=0;i<points.length;i++){
    if(i===index)continue;
    const deltaX=points[i]!.x-origin.x,deltaY=points[i]!.y-origin.y;
    const forward=direction==="right"?deltaX:direction==="left"?-deltaX:direction==="down"?deltaY:-deltaY;
    if(forward<=.5)continue;
    const across=Math.abs(direction==="left"||direction==="right"?deltaY:deltaX);
    const rank=forward+across*3+Math.hypot(deltaX,deltaY)*.08;
    if(rank<score){score=rank;best=i;}
  }
  return best;
}

/** Small, consistent extension palette; theme still controls the surrounding UI. */
export function spatialFileType(name:string):"image"|"document"|"archive"|"video"|"audio"|"code"|"other"{
  const ext=name.split(".").pop()?.toLowerCase()||"";
  if(["png","jpg","jpeg","webp","gif","bmp","svg","heic"].includes(ext))return "image";
  if(["pdf","doc","docx","txt","rtf","md","odt","xls","xlsx","ppt","pptx","csv"].includes(ext))return "document";
  if(["zip","7z","rar","tar","gz"].includes(ext))return "archive";
  if(["mp4","mov","webm","mkv","avi"].includes(ext))return "video";
  if(["mp3","wav","ogg","flac","m4a"].includes(ext))return "audio";
  if(["ts","js","py","html","css","json","yaml","yml","sql","rs","go"].includes(ext))return "code";
  return "other";
}
/** Colour age from actual uploadedAt, never invent a file modification timestamp. */
export function spatialAge(uploadedAt?:string,now=Date.now()):"today"|"week"|"old"|"unknown"{
  const stamp=uploadedAt?Date.parse(uploadedAt):NaN;
  if(!Number.isFinite(stamp)||stamp>now+86400000)return "unknown";
  const delta=Math.max(0,now-stamp);
  return delta<86400000?"today":delta<604800000?"week":"old";
}
