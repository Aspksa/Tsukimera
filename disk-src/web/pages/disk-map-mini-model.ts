/**
 * Pure, bounded overview/detail models for the Disk mini-map.
 * Clusters summarize catalog entries excluded from the rendered sample;
 * their counts/bytes are computed from real DiskFile records.
 */
import type {DiskFile} from "../api";
import {graphFromFiles,type DiskGraph,type MapNode,type MapEdge} from "./disk-map-layout";

export type MiniCluster=MapNode&{kind:"cluster";hiddenFiles:number;hiddenFolders:number};
export type MiniNode=MapNode|MiniCluster;
export type MiniGraph=Omit<DiskGraph,"nodes">&{nodes:MiniNode[];focus:string;detail:boolean};
export type MiniView={zoom:number;panX:number;panY:number;focus:string};
export const MINI_VIEW_KEY="tsukimera.disk.minimap.view.v1";
export const clampView=(n:number,min:number,max:number)=>Math.max(min,Math.min(max,n));
export function normalizeMiniView(raw:unknown):MiniView{
  const data=raw&&typeof raw==="object"?raw as Partial<MiniView>:{};
  const number=(v:unknown,fallback:number,min:number,max:number)=>{
    const n=typeof v==="number"?v:NaN;
    return Number.isFinite(n)?clampView(n,min,max):fallback;
  };
  return {zoom:number(data.zoom,1,.65,9),
    panX:number(data.panX,0,-3000,3000),panY:number(data.panY,0,-3000,3000),
    focus:typeof data.focus==="string"&&data.focus.length<=512?data.focus:""};
}
function scopeCatalog(files:DiskFile[],folders:string[],focus:string){
  if(!focus)return {files,folders};
  const prefix=focus+"/";
  return {files:files.filter(f=>!f.deletedAt&&(f.folder===focus||f.folder.startsWith(prefix))),
    folders:folders.filter(f=>f===focus||f.startsWith(prefix))};
}
/** Deterministic cluster construction with a strict 12-cluster maximum.
 * Overview 70 files/40 folders, near zoom 190 files/100 folders.
 * Every excluded file and folder is counted once, never fabricated.
 */
export function miniGraphFromCatalog(files:DiskFile[],folders:string[],
  focus="",detail=false):MiniGraph{
  const scoped=scopeCatalog(files,folders,focus);
  const graph=graphFromFiles(scoped.files,scoped.folders,detail?190:70,detail?100:40);
  const nodes:MiniNode[]=[...graph.nodes],edges:MapEdge[]=[...graph.edges];
  const includedFiles=new Set(graph.nodes.filter(n=>n.kind==="file").map(n=>n.id.slice(5)));
  const includedFolders=new Set(graph.nodes.filter(n=>n.kind==="folder").map(n=>n.folder));
  const aggregate=new Map<string,{bytes:number;files:number;folders:number}>();
  const nearest=(folder:string)=>{
    let path=folder;
    while(path){
      if(includedFolders.has(path))return path;
      const ix=path.lastIndexOf("/");
      path=ix<0?"":path.slice(0,ix);
    }
    return "";
  };
  const add=(where:string,bytes:number,fileCount:number,folderCount:number)=>{
    const group=aggregate.get(where)??{bytes:0,files:0,folders:0};
    group.bytes+=bytes;group.files+=fileCount;group.folders+=folderCount;
    aggregate.set(where,group);
  };
  for(const file of scoped.files){
    if(file.deletedAt||includedFiles.has(file.id))continue;
    add(nearest(file.folder),file.size,1,0);
  }
  // Include empty folders that were omitted from the actual Canvas sample.
  // Count all levels implied by catalog paths, even when not explicitly listed.
  const allPaths=new Set<string>();
  for(const folder of scoped.folders){
    const parts=folder.split("/");
    for(let i=1;i<=parts.length;i++)allPaths.add(parts.slice(0,i).join("/"));
  }
  for(const folder of allPaths){
    if(includedFolders.has(folder))continue;
    const parent=folder.includes("/")?folder.slice(0,folder.lastIndexOf("/")):"";
    add(nearest(parent),0,0,1);
  }
  const candidates=[...aggregate].filter(([,v])=>v.files+v.folders>0)
    .sort((a,b)=>(b[1].files+b[1].folders)-(a[1].files+a[1].folders)||a[0].localeCompare(b[0],"ru"));
  const head=candidates.slice(0,11),tail=candidates.slice(11);
  if(tail.length){
    const sum=tail.reduce((v,[,n])=>({bytes:v.bytes+n.bytes,files:v.files+n.files,folders:v.folders+n.folders}),
      {bytes:0,files:0,folders:0});
    head.push(["",sum]);
  }
  const byFolder=new Map(graph.nodes.filter(n=>n.kind==="folder").map(n=>[n.folder,n]));
  for(let i=0;i<head.length;i++){
    const [path,v]=head[i]!;
    const parent=byFolder.get(path)||graph.nodes[0]!;
    const angle=(i+1)*2.399963229728653;
    const distance=62+Math.sqrt(i+1)*17;
    const id="cluster:"+i+":"+path;
    nodes.push({id,kind:"cluster",name:path?path.split("/").pop()||"Группа":"Остальные",
      folder:path,x:parent.x+Math.cos(angle)*distance,y:parent.y+Math.sin(angle)*distance,
      size:v.bytes,count:v.files,hiddenFiles:v.files,hiddenFolders:v.folders});
    edges.push({from:parent.id,to:id,kind:"contains"});
  }
  return {...graph,nodes,edges,focus,detail};
}
