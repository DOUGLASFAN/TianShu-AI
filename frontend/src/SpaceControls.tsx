import {useEffect,useState} from 'react';
import type {OrbitScene} from './orbitScene';
import {isMobileLayout} from './mobileLayout';
export function SpaceControls({engine}:{engine:OrbitScene|null}){
 const [stars,setStars]=useState(true);
 const [mode,setMode]=useState('earth'),[visible,setVisible]=useState(false);useEffect(()=>{engine?.stars(stars);setMode(engine?.space.mode()||'earth');setVisible(!!engine?.space.visible());return engine?.space.subscribe(()=>{setMode(engine.space.mode());setVisible(engine.space.visible());});},[engine]);
 function changeScene(button:HTMLButtonElement,change:()=>void){
  change();
  if(isMobileLayout()){
   const menu=button.closest('details');
   menu?.removeAttribute('open');
   menu?.querySelector('summary')?.focus({preventScroll:true});
  }
 }
 return <><details className="space-control" data-space-sky={visible||undefined}><summary><span>太空</span></summary><div className="basemap-panel"><label><input type="checkbox" disabled={!engine} checked={stars} onChange={e=>{setStars(e.target.checked);engine?.stars(e.target.checked);}}/>银河星空</label><button type="button" disabled={!engine} onClick={event=>changeScene(event.currentTarget,()=>engine?.spaceView('moon'))}>地月全景</button><button type="button" disabled={!engine} onClick={event=>changeScene(event.currentTarget,()=>engine?.spaceView('lunar'))}>月球近景</button><button type="button" disabled={!engine} onClick={event=>changeScene(event.currentTarget,()=>engine?.spaceView('solar'))}>太阳系示意</button><button type="button" disabled={!engine} onClick={event=>changeScene(event.currentTarget,()=>engine?.home())}>返回地球</button></div></details>{mode==='solar'&&<span className="space-scale-note">太阳系示意 · 距离与尺寸已调整</span>}</>;
}
