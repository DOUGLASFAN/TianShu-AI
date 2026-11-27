import {GuideEntry} from './InteractiveGuide';
import {useState} from 'react';
import {Select} from './components/Select';
import type {BasemapPreferences} from './basemaps';

export const timeZones={
 sh:{label:'北京时间（UTC+8）',suffix:'UTC+8',offsetHours:8,isoOffset:'+08:00'},
 utc:{label:'协调世界时（UTC）',suffix:'UTC',offsetHours:0,isoOffset:'Z'},
} as const;
export type TimeZone=keyof typeof timeZones;
export const timeZoneOptions=Object.entries(timeZones).map(([value,zone])=>({value,label:zone.label}));
const timeZoneKey='star-nexus:explore-time-zone';
const motionKey='star-nexus:explore-reduced-motion';
const basemapModeKey='star-nexus:explore-basemap-mode';
const basemapLabelsKey='star-nexus:explore-basemap-labels';

export function readBasemapPreferences():BasemapPreferences {
 return {
  mode:localStorage.getItem(basemapModeKey)==='streets'?'streets':'imagery',
  labels:localStorage.getItem(basemapLabelsKey)!=='0',
 };
}

export function readTimeZone():TimeZone {
 return localStorage.getItem(timeZoneKey)==='utc'?'utc':'sh';
}

export function useDisplaySettings(){
 const [timeZone,setZone]=useState(readTimeZone);
 const [lessMotion,setMotion]=useState(()=>localStorage.getItem(motionKey)==='1');
 function setTimeZone(value:TimeZone){setZone(value);localStorage.setItem(timeZoneKey,value);}
 function setLessMotion(value:boolean){
  setMotion(value);
  localStorage.setItem(motionKey,value?'1':'0');
  window.dispatchEvent(new Event('star-nexus:motion-changed'));
 }
 return {timeZone,setTimeZone,lessMotion,setLessMotion};
}

export function DisplaySettings(){
 const {timeZone,setTimeZone,lessMotion,setLessMotion}=useDisplaySettings();
 const [basemap,setBasemap]=useState(readBasemapPreferences);
 function updateBasemap(next:BasemapPreferences){
  localStorage.setItem(basemapModeKey,next.mode);
  localStorage.setItem(basemapLabelsKey,next.labels?'1':'0');
  setBasemap(next);
 }
 return <main className="display-settings">
  <div className="page-heading"><h1>设置</h1></div>
  <section className="panel">
   <h2>互动练习</h2>
   <p>用真实的页面控件完成一次观测查询或异常调查。</p>
   <GuideEntry/>
  </section>
  <section className="panel">
   <h2>时间显示</h2>
   <label htmlFor="settings-time-zone">默认显示时区</label>
   <Select id="settings-time-zone" label="默认显示时区" value={timeZone} options={timeZoneOptions} onChange={value=>setTimeZone(value as TimeZone)}/>
   <p>用于卫星探索和新开的观测规划。</p>
   <div className="settings-motion">
    <label><input type="checkbox" checked={lessMotion} onChange={event=>setLessMotion(event.target.checked)}/>减少探索动画</label>
    <p>减少相机飞行和场景过渡。系统的减少动态效果也会生效。</p>
   </div>
  </section>
  <section className="panel">
   <h2>探索底图</h2>
   <label htmlFor="settings-basemap-mode">底图类型</label>
   <Select id="settings-basemap-mode" label="底图类型" value={basemap.mode}
    options={[{value:'imagery',label:'影像'},{value:'streets',label:'街道'}]}
    onChange={mode=>updateBasemap({...basemap,mode:mode==='streets'?'streets':'imagery'})}/>
   <div className="settings-motion">
    <label><input type="checkbox" disabled={basemap.mode==='streets'} checked={basemap.mode==='streets'||basemap.labels}
     onChange={event=>updateBasemap({...basemap,labels:event.target.checked})}/>显示地名</label>
    <p>{basemap.mode==='streets'?'街道底图自带地名。':'放大地球后显示在线影像，地名随近地视角加载。'}</p>
   </div>
   <details className="settings-motion">
    <summary>素材署名</summary>
    <p>地表、夜光和云层来自 <a href="https://www.solarsystemscope.com/textures/">Solar System Scope</a>，采用 CC BY 4.0。</p>
    <p>星空来自 <a href="https://svs.gsfc.nasa.gov/4851/">NASA/GSFC/SVS</a>、ESA/Gaia/DPAC。</p>
   </details>
  </section>
 </main>;
}
