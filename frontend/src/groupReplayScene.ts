// One primitive collection for the complete batch; labels and paths only for selection.
export function createGroupReplayLayer(viewer:any,C:any,station:any,onSelect:(norad:number)=>void){
 const points=viewer.scene.primitives.add(new C.PointPrimitiveCollection()),byId=new Map<number,any>();
 const selectedPosition=new C.Cartesian3(),groundPosition=new C.Cartesian3();let hasSelection=false,selectionShown=false,current:any=null,pathKey='',fitted=false;
 const colors={below:C.Color.fromCssColorString('#8195a9').withAlpha(.7),above:C.Color.fromCssColorString('#69d6ff'),selected:C.Color.fromCssColorString('#ffc56b')};
 const marker=viewer.entities.add({id:'group-selected-marker',position:new C.CallbackPositionProperty(()=>hasSelection&&selectionShown?selectedPosition:undefined,false),label:{text:'',font:'13px sans-serif',pixelOffset:new C.Cartesian2(0,-22),showBackground:true}});
 const ground=viewer.entities.add({id:'group-selected-ground',position:new C.CallbackPositionProperty(()=>hasSelection&&selectionShown?groundPosition:undefined,false),point:{pixelSize:6,color:colors.above}});
 const path=viewer.entities.add({id:'group-selected-orbit',polyline:{positions:[],width:1.5,material:colors.selected.withAlpha(.7)}});
 const projection=viewer.entities.add({id:'group-selected-projection',polyline:{positions:[],width:1.2,material:colors.above.withAlpha(.7)}});
 const handler=new C.ScreenSpaceEventHandler(viewer.scene.canvas);handler.setInputAction((e:any)=>{const hits=viewer.scene.drillPick(e.position,8);for(const hit of hits){const id=hit?.id?.id??hit?.id;if(typeof id==='string'&&id.startsWith('group-sat-')){onSelect(Number(id.slice(10)));return;}}},C.ScreenSpaceEventType.LEFT_CLICK);
 const origin=C.Cartesian3.fromDegrees(station.longitude,station.latitude,station.elevation_m||0),phi=station.latitude*Math.PI/180,lam=station.longitude*Math.PI/180;
 const up=[Math.cos(phi)*Math.cos(lam),Math.cos(phi)*Math.sin(lam),Math.sin(phi)],east=[-Math.sin(lam),Math.cos(lam),0],north=[-Math.sin(phi)*Math.cos(lam),-Math.sin(phi)*Math.sin(lam),Math.cos(phi)];
 const scratch=new C.Cartesian3();
 function fit(data:any){viewer.resize();let radius=6378137;for(const sat of data.satellites)for(const row of [sat.samples[0],sat.samples.at(-1)])radius=Math.max(radius,Math.hypot(row[0],row[1],row[2]));const height=radius/Math.sin(viewer.camera.frustum.fovy/2)*1.12-6378137;viewer.camera.setView({destination:C.Cartesian3.fromDegrees(station.longitude,station.latitude,height)});viewer.scene.requestRender();}
 return {
  fit(){if(current)fit(current);},
  update(data:any,time:number,selected:number|null,onlyAbove:boolean){
   hasSelection=false;const inside=!!data&&time>=Date.parse(data.start)&&time<=Date.parse(data.end);points.show=inside;marker.show=inside;ground.show=inside;path.show=inside;projection.show=inside;
   if(!inside){const state={time,loadedCount:0,totalCount:data?.totalCount||0,aboveCount:0,shownCount:0,selectedNorad:selected,selected:null,loading:true};(window as any).groupReplayDiagnostics=state;return state;}
   if(current!==data){const ids=new Set<number>(data.satellites.map((s:any)=>s.noradId));for(const [id,p]of byId)if(!ids.has(id)){points.remove(p);byId.delete(id);}for(const sat of data.satellites)if(!byId.has(sat.noradId))byId.set(sat.noradId,points.add({id:{id:'group-sat-'+sat.noradId},position:new C.Cartesian3(...sat.samples[0].slice(0,3)),pixelSize:5,color:colors.below}));current=data;if(!fitted){fit(data);fitted=true;}}
   const offset=(time-Date.parse(data.start))/1000/data.stepSeconds,index=Math.max(0,Math.min(data.sampleCount-2,Math.floor(offset))),fraction=Math.max(0,Math.min(1,offset-index));let aboveCount=0,shownCount=0,selectedState:any=null;const pickCandidates:any[]=[];
   for(const sat of data.satellites){const a=sat.samples[index],b=sat.samples[index+1],p=byId.get(sat.noradId);scratch.x=a[0]+(b[0]-a[0])*fraction;scratch.y=a[1]+(b[1]-a[1])*fraction;scratch.z=a[2]+(b[2]-a[2])*fraction;p.position=scratch;
    const d=[scratch.x-origin.x,scratch.y-origin.y,scratch.z-origin.z],distance=Math.hypot(...d),dot=(axis:number[])=>d[0]*axis[0]+d[1]*axis[1]+d[2]*axis[2],elevation=Math.asin(Math.max(-1,Math.min(1,dot(up)/distance)))*180/Math.PI,above=elevation>=data.minElevation;
    if(above)aboveCount++;p.show=!onlyAbove||above;if(p.show){shownCount++;if(pickCandidates.length<12){const screen=C.SceneTransforms.worldToWindowCoordinates(viewer.scene,scratch);if(screen&&screen.x>40&&screen.y>40&&screen.x<viewer.canvas.clientWidth-40&&screen.y<viewer.canvas.clientHeight-40)pickCandidates.push({noradId:sat.noradId,x:screen.x,y:screen.y});}}p.pixelSize=sat.noradId===selected?9:above?6:4;p.color=sat.noradId===selected?colors.selected:above?colors.above:colors.below;
    if(sat.noradId===selected){hasSelection=true;selectionShown=p.show;C.Cartesian3.clone(scratch,selectedPosition);const geo=C.Cartographic.fromCartesian(scratch);C.Cartesian3.fromRadians(geo.longitude,geo.latitude,6000,C.Ellipsoid.WGS84,groundPosition);marker.label.text=sat.name;
     selectedState={noradId:selected,name:sat.name,elevation,azimuth:(Math.atan2(dot(east),dot(north))*180/Math.PI+360)%360,rangeKm:distance/1000,altitudeKm:geo.height/1000,above,position:[scratch.x,scratch.y,scratch.z]};
     const nextKey=data.start+':'+sat.noradId;if(nextKey!==pathKey){pathKey=nextKey;path.polyline.positions=sat.samples.map((r:any)=>new C.Cartesian3(r[0],r[1],r[2]));projection.polyline.positions=sat.samples.map((r:any)=>{const g=C.Cartographic.fromCartesian(new C.Cartesian3(r[0],r[1],r[2]));return C.Cartesian3.fromRadians(g.longitude,g.latitude,6000);});}
    }
   }
   path.show=inside&&hasSelection&&selectionShown;projection.show=path.show;
   const state={time,loadedCount:data.satellites.length,totalCount:data.totalCount,aboveCount,shownCount,selectedNorad:selected,selected:selectedState,pickCandidates,loading:false};(window as any).groupReplayDiagnostics=state;return state;
  },
  dispose(){handler.destroy();if(!viewer.isDestroyed()){viewer.scene.primitives.remove(points);for(const e of [marker,ground,path,projection])viewer.entities.remove(e);viewer.clock.currentTime=C.JulianDate.now();viewer.scene.requestRender();}byId.clear();(window as any).groupReplayDiagnostics={active:false,loadedCount:0};}
 };
}
