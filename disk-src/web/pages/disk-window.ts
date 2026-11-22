/**
 * Viewport windowing for one-column Disk list and table modes.
 * We keep the full ordered data model but instantiate only visible DOM rows.
 * Grouped/tile modes retain progressive page loading to avoid incorrect row
 * height assumptions and preserve the existing responsive CSS.
 */
export type FileWindow={start:number;end:number;before:number;after:number;rowHeight:number};
const clamp=(n:number,lo:number,hi:number)=>Math.max(lo,Math.min(hi,n));
export function fileWindow(total:number,offset:number,viewport:number,rowHeight:number,overscan=24):FileWindow{
  const length=Math.max(0,Math.floor(total));
  const row=Math.max(28,Math.floor(rowHeight));
  const start=clamp(Math.floor(Math.max(0,offset)/row)-overscan,0,length);
  const take=Math.ceil(Math.max(1,viewport)/row)+overscan*2;
  const end=clamp(start+take,start,length);
  return {start,end,before:start*row,after:(length-end)*row,rowHeight:row};
}
