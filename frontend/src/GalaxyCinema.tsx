import {useEffect,useRef,useState} from 'react';
import {X,ArrowSquareOut} from '@phosphor-icons/react';
import type {OrbitScene} from './orbitScene';
import './galaxy-cinema.css';

export function GalaxyCinema({engine,reduced,onClose}:{engine:OrbitScene|null;reduced:boolean;onClose:()=>void}){
 const dialog=useRef<HTMLDialogElement>(null),video=useRef<HTMLVideoElement>(null),returnFocus=useRef(document.activeElement as HTMLElement|null),[error,setError]=useState('');
 useEffect(()=>{
  const previous=document.body.style.overflow,player=video.current,element=dialog.current;document.body.style.overflow='hidden';element?.showModal();
  return()=>{if(player){player.pause();player.removeAttribute('src');player.load();}element?.close();document.body.style.overflow=previous;if(returnFocus.current?.isConnected)returnFocus.current.focus();};
 },[]);
 useEffect(()=>{engine?.suspend(true);return()=>engine?.suspend(false);},[engine]);
 return <dialog ref={dialog} className="galaxy-cinema" aria-labelledby="galaxy-cinema-title" onCancel={event=>{event.preventDefault();onClose();}}>
  <header><div><h2 id="galaxy-cinema-title">星系穿行</h2><span>NASA 原创成片 · 4K · 非实时轨道画面</span></div><button type="button" aria-label="关闭电影视角" onClick={onClose}><X size={21}/></button></header>
  <video ref={video} src="/space/cinema/nasa-galaxies-4k.mp4" poster="/space/cinema/nasa-galaxies-poster.jpg" controls playsInline muted preload="metadata" autoPlay={!reduced} onError={()=>setError('动画暂时无法播放，请重新打开或使用下方原始资源。')} onLoadedMetadata={event=>{const v=event.currentTarget;(window as any).galaxyCinemaDiagnostics={width:v.videoWidth,height:v.videoHeight,duration:v.duration,source:'NASA SVS 14950'};}}/>
  {error&&<p className="cinema-error" role="alert">{error}</p>}
  <footer><span>NASA’s Goddard Space Flight Center / Conceptual Image Lab</span><a href="https://svs.gsfc.nasa.gov/14950/" target="_blank" rel="noreferrer">原始资源<ArrowSquareOut size={15}/></a></footer>
 </dialog>;
}
