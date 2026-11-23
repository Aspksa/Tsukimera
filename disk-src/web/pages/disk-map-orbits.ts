/**
 * Disk 9.0 orbit layout: only actual "contains" relationships define parents.
 * Stable, collision-aware, bounded placement. No physics loop or dependency.
 */
import type {MiniGraph,MiniNode} from "./disk-map-mini-model";

export type OrbitPoint={x:number;y:number};
const TAU=Math.PI*2;
const GOLDEN=2.399963229728653;
const GRID=40;
const MIN_GAP=29;
const parentOf=(graph:MiniGraph)=>{
  const parents=new Map<string,string>();
  for(const e of graph.edges)
    if(e.kind==="contains"&&!parents.has(e.to))parents.set(e.to,e.from);
  return parents;
};
/** Full root -> node trail via actual folder/file containment edges, with loop guard. */
export function containmentTrail(graph:MiniGraph,nodeId:string):string[]{
  const parents=parentOf(graph),exists=new Set(graph.nodes.map(n=>n.id));
  if(!exists.has(nodeId))return [];
  const path:string[]=[],seen=new Set<string>();
  let id: string|undefined=nodeId;
  while(id&&exists.has(id)&&!seen.has(id)){
    path.push(id);seen.add(id);id=parents.get(id);
  }
  return path.reverse();
}
export function adaptiveMapWeight(folderCount:number):number{
  // Many folders need taller tree; empty Disk gives the map more space.
  const count=Number.isFinite(folderCount)?Math.max(0,folderCount):0;
  return Math.max(.15,Math.min(.33,.32-Math.log2(1+count)*.022));
}
export function orbitLayout(graph:MiniGraph):MiniGraph{
  const nodes=graph.nodes,byId=new Map(nodes.map(n=>[n.id,n]));
  const children=new Map<string,MiniNode[]>();
  const parents=parentOf(graph);
  for(const n of nodes){
    const parent=parents.get(n.id);
    if(!parent||!byId.has(parent))continue;
    const bucket=children.get(parent)||[];
    bucket.push(n);children.set(parent,bucket);
  }
  const priority=(n:MiniNode)=>n.kind==="folder"?0:n.kind==="cluster"?1:2;
  for(const list of children.values())list.sort((a,b)=>
    priority(a)-priority(b)||b.size-a.size||a.id.localeCompare(b.id,"ru"));
  const positions=new Map<string,OrbitPoint>([["root",{x:0,y:0}]]);
  // Spatial buckets avoid quadratic overlap checks even for the 303-node limit.
  const buckets=new Map<string,OrbitPoint[]>();
  const key=(x:number,y:number)=>Math.floor(x/GRID)+":"+Math.floor(y/GRID);
  const occupy=(p:OrbitPoint)=>{
    const k=key(p.x,p.y),bucket=buckets.get(k)||[];
    bucket.push(p);buckets.set(k,bucket);
  };
  occupy({x:0,y:0});
  const clear=(p:OrbitPoint)=>{
    const cx=Math.floor(p.x/GRID),cy=Math.floor(p.y/GRID);
    for(let dx=-1;dx<=1;dx++)for(let dy=-1;dy<=1;dy++){
      const others=buckets.get((cx+dx)+":"+(cy+dy));
      if(!others)continue;
      for(const q of others)if((p.x-q.x)**2+(p.y-q.y)**2<MIN_GAP**2)return false;
    }
    return true;
  };
  const queue=["root"],seen=new Set(queue);
  while(queue.length){
    const parentId=queue.shift()!;
    const parent=positions.get(parentId)||{x:0,y:0};
    const siblings=children.get(parentId)||[];
    for(let i=0;i<siblings.length;i++){
      const n=siblings[i]!;
      const base=n.kind==="file"?60:n.kind==="cluster"?94:130;
      // Width grows with sibling count without forcing one huge single ring.
      const ring=Math.floor(Math.sqrt(i));
      const angle=i*GOLDEN+(parentId==="root"?0:.52);
      let selected:OrbitPoint|null=null;
      for(let trial=0;trial<90;trial++){
        const r=base+ring*43+trial*13;
        const a=angle+trial*.31;
        const candidate={x:parent.x+Math.cos(a)*r,y:parent.y+Math.sin(a)*r};
        if(clear(candidate)){selected=candidate;break;}
      }
      // Bounded emergency fallback (never an infinite search).
      if(!selected)selected={x:parent.x+Math.cos(angle)*(base+1400+i*5),
        y:parent.y+Math.sin(angle)*(base+1400+i*5)};
      positions.set(n.id,selected);occupy(selected);
      if(!seen.has(n.id)){seen.add(n.id);queue.push(n.id);}
    }
  }
  // Defensive handling of a malformed external graph: detached entries remain
  // visible as distant satellites, not silently dropped.
  let detached=0;
  return {...graph,nodes:nodes.map(n=>{
    const p=positions.get(n.id);
    if(p)return {...n,x:p.x,y:p.y};
    const index=++detached,angle=index*GOLDEN;
    return {...n,x:Math.cos(angle)*(1400+index*32),y:Math.sin(angle)*(1400+index*32)};
  })};
}
