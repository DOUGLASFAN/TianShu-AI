import {api,authHeaders} from './api';

export type BasemapPreferences={mode:'imagery'|'streets';labels:boolean};

export function createBasemap(viewer:any,C:any,space=false,onlyNear?:()=>boolean,preferences?:BasemapPreferences){
 let disposed=false,mode:string=preferences?.mode??'imagery',labels=preferences?.labels??true,provider='esri',generation=0,success=0,failed=0;
 let demoBlocked=(window as any).starDemoPhase==='active',directCount=0,relayCount=0;
 let online:any[]=[],local:any,config:any,localPending:Promise<void>|undefined;let levels:Record<string,number>={},unresolved=new Set<string>();const listeners=new Set<()=>void>();
 let state={mode,labels,status:'本地地球',level:0,source:'Esri',credit:'',sourceUrl:''};
 const id=crypto.randomUUID(),diagnostics=((window as any).basemapDiagnostics??={});
 function ensureLocal(){
  return localPending??=C.SingleTileImageryProvider.fromUrl('/earth/day-8k.jpg',{credit:'Solar System Scope / INOVE · CC BY 4.0'})
   .then((provider:any)=>{if(!disposed)local=viewer.imageryLayers.addImageryProvider(provider,0);});
 }
 const publish=(patch:any)=>{const changed=Object.keys(patch).some(key=>(state as any)[key]!==patch[key]);state={...state,...patch};diagnostics[id]={...state,height:viewer.camera.positionCartographic.height,success,failed,levels};if(changed)for(const fn of listeners)fn();};
 const update=()=>{if(disposed||viewer.isDestroyed())return;const h=viewer.camera.positionCartographic.height,active=!(space||onlyNear?.())||h<3000000;
  if(space){const t=Math.max(0,Math.min(1,(h-700000)/2300000));viewer.scene.globe.material.uniforms.spaceOpacity=t*t*(3-2*t);}
  if(space&&active&&!localPending)void ensureLocal().catch(()=>{});
  for(const layer of online)layer.show=active&&(layer._starLabels?labels&&mode==='imagery'&&h<2000000:true);
  diagnostics[id]={...state,height:h,success,failed,levels,directCount,relayCount,spaceOpacity:space?viewer.scene.globe.material.uniforms.spaceOpacity:null};
 };
 async function rebuild(){
  const version=++generation;success=0;failed=0;levels={};unresolved=new Set();for(const layer of online)viewer.imageryLayers.remove(layer,true);online=[];
  if(!config||provider==='local'){publish({status:'本地地球 · 无街道细节'});return;}
  publish({status:'等待分级影像'});
  for(const name of [mode,...(mode==='imagery'?['labels']:provider==='tianditu'?['street-labels']:[])]){
   const relayResource=new C.Resource({url:`/api/maps/tiles/${provider}/${name}/{z}/{x}/{y}`,headers:authHeaders()}),direct=provider==='esri'?config.directTemplates?.[name]:undefined;
   const resource=direct?new C.Resource({url:direct}):relayResource;
   const p=new C.UrlTemplateImageryProvider({url:resource,tilingScheme:new C.WebMercatorTilingScheme(),maximumLevel:name==='labels'||provider==='tianditu'?18:19,credit:config.providers.find((x:any)=>x.id===provider)?.credit});
   const original=p.requestImage.bind(p),fallback=direct?new C.UrlTemplateImageryProvider({url:relayResource,tilingScheme:new C.WebMercatorTilingScheme(),maximumLevel:p.maximumLevel}):null;
   p.requestImage=(x:number,y:number,z:number,request:any)=>{if(demoBlocked)return Promise.reject(Error('故障演示中'));
    const result=original(x,y,z,request);if(!result)return result;if(direct)directCount++;else relayCount++;
    return Promise.resolve(result).catch(error=>{if(!fallback||disposed||version!==generation||demoBlocked||request?.cancelled)throw error;relayCount++;const retry=fallback.requestImage(x,y,z);if(!retry)throw error;return retry;}).then(image=>{if(!disposed&&version===generation){success++;unresolved.delete(`${name}/${z}/${x}/${y}`);levels[name]=Math.max(z,levels[name]??0);publish({status:unresolved.size?'部分图块未加载 · 保留已有画面':'在线地图',level:Math.max(z,state.level)});}return image;});};
   p.errorEvent.addEventListener((error:any)=>{error.retry=false;if(disposed||version!==generation)return;const key=`${name}/${error.level}/${error.x}/${error.y}`;unresolved.add(key);failed++;publish({status:demoBlocked?'故障演示中 · 保留已有画面':success?'部分图块未加载 · 保留已有画面':'在线地图不可用 · 本地地球'});});
   const layer=viewer.imageryLayers.addImageryProvider(p);layer._starLabels=name==='labels';online.push(layer);
  }
  update();viewer.scene.requestRender();
 }
 const remove=viewer.scene.preRender.addEventListener(update);
 const globe=viewer.scene.globe;globe.tileCacheSize=256;globe.loadingDescendantLimit=4;globe.preloadSiblings=false;
 const start=viewer.camera.moveStart.addEventListener(()=>{globe.maximumScreenSpaceError=8;}),end=viewer.camera.moveEnd.addEventListener(()=>{globe.maximumScreenSpaceError=2;viewer.scene.requestRender();});
 const demoChanged=(event:Event)=>{const blocked=(event as CustomEvent).detail==='active';if(blocked!==demoBlocked){demoBlocked=blocked;if(!blocked)void rebuild();}};window.addEventListener('system:demo-phase',demoChanged);
 const refreshConfig=async()=>{const response=await api('/maps/config');if(disposed)return;config=response.data;demoBlocked=!!config.demoActive||(window as any).starDemoPhase==='active';provider=config.preferred;const source=config.providers.find((x:any)=>x.id===provider);if(source)publish({source:provider==='esri'?'Esri':source.name,credit:source.credit,sourceUrl:source.sourceUrl});};
 const ready=(async()=>{
  if(!space)await ensureLocal();
  if(disposed)return;
  try{await refreshConfig();}catch{publish({status:'本地地球 · 地图服务未连接'});return;}
  if(!disposed)await rebuild();
 })();
 ready.catch(()=>!disposed&&publish({status:'本地地球加载失败'}));
 return {ready,get:()=>state,subscribe(fn:()=>void){listeners.add(fn);return()=>{listeners.delete(fn);};},
  mode(value:string){if(disposed)return;mode=value;publish({mode,level:0});void rebuild();},
  labels(value:boolean){labels=value;publish({labels});update();viewer.scene.requestRender();},
  async retry(){if(!config){try{await refreshConfig();}catch{publish({status:'本地地球 · 地图服务未连接'});return;}}if(!disposed)await rebuild();},
  dispose(){disposed=true;generation++;remove();start();end();window.removeEventListener('system:demo-phase',demoChanged);listeners.clear();delete diagnostics[id];if(!viewer.isDestroyed()){for(const l of online)viewer.imageryLayers.remove(l,true);if(local)viewer.imageryLayers.remove(local,true);}online=[];}
 };
}
export type Basemap=ReturnType<typeof createBasemap>;
