import {useEffect,useId,useLayoutEffect,useRef,useState,type KeyboardEvent,type CSSProperties} from 'react';
import {createPortal} from 'react-dom';
import {CaretDown,Check} from '@phosphor-icons/react';
import './select.css';

export type SelectOption={value:string;label:string;description?:string;disabled?:boolean};
export function Select({id,label,value,options,onChange,placeholder='请选择',disabled=false,className=''}:{id?:string;label:string;value:string;options:SelectOption[];onChange:(value:string)=>void;placeholder?:string;disabled?:boolean;className?:string}){
 const uid=useId(),listId=uid+'-options',button=useRef<HTMLButtonElement>(null),list=useRef<HTMLDivElement>(null),[open,setOpen]=useState(false),[active,setActive]=useState(0),[position,setPosition]=useState<CSSProperties>({left:0,top:0,width:0,maxHeight:280});
 const search=useRef(''),timer=useRef<ReturnType<typeof setTimeout>|undefined>(undefined);
 const portalHost=button.current?.closest('dialog[open]')||document.body;
 const selected=options.find(x=>x.value===value),enabled=options.map((o,i)=>o.disabled?-1:i).filter(i=>i>=0);
 function show(){if(disabled||!enabled.length)return;const index=options.findIndex(x=>x.value===value&&!x.disabled);setActive(index>=0?index:enabled[0]);setOpen(true);}
 function choose(index:number){if(!options[index]||options[index].disabled)return;onChange(options[index].value);setOpen(false);button.current?.focus();}
 useEffect(()=>()=>clearTimeout(timer.current),[]);
 useEffect(()=>{if(disabled)setOpen(false);},[disabled]);
 useLayoutEffect(()=>{if(!open)return;
  const place=()=>{if(!button.current)return;const r=button.current.getBoundingClientRect(),below=innerHeight-r.bottom-12,above=r.top-12,up=below<Math.min(220,options.length*48+12)&&above>below,maxHeight=Math.min(300,Math.max(80,up?above:below)),width=Math.min(Math.max(r.width,180),innerWidth-24);setPosition({left:Math.max(12,Math.min(r.left,innerWidth-width-12)),top:up?undefined:r.bottom+8,bottom:up?innerHeight-r.top+8:undefined,width,maxHeight});};
  const outside=(e:PointerEvent)=>{if(!button.current?.contains(e.target as Node)&&!list.current?.contains(e.target as Node))setOpen(false);};
  place();window.addEventListener('resize',place);window.addEventListener('scroll',place,true);document.addEventListener('pointerdown',outside);
  return()=>{window.removeEventListener('resize',place);window.removeEventListener('scroll',place,true);document.removeEventListener('pointerdown',outside);};
 },[open,options.length]);
 useEffect(()=>{
  const menu=list.current,item=menu?.querySelector<HTMLElement>(`[data-index="${active}"]`);
  if(!open||!menu||!item)return;
  const offset=item.offsetTop-menu.scrollTop;
  if(offset<0)menu.scrollTop+=offset;
  else if(offset+item.offsetHeight>menu.clientHeight)menu.scrollTop+=offset+item.offsetHeight-menu.clientHeight;
 },[open,active]);
 function key(e:KeyboardEvent<HTMLButtonElement>){
  if(!enabled.length)return;
  if(e.key==='Tab'){setOpen(false);return;}
  if(e.key==='Escape'&&open){e.preventDefault();e.stopPropagation();setOpen(false);return;}
  if(['ArrowDown','ArrowUp','Home','End','Enter',' '].includes(e.key)){
   e.preventDefault();if(!open){show();return;}
   if(e.key==='Enter'||e.key===' '){choose(active);return;}
   const index=enabled.indexOf(active);setActive(e.key==='Home'?enabled[0]:e.key==='End'?enabled.at(-1)!:enabled[(index+(e.key==='ArrowDown'?1:-1)+enabled.length)%enabled.length]);return;
  }
  if(e.key.length===1&&!e.ctrlKey&&!e.metaKey){search.current+=e.key.toLocaleLowerCase();clearTimeout(timer.current);timer.current=setTimeout(()=>search.current='',700);const index=options.findIndex(x=>!x.disabled&&x.label.toLocaleLowerCase().startsWith(search.current));if(index>=0){setActive(index);if(!open)onChange(options[index].value);}}
 }
 return <><button id={id} ref={button} type="button" role="combobox" aria-label={label} aria-expanded={open} aria-haspopup="listbox" aria-controls={open?listId:undefined} aria-activedescendant={open?`${uid}-${active}`:undefined} disabled={disabled} data-value={value} className={`ui-select ${open?'is-open':''} ${className}`} onClick={()=>open?setOpen(false):show()} onKeyDown={key} onBlur={e=>{if(!list.current?.contains(e.relatedTarget))setOpen(false);}}><span className={!selected?'placeholder':''}>{selected?.label||placeholder}</span><CaretDown size={15}/></button>
 {open&&createPortal(<div ref={list} id={listId} className="ui-select-menu" data-side={position.bottom===undefined?'bottom':'top'} role="listbox" aria-label={label} style={position}>{options.map((option,index)=><div id={`${uid}-${index}`} key={option.value} role="option" aria-selected={option.value===value} aria-disabled={option.disabled||undefined} data-index={index} data-value={option.value} className={`ui-select-option ${active===index?'is-active':''} ${option.value===value?'is-selected':''}`} onPointerMove={e=>{if(e.pointerType==='mouse'&&!option.disabled)setActive(index);}} onPointerDown={e=>e.preventDefault()} onClick={()=>choose(index)}><div><span>{option.label}</span>{option.description&&<small>{option.description}</small>}</div>{option.value===value&&<Check size={16} weight="bold"/>}</div>)}</div>,portalHost)}
 </>;
}
