import {TelemetryPage} from './TelemetryPage';
import {SamplingPage} from './SamplingPage';
import { lazy,Suspense,useEffect,useRef,useState,type FormEvent } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter,Link,Navigate,NavLink,Route,Routes,useLocation,useNavigate } from 'react-router-dom';
import { QueryClient,QueryClientProvider,useMutation,useQuery,useQueryClient } from '@tanstack/react-query';
import { motion,MotionConfig,useReducedMotion } from 'motion/react';
import { ArrowRight,SignOut,MagnifyingGlass,Star,Plus,CheckCircle,WarningCircle,CaretDown,GlobeHemisphereEast,ListBullets,Crosshair,X,GearSix,MapPin,Eye,EyeSlash } from '@phosphor-icons/react';
import { AuthProvider,useAuth } from './auth';
import { api,ApiError } from './api';
import {Plans} from './Plans';
import {SystemStatus} from './SystemStatus';
import {NotificationBell,Notifications} from './Notifications';
import {useMobileLayout} from './mobileLayout';
import {DisplaySettings} from './DisplaySettings';
import {Select} from './components/Select';
import {BrandMark,projectName} from './brand';
import './style.css';
const Dashboard=lazy(()=>import('./Dashboard').then(m=>({default:m.Dashboard})));
const Admin=lazy(()=>import('./Admin').then(m=>({default:m.Admin})));
const loadEnvironment=()=>import('./Environment');
const loadObservations=()=>import('./Observations');
const loadExplore=()=>import('./Explore');
const Environment=lazy(()=>loadEnvironment().then(module=>({default:module.Environment})));
const Observations=lazy(()=>loadObservations().then(module=>({default:module.Observations})));
const Explore=lazy(()=>loadExplore().then(module=>({default:module.Explore})));

function warmRoute(load:()=>Promise<unknown>){
 return ()=>{void load().catch(()=>{});};
}
const warmExplore=warmRoute(loadExplore),warmObservations=warmRoute(loadObservations),warmEnvironment=warmRoute(loadEnvironment);

let lastExplorePath='/explore',lastObservationPath='/observations',navigationOwner='';
const queryClient=new QueryClient({defaultOptions:{queries:{retry:false,refetchOnWindowFocus:false}}});
function Brand(){return <Link className="brand" to="/explore"><BrandMark/><div><b>{projectName}</b></div></Link>;}
function Notice({error}:{error:unknown}){if(!error)return null;return <div className="notice error" role="alert"><WarningCircle size={19}/><div>{error instanceof Error?error.message:'操作暂未完成'}{error instanceof ApiError&&error.requestId&&<small>请求编号 {error.requestId}</small>}</div></div>;}

function AccessPage({register=false}:{register?:boolean}){
 const auth=useAuth(),navigate=useNavigate(),reduced=useReducedMotion();
 const [username,setUsername]=useState(''),[password,setPassword]=useState(''),[confirm,setConfirm]=useState(''),[visible,setVisible]=useState(false);
 const [busy,setBusy]=useState<'account'|'guest'|null>(null),[error,setError]=useState<unknown>(null),[created,setCreated]=useState(false);
 if(auth.user)return <Navigate to="/explore" replace/>;
 async function submit(event:FormEvent){event.preventDefault();if(busy)return;setError(null);setBusy('account');
  try{if(register){if(password!==confirm)throw Error('两次输入的密码不一致。');await api('/auth/register',{method:'POST',body:JSON.stringify({username,password})});setCreated(true);setPassword('');setConfirm('');}
   else{await auth.login(username,password);navigate('/explore',{replace:true});}}
  catch(error){setError(error);}finally{setBusy(null);}
 }
 async function enterAsGuest(){
  if(busy)return;
  setError(null);setBusy('guest');
  try{await auth.loginAsGuest();navigate('/explore',{replace:true});}
  catch(error){setError(error);}finally{setBusy(null);}
 }
 return <main className="access-page"><div className="access-image" aria-hidden="true"/><header className="access-header"><Brand/></header>
  <div className="access-story"><h1>全球卫星态势<br/>与观测平台</h1></div>
  <motion.section className="access-card" initial={reduced?false:{opacity:0,y:12}} animate={{opacity:1,y:0}} transition={{duration:.35}}>
   <h2>{register?'创建账号':'欢迎回来'}</h2>
   {created?<><div className="notice success"><CheckCircle size={20}/>账号已创建，请使用新账号登录。</div><div className="access-actions"><Link className="button primary access-action" to="/login">前往登录</Link></div></>:<form onSubmit={submit}>
    <label htmlFor="username">用户名</label><input id="username" autoComplete="username" value={username} onChange={e=>setUsername(e.target.value)} required minLength={3} maxLength={32} pattern="[A-Za-z0-9_]+" placeholder="输入用户名"/>
    <label htmlFor="password">密码</label>
    <div className="password-field">
     <input id="password" type={visible?'text':'password'} autoComplete={register?'new-password':'current-password'} value={password} onChange={e=>setPassword(e.target.value)} required minLength={10} maxLength={128} placeholder={register?'至少 10 个字符':'输入密码'}/>
     <button type="button" onClick={()=>setVisible(value=>!value)} aria-label={visible?'隐藏密码':'显示密码'} aria-controls="password">
      {visible?<EyeSlash size={20} aria-hidden="true"/>:<Eye size={20} aria-hidden="true"/>}
     </button>
    </div>
    {register&&<><label htmlFor="confirm">确认密码</label><input id="confirm" type="password" autoComplete="new-password" value={confirm} onChange={e=>setConfirm(e.target.value)} required minLength={10} maxLength={128}/><small className="field-hint">用户名为 3–32 位字母、数字或下划线。</small></>}
    <Notice error={error}/>
    <div className="access-actions">
     <button className="primary access-action" type="submit" disabled={busy!==null}>{busy==='account'?'正在处理…':register?'创建账号':`进入${projectName}`}</button>
     {!register&&<button className="access-action access-guest" type="button" disabled={busy!==null} onClick={enterAsGuest}>{busy==='guest'?'正在进入…':'游客体验'}</button>}
    </div>
   </form>}
   <div className="access-switch">{register?'已有账号？':'还没有账号？'} <Link to={register?'/login':'/register'}>{register?'立即登录':'创建账号'}</Link></div>
   
  </motion.section>
 </main>;
}

function MainNavigation({admin}:{admin:boolean}){
 const [open,setOpen]=useState(false),nav=useRef<HTMLElement>(null),toggle=useRef<HTMLButtonElement>(null);
 const {pathname}=useLocation();
 useEffect(()=>setOpen(false),[pathname]);
 useEffect(()=>{
  if(!open)return;
  function dismiss(event:PointerEvent){
   if(event.target instanceof Node&&!nav.current?.contains(event.target))setOpen(false);
  }
  document.addEventListener('pointerdown',dismiss);
  return()=>document.removeEventListener('pointerdown',dismiss);
 },[open]);
 return <nav ref={nav} className="main-nav" aria-label="主要导航" onBlur={event=>{
  if(!event.currentTarget.contains(event.relatedTarget))setOpen(false);
 }} onKeyDown={event=>{
  if(event.key==='Escape'&&open){setOpen(false);toggle.current?.focus();}
 }}>
  <NavLink to={lastExplorePath} aria-label="卫星探索" onPointerEnter={warmExplore} onPointerDown={warmExplore} onFocus={warmExplore} onClick={()=>setOpen(false)}><GlobeHemisphereEast size={16} aria-hidden="true"/><span className="desktop-nav-label">卫星探索</span><span className="mobile-nav-label" aria-hidden="true">探索</span></NavLink>
  <NavLink to="/catalog" aria-label="卫星目录" onClick={()=>setOpen(false)}><ListBullets size={16} aria-hidden="true"/><span className="desktop-nav-label">卫星目录</span><span className="mobile-nav-label" aria-hidden="true">目录</span></NavLink>
  <NavLink to={lastObservationPath} aria-label="观测规划" onPointerEnter={warmObservations} onPointerDown={warmObservations} onFocus={warmObservations} onClick={()=>setOpen(false)}><Crosshair size={16} aria-hidden="true"/><span className="desktop-nav-label">观测规划</span><span className="mobile-nav-label" aria-hidden="true">观测</span></NavLink>
  <button ref={toggle} className="mobile-nav-toggle" type="button" aria-expanded={open} aria-controls="secondary-navigation" onClick={()=>setOpen(value=>!value)}>更多<CaretDown size={14} aria-hidden="true"/></button>
  <div id="secondary-navigation" className={`secondary-navigation ${open?'is-open':''}`}>
   <NavLink to="/telemetry" onClick={()=>setOpen(false)}>历史遥测</NavLink><NavLink to="/sampling" onClick={()=>setOpen(false)}>采样管理</NavLink>
   <NavLink to="/environment" onPointerEnter={warmEnvironment} onPointerDown={warmEnvironment} onFocus={warmEnvironment} onClick={()=>setOpen(false)}>空间环境</NavLink>
   <NavLink to="/dashboard" onClick={()=>setOpen(false)}>态势大屏</NavLink>
   <NavLink to="/workspace" onClick={()=>setOpen(false)}>我的空间</NavLink>
   {admin&&<NavLink to="/admin" onClick={()=>setOpen(false)}>系统管理</NavLink>}
  </div>
 </nav>;
}

function Shell(){const mounted=useRef(false),reduced=useReducedMotion();useEffect(()=>{mounted.current=true;},[]);const auth=useAuth(),[error,setError]=useState<unknown>(null);const location=useLocation(),exploring=location.pathname==='/explore',observing=location.pathname==='/observations';if(auth.user&&navigationOwner!==auth.user.id){navigationOwner=auth.user.id;lastExplorePath='/explore';lastObservationPath='/observations';}if(exploring)lastExplorePath=location.pathname+location.search;if(observing)lastObservationPath=location.pathname+location.search;
 if(auth.loading)return <div className="loading-screen">正在恢复会话…</div>;
 if(!auth.user)return <Navigate to="/login" replace/>;
 return <div className={`app-shell ${exploring?'exploration-shell':observing?'observation-shell':''}`}><header className="app-header"><Brand/><MainNavigation admin={auth.user.role==='admin'}/><div className="account"><NotificationBell/><span>{auth.user.isGuest ? '游客' : auth.user.username}</span><NavLink className="button icon-button account-settings" to="/settings" aria-label="设置" title="设置"><GearSix size={20} aria-hidden="true"/></NavLink><button className="icon-button" aria-label="退出登录" onClick={()=>auth.logout().catch(setError)}><SignOut size={21}/></button></div></header><SystemStatus/><Notice error={error}/><motion.div key={location.pathname} className={exploring?'exploration-page':'page-wrap'} initial={!mounted.current||reduced||exploring?false:{opacity:.8,y:observing?0:4}} animate={{opacity:1,y:0}} transition={{duration:.17,ease:[.2,.72,.25,1]}}><Routes><Route path="/explore" element={<Suspense fallback={<div className="loading-screen explore-loading" role="status">正在加载卫星探索…</div>}><Explore/></Suspense>}/><Route path="/observations" element={<Suspense fallback={<div className="loading-screen">正在加载观测规划…</div>}><Observations/></Suspense>}/><Route path="/environment" element={<Suspense fallback={<div className="loading-screen">正在加载空间环境…</div>}><Environment/></Suspense>}/><Route path="/telemetry" element={<TelemetryPage/>}/><Route path="/sampling" element={<SamplingPage/>}/><Route path="/settings" element={<DisplaySettings/>}/><Route path="/notifications" element={<Notifications/>}/><Route path="/catalog" element={<Catalog/>}/><Route path="/workspace" element={<Workspace/>}/><Route path="/admin" element={auth.user.role==='admin'?<Suspense fallback={<div className="loading-screen">正在加载管理中心…</div>}><Admin/></Suspense>:<Navigate to="/explore" replace/>}/><Route path="*" element={<Navigate to="/explore" replace/>}/></Routes></motion.div></div>;
}

function Catalog(){
 const cache=useQueryClient(),[keyword,setKeyword]=useState(''),[search,setSearch]=useState(''),[page,setPage]=useState(1),[group,setGroup]=useState(''),[selected,setSelected]=useState<number|null>(null);
 const data=useQuery({queryKey:['satellites',page,search,group],queryFn:()=>api(`/satellites?page=${page}&size=12&keyword=${encodeURIComponent(search)}${group?'&group='+group:''}`)});
 const groups=useQuery({queryKey:['groups'],queryFn:()=>api('/groups')});
 const favorites=useQuery({queryKey:['favorites'],queryFn:()=>api('/favorites')});
 const details=useQuery({queryKey:['detail',selected],queryFn:()=>api(`/satellites/${selected}`),enabled:selected!==null});
 const change=useMutation({mutationFn:({id,exists}:{id:number;exists:boolean})=>api(exists?`/favorites/${id}`:'/favorites',{method:exists?'DELETE':'POST',body:exists?undefined:JSON.stringify({noradId:id})}),onSuccess:()=>cache.invalidateQueries({queryKey:['favorites']})});
 useEffect(()=>{const id=setTimeout(()=>{setSearch(keyword);setPage(1);},300);return()=>clearTimeout(id);},[keyword]);
 const mobile=useMobileLayout(),detailDialog=useRef<HTMLDialogElement>(null);
 useEffect(()=>{
  if(mobile&&selected!==null)detailDialog.current?.showModal();
 },[mobile,selected]);
 function closeDetails(){
  detailDialog.current?.close();
  setSelected(null);
 }
 const favoriteIds=new Set<number>(favorites.data?.list.map((x:any)=>x.noradId)||[]);
 const quickLink=(id:number)=><Link className="catalog-observe" to={`/observations?sat=${id}`} state={{quickObservation:true}}><Crosshair size={16}/>观测</Link>;
 const satellite=details.data?.data;
 const archive=<><Notice error={details.error}/>{satellite?<><h3>{satellite.name}</h3><div className="detail-grid">
  {mobile&&<><div><span>发射日期</span><b>{satellite.launchDate||'未知'}</b></div><div><span>归属</span><b>{satellite.owner||'未知'}</b></div></>}
  <div><span>轨道历元 UTC</span><b>{satellite.dataQuality.epoch}</b></div><div><span>原始采集时间 UTC</span><b>{satellite.dataQuality.fetchedAt}</b></div>
  <div><span>倾角</span><b>{satellite.orbitElements.INCLINATION}°</b></div><div><span>国际编号</span><b>{satellite.orbitElements.OBJECT_ID||'未知'}</b></div>
 </div></>:<p>正在读取档案…</p>}</>;
 return <><div className="page-heading"><div><h1>卫星目录</h1></div></div>
  <section className="panel catalog-panel"><div className="catalog-toolbar"><div className="search-field"><MagnifyingGlass size={20}/><input aria-label="搜索卫星" placeholder="搜索卫星名称或 NORAD 编号" value={keyword} onChange={e=>setKeyword(e.target.value)}/></div><Select className="catalog-group-select" label="卫星分组" value={group} onChange={value=>{setGroup(value);setPage(1);}} options={[{value:'',label:'全部已导入记录'},...(groups.data?.list||[]).map((row:any)=>({value:row.slug,label:row.name,description:`${row.count.toLocaleString()} 颗`}))]}/></div>
   <Notice error={data.error||change.error}/>{data.isPending?<div className="empty">正在读取目录…</div>:<>{mobile?<ul className="catalog-mobile-list" aria-label="卫星列表">{data.data?.list.map((item:any)=>{
    const followed=favoriteIds.has(item.noradId);
    const quality=item.dataQuality.state;
    const warning=({stale:'根数陈旧',very_stale:'根数严重陈旧',future_epoch:'未来历元'} as Record<string,string>)[quality];
    return <li key={item.noradId}>
     <button type="button" className="catalog-row-name" aria-haspopup="dialog" onClick={()=>setSelected(item.noradId)}><strong>{item.name}</strong><small>NORAD {item.noradId} · {item.owner||'归属未知'}{warning&&<span> · {warning}</span>}</small></button>
     {quickLink(item.noradId)}
     <button className={`favorite-button ${followed?'is-saved':''}`} type="button" disabled={change.isPending} aria-label={`${followed?'取消关注':'关注'} ${item.name}`} onClick={()=>change.mutate({id:item.noradId,exists:followed})}><Star size={18} weight={followed?'fill':'regular'}/></button>
    </li>;
   })}</ul>:<div className="table-scroll"><table><thead><tr><th>卫星名称</th><th>NORAD</th><th>国家 / 组织归属</th><th>根数状态</th><th>操作</th></tr></thead><tbody>{data.data?.list.map((x:any)=><tr key={x.noradId}><td><button className="text-button satellite-name" onClick={()=>setSelected(x.noradId)}>{x.name}</button><small>{x.launchDate||'发射日期未知'}</small></td><td className="mono">{x.noradId}</td><td>{x.owner||'未知'}</td><td><span className={`quality ${x.dataQuality.state}`}>{({available:'可用',stale:'陈旧',very_stale:'严重陈旧',future_epoch:'未来历元'} as any)[x.dataQuality.state]}</span></td><td><button className="favorite-button" disabled={change.isPending} aria-label={`${favoriteIds.has(x.noradId)?'取消关注':'关注'} ${x.name}`} onClick={()=>change.mutate({id:x.noradId,exists:favoriteIds.has(x.noradId)})}><Star size={20} weight={favoriteIds.has(x.noradId)?'fill':'regular'}/></button></td></tr>)}</tbody></table></div>}{data.data?.total===0&&<div className="empty">没有找到匹配的卫星，试试其他名称或编号。</div>}<div className="pagination"><span>{data.data?.total?.toLocaleString()??'—'} 颗</span><button disabled={page===1} onClick={()=>setPage(page-1)}>上一页</button><span>{page} / {Math.max(1,Math.ceil((data.data?.total||0)/12))}</span><button disabled={page*12>=(data.data?.total||0)} onClick={()=>setPage(page+1)}>下一页</button></div></>}
  </section>
  {selected!==null&&(mobile?<dialog className="catalog-archive" ref={detailDialog} aria-labelledby="catalog-archive-title" onCancel={event=>{event.preventDefault();closeDetails();}} onClick={event=>{if(event.target===event.currentTarget)closeDetails();}}><section>
   <header className="section-heading"><h2 id="catalog-archive-title">卫星档案</h2><button type="button" aria-label="关闭档案" onClick={closeDetails}><X size={20}/></button></header>{archive}{quickLink(selected)}
  </section></dialog>:<section className="panel detail-inline" tabIndex={-1}><div className="section-heading"><h2>卫星档案</h2><button onClick={closeDetails}>收起</button></div>{archive}</section>)}

 </>;
}

function Workspace(){
 const cache=useQueryClient(),[name,setName]=useState(''),[lat,setLat]=useState('39.9'),[lng,setLng]=useState('116.4');
 const favorites=useQuery({queryKey:['favorites'],queryFn:()=>api('/favorites')});
 const stations=useQuery({queryKey:['stations'],queryFn:()=>api('/stations')});
 const create=useMutation({mutationFn:()=>api('/stations',{method:'POST',body:JSON.stringify({name,latitude:Number(lat),longitude:Number(lng),elevation_m:0})}),onSuccess:()=>{setName('');cache.invalidateQueries({queryKey:['stations']});}});
 return <main className="workspace-page">
  <header className="page-heading"><h1>我的空间</h1></header>
  <Plans/>
  <div className="personal-grid">
   <section className="panel" aria-labelledby="workspace-favorites">
    <header className="section-heading">
     <h2 id="workspace-favorites">我的关注 {favorites.data?.total>0 && <span className="count">{favorites.data.total}</span>}</h2>
    </header>
    <Notice error={favorites.error}/>
    {favorites.isPending && <p role="status">正在读取关注…</p>}
    {favorites.data?.list.map((sat:{noradId:number;name:string})=><div className="workspace-row" key={sat.noradId}>
     <Link className="workspace-object" to={`/explore?sat=${sat.noradId}`}><Star className="workspace-star" size={17} weight="fill" aria-hidden="true"/><strong>{sat.name}</strong></Link>
     <Link className="button" to={`/observations?sat=${sat.noradId}`}>观测</Link>
    </div>)}
    {favorites.data?.total===0 && <div className="utility-empty">
     <Star size={22} aria-hidden="true"/><p>暂无关注的卫星</p>
     <Link className="button" to="/catalog">浏览目录 <ArrowRight size={15} aria-hidden="true"/></Link>
    </div>}
   </section>
   <section className="panel" aria-labelledby="workspace-stations">
    <header className="section-heading">
     <h2 id="workspace-stations">观测站 {stations.data?.total>0 && <span className="count">{stations.data.total}</span>}</h2>
     <Link className="button" to="/observations">管理观测站</Link>
    </header>
    <Notice error={stations.error}/>
    {stations.isPending && <p role="status">正在读取观测站…</p>}
    {stations.data?.total===0 && <p>暂无观测站</p>}
    {stations.data?.list.map((station:{id:string;name:string;latitude:number;longitude:number})=><div className="workspace-row" key={station.id}>
     <div className="workspace-object"><MapPin size={17} aria-hidden="true"/><strong>{station.name}</strong></div>
     <span className="workspace-coordinate">{station.latitude.toFixed(3)}°, {station.longitude.toFixed(3)}°</span>
    </div>)}
    <details className="workspace-station-entry">
     <summary><Plus size={16} aria-hidden="true"/>添加观测站</summary>
     <form className="station-form" onSubmit={e=>{e.preventDefault();create.mutate();}}>
      <label htmlFor="station-name">观测站名称</label><input id="station-name" value={name} onChange={e=>setName(e.target.value)} required maxLength={80} placeholder="例如：北京观测站"/>
      <div className="coordinate-fields">
       <div><label htmlFor="latitude">纬度 °</label><input id="latitude" type="number" min={-90} max={90} step="any" required value={lat} onChange={e=>setLat(e.target.value)}/></div>
       <div><label htmlFor="longitude">经度 °</label><input id="longitude" type="number" min={-180} max={180} step="any" required value={lng} onChange={e=>setLng(e.target.value)}/></div>
      </div>
      <Notice error={create.error}/><button className="primary" disabled={create.isPending}>{create.isPending?'保存中…':'保存观测站'}</button>
     </form>
    </details>
   </section>
  </div>
 </main>;
}

function App(){const auth=useAuth();if(auth.loading)return <div className="loading-screen"><BrandMark size={40}/><span>正在连接{projectName}…</span></div>;return <Routes><Route path="/login" element={<AccessPage/>}/><Route path="/register" element={<AccessPage key="register" register/>}/><Route path="/dashboard" element={auth.user?<Suspense fallback={<div className="loading-screen">正在加载态势大屏…</div>}><Dashboard/></Suspense>:<Navigate to="/login" replace/>}/><Route path="/*" element={<Shell/>}/></Routes>;}
createRoot(document.getElementById('root')!).render(<QueryClientProvider client={queryClient}><BrowserRouter><AuthProvider><MotionConfig reducedMotion="user"><App/></MotionConfig></AuthProvider></BrowserRouter></QueryClientProvider>);
