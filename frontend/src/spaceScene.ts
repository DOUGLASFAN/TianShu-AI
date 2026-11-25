// Local photographic sky and procedural planets; no runtime external asset requests.
let skySources:Promise<Record<string,HTMLImageElement>>|undefined;
let skyDimensions:number[]=[];
function sky(){
 const faces=['positiveX','negativeX','positiveY','negativeY','positiveZ','negativeZ'];
 return skySources??=Promise.all(faces.map(name=>new Promise<HTMLImageElement>((resolve,reject)=>{const image=new Image();image.onload=()=>resolve(image);image.onerror=()=>{skySources=undefined;reject(Error('NASA 高清星空加载失败'));};image.src=`/space/nasa-8k/${name}.webp`;}))).then(images=>{skyDimensions=[images[0].naturalWidth,images[0].naturalHeight];return Object.fromEntries(faces.map((name,i)=>[name,images[i]]));});
}
function surface(base:number[],gas:boolean){const canvas=document.createElement('canvas');canvas.width=512;canvas.height=256;const ctx=canvas.getContext('2d')!,image=ctx.createImageData(512,256);for(let y=0;y<256;y++)for(let x=0;x<512;x++){const band=gas?Math.sin(y*.17)+.4*Math.sin(y*.63)+.25*Math.sin(x*.03+y*.22):Math.sin(x*.05+Math.cos(y*.13)*3)*Math.sin(y*.11),shade=.82+band*.12;const i=(y*512+x)*4;for(let k=0;k<3;k++)image.data[i+k]=base[k]*shade;image.data[i+3]=255;}ctx.putImageData(image,0,0);return canvas;}

export function createSpaceScene(viewer:any,C:any,reduced:boolean){
 let enabled=true,mode='earth',disposed=false,solar:any[]=[],ring:any,skybox:any,loaded=false,fallback=false;
 let skyAllowed=false;
 const skyTimer=setTimeout(()=>{skyAllowed=true;update();viewer.scene.requestRender();},1600);
 let lastMode='',loading=false,inFlight=false;const listeners=new Set<()=>void>();
 const source=new C.CustomDataSource('space-illustration');viewer.dataSources.add(source);
 const id=crypto.randomUUID(),all=((window as any).spaceDiagnostics??={});
 viewer.scene.moon=new C.Moon();viewer.scene.sun=new C.Sun();viewer.scene.screenSpaceCameraController.maximumZoomDistance=1e10;viewer.camera.frustum.far=2e11;
 const notify=()=>{all[id]={mode,enabled,skyLoaded:loaded,galaxyLoaded:loaded&&!fallback,skyDimensions,sourceResolution:[8192,4096],sourceAttached:viewer.dataSources.contains(source),planets:solar.filter(e=>e.ellipsoid).length,moon:viewer.scene.moon.show,height:viewer.camera.positionCartographic.height};const state=[mode,enabled,loaded,skybox?.show].join('/');if(state!==lastMode){lastMode=state;for(const fn of listeners)fn();}};
 function moonPosition(){const t=viewer.clock.currentTime,transforms=C.CelestialFrameTransforms||C.Transforms,rotation=transforms.computeIcrfToFixedMatrix(t)||transforms.computeTemeToPseudoFixedMatrix(t);return C.Matrix3.multiplyByVector(rotation,C.Simon1994PlanetaryPositions.computeMoonPositionInEarthInertialFrame(t),new C.Cartesian3());}
 function makeSolar(){if(solar.length)return;
  const centre=new C.Cartesian3(-8e8,0,0),names=['太阳','水星','金星','地球','火星','木星','土星','天王星','海王星'];
  const definitions:any[]=[['太阳',0,0,1.6e8,[255,181,66]],['水星',1.5e8,2.3,1e7,[169,155,137]],['金星',3.5e8,4.4,2e7,[222,185,123]],['火星',1.1e9,.7,1.6e7,[189,95,65]],['木星',1.6e9,2,1e8,[207,175,143]],['土星',2.1e9,4.3,9e7,[211,190,143]],['天王星',2.7e9,.5,6e7,[123,196,203]],['海王星',3.2e9,3,5.7e7,[63,101,194]]];
  const label=(text:string)=>({text,font:'13px sans-serif',fillColor:C.Color.fromCssColorString('#d8e7f3'),showBackground:true,backgroundColor:C.Color.fromCssColorString('#07111dcc'),pixelOffset:new C.Cartesian2(0,-32),disableDepthTestDistance:Infinity});
  for(const [name,distance,angle,radius,color]of definitions){const position=new C.Cartesian3(centre.x+Math.cos(angle)*distance,Math.sin(angle)*distance,0),material=new C.ImageMaterialProperty({image:surface(color,['木星','土星','天王星','海王星'].includes(name))});solar.push(source.entities.add({id:'space-'+name,position,ellipsoid:{radii:new C.Cartesian3(radius,radius,radius),material},label:label(name)}));
   if(distance){const points=[];for(let j=0;j<=160;j++){const a=j/160*Math.PI*2;points.push(new C.Cartesian3(centre.x+Math.cos(a)*distance,Math.sin(a)*distance,0));}solar.push(source.entities.add({polyline:{positions:points,width:1,material:C.Color.fromCssColorString('#7896b9').withAlpha(.15)}}));}
   if(name==='土星'){
    const vertices=[],indices=[];for(let j=0;j<=128;j++)for(const r of [radius*1.3,radius*2.15]){const a=j/128*Math.PI*2;vertices.push(position.x+r*Math.cos(a),position.y+r*Math.sin(a)*.82,position.z+r*Math.sin(a)*.57);}
    for(let j=0;j<128;j++){const k=j*2;indices.push(k,k+1,k+2,k+1,k+3,k+2);}
    ring=viewer.scene.primitives.add(new C.Primitive({geometryInstances:new C.GeometryInstance({geometry:new C.Geometry({attributes:{position:new C.GeometryAttribute({componentDatatype:C.ComponentDatatype.DOUBLE,componentsPerAttribute:3,values:new Float64Array(vertices)})},indices:new Uint16Array(indices),primitiveType:C.PrimitiveType.TRIANGLES,boundingSphere:C.BoundingSphere.fromVertices(vertices)}),attributes:{color:C.ColorGeometryInstanceAttribute.fromColor(C.Color.fromCssColorString('#c8b58b').withAlpha(.75))}}),appearance:new C.PerInstanceColorAppearance({flat:true,translucent:true,closed:false}),asynchronous:false}));
   }
  }
  solar.push(source.entities.add({position:C.Cartesian3.ZERO,ellipsoid:{radii:new C.Cartesian3(2.5e7,2.5e7,2.5e7),material:new C.ImageMaterialProperty({image:'/earth/day-8k.jpg'})},label:label('地球')}));
  // names describes an illustration, with adjusted radii/distances; it is not an ephemeris.
  all[id]={...all[id],names};
 }
 function showSolar(show:boolean){viewer.scene.globe.show=!show;viewer.entities.show=!show;for(const e of solar)e.show=show;if(ring)ring.show=show;}
 function update(){if(disposed)return;const h=viewer.camera.positionCartographic.height;
  if(skyAllowed&&enabled&&h>8e5&&!skybox&&!loading){loading=true;sky().then(sources=>{if(disposed)return;skybox=new C.SkyBox({sources});viewer.scene.skyBox=skybox;loaded=true;viewer.scene.requestRender();}).catch(()=>{if(disposed)return;fallback=true;skybox=C.SkyBox.createEarthSkyBox();viewer.scene.skyBox=skybox;loaded=true;viewer.scene.requestRender();});}
  if(skybox)skybox.show=enabled&&h>8e5;
  viewer.scene.moon.show=enabled&&h>8e5&&mode!=='solar';viewer.scene.sun.show=enabled&&h>8e5&&mode!=='solar';
  if(mode!=='solar'&&h>1.5e9&&!inFlight){mode='solar';makeSolar();showSolar(true);}
  if(mode==='solar'&&h<3e8&&!inFlight){mode='earth';showSolar(false);}
  if(mode==='solar')showSolar(h>3e8);
  notify();
 }
 const remove=viewer.scene.preRender.addEventListener(update),handler=new C.ScreenSpaceEventHandler(viewer.scene.canvas);
 handler.setInputAction((event:any)=>{const picked=viewer.scene.pick(event.position)?.id;if(mode!=='solar'||!picked?.id?.startsWith('space-')||!picked.ellipsoid)return;const centre=picked.position.getValue(viewer.clock.currentTime),radii=picked.ellipsoid.radii.getValue(viewer.clock.currentTime);viewer.camera.flyToBoundingSphere(new C.BoundingSphere(centre,radii.x*2.8),{duration:reduced?0:1.4,offset:new C.HeadingPitchRange(0,-.8,0)});},C.ScreenSpaceEventType.LEFT_CLICK);
 return {mode:()=>mode,visible:()=>!!skybox?.show&&loaded&&!fallback,subscribe(fn:()=>void){listeners.add(fn);return()=>{listeners.delete(fn);};},enabled(value:boolean){enabled=value;update();viewer.scene.requestRender();},setReducedMotion(value:boolean){reduced=value;},
  view(value:'moon'|'solar'|'lunar'){
   skyAllowed=true;
   viewer.trackedEntity=undefined;viewer.camera.cancelFlight();viewer.camera.lookAtTransform(C.Matrix4.IDENTITY);mode=value;inFlight=true;
   const finish={complete:()=>{inFlight=false;update();},cancel:()=>{inFlight=false;}};
   if(value==='solar'){makeSolar();showSolar(viewer.camera.positionCartographic.height>3e8);viewer.camera.flyToBoundingSphere(new C.BoundingSphere(new C.Cartesian3(-8e8,0,0),3.5e9),{...finish,duration:reduced?0:1.8,offset:new C.HeadingPitchRange(0,-1.1,0)});}
   else{mode='moon';showSolar(false);const moon=moonPosition(),centre=value==='lunar'?moon:C.Cartesian3.multiplyByScalar(moon,.5,new C.Cartesian3());viewer.camera.flyToBoundingSphere(new C.BoundingSphere(centre,value==='lunar'?4e6:C.Cartesian3.magnitude(moon)*.56),{...finish,duration:reduced?0:1.6,offset:new C.HeadingPitchRange(0,-1.2,0)});}
   viewer.scene.requestRender();notify();
  },leave(){inFlight=false;mode='earth';showSolar(false);notify();},
  dispose(){disposed=true;clearTimeout(skyTimer);remove();handler.destroy();listeners.clear();delete all[id];viewer.dataSources.remove(source,true);if(ring)viewer.scene.primitives.remove(ring);solar=[];}
 };
}
