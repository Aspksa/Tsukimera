/** Bounded, deterministic graph model. Every edge describes a real relationship:
 * folder membership, identical SHA-256, or a shared saved tag.
 */
import type {DiskFile} from "../api";

export type MapNode={
  id:string;kind:"root"|"folder"|"file";name:string;folder:string;
  x:number;y:number;size:number;sha?:string;tags?:string[];
};
export type MapEdge={from:string;to:string;kind:"contains"|"duplicate"|"tag"};
export type DiskGraph={nodes:MapNode[];edges:MapEdge[];shownFiles:number;totalFiles:number;
  shownFolders:number;totalFolders:number;bytes:number};

export function graphFromFiles(files:DiskFile[],folderNames:string[],
  limitFiles=240,limitFolders=110):DiskGraph{
  const active=files.filter(f=>!f.deletedAt);
  const folderSet=new Set<string>();
  const addPath=(path:string)=>{
    if(!path)return;
    const bits=path.split("/");
    for(let i=1;i<=bits.length;i++)folderSet.add(bits.slice(0,i).join("/"));
  };
  for(const folder of folderNames)addPath(folder);
  for(const file of active)addPath(file.folder);
  const sizes=new Map<string,number>();
  for(const file of active){
    if(!file.folder)continue;
    const parts=file.folder.split("/");
    for(let i=1;i<=parts.length;i++){
      const key=parts.slice(0,i).join("/");
      sizes.set(key,(sizes.get(key)||0)+file.size);
    }
  }
  const totalFolders=folderSet.size;
  const allFolders=[...folderSet].sort((a,b)=>
    (b?b.split("/").length:0)-(a?a.split("/").length:0) || a.localeCompare(b,"ru"));
  // Prefer folders containing data, but always include their parents.
  const picked=new Set<string>();
  const weighted=[...allFolders].sort((a,b)=>
    (sizes.get(b)||0)-(sizes.get(a)||0) || a.split("/").length-b.split("/").length || a.localeCompare(b,"ru"));
  for(const folder of weighted){
    const parts=folder.split("/"),required:string[]=[];
    for(let i=1;i<=parts.length;i++){
      const parent=parts.slice(0,i).join("/");
      if(!picked.has(parent))required.push(parent);
    }
    if(picked.size+required.length>Math.max(1,limitFolders))continue;
    required.forEach(f=>picked.add(f));
  }
  const selectedFolders=[...picked].sort((a,b)=>
    a.split("/").length-b.split("/").length || a.localeCompare(b,"ru"));
  const bytes=active.reduce((sum,f)=>sum+f.size,0);
  const nodes:MapNode[]=[{id:"root",kind:"root",name:"Диск",folder:"",x:0,y:0,size:bytes}];
  const edges:MapEdge[]=[];
  const byFolder=new Map<string,MapNode>();
  const byId=new Map(nodes.map(n=>[n.id,n]));
  let i=0;
  for(const name of selectedFolders){
    const depth=name.split("/").length;
    const angle=i++*2.399963229728653+depth*.24;
    const radius=115+Math.sqrt(i)*38+depth*48;
    const parent=name.includes("/")?name.slice(0,name.lastIndexOf("/")):"";
    const n:MapNode={id:"folder:"+name,kind:"folder",name:name.split("/").pop()||name,
      folder:name,x:Math.cos(angle)*radius,y:Math.sin(angle)*radius,size:sizes.get(name)||0};
    nodes.push(n);byId.set(n.id,n);byFolder.set(name,n);
    edges.push({from:byFolder.has(parent)?"folder:"+parent:"root",to:n.id,kind:"contains"});
  }
  const selected=active.filter(f=>!f.folder||picked.has(f.folder))
    .sort((a,b)=>b.size-a.size || a.name.localeCompare(b.name,"ru"))
    .slice(0,Math.max(0,limitFiles));
  const perFolder=new Map<string,number>();
  const duplicates=new Map<string,string>();
  const tags=new Map<string,string>();
  for(const file of selected){
    const parent=byFolder.get(file.folder)||nodes[0]!;
    const count=perFolder.get(file.folder)||0;perFolder.set(file.folder,count+1);
    const angle=(count+1)*2.399963229728653+(file.folder.length%13);
    const radius=43+Math.sqrt(count)*21;
    const n:MapNode={id:"file:"+file.id,kind:"file",name:file.name,folder:file.folder,
      x:parent.x+Math.cos(angle)*radius,y:parent.y+Math.sin(angle)*radius,
      size:file.size,sha:file.sha256,tags:file.tags};
    nodes.push(n);byId.set(n.id,n);
    edges.push({from:parent.id,to:n.id,kind:"contains"});
    if(file.sha256){
      const other=duplicates.get(file.sha256);
      if(other)edges.push({from:other,to:n.id,kind:"duplicate"});
      else duplicates.set(file.sha256,n.id);
    }
    // Limit auxiliary links to at most one per shared tag chain.
    for(const raw of (file.tags??[]).slice(0,3)){
      const tag=raw.trim().toLocaleLowerCase("ru-RU");
      if(!tag)continue;
      const other=tags.get(tag);
      if(other&&other!==n.id)edges.push({from:other,to:n.id,kind:"tag"});
      tags.set(tag,n.id);
    }
  }
  return {nodes,edges,shownFiles:selected.length,totalFiles:active.length,
    shownFolders:selectedFolders.length,totalFolders,bytes};
}
