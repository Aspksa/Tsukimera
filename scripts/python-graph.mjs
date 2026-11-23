/** Small, argument-only compatibility bridge for the Python Graph Engine.
 * The old Node API stays active until the full migration can be validated;
 * this bridge never shells out, installs Python, starts an extra server,
 * accepts executable paths from requests or modifies source documents.
 */
import {spawn} from "node:child_process";
import {join} from "node:path";
const maxBytes=4*1024*1024,timeoutMs=7000;
let workingCommand=null;
const commands=()=>{
  const opts=[];
  const configured=process.env.TSUKIMERA_PYTHON||process.env.PYTHON;
  if(configured)opts.push({exe:configured,prefix:[]});
  if(process.platform==="win32")opts.push({exe:"py",prefix:["-3"]});
  opts.push({exe:"python3",prefix:[]},{exe:"python",prefix:[]});
  return workingCommand?[workingCommand,...opts.filter(x=>x.exe!==workingCommand.exe)]:opts;
};
const allowed=new Set(["view","sync","path","impact","timeline","diagnose"]);
export async function runPythonGraph({root,dbPath,action="view",params={}}){
  if(!allowed.has(action))return {ok:false,error:"Unsupported graph operation"};
  const script=join(root,"python","tsukimera_graph.py");
  const args=["--db",dbPath,"--action",action];
  const limits={limit:[1,320],batch:[1,100],offset:[0,2000000]};
  for(const [key,[min,max]] of Object.entries(limits)){
    if(params[key]===undefined)continue;
    const n=Number(params[key]);if(!Number.isFinite(n))continue;
    args.push("--"+key,String(Math.max(min,Math.min(max,Math.round(n)))));
  }
  for(const key of ["focus","folder","source","target"]){
    if(typeof params[key]==="string"&&params[key].length<=180)
      args.push("--"+key,params[key]);
  }
  if(["far","medium","near"].includes(params.level))
    args.push("--level",params.level);
  let last="Python 3 is unavailable";
  for(const candidate of commands()){
    try{
      const result=await new Promise((resolve,reject)=>{
        const child=spawn(candidate.exe,[...candidate.prefix,script,...args],{
          cwd:root,shell:false,windowsHide:true,stdio:["ignore","pipe","pipe"]});
        let output="",stderr="",bytes=0,finished=false;
        const timer=setTimeout(()=>{
          child.kill();reject(new Error("Graph timeout"));},timeoutMs);
        child.stdout.setEncoding("utf8");child.stderr.setEncoding("utf8");
        child.stdout.on("data",chunk=>{
          bytes+=Buffer.byteLength(chunk);
          if(bytes>maxBytes){child.kill();return;}
          output+=chunk;
        });
        child.stderr.on("data",chunk=>{stderr=(stderr+chunk).slice(-1000);});
        child.once("error",error=>{clearTimeout(timer);reject(error);});
        child.once("close",code=>{
          if(finished)return;finished=true;clearTimeout(timer);
          if(bytes>maxBytes)return reject(new Error("Graph response exceeds limit"));
          let data;try{data=JSON.parse(output);}catch{
            return reject(new Error("Graph Python error: "+stderr.slice(0,160)));
          }
          if(code!==0||!data.ok)return resolve({ok:false,error:data.error||"Graph operation failed"});
          resolve({ok:true,data:data.data});
        });
      });
      workingCommand=candidate;
      return result;
    }catch(error){
      last=error instanceof Error?error.message:String(error);
      if(!/ENOENT|not found|spawn .*ENOENT/i.test(last))break;
    }
  }
  return {ok:false,error:last.slice(0,200)};
}
