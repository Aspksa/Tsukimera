/** Disk 21: a visible document chain is an ordering of REAL graph edges.
 * Never connect two nodes with an invented curve or claim that sharing
 * an organization means participating in a contract.
 */
import type {GraphScene,GraphLink,GraphNode,GraphPoint} from "./disk-map-graph";
export type DocumentChain={nodes:string[];links:GraphLink[];contract:string};
function documentKind(name:string):number{
  if(/договор|контракт/i.test(name))return 0;
  if(/приложен|соглашен/i.test(name))return 1;
  if(/акт/i.test(name))return 2;
  if(/сч[её]т|invoice/i.test(name))return 3;
  return 4;
}
/** A contract entity requires at least two evidenced file->project links
 * (not general company co-mentions), then orders the known document types.
 * A direct file-file "reference" must explicitly name a shared contract.
 */
export function graphDocumentChain(scene:Pick<GraphScene,"nodes"|"links">,
  fileNodeId:string):DocumentChain|null{
  const nodes=new Map(scene.nodes.map(n=>[n.id,n]));
  const selected=nodes.get(fileNodeId);
  if(!selected||selected.kind!=="file")return null;
  const matches:Array<{node:GraphNode;edge:GraphLink;project:string}>=[];
  for(const e of scene.links){
    if(e.kind!=="entity"||!(e.confidence!==undefined&&e.confidence>=.9))continue;
    const a=nodes.get(e.source),b=nodes.get(e.target);
    const project=a?.kind==="project"?a:b?.kind==="project"?b:null;
    const file=a?.kind==="file"?a:b?.kind==="file"?b:null;
    if(!project||!file||!/^Договор №/i.test(project.name)||
      !/(?:договор|контракт)/i.test(e.evidence||""))continue;
    matches.push({node:file,edge:e,project:project.id});
  }
  const projectIds=[...new Set(matches.filter(x=>x.node.id===fileNodeId).map(x=>x.project))];
  for(const project of projectIds){
    const candidates=matches.filter(x=>x.project===project)
      .sort((a,b)=>documentKind(a.node.name)-documentKind(b.node.name)||
        a.node.name.localeCompare(b.node.name,"ru")||a.node.id.localeCompare(b.node.id));
    const unique=[...new Map(candidates.map(x=>[x.node.id,x])).values()].slice(0,8);
    if(unique.length<2)continue;
    const result={nodes:unique.map(x=>x.node.id),links:unique.map(x=>x.edge),
      contract:nodes.get(project)?.name||"Договор"};
    // Include the actual intermediate project hub so that every painted
    // highlighted segment has one of the existing source-backed edges.
    result.nodes.push(project);
    return result;
  }
  return null;
}
/** Newly discovered factual nodes enter near an already positioned real
 * neighbor, preferring "contains" for new files and "entity"/"reference"
 * for new knowledge nodes. Deterministic slight offset prevents overlap.
 * Existing points remain unchanged and manual pins stay untouched.
 */
export function graphEntryPoint(node:GraphNode,links:readonly GraphLink[],
  coords:Map<string,GraphPoint>,fallback:GraphPoint):GraphPoint{
  const priority:Record<string,number>={contains:0,reference:1,entity:2,
    duplicate:3,tag:4,lexical:5,co_mention:6,revision:7};
  const nearby=links.filter(e=>e.source===node.id||e.target===node.id)
    .map(e=>({edge:e,other:e.source===node.id?e.target:e.source}))
    .filter(x=>coords.has(x.other))
    .sort((a,b)=>(priority[a.edge.kind]??8)-(priority[b.edge.kind]??8)||
      a.other.localeCompare(b.other));
  if(!nearby.length)return {...fallback};
  const base=coords.get(nearby[0]!.other)!;
  const sum=[...node.id].reduce((n,c)=>(Math.imul(n,31)+c.charCodeAt(0))>>>0,7);
  const angle=(sum%360)*Math.PI/180;
  const radius=23+sum%19;
  return {x:base.x+Math.cos(angle)*radius,
    y:base.y+Math.sin(angle)*radius,vx:0,vy:0};
}
