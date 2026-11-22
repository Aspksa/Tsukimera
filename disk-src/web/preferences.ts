/**
 * Disk preferences: SQLite is authoritative; localStorage is a synchronous
 * in-browser mirror for the existing UI. Only durable allowlisted keys reach
 * the server. One queue preserves the latest value during rapid drag/zoom.
 */
import {showToast} from "./toast";
let queue:Promise<void>=Promise.resolve();
export function writePreference(key:string,value:string):void{
  try{localStorage.setItem(key,value);}catch{}
  queue=queue.catch(()=>{}).then(async()=>{
    const response=await fetch("/api/preferences",{
      method:"PUT",headers:{"Content-Type":"application/json","X-Tsukimera-Request":"1"},
      body:JSON.stringify({changes:{[key]:value}})
    });
    if(!response.ok)throw new Error((await response.json().catch(()=>({}))).error||"HTTP "+response.status);
  }).catch(error=>{
    console.error("Tsukimera preferences:",error);
    showToast("Настройка не сохранена в SQLite: "+error.message);
  });
}
