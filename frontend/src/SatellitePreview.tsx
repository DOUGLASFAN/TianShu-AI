import {useEffect,useRef,useState} from 'react';
import {ArrowCounterClockwise,Play,Pause} from '@phosphor-icons/react';
import * as THREE from 'three';
import {GLTFLoader} from 'three/addons/loaders/GLTFLoader.js';
import {DRACOLoader} from 'three/addons/loaders/DRACOLoader.js';
import {OrbitControls} from 'three/addons/controls/OrbitControls.js';
import {RoomEnvironment} from 'three/addons/environments/RoomEnvironment.js';

function disposeModel(model:THREE.Object3D){
 const materials=new Set<THREE.Material>(),textures=new Set<THREE.Texture>();
 model.traverse(object=>{if(object instanceof THREE.Mesh){object.geometry.dispose();for(const m of Array.isArray(object.material)?object.material:[object.material])materials.add(m);}});
 for(const material of materials){for(const value of Object.values(material))if(value instanceof THREE.Texture)textures.add(value);material.dispose();}
 for(const texture of textures)texture.dispose();
}

const MODELS=[
 {id:'cygnss',name:'双翼卫星',original:'CYGNSS',credit:'NASA',file:'/models/cygnss/satellite.glb'},
 {id:'aqua',name:'对地观测',original:'Aqua',credit:'NASA/Brian E. Kumanchik; NASA/Christian A. Lopez',file:'/models/aqua/satellite.glb'},
 {id:'tdrs',name:'通信中继',original:'TDRS',credit:'NASA/JPL/Eyes on the Solar System',file:'/models/tdrs/satellite.glb'},
 {id:'cubesat',name:'立方星',original:'CubeSat',credit:'NASA/Christopher R. Meaney',file:'/models/cubesat/satellite.glb'},
 {id:'goes',name:'气象卫星',original:'GOES',credit:'NASA/Christopher R. Meaney',file:'/models/generic-satellite/satellite.glb'},
];
export function SatellitePreview({reduced=false}:{reduced?:boolean}){
 const host=useRef<HTMLDivElement>(null),reset=useRef<()=>void>(()=>{});
 const [modelId,setModelId]=useState('cygnss'),[auto,setAuto]=useState(true);
 const chosen=MODELS.find(m=>m.id===modelId)!;
 const animation=useRef(false),kick=useRef<()=>void>(()=>{});animation.current=auto&&!reduced;
 useEffect(()=>{kick.current();},[auto,reduced]);
 const [state,setState]=useState<'loading'|'ready'|'error'>('loading'),[attempt,setAttempt]=useState(0);
 useEffect(()=>{
  let removeVisibility=()=>{};
  let cancelled=false,visible=true,lastFrame=0,model:THREE.Object3D|undefined,frame=0,renderer:THREE.WebGLRenderer|undefined,controls:OrbitControls|undefined,observer:ResizeObserver|undefined,intersection:IntersectionObserver|undefined,environment:THREE.WebGLRenderTarget|undefined;
  const diagnostic=((window as any).satellitePreviewDiagnostics??={created:0,destroyed:0,active:0,renders:0,loaded:false});
  const decoder=new DRACOLoader().setDecoderPath('/draco/').setWorkerLimit(1);
  setState('loading');
  try{
   const target=host.current!;
   renderer=new THREE.WebGLRenderer({alpha:true,antialias:true});
   diagnostic.created++;diagnostic.active++;diagnostic.loaded=false;
   renderer.setPixelRatio(Math.min(window.devicePixelRatio,1.5));renderer.setClearColor(0x000000,0);
   renderer.toneMapping=THREE.ACESFilmicToneMapping;renderer.toneMappingExposure=.85;
   renderer.domElement.tabIndex=0;renderer.domElement.setAttribute('aria-label','通用卫星三维模型，可拖动旋转或用方向键查看');
   target.append(renderer.domElement);
   const scene=new THREE.Scene(),camera=new THREE.PerspectiveCamera(34,1,.01,100);
   const draw=()=>{
    if(cancelled||frame||!visible||document.hidden)return;
    frame=requestAnimationFrame(stamp=>{
     const rotating=!!model&&animation.current;
     if(!rotating||!lastFrame||stamp-lastFrame>=30){
      if(controls){controls.autoRotate=rotating;controls.autoRotateSpeed=.5;if(rotating)controls.update(Math.min(.1,(stamp-lastFrame)/1000));}
      renderer!.render(scene,camera);diagnostic.renders++;lastFrame=stamp;
     }
     frame=0;
     if(rotating)draw();
    });
   };
   kick.current=draw;
   scene.add(new THREE.HemisphereLight(0xcce9ff,0x182333,.8));
   const key=new THREE.DirectionalLight(0xfff2de,1.8);key.position.set(3,5,4);scene.add(key);
   const rim=new THREE.DirectionalLight(0x81caff,.9);rim.position.set(-4,1,-2);scene.add(rim);
   const pmrem=new THREE.PMREMGenerator(renderer),room=new RoomEnvironment();
   environment=pmrem.fromScene(room,.04);scene.environment=environment.texture;scene.environmentIntensity=.65;room.dispose();pmrem.dispose();
   controls=new OrbitControls(camera,renderer.domElement);controls.enablePan=false;controls.enableDamping=false;controls.minDistance=2;controls.maxDistance=7;controls.addEventListener('change',draw);
   const home=()=>{camera.position.set(2.5,1.7,3.5);controls!.target.set(0,0,0);controls!.update();draw();};reset.current=home;home();
   const onVisibility=()=>draw();document.addEventListener('visibilitychange',onVisibility);removeVisibility=()=>document.removeEventListener('visibilitychange',onVisibility);
   intersection=new IntersectionObserver(([entry])=>{visible=entry.isIntersecting;draw();});intersection.observe(target);
   const resize=()=>{const {width,height}=target.getBoundingClientRect();if(!width||!height)return;renderer!.setSize(width,height,false);camera.aspect=width/height;camera.updateProjectionMatrix();draw();};
   observer=new ResizeObserver(resize);observer.observe(target);resize();
   const keyDown=(event:KeyboardEvent)=>{if(!['ArrowLeft','ArrowRight','ArrowUp','ArrowDown','Home'].includes(event.key))return;event.preventDefault();if(event.key==='Home'){home();return;}const offset=camera.position.clone().sub(controls!.target),spherical=new THREE.Spherical().setFromVector3(offset);spherical.theta+=event.key==='ArrowLeft'?.16:event.key==='ArrowRight'?-.16:0;spherical.phi=THREE.MathUtils.clamp(spherical.phi+(event.key==='ArrowUp'?-.12:event.key==='ArrowDown'?.12:0),.1,Math.PI-.1);camera.position.copy(controls!.target).add(new THREE.Vector3().setFromSpherical(spherical));controls!.update();draw();};
   renderer.domElement.addEventListener('keydown',keyDown);
   new GLTFLoader().setDRACOLoader(decoder).loadAsync(chosen.file).then(gltf=>{
    if(cancelled){disposeModel(gltf.scene);return;}
    model=gltf.scene;const bounds=new THREE.Box3().setFromObject(model),size=bounds.getSize(new THREE.Vector3()),center=bounds.getCenter(new THREE.Vector3());
    model.position.sub(center);const group=new THREE.Group();group.add(model);group.scale.setScalar(2.6/Math.max(size.x,size.y,size.z));if(modelId==='cygnss')group.rotation.y=Math.PI;if(modelId==='aqua')group.rotation.z=Math.PI/2;scene.add(group);
    diagnostic.loaded=true;diagnostic.modelId=modelId;setState('ready');draw();
   }).catch(()=>{if(!cancelled)setState('error');});
  }catch{setState('error');}
  return()=>{cancelled=true;removeVisibility();cancelAnimationFrame(frame);observer?.disconnect();intersection?.disconnect();controls?.dispose();decoder.dispose();if(model)disposeModel(model);environment?.dispose();
   if(renderer){renderer.dispose();renderer.forceContextLoss();renderer.domElement.remove();diagnostic.active--;diagnostic.destroyed++;}reset.current=()=>{};kick.current=()=>{};
  };
 },[attempt,modelId]);
 return <div className="satellite-preview" aria-label="通用卫星模型预览"><div ref={host} className="satellite-preview-canvas"/>
  {state==='loading'&&<span className="model-feedback" role="status">模型加载中…</span>}
  {state==='error'&&<button className="model-feedback" onClick={()=>setAttempt(v=>v+1)}>模型加载失败，重试</button>}
  <select className="model-select" aria-label="预览模型" title="通用外形示意" value={modelId} onChange={e=>setModelId(e.target.value)}>{MODELS.map(model=><option key={model.id} value={model.id}>{model.name}</option>)}</select>
  {state==='ready'&&<button className="model-auto" aria-label={auto?'停止模型自转':'开启模型自转'} title={reduced?'减少动态效果已开启':auto?'停止自转':'缓慢自转'} disabled={reduced} onClick={()=>setAuto(!auto)}>{auto?<Pause size={14}/>:<Play size={14}/>}</button>}
  <details className="model-source"><summary aria-label="模型来源">来源</summary><div>{chosen.original} · {chosen.credit}<br/>通用外形示意，不代表所选卫星的真实结构或姿态。</div></details>
  {state==='ready'&&<button className="model-reset" aria-label="重置模型视角" title="重置模型视角" onClick={()=>reset.current()}><ArrowCounterClockwise size={16}/></button>}
 </div>;
}
