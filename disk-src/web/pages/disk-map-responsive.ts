/**
 * Disk 16: resolution-independent graph geometry and level-of-detail policy.
 * Pure calculations: no DOM, GPU, new dependencies or persistent user state.
 * Dimensions are CSS pixels, while DPR only controls backing-canvas clarity.
 */
export type GraphDetail="overview"|"standard"|"detail";
export type GraphScreen={
  width:number;height:number;aspect:number;dpr:number;pixelWidth:number;pixelHeight:number;
  maxNodes:number;detail:GraphDetail;perFolder:number;
  markerScale:number;lineScale:number;labelSize:number;touchRadius:number;
  padding:number;highDensity:boolean;ultrawide:boolean;
};
export type GraphXY={x:number;y:number};
export type GraphCamera={cx:number;cy:number;scale:number;worldX:number;worldY:number};
export type GraphBounds={minX:number;maxX:number;minY:number;maxY:number};
const clamp=(x:number,min:number,max:number)=>Math.max(min,Math.min(max,x));
const sensible=(value:number,fallback:number)=>Number.isFinite(value)&&value>0?value:fallback;
export function graphScreen(
  width:number,height:number,dpr=1,zoom=1,expanded=false
):GraphScreen{
  const w=sensible(width,320),h=sensible(height,280);
  const aspect=w/h;
  const area=w*h;
  const compact=w<540||h<360;
  const ultrawide=aspect>2.1;
  // Node budget tracks pixels rather than a fixed monitor model or CSS label.
  // True 4K and 21:9 screens reveal more data without exceeding 240 nodes.
  const base=16+Math.sqrt(area)*.12;
  const capacity=clamp(Math.round(base*(ultrawide?1.08:1)),24,240);
  const detail:GraphDetail=zoom<.82?"overview":zoom>=1.55?"detail":"standard";
  const multiplier=detail==="overview"?.74:detail==="detail"?1.24:1;
  const maxNodes=clamp(Math.round(capacity*multiplier),24,240);
  const perFolder=detail==="overview"?4:detail==="detail"?72:28;
  const shortSide=Math.min(w,h);
  const markerScale=clamp(Math.sqrt(shortSide/500),.84,1.47);
  const lineScale=clamp(Math.sqrt(shortSide/750),.75,1.65);
  const labelSize=clamp(shortSide/44,10,15);
  const backingDpr=clamp(Math.min(sensible(dpr,1),2.5,
    Math.sqrt(10_000_000/area)),.6,2.5);
  return {
    width:w,height:h,aspect,detail,maxNodes,perFolder,
    dpr:backingDpr,pixelWidth:Math.max(1,Math.round(w*backingDpr)),
    pixelHeight:Math.max(1,Math.round(h*backingDpr)),
    markerScale,lineScale,labelSize,touchRadius:compact?16:12,
    padding:compact?20:Math.max(26,Math.min(84,shortSide*.055)),
    highDensity:!compact&&area>=850_000,ultrawide
  };
}
/** Content bounds use both axes: a 32:9 layout must use its width, not a circle. */
export function graphBounds(points:Iterable<GraphXY>):GraphBounds{
  let minX=Infinity,maxX=-Infinity,minY=Infinity,maxY=-Infinity;
  for(const p of points){
    if(!Number.isFinite(p.x)||!Number.isFinite(p.y))continue;
    minX=Math.min(minX,p.x);maxX=Math.max(maxX,p.x);
    minY=Math.min(minY,p.y);maxY=Math.max(maxY,p.y);
  }
  if(!Number.isFinite(minX))return {minX:-120,maxX:120,minY:-100,maxY:100};
  if(maxX-minX<130){const center=(minX+maxX)/2;minX=center-65;maxX=center+65;}
  if(maxY-minY<130){const center=(minY+maxY)/2;minY=center-65;maxY=center+65;}
  return {minX,maxX,minY,maxY};
}
/** Maps stable world positions into CSS pixels; pans are in screen pixels. */
export function graphCamera(
  bounds:GraphBounds,screen:Pick<GraphScreen,"width"|"height"|"padding">,
  zoom=1,panX=0,panY=0
):GraphCamera{
  const worldX=(bounds.minX+bounds.maxX)/2,worldY=(bounds.minY+bounds.maxY)/2;
  const usableW=Math.max(1,screen.width-2*screen.padding);
  const usableH=Math.max(1,screen.height-2*screen.padding);
  const baseScale=Math.min(usableW/(bounds.maxX-bounds.minX+35),
    usableH/(bounds.maxY-bounds.minY+35));
  const scale=clamp(baseScale,.025,9)*clamp(zoom,.65,4);
  return {
    cx:screen.width/2+panX-worldX*scale,
    cy:screen.height/2+panY-worldY*scale,
    scale,worldX,worldY
  };
}
/** Maintain the same document beneath the cursor while zooming. */
export function anchoredZoom(
  current:GraphCamera,screen:Pick<GraphScreen,"width"|"height"|"padding">,
  bounds:GraphBounds,newZoom:number,mouseX:number,mouseY:number
):{panX:number;panY:number}{
  const worldX=(mouseX-current.cx)/current.scale;
  const worldY=(mouseY-current.cy)/current.scale;
  const next=graphCamera(bounds,screen,newZoom,0,0);
  return {
    panX:mouseX-(next.cx+worldX*next.scale),
    panY:mouseY-(next.cy+worldY*next.scale)
  };
}
/** Ease cluster movement toward target rather than snapping the whole scene. */
export function graphLerp(from:number,to:number,rate=.14):number{
  return from+(to-from)*clamp(rate,0,1);
}
/** Select a stable physical damping budget by graph size and user preferences. */
export function graphMotionBudget(count:number,reduceMotion:boolean,visible:boolean):number{
  if(reduceMotion||!visible)return 1;
  if(count>=180)return 42;
  if(count>=100)return 64;
  return 96;
}
