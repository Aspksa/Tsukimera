/**
 * Tsukimera Disk 11: local, bounded, folder-centered spatial explorer.
 * UI adaptation of the navigation ideas documented by OmniBrille (MIT).
 * No code or libraries copied from its C#/Avalonia renderer.
 */
import type {DiskFile} from "../api";

export type SpatialItem={
  id:string;kind:"folder"|"file";name:string;folder:string;size:number;count:number;
};
export type SpatialScene={
  folder:string;focusName:string;parent:string;items:SpatialItem[];
  total:number;pages:number;page:number;folders:number;files:number;bytes:number;
  filtered:boolean;
};
export const SPATIAL_PAGE_SIZE=14;

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
  const directFiles:SpatialItem[]=active.filter(f=>f.folder===focus)
    .map(f=>({id:"file:"+f.id,kind:"file",name:f.name,folder:f.folder,
      size:f.size,count:1})).sort((a,b)=>sortRu(a.name,b.name));
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
