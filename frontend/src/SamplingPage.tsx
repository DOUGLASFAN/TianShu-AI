import {useLayoutEffect, useRef, useState, type FormEvent} from 'react';
import {useMutation, useQuery, useQueryClient} from '@tanstack/react-query';
import {Link, useNavigate} from 'react-router-dom';
import {ArrowRight, Path, Plus, X} from '@phosphor-icons/react';
import {api, ApiError} from './api';
import {SamplingTargetPicker} from './SamplingTargetPicker';
import './sampling.css';

type Configuration = {
  name: string; mode: 'relative' | 'fixed'; start: string | null; end: string | null;
  offsetMinutes: number; durationMinutes: number; stepSeconds: number; noradIds: number[];
};
type Profile = Configuration & {id: string; updatedAt: string};
type SatelliteTarget = {noradId:number;name:string};
type Preview = {
  start: string; end: string; stepSeconds: number;
  satellites: {noradId: number; name: string; sampleCount: number; dataQuality: {epoch: string; state: string; source: string}}[];
  failed: {noradId: number; code: string}[];
};
const shanghai = (value: string) => new Date(value).toLocaleString('zh-CN', {timeZone: 'Asia/Shanghai', hour12: false});
const inputTime = (value: string) => new Date(Date.parse(value) + 8 * 3600000).toISOString().slice(0,16);
const errorMessage = (error: unknown) => error instanceof ApiError
  ? error.fields?.map(field=>field.message).filter(Boolean).join('；') || error.message
  : String(error);
function defaultConfig(): Configuration {
  const start = Math.floor(Date.now() / 60000) * 60000;
  return {name:'未来两小时', mode:'relative', start:inputTime(new Date(start).toISOString()),
    end:inputTime(new Date(start + 7200000).toISOString()), offsetMinutes:0, durationMinutes:120, stepSeconds:30, noradIds:[25544]};
}

export function SamplingPage() {
  const client = useQueryClient(), navigate = useNavigate();
  const editor = useRef<HTMLDialogElement>(null);
  const editorFeedback = useRef<HTMLDivElement>(null);
  const [editorOpen, setEditorOpen] = useState(false);
  const [config, setConfig] = useState(defaultConfig);
  const [editing, setEditing] = useState<string | null>(null);
  const [pickingTargets, setPickingTargets] = useState(false);
  const [notice, setNotice] = useState('');
  const [problem, setProblem] = useState('');
  const [preview, setPreview] = useState<Preview>();
  const profiles = useQuery({queryKey:['sampling-profiles'], queryFn:()=>api<{data:Profile[]}>('/sampling/profiles')});
  const selectedNames = useQuery({
    queryKey:['sampling-target-names',...config.noradIds],
    queryFn:({signal})=>api<{list:SatelliteTarget[]}>(`/sampling/targets?${config.noradIds.map(id=>'ids='+id).join('&')}`,{signal}),
    enabled:editorOpen && config.noradIds.length>0,staleTime:300000,placeholderData:previous=>previous,
  });
  useLayoutEffect(() => {
    if (!editorOpen) return;
    const dialog = editor.current;
    const trigger = document.activeElement;
    dialog?.showModal();
    return () => {
      dialog?.close();
      if (trigger instanceof HTMLElement && trigger.isConnected) trigger.focus({preventScroll:true});
    };
  }, [editorOpen]);
  function payload(): Configuration {
    return {...config, start:config.mode==='fixed' && config.start ? config.start + '+08:00' : null,
      end:config.mode==='fixed' && config.end ? config.end + '+08:00' : null,
      offsetMinutes:config.mode==='fixed'?0:config.offsetMinutes,
      durationMinutes:config.mode==='fixed'?120:config.durationMinutes};
  }
  function change<K extends keyof Configuration>(key: K, value: Configuration[K]) {
    setConfig(previous=>({...previous,[key]:value}));
    setPreview(undefined);
    setProblem('');
  }
  function edit(profile?: Profile) {
    if (profile) {
      const {id, updatedAt: _updatedAt, ...input} = profile;
      const defaults = defaultConfig();
      setEditing(id);
      setConfig({...input, start:input.start ? inputTime(input.start) : defaults.start, end:input.end ? inputTime(input.end) : defaults.end});
    } else {
      setEditing(null);
      setConfig(defaultConfig());
    }
    setPreview(undefined);
    setNotice('');
    setProblem('');
    runPreview.reset();
    save.reset();
    setEditorOpen(true);
  }
  const runPreview = useMutation({
    mutationFn:()=>api<Preview>('/sampling/preview',{method:'POST',body:JSON.stringify(payload())}),
    onSuccess:data=>setPreview(data),
  });
  const save = useMutation({
    mutationFn:()=>api<{data:Profile}>(editing ? '/sampling/profiles/'+editing : '/sampling/profiles',
      {method:editing?'PUT':'POST',body:JSON.stringify(payload())}),
    onSuccess:({data})=>{
      setNotice('方案已保存');
      setEditorOpen(false);
      client.removeQueries({queryKey:['explore-scene',data.id]});
      void client.invalidateQueries({queryKey:['sampling-profiles']});
    },
  });
  const remove = useMutation({
    mutationFn:(id:string)=>api('/sampling/profiles/'+id,{method:'DELETE'}),
    onSuccess:(_,id)=>{
      setNotice('方案已删除');
      client.removeQueries({queryKey:['explore-scene',id]});
      void client.invalidateQueries({queryKey:['sampling-profiles']});
    },
  });
  const download = useMutation({
    mutationFn:async (profile: Profile)=>{
      const scene = await api(`/sampling/profiles/${profile.id}/scene`);
      const url = URL.createObjectURL(new Blob([JSON.stringify(scene,null,2)],{type:'application/json'}));
      const link = document.createElement('a');
      link.href=url;
      link.download=`sampling-${profile.id}.json`;
      link.click();
      setTimeout(()=>URL.revokeObjectURL(url),1000);
    },
  });
  const error = problem || [runPreview.error,save.error].filter(Boolean).map(errorMessage).join('；');
  const libraryError = [remove.error,download.error,profiles.error].filter(Boolean).map(errorMessage).join('；');
  useLayoutEffect(() => {
    if (error || preview) editorFeedback.current?.scrollIntoView({block:'start'});
  }, [error, preview]);
  const duration = config.mode==='relative' ? config.durationMinutes :
    config.start && config.end ? (Date.parse(config.end+'+08:00')-Date.parse(config.start+'+08:00'))/60000 : 0;
  const estimate = duration > 0 ? (Math.floor(duration*60/config.stepSeconds)+1)*config.noradIds.length : 0;
  const busy = runPreview.isPending || save.isPending || remove.isPending || download.isPending;
  const names = new Map(selectedNames.data?.list.map(item=>[item.noradId,item.name]));
  const libraryEmpty = profiles.data?.data.length === 0;
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setProblem('');
    const action = (event.nativeEvent as SubmitEvent).submitter?.getAttribute('value');
    if(!config.noradIds.length) {setProblem('请添加至少一颗卫星。');return;}
    if(!Number.isInteger(duration)||duration<1||duration>1440) {setProblem('结束时间须比开始时间晚 1 分钟至 24 小时。');return;}
    if(duration*60%config.stepSeconds) {setProblem('时长须能被采样间隔整除。');return;}
    if(estimate>12000) {setProblem('预计超过 12,000 点，请增大间隔或减少卫星。');return;}
    if(action==='preview') { save.reset();runPreview.mutate();return; }
    runPreview.reset();
    save.mutate(undefined,{onSuccess:({data})=>{if(action==='open')navigate('/explore?sampling='+data.id+'&sat='+data.noradIds[0]);}});
  }
  return <main className="sampling-page">
    <header className="sampling-heading page-heading">
      <h1>采样管理</h1>
    </header>
    <section className="panel sampling-library" aria-label="我的方案">
      <header>
        {libraryEmpty ? <div className="utility-empty sampling-empty">
          <Path size={22} aria-hidden="true"/>
          <div><h2>暂无采样方案</h2><p>保存一组卫星和采样条件，随时加载回放。</p></div>
        </div> : <h2>我的方案 {profiles.data && <span>{profiles.data.data.length}</span>}</h2>}
        <button className="primary" type="button" disabled={busy} aria-haspopup="dialog" onClick={()=>edit()}><Plus size={16} aria-hidden="true"/> 新建方案</button>
      </header>
      <div className="sampling-saved-profiles">
        {profiles.isPending && <p>正在读取方案…</p>}
        {profiles.data?.data.map(profile=><article key={profile.id}>
          <div className="sampling-profile">
            <strong>{profile.name}</strong><span>{profile.mode==='relative'?'相对当前时间':'固定区间'} · {profile.noradIds.length} 颗 · {profile.stepSeconds} 秒</span>
          </div>
          <div className="sampling-list-actions">
            <button type="button" disabled={busy} aria-haspopup="dialog" aria-label={`编辑 ${profile.name}`} onClick={()=>edit(profile)}>编辑</button>
            <Link to={`/explore?sampling=${profile.id}&sat=${profile.noradIds[0]}`}>加载到探索页</Link>
            <button type="button" disabled={busy} onClick={()=>download.mutate(profile)}>导出 JSON</button>
            <button type="button" disabled={busy} onClick={()=>{if(window.confirm(`删除采样方案「${profile.name}」？`))remove.mutate(profile.id);}}>删除</button>
          </div>
        </article>)}
      </div>
      {libraryError && <p role="alert" className="sampling-error">{libraryError}</p>}
      {notice && <p role="status">{notice}</p>}
    </section>
    <dialog ref={editor} className="sampling-editor" aria-labelledby="sampling-editor-title"
      onCancel={event=>{event.preventDefault();if(!busy)setEditorOpen(false);}}>
      {editorOpen && <form onSubmit={submit}>
        <header className="sampling-editor-heading">
          <h2 id="sampling-editor-title">{editing?'编辑方案':'新建方案'}</h2>
          <button type="button" className="sampling-close" aria-label="关闭方案窗口" disabled={busy}
            onClick={()=>setEditorOpen(false)}><X size={20}/></button>
        </header>
        <div className="sampling-editor-body">
          <fieldset disabled={busy} className="sampling-conditions">
            <div className="sampling-fields">
              <label>方案名称<input required maxLength={60} value={config.name} onChange={e=>change('name',e.target.value)}/></label>
              <label>时间模式<select value={config.mode} onChange={e=>change('mode',e.target.value as Configuration['mode'])}>
                <option value="relative">相对当前时间</option><option value="fixed">固定区间</option>
              </select></label>
            </div>
            <div className="sampling-fields sampling-window">
              {config.mode==='relative'?<>
                <label>起点偏移（分钟）<input type="number" required min={-1440} max={1440} value={Number.isNaN(config.offsetMinutes)?'':config.offsetMinutes} onChange={e=>change('offsetMinutes',e.target.valueAsNumber)}/></label>
                <label>采样时长（分钟）<input type="number" required min={1} max={1440} value={Number.isNaN(config.durationMinutes)?'':config.durationMinutes} onChange={e=>change('durationMinutes',e.target.valueAsNumber)}/></label>
              </>:<>
                <label>开始时间（北京时间）<input type="datetime-local" required value={config.start??''} onChange={e=>change('start',e.target.value)}/></label>
                <label>结束时间（北京时间）<input type="datetime-local" required value={config.end??''} onChange={e=>change('end',e.target.value)}/></label>
              </>}
              <label>采样间隔<select value={config.stepSeconds} onChange={e=>change('stepSeconds',Number(e.target.value))}>
                {[10,20,30,60,120,300].map(step=><option key={step} value={step}>每 {step} 秒</option>)}
              </select></label>
            </div>
            <section className="sampling-selected" aria-labelledby="sampling-selected-title">
              <header>
                <div><h3 id="sampling-selected-title">采样卫星</h3><span aria-live="polite">{config.noradIds.length} / 12 颗</span></div>
                <button type="button" aria-haspopup="dialog" onClick={()=>setPickingTargets(true)}><Plus size={16}/> 选择卫星</button>
              </header>
              {config.noradIds.length===0 && <p>请至少选择一颗卫星。</p>}
              <div className="sampling-targets">{config.noradIds.map(id=><button type="button" key={id}
                title={`NORAD ${id}`}
                aria-label={`移除卫星 ${id}${names.has(id)?' '+names.get(id):''}`}
                onClick={()=>change('noradIds',config.noradIds.filter(target=>target!==id))}>
                <span>{id===25544?'国际空间站（ISS）':names.get(id) || `NORAD ${id}`}</span><X size={14} aria-hidden="true"/>
              </button>)}</div>
            </section>
          </fieldset>
          <div className="sampling-estimate">
            <span>预计 <strong>{estimate.toLocaleString()}</strong> 点</span>
            <details className="sampling-limits"><summary>采样限制</summary>
              <p>每次最多 12 颗、24 小时、12,000 点。时间区间须在当前时刻前后 7 天内。固定方案加载时会用目录中当前的轨道根数重新推算。</p>
            </details>
          </div>
          <div ref={editorFeedback}>
            {error && <p role="alert" className="sampling-error">{error}</p>}
            {preview && <section className="sampling-preview" aria-label="试算结果">
              <h3>试算结果</h3><p>{shanghai(preview.start)} — {shanghai(preview.end)}（北京时间）</p>
              {preview.satellites.map(sat=><div className="sampling-track" key={sat.noradId}>
                <strong>{sat.name}</strong><span>{sat.sampleCount} 点 · {sat.dataQuality.state==='available'?'根数可用':'请核对根数时效'}</span>
                <small>根数历元 {shanghai(sat.dataQuality.epoch)} · {sat.dataQuality.source}</small></div>)}
              {preview.failed.map(sat=><p key={sat.noradId}>#{sat.noradId} {sat.code==='SATELLITE_NOT_FOUND'?'目录中找不到该卫星':'该区间推算失败'}</p>)}
            </section>}
          </div>
        </div>
        <footer className="sampling-form-actions">
          <button value="preview" disabled={busy}>{runPreview.isPending?'正在试算…':'试算'}</button>
          <button value="open" disabled={busy}>保存并加载 <ArrowRight size={16}/></button>
          <button className="primary" value="save" disabled={busy}>保存方案</button>
        </footer>
      </form>}
    </dialog>
    {pickingTargets && <SamplingTargetPicker initialIds={config.noradIds} initialNames={names}
      onClose={()=>setPickingTargets(false)} onApply={ids=>{
        change('noradIds',ids);
        setPickingTargets(false);
      }}/>}
  </main>;
}
