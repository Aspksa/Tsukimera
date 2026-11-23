/** Adapter for the incremental Python Graph Engine 22.
 * It only supplies observed semantic evidence to the existing single Canvas;
 * the catalogue remains the source of truth for file/folder identity.
 */
import type {SemanticIndex,SemanticNode,SemanticLink} from "./disk-map-semantic";
type NodeLike={id:string;kind:string;name:string;degree?:number};
type EdgeLike={source:string;target:string;kind:string;weight?:number;
  evidence?:string;confidence?:number};
export type PythonGraph22={
  nodes?:NodeLike[];links?:EdgeLike[];total?:number;visible?:number;
  omitted?:number;level?:string;progress?:{processed?:number;pending?:number;files?:number}
};
const allowed=new Set(["project","organization","person","date"]);
const strength=(v:unknown)=>typeof v==="number"&&Number.isFinite(v)?
  Math.max(0,Math.min(1,v)):0;
export function graph22ToSemantic(raw:PythonGraph22):SemanticIndex{
  const indexed=Array.isArray(raw.nodes)?raw.nodes:[];
  const allIds=new Set(indexed.map(x=>x.id));
  const nodes:SemanticNode[]=indexed.filter(n=>allowed.has(n.kind)&&
    typeof n.id==="string"&&typeof n.name==="string")
    .slice(0,70).map(n=>({id:n.id,
      kind:n.kind as SemanticNode["kind"],name:n.name,
      count:Math.max(1,n.degree||1)}));
  const links:SemanticLink[]=[];
  const seen=new Set<string>();
  for(const edge of Array.isArray(raw.links)?raw.links:[]){
    if(!allIds.has(edge.source)||!allIds.has(edge.target))continue;
    if(edge.kind!=="reference"&&edge.kind!=="contract"&&edge.kind!=="organization")
      continue;
    if(typeof edge.evidence!=="string"||!edge.evidence.trim())continue;
    // File-to-entity references and precise same-contract relationships
    // are grounded; a shared organization remains a weaker, descriptive edge.
    const relation:SemanticLink={
      source:edge.source,target:edge.target,
      kind:edge.kind==="contract"?"reference":"entity",
      weight:Math.max(.3,Math.min(2,edge.weight??edge.confidence??.5)),
      confidence:strength(edge.confidence),evidence:edge.evidence.slice(0,320)
    };
    const key=[relation.source,relation.target].sort().join("|")+":"+edge.kind;
    if(!seen.has(key)){links.push(relation);seen.add(key);}
    if(links.length>=320)break;
  }
  return {records:{},nodes,links,
    processed:raw.progress?.files||0,unreadable:0,
    truncated:Math.max(0,Number(raw.omitted)||0)};
}
