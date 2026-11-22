/**
 * Cloud.ru Foundation Models (https://foundation-models.api.cloud.ru/v1).
 * The only network operation here is GET /models (no paid inference).
 * Keys live in process memory or in the CLOUD_RU_FOUNDATION_MODELS_API_KEY
 * environment variable, never in SQLite, browser storage or logs.
 */
const MODELS_URL = "https://foundation-models.api.cloud.ru/v1/models";
const MAX_KEY = 4096;
const statuses = {
  400:"Некорректный запрос к Cloud.ru.",
  401:"Ключ Cloud.ru недействителен или истёк.",
  402:"Недостаточно средств или доступ к услуге не оплачен.",
  403:"Нет прав для Foundation Models или выбранного проекта.",
  404:"Эндпоинт Cloud.ru не найден.",
  408:"Время ожидания Cloud.ru истекло.",
  429:"Лимит Cloud.ru исчерпан. Подождите перед повторной проверкой.",
  500:"Cloud.ru сообщил о внутренней ошибке.",
  502:"Cloud.ru временно недоступен (502).",
  503:"Cloud.ru временно недоступен (503).",
  504:"Cloud.ru не ответил вовремя (504).",
  524:"Cloud.ru не ответил вовремя (524).",
};
const err=(message,status=502,code="upstream_error")=>Object.assign(new Error(message),{status,code});
export function cloudFailure(status){
  return {code:"cloud_"+status,reason:statuses[status]||("Cloud.ru вернул HTTP "+status+"."),
    retryable:[408,429,500,502,503,504,524].includes(status)};
}
export function parseCloudModels(json){
  if(!json||!Array.isArray(json.data))throw err("Cloud.ru вернул неожиданный формат списка моделей.");
  const names=new Set();
  for(const item of json.data){
    const name=item?.id;
    if(typeof name==="string"&&name.length>0&&name.length<=150&&
      !name.includes("..")&&!name.startsWith("/")&&!name.includes("//")&&
      /^[a-zA-Z0-9_.:@+-]+(?:\/[a-zA-Z0-9_.:@+-]+)*$/.test(name))names.add(name);
  }
  return [...names].sort((a,b)=>a.localeCompare(b));
}
export function createCloudConnection({
  request=globalThis.fetch,
  envKey=process.env.CLOUD_RU_FOUNDATION_MODELS_API_KEY||"",
  timeoutMs=9000,
}={}){
  let sessionKey="",lastCheck=null,lastModels=[],lastError=null,checkedAt=null;
  const credentials=()=>sessionKey||envKey;
  const status=()=>({
    configured:!!credentials(),source:sessionKey?"session":envKey?"environment":"none",
    verified:lastCheck===true,lastError,lastCheckedAt:checkedAt,
    modelsCount:lastModels.length,endpoint:"https://foundation-models.api.cloud.ru/v1",
    modelApiReady:!!credentials(),inferenceEnabled:false,
  });
  const changeKey=(key)=>{
    if(typeof key!=="string"||key.length>MAX_KEY||
      (key.length>0&&(!key.trim()||/[\r\n\0]/.test(key))))
      throw err("Недопустимый API-ключ.",400,"invalid_key");
    sessionKey=key.trim();
    lastCheck=null;lastModels=[];lastError=null;checkedAt=null;
    return status();
  };
  const clear=()=>{
    sessionKey="";envKey="";lastCheck=null;lastModels=[];lastError=null;checkedAt=null;
    return status();
  };
  const list=async()=>{
    const key=credentials();
    if(!key)throw err("Введите ключ Cloud.ru или задайте переменную окружения.",409,"key_missing");
    let result;
    try{
      result=await request(MODELS_URL,{
        method:"GET",
        headers:{Authorization:"Bearer "+key,Accept:"application/json"},
        signal:AbortSignal.timeout(timeoutMs),
        redirect:"error",
      });
    }catch(e){
      const timeout=e?.name==="TimeoutError"||e?.name==="AbortError";
      const message=timeout?"Истекло время ожидания Cloud.ru.":"Нет соединения с Cloud.ru. Проверьте интернет и DNS.";
      const failure=err(message,timeout?504:502,timeout?"timeout":"network");
      lastCheck=false;lastError={code:failure.code,message:failure.message,retryable:true};checkedAt=new Date().toISOString();
      throw failure;
    }
    if(!result.ok){
      const detail=cloudFailure(result.status);
      lastCheck=false;lastModels=[];lastError={code:detail.code,message:detail.reason,retryable:detail.retryable};
      checkedAt=new Date().toISOString();
      throw err(detail.reason,result.status,detail.code);
    }
    let body;
    try{
      const raw=await result.text();
      if(raw.length>2*1024*1024)throw Error("Response too large");
      body=JSON.parse(raw);
      const models=parseCloudModels(body);
      lastCheck=true;lastModels=models;lastError=null;checkedAt=new Date().toISOString();
      return {models,checkedAt,source:"cloud.ru"};
    }catch{
      lastCheck=false;lastModels=[];
      const failure=err("Не удалось прочитать список моделей Cloud.ru.",502,"invalid_response");
      lastError={code:failure.code,message:failure.message,retryable:true};
      checkedAt=new Date().toISOString();throw failure;
    }
  };
  return {status,changeKey,clear,list,models:()=>[...lastModels]};
}
