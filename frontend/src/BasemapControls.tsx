import {useEffect,useState} from 'react';
import type {Basemap} from './basemaps';
import './basemaps.css';
import {isMobileLayout} from './mobileLayout';
export function BasemapControls({map,showControls=true}:{map?:Basemap|null;showControls?:boolean}){
 const [state,setState]=useState(map?.get());
 useEffect(()=>{setState(map?.get());return map?.subscribe(()=>setState(map.get()));},[map]);
 if(!map||!state)return null;
 return <>{showControls&&<details className="basemap-control"><summary><span>底图</span></summary><div className="basemap-panel"><div className="basemap-modes" role="group" aria-label="底图类型">{[['imagery','影像'],['streets','街道']].map(([value,label])=><button type="button" key={value} aria-pressed={state.mode===value} onClick={event=>{map.mode(value);if(isMobileLayout())event.currentTarget.closest('details')?.removeAttribute('open');}}>{label}</button>)}</div><label><input type="checkbox" checked={state.labels} disabled={state.mode==='streets'} onChange={e=>map.labels(e.target.checked)}/>{state.mode==='streets'?'街道自带地名':'地名'}</label><p role="status">{state.status}</p>{['不可用','未加载','未连接'].some(text=>state.status.includes(text))?<button type="button" onClick={()=>map.retry()}>重试地图</button>:null}<small>影像年代与精度因地区而异</small></div></details>}{state.level>0&&<div className="map-online-credit"><a href={state.sourceUrl} target="_blank" rel="noreferrer">{state.source}</a> · {state.credit}</div>}</>;
}
