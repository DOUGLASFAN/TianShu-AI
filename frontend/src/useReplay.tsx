import {useEffect,useRef,useState} from 'react';
import {Pause,Play,ArrowCounterClockwise,X} from '@phosphor-icons/react';

export function useReplay(){
 const [track,setTrack]=useState<any>(null),[time,setTime]=useState(0),[playing,setPlaying]=useState(false),[rate,setRate]=useState(10),anchor=useRef({clock:0,real:0});
 useEffect(()=>{if(!playing||!track)return;let frame=0,last=0;anchor.current={clock:time,real:performance.now()};
  const tick=(stamp:number)=>{if(stamp-last>=33){last=stamp;const next=Math.min(Date.parse(track.end),anchor.current.clock+(stamp-anchor.current.real)*rate);setTime(next);if(next>=Date.parse(track.end)){setPlaying(false);return;}}frame=requestAnimationFrame(tick);};frame=requestAnimationFrame(tick);
  const hidden=()=>{if(document.hidden)setPlaying(false);};document.addEventListener('visibilitychange',hidden);return()=>{cancelAnimationFrame(frame);document.removeEventListener('visibilitychange',hidden);};
 },[playing,rate,track]);
 function start(value:any,at?:number){setTrack(value);setTime(Math.max(Date.parse(value.start),Math.min(Date.parse(value.end),at??Date.parse(value.start))));setRate(10);setPlaying(true);}
 function seek(value:number){setTime(Math.max(Date.parse(track.start),Math.min(Date.parse(track.end),value)));setPlaying(false);}
 function exit(){setPlaying(false);setTrack(null);setTime(Date.now());}
 useEffect(()=>{(window as any).replayDiagnostics={active:!!track,time,playing,rate,start:track?.start,end:track?.end};},[track,time,playing,rate]);
 return {track,time,playing,rate,start,seek,exit,setPlaying,setRate};
}

export function ReplayControls({clock,zone}:{clock:ReturnType<typeof useReplay>;zone:string}){
 const [input,setInput]=useState(''),offset=zone==='sh'?8*3600000:0;
 useEffect(()=>setInput(new Date(clock.time+offset).toISOString().slice(0,19)),[clock.time,offset]);
 if(!clock.track)return null;
 const stamp=new Date(clock.time+offset).toISOString().replace('T',' ').slice(0,19);
 return <section className="replay-controls" aria-label="过境回放"><div className="replay-clock"><button aria-label={clock.playing?'暂停回放':'播放回放'} onClick={()=>clock.setPlaying(!clock.playing)}>{clock.playing?<Pause weight="fill"/>:<Play weight="fill"/>}</button><div><span>{clock.track.kind==='group'?'整组回放':'单星回放'} · {zone==='sh'?'UTC+8':'UTC'}</span><time>{stamp}</time></div><button aria-label="从头回放" onClick={()=>clock.seek(Date.parse(clock.track.start))}><ArrowCounterClockwise/></button></div>
 <input type="range" aria-label="回放时间轴" min={Date.parse(clock.track.start)} max={Date.parse(clock.track.end)} step={100} value={clock.time} onKeyDown={e=>{if(e.key==='Home'||e.key==='End'){e.preventDefault();clock.seek(Date.parse(e.key==='Home'?clock.track.start:clock.track.end));}}} onChange={e=>clock.seek(Number(e.target.value))}/><div className="replay-actions"><div className="range-segments" role="group" aria-label="回放速度">{[1,10,30,60].map(n=><button key={n} aria-pressed={clock.rate===n} onClick={()=>clock.setRate(n)}>{n}×</button>)}</div><form onSubmit={e=>{e.preventDefault();const value=Date.parse(input+(zone==='sh'?'+08:00':'Z'));if(Number.isFinite(value))clock.seek(value);}}><input aria-label="回放指定时间" type="datetime-local" step="1" required onFocus={()=>clock.setPlaying(false)} value={input} onChange={e=>{clock.setPlaying(false);setInput(e.target.value);}}/><button>定位</button></form><button onClick={clock.exit}><X/>回到当前</button></div></section>;
}
