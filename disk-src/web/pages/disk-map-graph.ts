/** Original, dependency-free, source-backed graph model for Tsukimera Disk 13.
 * The visual behavior is inspired by Obsidian Graph View (not its source code).
 * The graph never infers a semantic relation from a similar name or folder.
 */
import type {DiskFile} from "../api";
import type {SemanticIndex} from "./disk-map-semantic";
import {spatialFileType} from "./disk-map-spatial";
export type GraphKind="folder"|"file"|"tag"|"topic"|"person"|"organization"|"date"|"project"|"revision";
export type LinkKind="contains"|"duplicate"|"tag"|"lexical"|"entity"|"reference"|"revision";
export type GraphNode={
  id:string;kind:GraphKind;name:string;folder:string;size:number;depth:number;
  fileId?:string;sha256?:string;count?:number;revision?:number;fileType?:string;
};
export type GraphLink={source:string;target:string;kind:LinkKind;weight?:number;evidence?:string;confidence?:number};
export type GraphScene={
  nodes:GraphNode[];links:GraphLink[];focus:string;
  totalCandidates:number;hidden:number;folders:number;files:number;duplicates:number;
};
export type GraphOptions={depth?:number;limit?:number;includeTags?:boolean;includeDuplicates?:boolean;
 perFolder?:number;detailLevel?:"overview"|"standard"|"detail";
 semantic?:SemanticIndex|null;viewMode?:"all"|"meaning"|"versions"|"entities";};
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
  // Folder nodes remain factual: their relative area represents the number
  // of real descendants, even when individual files are intentionally folded.
  const counts=new Map<string,number>();
  for(const f of active){
    counts.set("",(counts.get("")||0)+1);
    let parent=f.folder;
    while(parent){
      counts.set(parent,(counts.get(parent)||0)+1);
      parent=parentOf(parent);
    }
  }

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
  add({id:focusId,kind:"folder",name:last(folder),folder,size:0,depth:0,count:counts.get(folder)||0});
  if(folder)add({id:"folder:"+parent,kind:"folder",name:last(parent),folder:parent,size:0,depth:-1,count:counts.get(parent)||0});
  // Reserve graph capacity for documents, even in a root with hundreds of folders.
  // Without this, folder nodes consume the whole limit before files appear.
  let shownFolderCandidates=0;
  const folderBudget=Math.max(3,Math.floor(limit*.55));
  for(const path of folderCandidates){
    if(shownFolderCandidates>=folderBudget)break;
    const relative=folder?path.slice(folder.length+1):path;
    const d=relative.split("/").length;
    add({id:"folder:"+path,kind:"folder",name:last(path),folder:path,size:0,depth:d,count:counts.get(path)||0});
    shownFolderCandidates++;
  }
  const depthOf=(path:string)=>folder?
    (path===folder?0:path.slice(folder.length+1).split("/").length):
    (path?path.split("/").length:0);
  const visibleFiles=active.filter(f=>within(f.folder,folder)&&depthOf(f.folder)<depth)
    .sort((a,b)=>depthOf(a.folder)-depthOf(b.folder)||compare(a.name,b.name)||
      compare(a.id,b.id));
  const fullCandidates=1+(folder?1:0)+folderCandidates.length+visibleFiles.length;
  const perFolder=Math.max(1,Math.min(96,Math.trunc(options.perFolder??
    (options.detailLevel==="overview"?4:options.detailLevel==="detail"?72:28))));
  // Balanced reveal by real folder: one enormous directory cannot starve
  // all smaller groups. At distant zoom the folder node itself is an honest
  // aggregate, with the true descendant count retained on that node.
  const byFolder=new Map<string,DiskFile[]>();
  for(const f of visibleFiles){
    if(!byId.has("folder:"+f.folder))continue;
    const group=byFolder.get(f.folder)||[];
    group.push(f);byFolder.set(f.folder,group);
  }
  const paths=[...byFolder.keys()].sort((a,b)=>depthOf(a)-depthOf(b)||compare(a,b));
  const chosen=new Map<string,number>();
  let any=true,round=0;
  while(any&&byId.size<limit&&round<perFolder){
    any=false;
    for(const path of paths){
      const group=byFolder.get(path)!;
      const index=chosen.get(path)||0;
      if(index>=group.length||index>=perFolder)continue;
      const f=group[index]!;
      add({id:"file:"+f.id,kind:"file",fileId:f.id,name:f.name,folder:f.folder,
        size:f.size,sha256:f.sha256,revision:f.revision,
        fileType:spatialFileType(f.name),depth:depthOf(f.folder)+1});
      chosen.set(path,index+1);any=true;
      if(byId.size>=limit)break;
    }
    round++;
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
          size:f.size,sha256:f.sha256,revision:f.revision,
          fileType:spatialFileType(f.name),depth:Math.min(depth+1,item.depth+1)});
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
  const edge=(source:string,target:string,kind:LinkKind,weight=1,evidence="",confidence=1)=>{
    if(source===target||!byId.has(source)||!byId.has(target))return;
    const key=kind+":"+[source,target].sort().join("|");
    if(seen.has(key))return;
    seen.add(key);links.push({source,target,kind,weight,evidence,confidence});
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

  // Only source-backed semantic nodes whose actual file endpoints are visible.
  // The extraction is opt-in and ephemeral; this model never reads file text.
  const evidence=options.semantic;
  if(evidence&&options.viewMode!=="versions"){
    for(const n of evidence.nodes){
      if(!evidence.links.some(l=>l.source===n.id&&byId.has(l.target)))continue;
      if(!byId.has(n.id))add({id:n.id,kind:n.kind,name:n.name,folder:"",size:0,
        depth:2,count:n.count});
    }
    for(const relation of evidence.links){
      if(!byId.has(relation.source)||!byId.has(relation.target))continue;
      // A shared folder only reinforces a demonstrated textual overlap.
      // Being in the same folder alone is never enough to imply similarity.
      const source=byId.get(relation.source),target=byId.get(relation.target);
      const sameFolder=relation.kind==="lexical"&&source?.kind==="file"&&
        target?.kind==="file"&&source.folder===target.folder;
      edge(relation.source,relation.target,relation.kind,
        relation.weight*(sameFolder?1.2:1),
        relation.evidence+(sameFolder?" · общая папка":""),relation.confidence);
    }
  }
  // The last known revision number is not a full revision history. Show a
  // metadata node only if the server catalogue explicitly reports revision >1.
  if(options.viewMode==="versions"||options.viewMode==="all"){
    for(const file of [...byId.values()].filter(n=>n.kind==="file"&&Number(n.revision)>1)){
      const nid="revision:"+file.id;
      add({id:nid,kind:"revision",name:"Редакция №"+file.revision,
        folder:file.folder,size:0,depth:file.depth+1,count:file.revision});
      edge(file.id,nid,"revision",.8,"Текущая редакция в каталоге: "+file.revision,1);
    }
  }
  const folderCount=[...byId.values()].filter(n=>n.kind==="folder").length;
  const fileCount=[...byId.values()].filter(n=>n.kind==="file").length;
  // Exclude metadata-only tag hubs from hidden source-object count.
  return {
    nodes:[...byId.values()],links:links.filter(l=>{
      if(options.viewMode==="meaning")return ["lexical","entity","reference"].includes(l.kind);
      if(options.viewMode==="versions")return ["duplicate","revision"].includes(l.kind);
      if(options.viewMode==="entities")return l.kind==="entity";
      return true;
    }),focus:focusId,
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
  // Real parent-folder affiliation gives new files a stable starting cluster.
  // Existing positions remain unchanged after updates (see graph UI).
  if(node.kind==="file"){
    const groupSeed=graphSeed("folder:"+node.folder);
    const fileSeed=graphSeed(node.id);
    const groupAngle=(groupSeed%100000)/100000*Math.PI*2;
    const localAngle=(fileSeed%100000)/100000*Math.PI*2;
    const parentDepth=Math.max(0,node.depth-1);
    const groupRadius=parentDepth===0?0:110+parentDepth*75;
    const localRadius=48+((fileSeed>>>11)%53);
    return {
      x:Math.cos(groupAngle)*groupRadius+Math.cos(localAngle)*localRadius,
      y:Math.sin(groupAngle)*groupRadius+Math.sin(localAngle)*localRadius,
      vx:0,vy:0
    };
  }
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
  // Damped collision forces prevent label/node overlap without explosive
  // motion; the same physical positions work at every monitor resolution.
  const repel=3350*strength;
  for(let i=0;i<n;i++){
    const ai=locations.get(nodes[i]!.id);if(!ai)continue;
    if(!ai.pinned){ai.vx-=ai.x*.0009;ai.vy-=ai.y*.0009;}
    for(let j=i+1;j<n;j++){
      const bj=locations.get(nodes[j]!.id);if(!bj)continue;
      let dx=ai.x-bj.x,dy=ai.y-bj.y;
      if(Math.abs(dx)+Math.abs(dy)<.001){
        const angle=(graphSeed(nodes[i]!.id+"|"+nodes[j]!.id)%360)*Math.PI/180;
        dx=Math.cos(angle)*2;dy=Math.sin(angle)*2;
      }
      const d=Math.max(1,Math.hypot(dx,dy)),d2=Math.max(160,d*d);
      const ra=nodes[i]!.kind==="folder"?33:nodes[i]!.kind==="file"?16:22;
      const rb=nodes[j]!.kind==="folder"?33:nodes[j]!.kind==="file"?16:22;
      const collision=Math.max(0,ra+rb-d)*.18*strength;
      const power=repel/d2+collision;
      const fx=dx/d*power,fy=dy/d*power;
      if(!ai.pinned){ai.vx+=fx;ai.vy+=fy;}
      if(!bj.pinned){bj.vx-=fx;bj.vy-=fy;}
    }
  }
  for(const link of links){
    const a=locations.get(link.source),b=locations.get(link.target);
    if(!a||!b)continue;
    const dx=b.x-a.x,dy=b.y-a.y;
    const length=Math.max(1,Math.hypot(dx,dy));
    const target=link.kind==="contains"?100:link.kind==="duplicate"?85:
      link.kind==="lexical"?125:105;
    const power=(length-target)*.013*strength*Math.max(.35,Math.min(1.5,link.weight??1));
    const fx=dx/length*power,fy=dy/length*power;
    if(!a.pinned){a.vx+=fx;a.vy+=fy;}
    if(!b.pinned){b.vx-=fx;b.vy-=fy;}
  }
  let kinetic=0;
  for(const node of nodes){
    const p=locations.get(node.id);if(!p||p.pinned)continue;
    p.vx=Math.max(-8,Math.min(8,p.vx*.72));
    p.vy=Math.max(-8,Math.min(8,p.vy*.72));
    p.x=Math.max(-900,Math.min(900,p.x+p.vx));
    p.y=Math.max(-900,Math.min(900,p.y+p.vy));
    kinetic+=Math.abs(p.vx)+Math.abs(p.vy);
  }
  return kinetic/n;
}
