import {createBasemap,type Basemap} from './basemaps';
import {BasemapControls} from './BasemapControls';
import {useEffect,useRef,useState} from 'react';
import {loadRuntime} from './orbitScene';
import {Crosshair,GlobeHemisphereEast} from '@phosphor-icons/react';
import {createGroupReplayLayer} from './groupReplayScene';
import {isMobileLayout} from './mobileLayout';

export function ObservationMap({station,event,pick,onPick,replay,replayTime,groupPaused,groupActive,groupData,groupSelected,onlyAbove,onGroupSelect,onGroupState}:{station:any;event?:any;pick?:boolean;onPick?:(lat:number,lng:number)=>void;replay?:any;replayTime?:number;groupPaused?:boolean;groupActive?:boolean;groupData?:any;groupSelected?:number|null;onlyAbove?:boolean;onGroupSelect?:(norad:number)=>void;onGroupState?:(state:any)=>void}){
 const host=useRef<HTMLDivElement>(null),engine=useRef<any>(null),callback=useRef(onPick),[ready,setReady]=useState(0),[error,setError]=useState('');callback.current=onPick;
 const [basemap,setBasemap]=useState<Basemap|null>(null);
 const groupLayer=useRef<any>(null),groupCallbacks=useRef({onGroupSelect,onGroupState}),lastGroupState=useRef(0);groupCallbacks.current={onGroupSelect,onGroupState};
 useEffect(()=>{let disposed=false,viewer:any,handler:any,map:Basemap|undefined;const observer=new ResizeObserver(([entry])=>{if(viewer&&!viewer.isDestroyed()&&entry.contentRect.width&&entry.contentRect.height){viewer.resize();viewer.scene.requestRender();}});
  const diagnostics=((window as any).observationMapDiagnostics??={created:0,destroyed:0,active:0,picks:0});
  loadRuntime().then(async()=>{const C=(window as any).Cesium;if(disposed)return;
   viewer=new C.Viewer(host.current!,{baseLayer:false,animation:false,timeline:false,baseLayerPicker:false,geocoder:false,homeButton:false,sceneModePicker:false,navigationHelpButton:false,fullscreenButton:false,selectionIndicator:false,infoBox:false,skyBox:false,sun:false,moon:false,requestRenderMode:true,maximumRenderTimeChange:Infinity});
   diagnostics.created++;diagnostics.active++;engine.current=viewer;viewer.scene.backgroundColor=C.Color.fromCssColorString('#07111d');viewer.resolutionScale=Math.min(devicePixelRatio,1.25);viewer.scene.globe.baseColor=C.Color.fromCssColorString('#183b58');
   viewer.camera.setView({destination:C.Cartesian3.fromDegrees(110,25,9500000)});
   viewer.scene.screenSpaceCameraController.minimumZoomDistance=150;
   map=createBasemap(viewer,C,false,isMobileLayout);setBasemap(map);await map.ready;if(disposed)return;observer.observe(host.current!);
   if(pick){handler=new C.ScreenSpaceEventHandler(viewer.scene.canvas);handler.setInputAction((e:any)=>{const ray=viewer.camera.getPickRay(e.position),point=viewer.scene.globe.pick(ray,viewer.scene);if(!point){setError('请点击地球表面');return;}const p=C.Cartographic.fromCartesian(point);diagnostics.picks++;setError('');callback.current?.(C.Math.toDegrees(p.latitude),C.Math.toDegrees(p.longitude));},C.ScreenSpaceEventType.LEFT_CLICK);}
   setReady(v=>v+1);
  }).catch(()=>!disposed&&setError('地球加载失败，可使用坐标输入。'));
  return()=>{disposed=true;map?.dispose();observer.disconnect();handler?.destroy();if(viewer&&!viewer.isDestroyed()){viewer.destroy();diagnostics.destroyed++;diagnostics.active--;}engine.current=null;};
 },[pick]);
 useEffect(()=>{const v=engine.current,C=(window as any).Cesium;if(!ready||!v||v.isDestroyed())return;for(const e of [...v.entities.values])if(e.id==='obs-station'||String(e.id).startsWith('preview-ground-'))v.entities.remove(e);
  if(station){v.entities.add({id:'obs-station',position:C.Cartesian3.fromDegrees(station.longitude,station.latitude),point:{pixelSize:8,color:C.Color.fromCssColorString('#d5efff'),outlineColor:C.Color.fromCssColorString('#4eaddc'),outlineWidth:2},label:{text:station.name||'候选位置',font:'14px sans-serif',fillColor:C.Color.fromCssColorString('#b7e5ff'),pixelOffset:new C.Cartesian2(0,-22),showBackground:true}});
   if(!pick&&!groupActive){v.resize();v.camera.setView({destination:C.Cartesian3.fromDegrees(station.longitude,station.latitude,9500000)});}}
  if(event?.curve&&!groupActive){const segments:number[][]=[[]];let previous:number|undefined;
   for(const row of event.curve){if(previous!==undefined&&Math.abs(row[7]-previous)>180)segments.push([]);segments.at(-1)!.push(row[7],row[6],12000);previous=row[7];}
   for(const [index,positions]of segments.entries())if(positions.length>=6)v.entities.add({id:'preview-ground-'+index,polyline:{positions:C.Cartesian3.fromDegreesArrayHeights(positions),width:2,material:C.Color.fromCssColorString('#69c5ff')}});}
  v.scene.requestRender();
 },[ready,station,event,pick,groupActive]);
 useEffect(()=>{const v=engine.current,C=(window as any).Cesium;if(!ready||!v||v.isDestroyed()||!groupActive||!station)return;const lighting=v.scene.globe.enableLighting;v.scene.globe.enableLighting=true;const layer=createGroupReplayLayer(v,C,station,id=>groupCallbacks.current.onGroupSelect?.(id));groupLayer.current=layer;return()=>{layer.dispose();groupLayer.current=null;if(!v.isDestroyed())v.scene.globe.enableLighting=lighting;};},[ready,groupActive,station]);
 useEffect(()=>{const v=engine.current,C=(window as any).Cesium;if(!ready||!groupActive||!groupLayer.current||replayTime===undefined||!v||v.isDestroyed())return;v.clock.currentTime=C.JulianDate.fromDate(new Date(replayTime));v.clock.shouldAnimate=false;const state=groupLayer.current.update(groupData,replayTime,groupSelected??null,!!onlyAbove);if(groupPaused||performance.now()-lastGroupState.current>200||!state.selected){lastGroupState.current=performance.now();groupCallbacks.current.onGroupState?.(state);}v.scene.requestRender();},[ready,groupActive,groupData,replayTime,groupSelected,onlyAbove,groupPaused]);
 useEffect(()=>{const v=engine.current,C=(window as any).Cesium;if(!ready||!v||v.isDestroyed()||!replay)return;
  const lighting=v.scene.globe.enableLighting;v.scene.globe.enableLighting=true;
  const p=new C.SampledPositionProperty(C.ReferenceFrame.FIXED);p.forwardExtrapolationType=C.ExtrapolationType.NONE;p.backwardExtrapolationType=C.ExtrapolationType.NONE;
  for(const row of replay.samples)p.addSample(C.JulianDate.fromDate(new Date(row[0])),new C.Cartesian3(row[1],row[2],row[3]));
  const entity=v.entities.add({id:'replay-satellite',position:p,point:{pixelSize:10,color:C.Color.fromCssColorString('#ffc56b'),outlineColor:C.Color.BLACK,outlineWidth:2},label:{text:event?.satellite?.name||'卫星',font:'13px sans-serif',pixelOffset:new C.Cartesian2(0,-22),showBackground:true}});
  const footprint=v.entities.add({id:'replay-ground',position:new C.CallbackPositionProperty((t:any)=>{const value=p.getValue(t);if(!value)return undefined;const geo=C.Cartographic.fromCartesian(value);return C.Cartesian3.fromRadians(geo.longitude,geo.latitude,6000);},false),point:{pixelSize:7,color:C.Color.fromCssColorString('#69c5ff')}});
  const line=v.entities.add({polyline:{positions:replay.samples.map((row:any)=>new C.Cartesian3(row[1],row[2],row[3])),width:1.5,material:C.Color.fromCssColorString('#ffc56b').withAlpha(.7)}});
  return()=>{if(!v.isDestroyed()){v.entities.remove(entity);v.entities.remove(footprint);v.entities.remove(line);v.scene.globe.enableLighting=lighting;v.clock.currentTime=C.JulianDate.now();v.clock.shouldAnimate=false;(window as any).replayMapDiagnostics={time:Date.now(),position:null};v.scene.requestRender();}};
 },[ready,replay,event,station]);
 useEffect(()=>{const v=engine.current,C=(window as any).Cesium;if(!ready||!v||v.isDestroyed()||!replay||replayTime===undefined)return;
  v.clock.currentTime=C.JulianDate.fromDate(new Date(replayTime));v.clock.shouldAnimate=false;v.scene.requestRender();
  const entity=v.entities.getById('replay-satellite'),position=entity?.position.getValue(v.clock.currentTime);(window as any).replayMapDiagnostics={time:replayTime,position:position?[position.x,position.y,position.z]:null};
 },[ready,replay,replayTime]);
 function view(global:boolean){const v=engine.current,C=(window as any).Cesium;if(!v||v.isDestroyed())return;if(global&&groupLayer.current){groupLayer.current.fit();return;}v.resize();const height=global?Math.max(16000000,6378137/Math.sin(v.camera.frustum.fovy/2)*1.12-6378137):100000;v.camera.setView({destination:C.Cartesian3.fromDegrees(station?.longitude??110,station?.latitude??25,height)});v.scene.requestRender();}
 return <div className={`observation-map ${pick?'picking':''}`}><div ref={host} className="observation-map-canvas"/><BasemapControls map={basemap}/><div className="observation-map-tools"><button type="button" aria-label="查看全球" title="查看全球" disabled={!ready} onClick={()=>view(true)}><GlobeHemisphereEast size={17}/></button><button type="button" aria-label="定位观测站" title="定位观测站" disabled={!ready||!station} onClick={()=>view(false)}><Crosshair size={17}/></button></div>{pick&&<span className="map-caption">点击地面选点</span>}{error&&<div className="map-error" role="alert">{error}</div>}<details className="map-source"><summary>图像来源</summary><a href="https://www.solarsystemscope.com/textures/" target="_blank" rel="noreferrer">Solar System Scope / INOVE</a> · <a href="https://creativecommons.org/licenses/by/4.0/" target="_blank" rel="noreferrer">CC BY 4.0</a> · 静态贴图<br/>在线影像与街道：Esri / Vantor / Earthstar Geographics / HERE / Garmin / OpenStreetMap contributors</details></div>;
}
