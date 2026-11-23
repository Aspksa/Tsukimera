/**
 * Disk 19 — living constellations. All colours, communities, curves and
 * visual bundles are derived solely from existing catalogue nodes and links.
 * A bundle is a rendering shortcut, NEVER a new link or inferred relationship.
 */
import type {GraphLink,GraphNode,GraphPoint,GraphScene} from "./disk-map-graph";

export type ArtCommunity={id:string;parent:string;members:string[];count:number;color:string;layer:number};
export type ArtLayout={membership:Map<string,string>;communities:ArtCommunity[];
  children:Map<string,string[]>;degree:Map<string,number>};
export type ArtBundle={edge:GraphLink;edges:GraphLink[];count:number};
export type ArtCurve={x1:number;y1:number;cx:number;cy:number;x2:number;y2:number};
export type ArtCamera={cx:number;cy:number;scale:number};
const clamp=(v:number,min:number,max:number)=>Math.max(min,Math.min(max,v));
export const artEase=(t:number)=>1-Math.pow(1-clamp(t,0,1),3);
export const artLerp=(from:number,to:number,t:number)=>from+(to-from)*clamp(t,0,1);
function hash(value:string):number{
  let n=2166136261;
  for(let i=0;i<value.length;i++){n^=value.charCodeAt(i);n=Math.imul(n,16777619);}
  return n>>>0;
}
const colorSet=["#e1b879","#91b9e4","#b9a1e7","#7accc2",
  "#db9fca","#9bcea1","#e1a594","#a0b6e2"];
export function artColor(key:string):string{
  return colorSet[hash(key)%colorSet.length]!;
}
export function artRgb(hex:string):string{
  const color=hex.replace("#","");
  return [0,2,4].map(i=>parseInt(color.slice(i,i+2),16)).join(",");
}
function topFolder(path:string):string{
  return path.split("/").filter(Boolean)[0]||"root";
}
function groupKey(n:GraphNode):string{
  if(n.kind==="folder"&&n.folder==="")return "root";
  if(n.kind==="folder"||n.kind==="file"||n.kind==="revision")
    return "folder:"+topFolder(n.folder);
  if(n.folder&&n.folder!=="")return "folder:"+topFolder(n.folder);
  return "semantic:"+n.kind;
}
/** Stable automatic communities: root folder groups and semantic satellites.
 * Meaningful verified edges attach a semantic satellite to its strongest
 * source group. Real folder membership takes priority for file nodes.
 * Label propagation may move files only when 2+ strong non-containment links
 * agree on another group — one lexical coincidence cannot relocate a file.
 */
export function graphArtLayout(scene:Pick<GraphScene,"nodes"|"links">):ArtLayout{
  const nodes=[...scene.nodes].sort((a,b)=>a.id.localeCompare(b.id));
  const initial=new Map(nodes.map(n=>[n.id,groupKey(n)]));
  const membership=new Map(initial);
  const degree=new Map(nodes.map(n=>[n.id,0]));
  const adjacency=new Map<string,Array<{other:string;weight:number;kind:string}>>();
  for(const edge of scene.links){
    if(!initial.has(edge.source)||!initial.has(edge.target))continue;
    degree.set(edge.source,(degree.get(edge.source)||0)+1);
    degree.set(edge.target,(degree.get(edge.target)||0)+1);
    const weight=edge.kind==="duplicate"?2.5:edge.kind==="reference"?2:
      edge.kind==="entity"?1.7:edge.kind==="co_mention"?1.25:
      edge.kind==="lexical"?1.0:edge.kind==="contains"?.5:1.1;
    for(const [id,other] of [[edge.source,edge.target],[edge.target,edge.source]]){
      const neighbors=adjacency.get(id)||[];
      neighbors.push({other,weight,kind:edge.kind});adjacency.set(id,neighbors);
    }
  }
  for(let pass=0;pass<2;pass++)for(const node of nodes){
    const scores=new Map<string,{score:number;support:number}>();
    for(const edge of adjacency.get(node.id)||[]){
      const key=membership.get(edge.other);
      if(!key||key==="root"||edge.kind==="contains")continue;
      const record=scores.get(key)||{score:0,support:0};
      record.score+=edge.weight;record.support++;
      scores.set(key,record);
    }
    const best=[...scores.entries()].sort((a,b)=>b[1].score-a[1].score||
      a[0].localeCompare(b[0]))[0];
    if(!best)continue;
    if(node.kind!=="file"&&node.kind!=="folder"&&node.kind!=="revision"){
      membership.set(node.id,best[0]);
    }else if(node.kind==="file"&&best[1].support>=2&&
      best[1].score>=4.8&&best[0]!==initial.get(node.id)){
      membership.set(node.id,best[0]);
    }
  }
  const groups=new Map<string,string[]>();
  for(const node of nodes){
    const key=membership.get(node.id)!;
    const members=groups.get(key)||[];members.push(node.id);groups.set(key,members);
  }
  const communities=[...groups.entries()].sort((a,b)=>a[0].localeCompare(b[0]))
    .map(([key,members],i)=>({id:key,parent:"root",members,
      count:members.length,color:colorSet[(i+hash(key)%3)%colorSet.length]!,
      layer:hash(key)%3}));
  // Real folder nesting is a separate refinement; no phantom subfolders.
  const children=new Map<string,string[]>();
  for(const n of nodes){
    if(n.kind!=="folder")continue;
    const p=n.folder.includes("/")?n.folder.slice(0,n.folder.lastIndexOf("/")):"";
    const parent="folder:"+p;
    if(n.id===parent)continue;
    const items=children.get(parent)||[];items.push(n.id);children.set(parent,items);
  }
  return {membership,communities,children,degree};
}
export function artCommunityColor(layout:ArtLayout,id:string):string{
  const key=layout.membership.get(id)||"root";
  return layout.communities.find(c=>c.id===key)?.color||artColor(key);
}
export function artImportance(node:GraphNode,layout:ArtLayout):number{
  const deg=layout.degree.get(node.id)||0;
  return clamp(1+.1*Math.sqrt(deg)+
    (node.kind==="folder"?.15*Math.log2(1+(node.count||0)):0),1,1.8);
}
export function artDepth(id:string,layout:ArtLayout):number{
  const key=layout.membership.get(id)||"root";
  const layer=layout.communities.find(c=>c.id===key)?.layer??0;
  return [.90,1,1.08][layer]!;
}
/** Visual detail is reversible: zoomed-out lines are a subset of factual
 * edges; no endpoints, links or evidence are fabricated or persisted.
 */
export function artBundleEdges(edges:readonly GraphLink[],
  layout:ArtLayout,zoom:number,emphasis:ReadonlySet<GraphLink>=new Set()):ArtBundle[]{
  if(zoom>=1.5)return edges.map(edge=>({edge,edges:[edge],count:1}));
  const groups=new Map<string,GraphLink[]>();
  for(const edge of edges){
    if(emphasis.has(edge)){
      groups.set("em:"+groups.size+":"+edge.source+"|"+edge.target,[edge]);continue;
    }
    let a=layout.membership.get(edge.source)||edge.source;
    let b=layout.membership.get(edge.target)||edge.target;
    if(a>b)[a,b]=[b,a];
    const key=edge.kind+"|"+a+"|"+b;
    const arr=groups.get(key)||[];arr.push(edge);groups.set(key,arr);
  }
  const output:ArtBundle[]=[];
  for(const list of groups.values()){
    const sorted=[...list].sort((a,b)=>a.source.localeCompare(b.source)||
      a.target.localeCompare(b.target));
    if(sorted.length<=2||zoom>1.02){
      for(const edge of sorted)output.push({edge,edges:[edge],count:1});
    }else{
      // Real representative edge; thickness reflects exact multiplicity.
      output.push({edge:sorted[0]!,edges:sorted,count:sorted.length});
    }
  }
  return output;
}
export function artCurve(edge:GraphLink,points:Map<string,GraphPoint>,
  camera:ArtCamera,layout:ArtLayout):ArtCurve|null{
  const a=points.get(edge.source),b=points.get(edge.target);
  if(!a||!b)return null;
  const x1=camera.cx+a.x*camera.scale,y1=camera.cy+a.y*camera.scale;
  const x2=camera.cx+b.x*camera.scale,y2=camera.cy+b.y*camera.scale;
  const dx=x2-x1,dy=y2-y1,d=Math.hypot(dx,dy);
  if(d<.001)return null;
  const left=layout.membership.get(edge.source);
  const right=layout.membership.get(edge.target);
  const cross=left!==right;
  // Cross-group links bend around dense centers; curved geometry is used
  // by both renderer and hit-testing, so tooltips match the visible line.
  const sign=(hash([edge.source,edge.target].sort().join("|"))%2)?1:-1;
  const bend=clamp(d*(cross?.12:.045),0,cross?32:12)*sign;
  return {x1,y1,x2,y2,cx:(x1+x2)/2-dy/d*bend,
    cy:(y1+y2)/2+dx/d*bend};
}
export function artCurvePoint(c:ArtCurve,t:number):{x:number;y:number}{
  const a=1-clamp(t,0,1),b=1-a;
  return {x:a*a*c.x1+2*a*b*c.cx+b*b*c.x2,
    y:a*a*c.y1+2*a*b*c.cy+b*b*c.y2};
}
export function artCurveHit(bundles:readonly ArtBundle[],
  points:Map<string,GraphPoint>,camera:ArtCamera,layout:ArtLayout,
  x:number,y:number,tolerance=8):ArtBundle|null{
  let closest=tolerance,chosen:ArtBundle|null=null;
  for(const bundle of bundles){
    const curve=artCurve(bundle.edge,points,camera,layout);
    if(!curve)continue;
    let previous=artCurvePoint(curve,0);
    for(let i=1;i<=12;i++){
      const next=artCurvePoint(curve,i/12);
      const dx=next.x-previous.x,dy=next.y-previous.y,den=dx*dx+dy*dy;
      if(den>.0001){
        const t=clamp(((x-previous.x)*dx+(y-previous.y)*dy)/den,0,1);
        const dist=Math.hypot(x-(previous.x+t*dx),y-(previous.y+t*dy));
        if(dist<closest){closest=dist;chosen=bundle;}
      }
      previous=next;
    }
  }
  return chosen;
}
export type ArtCloud={id:string;color:string;x:number;y:number;rx:number;ry:number;count:number;layer:number};
export function artClouds(layout:ArtLayout,points:Map<string,GraphPoint>,
  camera:ArtCamera,max=10):ArtCloud[]{
  const clouds:ArtCloud[]=[];
  for(const community of layout.communities){
    const visible=community.members.map(id=>points.get(id)).filter((p):p is GraphPoint=>!!p);
    if(visible.length<3)continue;
    const x=visible.reduce((n,p)=>n+p.x,0)/visible.length,
      y=visible.reduce((n,p)=>n+p.y,0)/visible.length;
    const spreadX=Math.sqrt(visible.reduce((n,p)=>n+(p.x-x)**2,0)/visible.length);
    const spreadY=Math.sqrt(visible.reduce((n,p)=>n+(p.y-y)**2,0)/visible.length);
    clouds.push({id:community.id,color:community.color,
      x:camera.cx+x*camera.scale,y:camera.cy+y*camera.scale,
      rx:clamp((spreadX*1.8+46)*camera.scale,25,250),
      ry:clamp((spreadY*1.8+46)*camera.scale,25,250),
      count:community.count,layer:community.layer});
  }
  return clouds.sort((a,b)=>b.count-a.count||a.id.localeCompare(b.id)).slice(0,max);
}
/** Deterministic gentle cluster field, grounded exclusively in communities.
 * Avoids the old all-node center collapse and leaves pinned nodes alone.
 */
export function artClusterStep(layout:ArtLayout,nodes:readonly GraphNode[],
  points:Map<string,GraphPoint>,strength=.12):void{
  const centers=new Map<string,{x:number;y:number;count:number}>();
  for(const node of nodes){
    const p=points.get(node.id);if(!p)continue;
    const key=layout.membership.get(node.id)||"root";
    const c=centers.get(key)||{x:0,y:0,count:0};
    c.x+=p.x;c.y+=p.y;c.count++;centers.set(key,c);
  }
  for(const c of centers.values()){c.x/=c.count;c.y/=c.count;}
  for(const node of nodes){
    const p=points.get(node.id);if(!p||p.pinned||node.id==="folder:")continue;
    const c=centers.get(layout.membership.get(node.id)||"root");
    if(!c||c.count<2)continue;
    const dx=c.x-p.x,dy=c.y-p.y,dist=Math.hypot(dx,dy);
    if(dist<35||dist>500)continue;
    const force=clamp(strength,0,.3)*Math.min(1.7,(dist-35)/150);
    p.vx+=dx/dist*force;p.vy+=dy/dist*force;
  }
}
/** Smooth decaying pan after release; not used when prefers-reduced-motion. */
export function artInertia(vx:number,vy:number):{vx:number;vy:number;done:boolean}{
  const x=clamp(vx*.82,-18,18),y=clamp(vy*.82,-18,18);
  return {vx:x,vy:y,done:Math.hypot(x,y)<.35};
}
