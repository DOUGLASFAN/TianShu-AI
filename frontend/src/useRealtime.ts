import {useEffect,useRef,useState} from 'react';
import {api,ApiError} from './api';
import {REALTIME_URL} from './config';

export function useRealtime(selected:number,onTrack:(value:any)=>void){
 const diagnostics=((window as any).liveDiagnostics??={connections:0,ignoredFrames:0,seq:0,streamId:''});
 const [connection,setConnection]=useState('连接中'),[snapshot,setSnapshot]=useState<any>(null);
 const socket=useRef<WebSocket|null>(null),target=useRef(selected),track=useRef(onTrack);target.current=selected;track.current=onTrack;
 useEffect(()=>{
  let stopped=false,timer:ReturnType<typeof setTimeout>,attempt=0,lastSeq=0,stream='';
  async function connect(){
   if(stopped)return;
   try{
    setConnection(attempt?'正在重连':'连接中');
    const ticket=await api('/realtime/ticket',{method:'POST'});if(stopped)return;
    const ws=new WebSocket(REALTIME_URL);socket.current=ws;
    ws.onopen=()=>ws.send(JSON.stringify({type:'auth',ticket:ticket.ticket}));
    ws.onmessage=event=>{
     if(stopped)return;
     let message;try{message=JSON.parse(event.data);}catch{return;}
     if(message.streamId!==stream){if(message.type!=='snapshot'){diagnostics.ignoredFrames++;return;}stream=message.streamId;lastSeq=0;}
     if(message.seq<=lastSeq){diagnostics.ignoredFrames++;return;}lastSeq=message.seq;diagnostics.seq=lastSeq;diagnostics.streamId=stream;
     if(message.type==='heartbeat'){ws.send(JSON.stringify({type:'pong'}));return;}
     if(message.type==='snapshot'){diagnostics.connections++;attempt=0;setConnection('已连接');setSnapshot(message.data);ws.send(JSON.stringify({type:'subscribe',noradId:target.current}));}
     if(message.type==='status')setSnapshot(message.data);
     if(message.type==='delta')setSnapshot((previous:any)=>({...previous,...message.data}));
     if(message.type==='trajectory'&&message.data.data.noradId===target.current)track.current(message.data);
    };
    ws.onclose=event=>{
     if(stopped)return;
     if(event.code===4401){setConnection('登录已失效');window.dispatchEvent(new Event('auth:expired'));return;}
     setConnection('连接中断');timer=setTimeout(connect,Math.min(30000,1000*2**Math.min(attempt++,5))*(.8+Math.random()*.4));
    };
    ws.onerror=()=>ws.close();
   }catch(error){
    if(stopped)return;
    if(error instanceof ApiError&&error.code==='SESSION_INVALID'){setConnection('登录已失效');return;}
    setConnection('连接中断');timer=setTimeout(connect,Math.min(30000,1000*2**Math.min(attempt++,5)));
   }
  }
  connect();return()=>{stopped=true;clearTimeout(timer);socket.current?.close();socket.current=null;};
 },[]);
 useEffect(()=>{const ws=socket.current;if(ws?.readyState===WebSocket.OPEN)ws.send(JSON.stringify({type:'subscribe',noradId:selected}));},[selected]);
 return {connection,snapshot};
}
