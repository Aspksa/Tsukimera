/** Original, dependency-free, source-backed graph model for Tsukimera Disk 13.
 * The visual behavior is inspired by Obsidian Graph View (not its source code).
 * The graph never infers a semantic relation from a similar name or folder.
 */
import type {DiskFile} from "../api";
export type GraphKind="folder"|"file"|"tag";
export type LinkKind="contains"|"duplicate"|"tag";
export type GraphNode={
  id:string;kind:GraphKind;name:string;folder:string;size:number;depth:number;
  fileId?:string;sha256?:string;count?:number;
};
export type GraphLink={source:string;target:string;kind:LinkKind};
export type GraphScene={
  nodes:GraphNode[];links:GraphLink[];focus:string;
  totalCandidates:number;hidden:number;folders:number;files:number;duplicates:number;
};
export type GraphOptions={depth?:number;limit?:number;includeTags?:boolean;includeDuplicates?:boolean};
export type GraphPoint={x:number;y:number;vx:number;vy:number;pinned?:boolean};

const compare=(a:string,b:string)=>a.localeCompare(b,"ru",{numeric:true,sensitivity:"base"});
const parentOf=(folder:string)=>folder.includes("/")?folder.slice(0,folder.lastIndexOf("/")):"";
const last=(folder:string)=>folder.split("/").pop()||"Мой Диск";
const validSha=(s:string)=>/^[a-f0-9]{64}$/i.test(s);
const within=(path:string,focus:string)=>!focus||path===focus||path.startsWith(focus+"/");

/** Uses only catalogue filenames, concrete containment, user tags and exact SHA-256. */
export function graphFromCatalog(
  files:readonly DiskFile[],folderNames:readonly string[],folder:string,
  options:GraphOptions={}
):GraphScene{
  const depth=Math.max(1,Math.min(3,Math.trunc(options.depth??2)));
  const limit=Math.max(8,Math.min(240,Math.trunc(options.limit??96)));
  const active=files.filter(f=>!f.deletedAt);
  const allFolders=new Set<string>();
  const addParents=(path:string)=>{
    if(!path)return;
    const parts=path.split("/").filter(Boolean);
    for(let i=1;i<=parts.length;i++)allFolders.add(parts.slice(0,i).join("/"));
  };
  for(const f of folderNames)addParents(f);
  for(const f of active)addParents(f.folder);
  if(folder)addParents(folder);

  const folderCandidates=[...allFolders].filter(f=>{
    if(!within(f,folder))return false;
    return f.slice(folder?folder.length+1:0).split("/").length<=depth;
  }).sort((a,b)=>{
    const da=a.split("/").length,db=b.split("/").length;
    return da-db||compare(a,b);
  });
  const parent=folder?parentOf(folder):"";
  const focusId="folder:"+folder;
  const byId=new Map<string,GraphNode>();
  const add=(node:GraphNode)=>{
    if(!byId.has(node.id)&&byId.size<limit)byId.set(node.id,node);
  };
  add({id:focusId,kind:"folder",name:last(folder),folder,size:0,depth:0});
  if(folder)add({id:"folder:"+parent,kind:"folder",name:last(parent),folder:parent,size:0,depth:-1});
  for(const path of folderCandidates){
    const relative=folder?path.slice(folder.length+1):path;
    const d=relative.split("/").length;
    add({id:"folder:"+path,kind:"folder",name:last(path),folder:path,size:0,depth:d});
  }
  const depthOf=(path:string)=>folder?
    (path===folder?0:path.slice(folder.length+1).split("/").length):
    (path?path.split("/").length:0);
  const visibleFiles=active.filter(f=>within(f.folder,folder)&&depthOf(f.folder)<depth)
    .sort((a,b)=>depthOf(a.folder)-depthOf(b.folder)||compare(a.name,b.name));
  const fullCandidates=1+(folder?1:0)+folderCandidates.length+visibleFiles.length;
  for(const f of visibleFiles){
    const parentId="folder:"+f.folder;
    if(!byId.has(parentId))continue;
    add({id:"file:"+f.id,kind:"file",fileId:f.id,name:f.name,folder:f.folder,
      size:f.size,sha256:f.sha256,depth:depthOf(f.folder)+1});
  }
  // Add only verified exact-hash matches to already shown files. Links are
  // optional and never imply content similarity from a shared extension.
  const hashGroups=new Map<string,DiskFile[]>();
  if(options.includeDuplicates!==false){
    for(const f of active)if(validSha(f.sha256)){
      const h=f.sha256.toLowerCase();const group=hashGroups.get(h)||[];
      group.push(f);hashGroups.set(h,group);
    }
    for(const item of [...byId.values()].filter(n=>n.kind==="file")){
      const hashes=hashGroups.get(item.sha256?.toLowerCase()||"")||[];
      for(const f of hashes.slice(0,8)){
        if(f.id===item.fileId||byId.has("file:"+f.id))continue;
        add({id:"file:"+f.id,kind:"file",fileId:f.id,name:f.name,folder:f.folder,
          size:f.size,sha256:f.sha256,depth:Math.min(depth+1,item.depth+1)});
      }
    }
  }
  // A tag hub is a real user-assigned tag, not a guessed topic.
  const shownFiles=[...byId.values()].filter(n=>n.kind==="file");
  const tagged=new Map<string,string[]>();
  if(options.includeTags!==false){
    for(const node of shownFiles){
      const file=active.find(f=>f.id===node.fileId);
      for(const raw of (file?.tags||[]).slice(0,8)){
        const tag=raw.trim().slice(0,50);
        if(!tag)continue;
        const ids=tagged.get(tag)||[];ids.push(node.id);tagged.set(tag,ids);
      }
    }
    for(const [tag,ids] of tagged)if(ids.length>=2)
      add({id:"tag:"+tag,kind:"tag",name:"#"+tag,folder:"",size:0,depth:1});
  }
  const links:GraphLink[]=[],seen=new Set<string>();
  const edge=(source:string,target:string,kind:LinkKind)=>{
    if(source===target||!byId.has(source)||!byId.has(target))return;
    const key=kind+":"+[source,target].sort().join("|");
    if(seen.has(key))return;
    seen.add(key);links.push({source,target,kind});
  };
  for(const node of byId.values()){
    if(node.kind==="folder"&&node.id!==focusId){
      // A parent shown above focus points into focus, all other folders into their parent.
      if(node.folder===parent&&folder)edge(node.id,focusId,"contains");
      else edge("folder:"+parentOf(node.folder),node.id,"contains");
    }
    if(node.kind==="file")edge("folder:"+node.folder,node.id,"contains");
  }
  if(options.includeDuplicates!==false)
    for(const group of hashGroups.values()){
      if(group.length<2)continue;
      const ids=group.map(f=>"file:"+f.id).filter(id=>byId.has(id));
      // Linear star, not a quadratic clique; still truthful and readable.
      for(let i=1;i<ids.length;i++)edge(ids[0]!,ids[i]!,"duplicate");
    }
  if(options.includeTags!==false)
    for(const [tag,ids] of tagged)
      if(byId.has("tag:"+tag))
        for(const id of ids)edge("tag:"+tag,id,"tag");
  const folderCount=[...byId.values()].filter(n=>n.kind==="folder").length;
  const fileCount=[...byId.values()].filter(n=>n.kind==="file").length;
  // Exclude metadata-only tag hubs from hidden source-object count.
  return {
    nodes:[...byId.values()],links,focus:focusId,
    totalCandidates:fullCandidates,
    hidden:Math.max(0,fullCandidates-(folderCount+fileCount)),
    folders:folderCount,files:fileCount,
    duplicates:links.filter(l=>l.kind==="duplicate").length
  };
}

/** Stable initial positions, independent of render timing and display resolution. */
export function graphSeed(id:string):number{
  let hash=2166136261;
  for(let i=0;i<id.length;i++)hash=Math.imul(hash^id.charCodeAt(i),16777619);
  return hash>>>0;
}
export function graphInitial(node:GraphNode):GraphPoint{
  if(node.depth===0&&node.kind==="folder")return {x:0,y:0,vx:0,vy:0};
  const hash=graphSeed(node.id);
  const angle=(hash%100000)/100000*Math.PI*2;
  const layer=node.depth<0?230:Math.max(70,Math.abs(node.depth)*115);
  const jitter=((hash>>>12)%100)/100*56;
  return {x:Math.cos(angle)*(layer+jitter),y:Math.sin(angle)*(layer+jitter),vx:0,vy:0};
}

/** Gentle force layout with bounded work: O(n²) for <=240 visible nodes.
 * Each step decays velocities; callers cap frames and stop when settled.
 */
export function graphForceStep(
  nodes:readonly GraphNode[],links:readonly GraphLink[],
  locations:Map<string,GraphPoint>,strength=1
):number{
  const n=nodes.length;if(!n)return 0;
  const repel=4000*strength;
  for(let i=0;i<n;i++){
    const ai=locations.get(nodes[i]!.id);if(!ai)continue;
    if(!ai.pinned){ai.vx-=ai.x*.0009;ai.vy-=ai.y*.0009;}
    for(let j=i+1;j<n;j++){
      const bj=locations.get(nodes[j]!.id);if(!bj)continue;
      let dx=ai.x-bj.x,dy=ai.y-bj.y;
      const d2=Math.max(130,dx*dx+dy*dy);
      if(d2<1e-5){dx=2;dy=1;}
      const power=repel/d2;
      const fx=dx/Math.sqrt(d2)*power,fy=dy/Math.sqrt(d2)*power;
      if(!ai.pinned){ai.vx+=fx;ai.vy+=fy;}
      if(!bj.pinned){bj.vx-=fx;bj.vy-=fy;}
    }
  }
  for(const link of links){
    const a=locations.get(link.source),b=locations.get(link.target);
    if(!a||!b)continue;
    const dx=b.x-a.x,dy=b.y-a.y;
    const length=Math.max(1,Math.hypot(dx,dy));
    const target=link.kind==="contains"?100:link.kind==="duplicate"?85:105;
    const power=(length-target)*.013*strength;
    const fx=dx/length*power,fy=dy/length*power;
    if(!a.pinned){a.vx+=fx;a.vy+=fy;}
    if(!b.pinned){b.vx-=fx;b.vy-=fy;}
  }
  let kinetic=0;
  for(const node of nodes){
    const p=locations.get(node.id);if(!p||p.pinned)continue;
    p.vx=Math.max(-10,Math.min(10,p.vx*.77));
    p.vy=Math.max(-10,Math.min(10,p.vy*.77));
    p.x=Math.max(-900,Math.min(900,p.x+p.vx));
    p.y=Math.max(-900,Math.min(900,p.y+p.vy));
    kinetic+=Math.abs(p.vx)+Math.abs(p.vy);
  }
  return kinetic/n;
}
