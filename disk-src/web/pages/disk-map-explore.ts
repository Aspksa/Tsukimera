/**
 * Disk 17: inspectable paths through genuinely present graph edges.
 * A path only exists when every step has a real relation in the current
 * bounded scene. Never silently infer a link between documents or people.
 */
import type {GraphLink,GraphNode,GraphScene,GraphPoint} from "./disk-map-graph";

export type GraphRoute={nodes:string[];links:GraphLink[];cost:number};
const edgeCost:Record<GraphLink["kind"],number>={
  duplicate:.45,reference:.85,lexical:1.7,entity:1.8,
  tag:2,co_mention:2.25,revision:2.5,contains:4.5
};
export function graphRoute(scene:Pick<GraphScene,"nodes"|"links">,
  from:string,to:string):GraphRoute|null{
  if(from===to)return scene.nodes.some(n=>n.id===from)?{nodes:[from],links:[],cost:0}:null;
  const exists=new Set(scene.nodes.map(n=>n.id));
  if(!exists.has(from)||!exists.has(to))return null;
  const adj=new Map<string,Array<{target:string;edge:GraphLink;cost:number}>>();
  for(const edge of scene.links){
    if(!exists.has(edge.source)||!exists.has(edge.target))continue;
    const cost=edgeCost[edge.kind]??4.5;
    const a=adj.get(edge.source)||[],b=adj.get(edge.target)||[];
    a.push({target:edge.target,edge,cost});
    b.push({target:edge.source,edge,cost});
    adj.set(edge.source,a);adj.set(edge.target,b);
  }
  const distance=new Map<string,number>([[from,0]]);
  const previous=new Map<string,{from:string;edge:GraphLink}>();
  const pending=new Set<string>([from]),visited=new Set<string>();
  while(pending.size){
    // Deterministic tie-breaking across browser sessions and re-renders.
    const current=[...pending].sort((a,b)=>(distance.get(a)??Infinity)-
      (distance.get(b)??Infinity)||a.localeCompare(b))[0]!;
    pending.delete(current);
    if(current===to)break;
    if(visited.has(current))continue;
    visited.add(current);
    for(const link of adj.get(current)||[]){
      if(visited.has(link.target))continue;
      const next=(distance.get(current)??Infinity)+link.cost;
      const old=distance.get(link.target)??Infinity;
      if(next<old-1e-7){
        distance.set(link.target,next);
        previous.set(link.target,{from:current,edge:link.edge});
        pending.add(link.target);
      }
    }
  }
  if(!previous.has(to))return null;
  const path=[to],links:GraphLink[]=[];
  let cursor=to;
  while(cursor!==from&&path.length<=exists.size+1){
    const step=previous.get(cursor);
    if(!step)return null;
    links.unshift(step.edge);path.unshift(step.from);cursor=step.from;
  }
  if(path[0]!==from)return null;
  return {nodes:path,links,cost:distance.get(to)!};
}
export function graphNeighbors(scene:Pick<GraphScene,"nodes"|"links">,
  id:string,hops=2):Set<string>{
  const result=new Set<string>();
  if(!scene.nodes.some(n=>n.id===id))return result;
  result.add(id);
  let frontier=new Set<string>([id]);
  for(let i=0;i<Math.min(3,Math.max(0,hops));i++){
    const next=new Set<string>();
    for(const e of scene.links){
      if(frontier.has(e.source)&&!result.has(e.target))next.add(e.target);
      if(frontier.has(e.target)&&!result.has(e.source))next.add(e.source);
    }
    for(const n of next)result.add(n);
    frontier=next;
    if(frontier.size===0)break;
  }
  return result;
}
export function graphEdgeExplanation(edge:GraphLink,
  nodes:readonly GraphNode[]):string{
  const byId=new Map(nodes.map(n=>[n.id,n]));
  const a=byId.get(edge.source),b=byId.get(edge.target);
  const source=a?.name||edge.source,target=b?.name||edge.target;
  if(edge.kind==="contains")return "Расположение на Диске: "+source+" → "+target;
  if(edge.kind==="duplicate")return "Точные дубликаты SHA-256: "+source+" и "+target;
  if(edge.kind==="tag")return "Пользовательская метка: "+source+" — "+target;
  if(edge.kind==="revision")return edge.evidence||"Номер редакции из каталога";
  if(edge.kind==="co_mention")return edge.evidence||
    "Имена встретились в одном тексте; знакомство не подтверждено";
  if(edge.kind==="entity")return edge.evidence||
    "Совпадающее упоминание в текстах (не подтверждение личности)";
  if(edge.kind==="reference")return edge.evidence||
    "Буквальное упоминание имени другого файла";
  if(edge.kind==="lexical")return edge.evidence||
    "Совпадающие слова, не доказанное смысловое тождество";
  return "Связь без проверенного источника";
}
/** Distance to a visible line segment, in CSS pixels. Null means no edge hit. */
export function graphEdgeAt(
  scene:Pick<GraphScene,"nodes"|"links">,
  points:Map<string,GraphPoint>,
  camera:{cx:number;cy:number;scale:number},
  x:number,y:number,threshold=8
):GraphLink|null{
  let result:GraphLink|null=null,closest=Math.max(0,threshold);
  for(const e of scene.links){
    const a=points.get(e.source),b=points.get(e.target);
    if(!a||!b)continue;
    const ax=camera.cx+a.x*camera.scale,ay=camera.cy+a.y*camera.scale;
    const bx=camera.cx+b.x*camera.scale,by=camera.cy+b.y*camera.scale;
    const dx=bx-ax,dy=by-ay,length2=dx*dx+dy*dy;
    if(length2<.0001)continue;
    const t=Math.max(0,Math.min(1,((x-ax)*dx+(y-ay)*dy)/length2));
    const distance=Math.hypot(x-(ax+dx*t),y-(ay+dy*t));
    if(distance<closest){closest=distance;result=e;}
  }
  return result;
}
