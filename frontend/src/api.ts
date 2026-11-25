export type User={id:string;username:string;role:'user'|'admin';enabled:boolean;isGuest:boolean};
export type AuthResult={accessToken:string;expiresAt:string;user:User};
let accessToken:string|null=null;
export function setToken(value:string|null){accessToken=value;}
export function authHeaders():Record<string,string>{return accessToken?{Authorization:`Bearer ${accessToken}`}:{}};
export async function saveDownload(path:string,filename:string){
  const response=await fetch(`/api${path}`,{credentials:'same-origin',headers:accessToken?{Authorization:`Bearer ${accessToken}`}:{}});
  if(!response.ok)throw Error('原始数据暂不可用，请稍后重试。');
  const url=URL.createObjectURL(await response.blob()),link=document.createElement('a');link.href=url;link.download=filename;link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
}
export class ApiError extends Error{
  constructor(public code:string,message:string,public requestId:string,public fields:{field:string;message:string}[]=[]){super(message);}
}
export async function api<T=any>(path:string,options:RequestInit={}):Promise<T>{
  const headers=new Headers(options.headers);
  if(options.body)headers.set('Content-Type','application/json');
  if(accessToken)headers.set('Authorization',`Bearer ${accessToken}`);
  let response:Response;
  try{response=await fetch(`/api${path}`,{...options,headers,credentials:'same-origin'});}
  catch{throw new ApiError('NETWORK_UNAVAILABLE','暂时无法连接服务，请检查网络后重试。','');}
  const data=await response.json();
  if(!response.ok){
    if(response.status===401&&!['/auth/login','/auth/register','/auth/session'].includes(path))window.dispatchEvent(new Event('auth:expired'));
    throw new ApiError(data.error?.code||'REQUEST_FAILED',data.error?.message||'请求失败',data.requestId||response.headers.get('X-Request-ID')||'',data.error?.fields||[]);
  }
  return data;
}
