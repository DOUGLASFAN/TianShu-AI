import {
 createContext,useCallback,useContext,useEffect,useId,useLayoutEffect,useMemo,useRef,useState,
 type CSSProperties,type ReactNode,
} from 'react';
import {createPortal} from 'react-dom';
import {useLocation,useNavigate} from 'react-router-dom';
import {GraduationCap,Crosshair,CheckCircle,ArrowRight} from '@phosphor-icons/react';
import './interactive-guide.css';

type LessonId='anomaly'|'observation'|'plan';
type GuideEvent='bookmarks'|'example'|'investigated'|'evidence'|'assistant'|'observation'|'comparison'|
 'prediction-ready'|'future-pass'|'plan-open'|'plan-saved'|'plan-viewed';
type Step={target:string;event:GuideEvent;title:string;instruction:string;path:string};
type Lesson={title:string;summary:string;steps:Step[];outcome:string};

const lessons:Record<LessonId,Lesson>={
 anomaly:{
  title:'追查一条遥测异常',summary:'从地球打开公开样本，调查一个异常，再回到测量证据。',
  steps:[
   {target:'bookmarks',event:'bookmarks',path:'/explore',title:'从地球打开书签',instruction:'点击高亮的「智能书签 · 异常调查」。这里汇总当前时间范围的过境和已归档的遥测线索。'},
   {target:'example',event:'example',path:'/explore',title:'打开公开示例',instruction:'点击「打开公开示例 · OPS-SAT 片段 8」。应用会打开真实样本，并定位到它的候选测量。'},
   {target:'investigate',event:'investigated',path:'/telemetry',title:'调查当前测量',instruction:'点「一键调查当前记录」，等结果返回。系统会复算两条规则，检查质量和同期证据。'},
   {target:'evidence',event:'evidence',path:'/telemetry',title:'把结论追到曲线',instruction:'先看结论和下一步，再点「回到曲线证据」。焦点会回到这条原始测量。'},
  ],
  outcome:'你已经从主页找到一条线索、运行调查，并回到同一条原始测量。下次可以选自己的遥测记录照这个流程复核。',
 },
 observation:{
  title:'用 AI 找观测窗口',summary:'提出一次真实问题，再追问改仰角，看看窗口如何变化。',
  steps:[
   {target:'assistant',event:'assistant',path:'/explore',title:'打开 AI 探索任务',instruction:'点击高亮按钮。从这里可以用一句话查卫星、问过境，或者诊断当前画面。'},
   {target:'observe-example',event:'observation',path:'/explore',title:'实际计算一次',instruction:'用高亮示例查询未来 24 小时的 ISS，也可以输入自己的问题。若缺少观测站，选一个已有站点继续。'},
   {target:'observe-compare',event:'comparison',path:'/explore',title:'改条件，比较两次计算',instruction:'点击「追问：最低仰角改成 30°」。系统保留同一站点与时段，算出哪些窗口仍然满足条件。'},
  ],
  outcome:'你已经用自然语言触发过境计算，并在同一时段对照了两套条件。有可用窗口时，可从结果直接定位或带条件去观测规划。',
 },
 plan:{
  title:'把过境保存为观测计划',summary:'预测一个未来过境，选定窗口，再在我的空间打开保存结果。',
  steps:[
   {target:'plan-calculate',event:'prediction-ready',path:'/observations',title:'计算未来的过境',instruction:'确认观测站、卫星和时间。点「计算过境」，等到列表出现未来窗口。没有观测站时可先添加一个。'},
   {target:'plan-pass',event:'future-pass',path:'/observations',title:'选择一个未来窗口',instruction:'点一条还未开始的过境。进入、最高点和离开是不同时间，选中后可以查看仰角曲线。'},
   {target:'plan-open',event:'plan-open',path:'/observations',title:'打开保存选项',instruction:'点「保存观测计划」，先检查卫星、站点和窗口时间。'},
   {target:'plan-confirm',event:'plan-saved',path:'/observations',title:'确认保存计划',instruction:'按需要选择提前提醒时间，再点「确认保存计划」。这会创建一条真实计划，供以后查看和提醒。'},
   {target:'plan-view',event:'plan-viewed',path:'/observations',title:'查看你保存的计划',instruction:'点「查看计划」，打开我的空间里的同一条计划并核对快照。'},
  ],
  outcome:'你已完成预测、选择过境、保存并打开计划。以后可在「我的空间」查看、回放或取消。',
 },
};

const storageKey='xingxun.interactive-guide.v1';
type Progress={lesson:LessonId;index:number};
type Stored={seen:boolean;progress:Progress|null;completed:LessonId[]};
type PlanningHandoff={href:string;minimum:number};
type GuideContextValue={openGuide:()=>void;signal:(event:GuideEvent,detail?:{planId?:string;planning?:PlanningHandoff})=>void;stepTarget?:string};
const GuideContext=createContext<GuideContextValue|null>(null);
export const useInteractiveGuide=()=>useContext(GuideContext);

function load():Stored{
 const empty:Stored={seen:false,progress:null,completed:[]};
 try{
  const saved=JSON.parse(localStorage.getItem(storageKey)||'null');
  if(!saved)return empty;
  const progress=saved.progress;
  const valid=progress&&(progress.lesson==='anomaly'||progress.lesson==='observation'||progress.lesson==='plan')&&
    Number.isInteger(progress.index)&&progress.index>=0&&progress.index<lessons[progress.lesson as LessonId].steps.length;
  return {seen:!!saved.seen,progress:valid?progress:null,
   completed:Array.isArray(saved.completed)?saved.completed.filter((id:unknown)=>id==='anomaly'||id==='observation'||id==='plan'):[]};
 }catch{return empty}
}

type Placement={target:HTMLElement|null;host:HTMLElement;top:number;left:number;width:number;measured:boolean;side:'above'|'below'|'fallback'};
function topDialog(){
 return Array.from(document.querySelectorAll<HTMLDialogElement>('dialog[open]'))
  .filter(d=>d.getBoundingClientRect().width>0).at(-1);
}

function GuideCompletion({children,reduced}:{children:ReactNode;reduced:boolean}){
 const [host,setHost]=useState<HTMLElement>(()=>topDialog()||document.body);
 useEffect(()=>{
  const update=()=>setHost(topDialog()||document.body);
  const observer=new MutationObserver(update);
  observer.observe(document.body,{childList:true,subtree:true,attributes:true,attributeFilter:['open']});
  return ()=>observer.disconnect();
 },[]);
 return createPortal(<aside data-guide-reduced={reduced} className={'guide-offer guide-outcome'+(host===document.body?'':' guide-outcome-in-dialog')} aria-label="练习完成">{children}</aside>,host);
}

function visibleTarget(name:string,modal:HTMLElement|undefined){
 const scope=modal||document;
 return Array.from(scope.querySelectorAll<HTMLElement>('[data-guide-target="'+name+'"]')).find(node=>{
  const rect=node.getBoundingClientRect(), css=getComputedStyle(node);
  return rect.width>0&&rect.height>0&&css.visibility!=='hidden'&&css.display!=='none';
 })||null;
}

function GuideStep({step,number,total,lesson,stop,recover,reduced}:{
 step:Step;number:number;total:number;lesson:string;stop:()=>void;recover:()=>void;reduced:boolean
}){
 const title=useId(), note=useId(), card=useRef<HTMLElement>(null);
 const [placement,setPlacement]=useState<Placement|null>(null);
 const priorTarget=useRef<HTMLElement|null>(null);
 useLayoutEffect(()=>{
  let frame=0;
  let lastTarget:HTMLElement|null=null;
  let description:string|null=null;
  const restoreDescription=()=>{
   lastTarget?.removeAttribute('data-guide-spotlight');
   if(description===null)lastTarget?.removeAttribute('aria-describedby');
   else lastTarget?.setAttribute('aria-describedby',description);
  };
  const measure=()=>{
   frame=0;
   const modal=topDialog();
   const host=modal||document.body, target=visibleTarget(step.target,modal);
   if(lastTarget!==target){
    restoreDescription();
    lastTarget=target;
    description=target?.getAttribute('aria-describedby')||null;
    target?.setAttribute('data-guide-spotlight',reduced?'static':'animated');
    target?.setAttribute('aria-describedby',description?description+' '+note:note);
   }
   const view=window.visualViewport;
   const vw=Math.min(document.documentElement.clientWidth,view?.width||Infinity);
   const vh=Math.min(window.innerHeight,view?.height||Infinity);
   const measured=card.current?.parentElement===host;
   const width=Math.min(354,vw-24),height=Math.min(measured?(card.current?.offsetHeight||166):166,vh*.58);
   const rect=target?.getBoundingClientRect();
   let top=vh-height-12,left=vw-width-12,side:Placement['side']='fallback';
   if(rect&&rect.bottom>0&&rect.top<vh){
    const gap=12;
    const above=rect.top-gap, below=vh-rect.bottom-gap;
    if(above>=height||above>=below){side='above';top=Math.max(12,above-height)}
    else{side='below';top=Math.min(vh-height-12,rect.bottom+gap)}
    left=Math.min(vw-width-12,Math.max(12,rect.left+rect.width/2-width/2));
   }
   const next={target,host,top:Math.round(top),left:Math.round(left),width,side,measured};
   setPlacement(p=>p&&p.target===next.target&&p.host===next.host&&p.top===next.top&&p.left===next.left&&p.width===width&&p.side===side&&p.measured===measured?p:next);
   if(target&&priorTarget.current!==target){
    priorTarget.current=target;
    if(rect&&(rect.top<60||rect.bottom>vh-34))target.scrollIntoView({block:'center'});
   }
  };
  const schedule=()=>{if(!frame)frame=requestAnimationFrame(measure)};
  const observer=new MutationObserver(schedule);
  observer.observe(document.body,{childList:true,subtree:true,attributes:true,attributeFilter:['open','hidden','disabled']});
  window.addEventListener('scroll',schedule,true);window.addEventListener('resize',schedule);
  window.visualViewport?.addEventListener('resize',schedule);
  schedule();
  return ()=>{
   cancelAnimationFrame(frame);observer.disconnect();window.removeEventListener('scroll',schedule,true);
   window.removeEventListener('resize',schedule);window.visualViewport?.removeEventListener('resize',schedule);
   restoreDescription();
  };
 },[step,note,reduced]);
 useLayoutEffect(()=>{
  const element=card.current;if(!element)return;
  const ro=new ResizeObserver(()=>window.dispatchEvent(new Event('resize')));
  ro.observe(element);
  return ()=>ro.disconnect();
 },[placement?.host]);
 if(!placement)return null;
 const {target,host,top,left,width,side,measured}=placement;
 return createPortal(<aside ref={card} className="guide-step" aria-labelledby={title} data-guide-side={side} data-guide-reduced={reduced}
  style={{top,left,width,visibility:measured?'visible':'hidden','--guide-remaining':(total-number)/total} as CSSProperties}>
  <div className="guide-step-meta"><span>{lesson}</span><span>第 {number} / {total} 步</span></div>
  <div className="guide-progress" aria-hidden="true"><span/></div>
  <div role="status" aria-live="polite"><h3 id={title}>{step.title}</h3><p id={note}>{step.instruction}</p></div>
  <div className="guide-actions">
   {target?<button type="button" className="guide-jump" onClick={()=>{target.scrollIntoView({block:'center'});target.focus({preventScroll:true})}}><Crosshair aria-hidden="true"/>聚焦这一步</button>:
    <button type="button" className="guide-jump" onClick={recover}>返回可操作的位置</button>}
   <button type="button" className="guide-pause" onClick={stop}>稍后继续</button>
  </div>
 </aside>,host);
}

export function InteractiveGuideProvider({children}:{children:ReactNode}){
 const navigate=useNavigate(), {pathname,search}=useLocation();
 const [stored,setStored]=useState(load),[running,setRunning]=useState<Progress|null>(null);
 const [complete,setComplete]=useState<LessonId|null>(null),[pickerOpen,setPickerOpen]=useState(false);
 const [planning,setPlanning]=useState<PlanningHandoff>();
 const picker=useRef<HTMLDialogElement>(null);
 const current=useRef<Progress|null>(null);
 const lessonPlan=useRef<string|null>(null);
 const location=useRef({pathname,search});location.current={pathname,search};
 const readMotion=()=>{try{return localStorage.getItem('star-nexus:explore-reduced-motion')==='1'}catch{return false}};
 const [lessMotion,setLessMotion]=useState(readMotion);
 useEffect(()=>{
  const sync=()=>setLessMotion(readMotion());
  window.addEventListener('star-nexus:motion-changed',sync);window.addEventListener('storage',sync);
  return ()=>{window.removeEventListener('star-nexus:motion-changed',sync);window.removeEventListener('storage',sync)};
 },[]);
 useEffect(()=>{try{localStorage.setItem(storageKey,JSON.stringify(stored))}catch{/* browsing remains available */}},[stored]);
 function setRun(progress:Progress){
  current.current=progress;setRunning(progress);setStored(s=>({...s,seen:true,progress}));
 }
 const signal=useCallback<GuideContextValue['signal']>((event,detail)=>{
  const active=current.current;if(!active)return;
  const lesson=lessons[active.lesson];
  if(lesson.steps[active.index].event!==event)return;
  if(event==='plan-saved'){
   if(!detail?.planId)return;
   lessonPlan.current=detail.planId;
  }
  if(event==='plan-viewed'&&(!detail?.planId||detail.planId!==lessonPlan.current))return;
  if(event==='comparison')setPlanning(detail?.planning);
  if(active.index+1===lesson.steps.length){
   current.current=null;setRunning(null);setComplete(active.lesson);
   setStored(s=>({...s,seen:true,progress:null,completed:Array.from(new Set([...s.completed,active.lesson]))}));
  }else setRun({...active,index:active.index+1});
 },[]);
 const openGuide=useCallback(()=>{
  setComplete(null);if(!picker.current?.open){picker.current?.showModal();setPickerOpen(true)}
  setStored(s=>s.seen?s:{...s,seen:true});
 },[]);
 const stepTarget=running?lessons[running.lesson].steps[running.index].target:undefined;
 const context=useMemo(()=>({openGuide,signal,stepTarget}),[openGuide,signal,stepTarget]);
 function dismissActive(){current.current=null;setRunning(null)}
 function routeFor(lesson:LessonId,reset=false){
  const path=lesson==='plan'?'/observations':'/explore';
  if(reset||location.current.pathname!==path)navigate(path+(lesson==='plan'?'?sat=25544&min=10':''));
 }
 function start(lesson:LessonId,resume=false,planningHref?:string){
  picker.current?.close();setComplete(null);
  lessonPlan.current=null;
  const saved=resume&&stored.progress?.lesson===lesson?stored.progress:null;
  const canResumeTelemetry=saved&&lessons[lesson].steps[saved.index].path==='/telemetry'&&
   location.current.pathname==='/telemetry'&&new URLSearchParams(location.current.search).has('run');
  const onPlanner=saved&&lesson==='plan'&&location.current.pathname==='/observations';
  const plannerParams=new URLSearchParams(location.current.search);
  const canResumePlan=onPlanner&&plannerParams.has('task')&&saved.index>0;
  const canResumeDraft=onPlanner&&plannerParams.has('draft');
  const index=canResumeTelemetry
   ?(saved.index===3&&!visibleTarget('evidence',undefined)?2:saved.index)
   :canResumePlan?1:0;
  setRun({lesson,index});
  if(planningHref)navigate(planningHref);
  else if(!canResumeTelemetry&&!canResumePlan&&!canResumeDraft)routeFor(lesson,lesson==='plan');
 }
 function recover(){
  if(!running)return;
  const {lesson}=running;
  const onReport=lesson==='anomaly'&&pathname==='/telemetry'&&new URLSearchParams(search).has('run');
  const onPlanResults=lesson==='plan'&&pathname==='/observations'&&new URLSearchParams(search).has('task');
  setRun({lesson,index:onReport?2:onPlanResults?1:0});
  if(!onReport&&!onPlanResults)routeFor(lesson);
 }
 const activeLesson=running?lessons[running.lesson]:null;
 return <GuideContext.Provider value={context}>
  {children}
  {pathname==='/explore'&&!stored.seen&&!running&&<aside className="guide-offer" aria-label="首次使用" data-guide-reduced={lessMotion}>
   <GraduationCap size={23} aria-hidden="true"/>
   <div><strong>第一次来到星巡？</strong><p>跟着页面做一次真实操作。</p>
    <div className="guide-actions"><button type="button" className="guide-jump" onClick={openGuide}>开始新手引导</button>
     <button type="button" className="guide-pause" onClick={()=>setStored(s=>({...s,seen:true}))}>跳过</button></div></div>
  </aside>}
  {running&&activeLesson&&!pickerOpen&&<GuideStep key={running.lesson+running.index} step={activeLesson.steps[running.index]}
   number={running.index+1} total={activeLesson.steps.length} lesson={activeLesson.title} stop={dismissActive} recover={recover} reduced={lessMotion}/>}
  <dialog className="guide-picker" ref={picker} aria-labelledby="guide-picker-title" onClose={()=>setPickerOpen(false)}>
   <header><div><span className="guide-step-meta">星巡 · 动手练习</span><h2 id="guide-picker-title">新手引导</h2></div>
    <button type="button" onClick={()=>picker.current?.close()}>关闭</button></header>
   <p>选择一个任务，跟着高亮提示操作。随时可以停在当前步骤。</p>
   {stored.progress&&<button type="button" className="guide-jump guide-resume" onClick={()=>start(stored.progress!.lesson,true)}>
    继续上次练习 · {lessons[stored.progress.lesson].title}
   </button>}
   <div className="guide-lessons">{(Object.keys(lessons) as LessonId[]).map(id=><section key={id}>
    <h3>{lessons[id].title}</h3><p>{lessons[id].summary}</p>
    <button type="button" onClick={()=>start(id)}>{stored.completed.includes(id)?'重新练习':'开始练习'} <span>{lessons[id].title}</span><ArrowRight aria-hidden="true"/></button>
   </section>)}</div>
  </dialog>
  {complete&&<GuideCompletion reduced={lessMotion}>
   <CheckCircle size={25} aria-hidden="true"/><div><div role="status"><strong>练习完成</strong><p>{lessons[complete].outcome}</p></div>
    <div className="guide-actions">{complete==='observation'&&planning&&<button type="button" className="guide-jump" onClick={()=>start('plan',false,planning.href)}>继续做计划 · {planning.minimum}°</button>}
     <button type="button" className={complete==='observation'&&planning?'guide-pause':'guide-jump'} onClick={openGuide}>选择其他练习</button>
     <button type="button" className="guide-pause" onClick={()=>setComplete(null)}>完成</button></div></div>
  </GuideCompletion>}
 </GuideContext.Provider>;
}

export function GuideEntry({className}:{className?:string}){
 const guide=useInteractiveGuide();
 return guide?<button className={className} type="button" onClick={guide.openGuide} aria-haspopup="dialog">
  新手引导
 </button>:null;
}
