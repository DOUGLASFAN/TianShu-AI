import {createBasemap,type BasemapPreferences} from './basemaps';
import {createSpaceScene} from './spaceScene';
// Cesium owns continuous motion; React receives telemetry at most once per second.
let C = (window as any).Cesium;
let runtime:Promise<void>|undefined;
export function loadRuntime(){
 if(C)return Promise.resolve();
 return runtime??=new Promise<void>((resolve,reject)=>{
  const script=document.createElement('script');script.src='/cesium/Cesium.js';
  script.onload=()=>{C=(window as any).Cesium;resolve();};
  script.onerror=()=>{runtime=undefined;script.remove();reject(Error('三维引擎加载失败，请重试。'));};
  document.head.append(script);
 });
}
export type Track = {noradId:number;name:string;start:string;end:string;stepSeconds:number;version:string;samples:number[][];dataQuality:any};
export type SceneData = {start:string;end:string;satellites:Track[];failed:any[];generatedAt:string;profileName?:string;stepSeconds?:number};
export type Telemetry = {time:string;lat:number|null;lng:number|null;alt:number|null;speed:number|null;valid:boolean;tracking:boolean;playing:boolean;atEnd:boolean;globalStatus?:string;globalStart?:string;globalEnd?:string};
const diagnostic = ((window as any).starSceneDiagnostics ??= {created:0,destroyed:0,active:0,frames:0,selected:null,tracking:false,errors:[],sampleCount:0});
const textureNames=['day','night','clouds'];
const textureUniforms=['dayMap','nightMap','cloudMap'];
let previewTextures:Promise<HTMLImageElement[]>|undefined;
const fullTextures=new Map<string,Promise<HTMLImageElement>>();
function loadTexture(file:string,priority:'high'|'low'){
 const image=new Image();
 image.fetchPriority=priority;
 image.src='/earth/'+file;
 return image.decode().then(()=>image);
}
function loadFullTexture(name:string){
 const existing=fullTextures.get(name);
 if(existing)return existing;
 const pending=loadTexture(name+'-8k.jpg','low').catch(error=>{fullTextures.delete(name);throw error;});
 fullTextures.set(name,pending);
 return pending;
}
function loadTextures(){
 return previewTextures??=Promise.all(textureNames.map(name=>loadTexture(name+'-preview.webp','high')
  .catch(()=>loadFullTexture(name)))).catch(()=>{previewTextures=undefined;throw Error('地球贴图加载失败，请重试。');});
}
export async function createOrbitScene(container:HTMLElement, callbacks:{telemetry:(data:Telemetry)=>void;select:(id:number)=>void;drag:()=>void;error:(message:string)=>void}, reduced:boolean,{dashboard=false,fitMobileGlobe,basemapPreferences}:{dashboard?:boolean;fitMobileGlobe?:()=>boolean;basemapPreferences?:BasemapPreferences}={}){
 const [,images]=await Promise.all([loadRuntime(),loadTextures()]);
 const viewer=new C.Viewer(container,{baseLayer:false,terrainProvider:new C.EllipsoidTerrainProvider(),animation:false,timeline:false,
  baseLayerPicker:false,geocoder:false,homeButton:false,sceneModePicker:false,navigationHelpButton:false,fullscreenButton:false,
  selectionIndicator:false,infoBox:false,shouldAnimate:true,skyBox:false,sun:false,moon:false,
  contextOptions:{webgl:{alpha:true,preserveDrawingBuffer:true}},creditContainer:container.querySelector('.globe-credits')||undefined});
 diagnostic.created++;diagnostic.active++;
 const textureDimensions=images.map(image=>[image.naturalWidth,image.naturalHeight]);
 diagnostic.textureDimensions=textureDimensions;
 diagnostic.textureStage='preview';
 try {
 viewer.scene.backgroundColor=C.Color.TRANSPARENT;
 viewer.scene.globe.enableLighting=false;
 viewer.scene.globe.showGroundAtmosphere=true;
 viewer.scene.globe.baseColor=C.Color.fromCssColorString('#071826');
 viewer.scene.highDynamicRange=true;
 viewer.scene.fxaa=true;viewer.resolutionScale=Math.min(window.devicePixelRatio,1.5);
 viewer.scene.screenSpaceCameraController.minimumZoomDistance=150;
 viewer.scene.screenSpaceCameraController.maximumZoomDistance=120000000;
 viewer.scene.skyAtmosphere.hueShift=-0.04;viewer.scene.skyAtmosphere.saturationShift=-0.2;viewer.scene.skyAtmosphere.brightnessShift=-0.12;
 viewer.scene.skyAtmosphere.dynamicAtmosphereLighting=true;viewer.scene.skyAtmosphere.dynamicAtmosphereLightingFromSun=true;
 // Fabric caches templates by type. Keep URL strings in cached uniforms: DOM image
 // instances cannot be cloned by Material when a second Viewer is created.
 const globeMaterial=new C.Material({fabric:{type:'StarNexusEarthV3',uniforms:{dayMap:C.Material.DefaultImageId,nightMap:C.Material.DefaultImageId,cloudMap:C.Material.DefaultImageId,cloudAmount:0.32,spaceOpacity:1.0},source:`
 czm_material czm_getMaterial(czm_materialInput materialInput) {
  czm_material m=czm_getDefaultMaterial(materialInput);
  vec3 worldPosition=(czm_inverseView*vec4(-materialInput.positionToEyeEC,1.0)).xyz;
  vec3 n=normalize(worldPosition*vec3(1.0,1.0,1.0067394967));
  vec2 uv=vec2(atan(n.y,n.x)/6.28318530718+0.5,asin(clamp(n.z,-1.0,1.0))/3.14159265359+0.5);
  vec3 day=pow(texture(dayMap,uv).rgb,vec3(1.55));
  vec3 night=texture(nightMap,uv).rgb;
  float clouds=texture(cloudMap,uv).r*cloudAmount;
  float light=dot(normalize(czm_viewRotation*n),normalize(czm_sunDirectionEC));
  float daylight=smoothstep(-0.13,0.18,light);
  vec3 surface=mix(day,vec3(0.92,0.96,1.0),clouds);
  m.diffuse=mix(night*0.85+day*0.035,surface*(0.35+0.65*max(light,0.0)),daylight);
  m.alpha=spaceOpacity;
  return m;
 }`}});
 textureUniforms.forEach((name,index)=>{globeMaterial.uniforms[name]=images[index];});
 viewer.scene.globe.material=globeMaterial;
 const basemap=createBasemap(viewer,C,true,undefined,basemapPreferences);
 const space=createSpaceScene(viewer,C,reduced);
 if(dashboard)space.enabled(false);
 let cinemaPaused=false,previousRenderLoop=true;
 let selected:number|null=null,selectedTrack:Track|null=null,tracking=false,destroyed=false,loadedScene:SceneData|undefined;
 let textureTimer:ReturnType<typeof setTimeout>|undefined;
 const afterFirstFrame=viewer.scene.postRender.addEventListener(()=>{
  afterFirstFrame();
  textureTimer=setTimeout(async()=>{
   for(const [index,name] of textureNames.entries()){
    if(destroyed)return;
    try{
     const image=await loadFullTexture(name);
     if(destroyed)return;
     globeMaterial.uniforms[textureUniforms[index]]=image;
     textureDimensions[index]=[image.naturalWidth,image.naturalHeight];
     // Material stages an image on the first update and uploads it on the next.
     const requestUpload=viewer.scene.postRender.addEventListener(()=>{requestUpload();viewer.scene.requestRender();});
     viewer.scene.requestRender();
    }catch{/* Keep the preview texture usable on this layer. */}
   }
   if(!destroyed&&textureDimensions.every(([width])=>width>=8192))diagnostic.textureStage='full';
  },1800);
 });
 let followsSystemTime=false;
 let globalPoints:any=null,globalData:any=null,globalWindows:any[]=[],lastGlobalUpdate=0;
 const globalPosition=new C.Cartesian3();
 function updateGlobal(ms:number){
  if(!globalPoints||!globalWindows.length)return;
  const active=globalWindows.find(data=>ms>=Date.parse(data.start)&&ms<=Date.parse(data.end));
  globalPoints.show=!!active&&space.mode()!=='solar';diagnostic.globalVisible=globalPoints.show;diagnostic.globalStatus=active?'ready':'outside';
  diagnostic.globalWindowCount=globalWindows.length;
  if(!active)return;
  if(active!==globalData){
   const sameIds=globalPoints.length===active.points.length&&active.points.every((row:any,i:number)=>globalPoints.get(i).id?.id==='sat-'+row[0]);
   if(!sameIds){globalPoints.removeAll();for(const row of active.points)globalPoints.add({id:{id:'sat-'+row[0]},position:new C.Cartesian3(row[1],row[2],row[3]),pixelSize:2,color:C.Color.fromCssColorString('#78b8e8').withAlpha(.65)});diagnostic.globalCollectionBuilds=(diagnostic.globalCollectionBuilds||0)+1;}
   globalData=active;
  }
  diagnostic.globalPointCount=active.points.length;diagnostic.globalActiveStart=active.start;diagnostic.globalActiveEnd=active.end;
  const start=Date.parse(active.start),fraction=(ms-start)/(Date.parse(active.end)-start);
  for(let i=0;i<active.points.length;i++){const row=active.points[i];globalPosition.x=row[1]+(row[4]-row[1])*fraction;globalPosition.y=row[2]+(row[5]-row[2])*fraction;globalPosition.z=row[3]+(row[6]-row[3])*fraction;globalPoints.get(i).position=globalPosition;}
 }
 const entities=new Map<number,any>(),tracks=new Map<number,Track>();
 const selectedScreenPoint=()=>{
  if(destroyed)return null;
  const position=entities.get(selected!)?.position.getValue(viewer.clock.currentTime);
  return position?C.SceneTransforms.worldToWindowCoordinates(viewer.scene,position):null;
 };
 if(import.meta.env.DEV)diagnostic.selectedScreenPoint=selectedScreenPoint;
 let orbit:any,ground:any,remover:any,lastTelemetry=0;
 const renderSoon=()=>{lastTelemetry=0;viewer.scene.requestRender();};
 function setPlayback(value:boolean){viewer.clock.shouldAnimate=value;viewer.scene.requestRenderMode=!value;renderSoon();}
 const home=()=>{space.leave();viewer.trackedEntity=undefined;tracking=false;diagnostic.tracking=false;viewer.camera.cancelFlight();viewer.camera.lookAtTransform(C.Matrix4.IDENTITY);
  viewer.resize();
  const frustum=viewer.camera.frustum,verticalHalf=frustum.fovy/2;
  let height=12000000;
  if(dashboard)height=6378137/Math.sin(verticalHalf)*1.10-6378137;
  else if(fitMobileGlobe?.()){
   const horizontalHalf=Math.atan(Math.tan(verticalHalf)*frustum.aspectRatio);
   height=6378137/Math.sin(Math.min(verticalHalf,horizontalHalf))*1.22-6378137;
  }
  viewer.camera.setView({destination:C.Cartesian3.fromDegrees(110,22,height),orientation:{heading:0,pitch:-C.Math.PI_OVER_TWO,roll:0}});};
 home();
 const property=(track:Track)=>{
  const p=new C.SampledPositionProperty(C.ReferenceFrame.FIXED),start=C.JulianDate.fromIso8601(track.start);
  p.forwardExtrapolationType=C.ExtrapolationType.NONE;p.backwardExtrapolationType=C.ExtrapolationType.NONE;
  p.setInterpolationOptions({interpolationDegree:1,interpolationAlgorithm:C.LinearApproximation});
  for(const point of track.samples)p.addSample(C.JulianDate.addSeconds(start,point[0],new C.JulianDate()),new C.Cartesian3(point[1],point[2],point[3]));
  return p;
 };
 const detach=()=>{space.leave();viewer.camera.cancelFlight();viewer.trackedEntity=undefined;viewer.camera.lookAtTransform(C.Matrix4.IDENTITY);tracking=false;diagnostic.tracking=false;};
 const removeOrbit=()=>{if(orbit)viewer.entities.remove(orbit);if(ground)viewer.entities.remove(ground);orbit=ground=undefined;};
 const decorate=()=>{for(const [id,e]of entities){const active=id===selected;e.point.pixelSize=active?9:4;e.point.color=C.Color.fromCssColorString(active?'#ffc56b':'#78b8e8');e.label.show=active;}};
 const add=(track:Track)=>{
  tracks.set(track.noradId,track);
  if(entities.has(track.noradId)){entities.get(track.noradId).position=property(track);return;}
  const entity=viewer.entities.add({id:'sat-'+track.noradId,name:track.name,position:property(track),
   point:{pixelSize:4,color:C.Color.fromCssColorString('#78b8e8'),outlineColor:C.Color.fromCssColorString('#050b14'),outlineWidth:1.5},
   label:{text:track.name,show:false,font:'14px sans-serif',fillColor:C.Color.fromCssColorString('#ffe2ac'),
    showBackground:true,backgroundColor:C.Color.fromCssColorString('#0e1927').withAlpha(.9),backgroundPadding:new C.Cartesian2(9,6),
    pixelOffset:new C.Cartesian2(15,-18),horizontalOrigin:C.HorizontalOrigin.LEFT,distanceDisplayCondition:new C.DistanceDisplayCondition(0,120000000)}});
  entities.set(track.noradId,entity);
 };
 const handler=new C.ScreenSpaceEventHandler(viewer.scene.canvas);
 handler.setInputAction((event:any)=>{const picks=viewer.scene.drillPick(event.position,8);for(const p of picks){const id=typeof p?.id==='string'?p.id:p?.id?.id;if(typeof id==='string'&&/^sat-\d+$/.test(id)){callbacks.select(Number(id.slice(4)));return;}}},C.ScreenSpaceEventType.LEFT_CLICK);
 let down:{x:number;y:number}|null=null;
 const pointerDown=(event:PointerEvent)=>{down={x:event.clientX,y:event.clientY};};
 const pointerMove=(event:PointerEvent)=>{if(down&&Math.hypot(event.clientX-down.x,event.clientY-down.y)>5){down=null;if(tracking){detach();callbacks.drag();}}};
 const pointerUp=()=>{down=null;};
 viewer.scene.canvas.addEventListener('pointerdown',pointerDown);viewer.scene.canvas.addEventListener('pointermove',pointerMove);window.addEventListener('pointerup',pointerUp);
 const renderError=(_scene:any,error:any)=>{diagnostic.errors.push(String(error));callbacks.error('三维场景渲染失败，请重新加载地球。');};
 viewer.scene.renderError.addEventListener(renderError);
 remover=viewer.scene.postRender.addEventListener(()=>{
  diagnostic.frames++;diagnostic.entityCount=viewer.entities.values.length;const stamp=performance.now();
  if(globalPoints&&globalWindows.length&&stamp-lastGlobalUpdate>200){
   lastGlobalUpdate=stamp;
   updateGlobal(C.JulianDate.toDate(viewer.clock.currentTime).getTime());
  }
  if(stamp-lastTelemetry<800)return;lastTelemetry=stamp;
  const date=C.JulianDate.toDate(viewer.clock.currentTime),p=entities.get(selected!)?.position?.getValue(viewer.clock.currentTime);
  const track=selectedTrack??tracks.get(selected!);let geo:any,speed=null;
  if(p){geo=C.Cartographic.fromCartesian(p);if(track){const i=Math.min(track.samples.length-1,Math.max(0,Math.floor((date.getTime()-Date.parse(track.start))/1000/track.stepSeconds)));speed=track.samples[i][4];}}
  const end=!followsSystemTime&&C.JulianDate.secondsDifference(viewer.clock.stopTime,viewer.clock.currentTime)<.1;
  if(end&&viewer.clock.shouldAnimate){viewer.clock.shouldAnimate=false;viewer.scene.requestRenderMode=true;}
  if(!p&&tracking){detach();callbacks.drag();}
  callbacks.telemetry({time:date.toISOString(),lat:geo?C.Math.toDegrees(geo.latitude):null,lng:geo?C.Math.toDegrees(geo.longitude):null,
   alt:geo?geo.height/1000:null,speed,valid:!!p,tracking,playing:viewer.clock.shouldAnimate,atEnd:end,globalStatus:diagnostic.globalStatus,globalStart:diagnostic.globalActiveStart,globalEnd:diagnostic.globalActiveEnd});
 });
 return {
  basemap,
  space,
  suspend(value:boolean){if(destroyed||viewer.isDestroyed()||cinemaPaused===value)return;cinemaPaused=value;if(value){previousRenderLoop=viewer.useDefaultRenderLoop;viewer.useDefaultRenderLoop=false;}else{viewer.useDefaultRenderLoop=previousRenderLoop;viewer.resize();viewer.scene.requestRender();}},
  spaceView(value:'moon'|'solar'|'lunar'){detach();space.view(value);},
  stars(value:boolean){space.enabled(value);},
  overview(data:SceneData, options?:{live:boolean;time?:string;rate?:number;playing?:boolean}){
   if(loadedScene!==data){
    if(loadedScene&&followsSystemTime&&options?.live){
     const nextIds=new Set(data.satellites.map(track=>track.noradId));
     for(const id of tracks.keys()){
      if(nextIds.has(id))continue;
      tracks.delete(id);
      if(id!==selected){viewer.entities.remove(entities.get(id));entities.delete(id);}
     }
     for(const track of data.satellites){
      if(track.noradId===selected&&selectedTrack)tracks.set(track.noradId,track);
      else add(track);
     }
    }else{
     detach();removeOrbit();viewer.entities.removeAll();entities.clear();tracks.clear();selectedTrack=null;
     for(const track of data.satellites)add(track);
    }
    loadedScene=data;
    diagnostic.sampleCount=data.satellites.reduce((n,s)=>n+s.samples.length,0);
    decorate();
   }
   followsSystemTime=options?.live===true;
   viewer.clock.clockStep=C.ClockStep.SYSTEM_CLOCK_MULTIPLIER;
   viewer.clock.startTime=C.JulianDate.fromIso8601(data.start);viewer.clock.stopTime=C.JulianDate.fromIso8601(data.end);
   const initial=options?.time?Date.parse(options.time):data.profileName?Date.parse(data.start):Date.now();
   viewer.clock.currentTime=C.JulianDate.fromDate(new Date(Math.max(Date.parse(data.start),Math.min(initial,Date.parse(data.end)))));
   viewer.clock.clockRange=C.ClockRange.CLAMPED;viewer.clock.multiplier=options?.rate??1;setPlayback(options?.playing??true);
   if(followsSystemTime)viewer.clock.clockStep=C.ClockStep.SYSTEM_CLOCK;
   lastTelemetry=0;
   viewer.scene.requestRender();
  },
  select(id:number|null){detach();removeOrbit();if(selected!==null&&!tracks.has(selected)){const previous=entities.get(selected);if(previous)viewer.entities.remove(previous);entities.delete(selected);}selected=id;selectedTrack=null;diagnostic.selected=id;decorate();renderSoon();},
  track(data:Track|null){
   removeOrbit();selectedTrack=data;renderSoon();
   if(!data||data.noradId!==selected)return;
   // Only one selected supplemental object survives rapid selection changes.
   for(const [id,e]of entities)if(id!==selected&&!tracks.has(id)){viewer.entities.remove(e);entities.delete(id);}
   const wasPresent=tracks.has(data.noradId);add(data);if(!wasPresent)tracks.delete(data.noradId);decorate();
   const positions=data.samples.map(p=>new C.Cartesian3(p[1],p[2],p[3]));
   orbit=viewer.entities.add({id:'selected-orbit',polyline:{positions,width:1.8,material:new C.PolylineGlowMaterialProperty({glowPower:.06,color:C.Color.fromCssColorString('#ffc56b').withAlpha(.85)})}});
   ground=viewer.entities.add({id:'selected-ground',polyline:{positions:positions.map(p=>{const c=C.Cartographic.fromCartesian(p);return C.Cartesian3.fromRadians(c.longitude,c.latitude,6000);}),width:1.3,material:new C.PolylineDashMaterialProperty({color:C.Color.fromCssColorString('#78b8e8').withAlpha(.7),dashLength:12})}});
  },
  locate(){const entity=entities.get(selected!);if(!entity?.position.getValue(viewer.clock.currentTime))return false;detach();
   const p=entity.position.getValue(viewer.clock.currentTime);const geo=C.Cartographic.fromCartesian(p);
   const mobile=fitMobileGlobe?.();
   const destination=C.Cartesian3.fromRadians(geo.longitude,geo.latitude,mobile?Math.max(geo.height+9000000,12000000):Math.max(geo.height+5000000,9000000));
   const orientation=mobile?{heading:0,pitch:-C.Math.PI_OVER_TWO,roll:0}:undefined;
   if(reduced)viewer.camera.setView({destination,orientation});else viewer.camera.flyTo({destination,orientation,duration:1.2});return true;},
  follow(){if(tracking){detach();return false;}const e=entities.get(selected!);if(!e?.position.getValue(viewer.clock.currentTime))return false;
   viewer.camera.cancelFlight();e.viewFrom=new C.Cartesian3(0,-6500000,4500000);viewer.trackedEntity=e;tracking=true;diagnostic.tracking=true;return true;},
  home,play:setPlayback,rate(value:number){viewer.clock.multiplier=value;},
  setReducedMotion(value:boolean){if(reduced===value)return;reduced=value;if(value)viewer.camera.cancelFlight();space.setReducedMotion(value);},
  global(data:any){
   if(!data){if(globalPoints)viewer.scene.primitives.remove(globalPoints);globalPoints=null;globalData=null;globalWindows=[];diagnostic.globalPointCount=0;diagnostic.globalWindowCount=0;diagnostic.globalActiveStart=undefined;diagnostic.globalActiveEnd=undefined;diagnostic.globalVisible=false;diagnostic.globalStatus='off';return;}
   if(data.delivery==='snapshot')globalWindows=[];
   globalWindows=[data,...globalWindows.filter(x=>x.start!==data.start||x.end!==data.end)].sort((a,b)=>Date.parse(b.generatedAt)-Date.parse(a.generatedAt)).slice(0,3);
   if(!globalPoints)globalPoints=viewer.scene.primitives.add(new C.PointPrimitiveCollection());
   updateGlobal(C.JulianDate.toDate(viewer.clock.currentTime).getTime());lastTelemetry=0;viewer.scene.requestRender();
  },
  seek(value:string){const t=C.JulianDate.fromIso8601(value);if(C.JulianDate.lessThan(t,viewer.clock.startTime)||C.JulianDate.greaterThan(t,viewer.clock.stopTime))return false;
   viewer.clock.currentTime=t;lastTelemetry=0;viewer.scene.requestRender();return true;},
  clouds(value:boolean){viewer.scene.globe.material.uniforms.cloudAmount=value?.32:0;viewer.scene.requestRender();},
  dispose(){if(destroyed)return;destroyed=true;clearTimeout(textureTimer);afterFirstFrame();remover?.();handler.destroy();viewer.scene.renderError.removeEventListener(renderError);
   if(diagnostic.selectedScreenPoint===selectedScreenPoint)delete diagnostic.selectedScreenPoint;
   viewer.scene.canvas.removeEventListener('pointerdown',pointerDown);viewer.scene.canvas.removeEventListener('pointermove',pointerMove);window.removeEventListener('pointerup',pointerUp);
   space.dispose();basemap.dispose();viewer.destroy();diagnostic.active--;diagnostic.destroyed++;diagnostic.tracking=false;entities.clear();tracks.clear();},
 };
 } catch(error) {
  if(!viewer.isDestroyed())viewer.destroy();diagnostic.active--;diagnostic.destroyed++;diagnostic.errors.push(String(error));throw error;
 }
}
export type OrbitScene = Awaited<ReturnType<typeof createOrbitScene>>;
