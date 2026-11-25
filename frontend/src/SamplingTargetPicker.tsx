import {useEffect, useRef, useState} from 'react';
import {useQuery} from '@tanstack/react-query';
import {Check, MagnifyingGlass, X} from '@phosphor-icons/react';
import {api} from './api';

type Target = {noradId: number; name: string};
type Preset = {slug: string; name: string; category: string};
type TargetPage = {list: Target[]; total: number; page: number; pages: number};

export function SamplingTargetPicker({initialIds, initialNames, onClose, onApply}: {
  initialIds: number[];
  initialNames: Map<number, string>;
  onClose: () => void;
  onApply: (ids: number[]) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const searchBox = useRef<HTMLInputElement>(null);
  const results = useRef<HTMLDivElement>(null);
  const [draft, setDraft] = useState(() => new Map(initialIds.map(id => [id, initialNames.get(id) ?? ''])));
  const [keyword, setKeyword] = useState('');
  const [group, setGroup] = useState('beidou');
  const [page, setPage] = useState(1);
  const term = keyword.trim();
  const searching = term.length > 0;
  const selectedOnly = group === 'selected' && !searching;

  useEffect(() => {
    const element = dialog.current;
    const trigger = document.activeElement;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    element?.showModal();
    if (window.matchMedia('(min-width: 611px)').matches) searchBox.current?.focus();
    return () => {
      element?.close();
      document.body.style.overflow = previousOverflow;
      if (trigger instanceof HTMLElement && trigger.isConnected) trigger.focus();
    };
  }, []);

  useEffect(() => {results.current?.scrollTo(0, 0);}, [group, page, term]);

  const presets = useQuery({
    queryKey: ['sampling-presets'],
    queryFn: ({signal}) => api<{list: Preset[]}>('/sampling/presets', {signal}),
    staleTime: 300000,
  });
  const members = useQuery({
    queryKey: ['sampling-preset-members', group, page],
    queryFn: ({signal}) => api<TargetPage>(`/sampling/presets?${new URLSearchParams({group, page: String(page)})}`, {signal}),
    enabled: !searching && !selectedOnly,
    staleTime: 300000,
  });
  const search = useQuery({
    queryKey: ['sampling-picker-search', term, page],
    queryFn: ({signal}) => api<{list: Target[]; total: number}>(`/satellites?${new URLSearchParams({size: '12', page: String(page), keyword: term})}`, {signal}),
    enabled: term.length >= 2,
  });
  const listing = searching ? search : members;
  const rows = selectedOnly ? Array.from(draft, ([noradId, name]) => ({noradId, name})) : listing.data?.list ?? [];
  const total = selectedOnly ? draft.size : listing.data?.total ?? 0;
  const currentGroup = presets.data?.list.find(item => item.slug === group);
  const categories = new Set(presets.data?.list.map(item => item.category));
  const currentPage = searching ? page : members.data?.page ?? page;
  const pages = searching ? Math.max(1, Math.ceil(total / 12)) : members.data?.pages ?? 1;

  function browse(slug: string) {
    setGroup(slug);
    setPage(1);
    setKeyword('');
  }

  function toggle(target: Target) {
    setDraft(previous => {
      const next = new Map(previous);
      if (next.has(target.noradId)) next.delete(target.noradId);
      else if (next.size < 12) next.set(target.noradId, target.name);
      return next;
    });
  }

  return <dialog className="sampling-picker" ref={dialog} aria-labelledby="sampling-picker-title"
    onCancel={event => {event.preventDefault(); onClose();}}>
    <div className="sampling-picker-layout">
      <header className="sampling-picker-heading">
        <h2 id="sampling-picker-title">选择卫星</h2>
        <button type="button" className="sampling-close" aria-label="关闭选择卫星窗口" onClick={onClose}><X size={20}/></button>
      </header>
      <div className="sampling-picker-main">
        <nav className="sampling-picker-groups" aria-label="预设卫星组">
          <button type="button" aria-pressed={selectedOnly} onClick={() => browse('selected')}>已选卫星 <span>{draft.size}</span></button>
          {[...categories].map(category => <div key={category} className="sampling-picker-category">
            <h3>{category}</h3>
            {presets.data?.list.filter(item => item.category === category).map(item =>
              <button type="button" key={item.slug} aria-pressed={!searching && group === item.slug} onClick={() => browse(item.slug)}>{item.name}</button>)}
          </div>)}
        </nav>
        <section className="sampling-picker-results" aria-labelledby="sampling-result-title">
          <div className="sampling-filter-mobile">
            <label>按组浏览<select value={group} onChange={event => browse(event.target.value)}>
              <option value="selected">已选卫星（{draft.size}）</option>
              {presets.isPending && <option value="beidou">北斗（中国）</option>}
              {[...categories].map(category => <optgroup label={category} key={category}>
                {presets.data?.list.filter(item => item.category === category).map(item => <option value={item.slug} key={item.slug}>{item.name}</option>)}
              </optgroup>)}
            </select></label>
          </div>
          <label className="sampling-picker-search">
            <MagnifyingGlass size={18} aria-hidden="true"/>
            <input ref={searchBox} type="search" aria-label="搜索全部卫星" placeholder="搜索名称或 NORAD 编号" maxLength={64}
              value={keyword} onChange={event => {setKeyword(event.target.value); setPage(1);}}/>
          </label>
          {presets.isError && <p role="alert">分组加载失败。 <button type="button" onClick={() => void presets.refetch()}>重试</button></p>}
          <div className="sampling-results-heading">
            <h3 id="sampling-result-title">{searching ? '搜索结果' : selectedOnly ? '已选卫星' : currentGroup?.name ?? '组内卫星'}</h3>
            {total > 0 && <span>{total.toLocaleString()} 颗</span>}
          </div>
          <div ref={results} className="sampling-picker-rows" role="group" aria-label="卫星列表">
            {searching && term.length < 2 ? <p>输入至少两个字符。</p> : !selectedOnly && listing.isPending ?
              <p role="status">正在读取卫星…</p> : !selectedOnly && listing.isError ?
              <p role="alert">卫星加载失败。 <button type="button" onClick={() => void listing.refetch()}>重试</button></p> :
              rows.length===0 ? <p>{selectedOnly ? '还没有选择卫星。' : '没有找到卫星。'}</p> :
              rows.map(target => <button type="button" className="sampling-target-row" key={target.noradId}
                aria-pressed={draft.has(target.noradId)} disabled={!draft.has(target.noradId) && draft.size >= 12} onClick={() => toggle(target)}>
                <span className="sampling-target-check" aria-hidden="true">{draft.has(target.noradId) && <Check size={13}/>}</span>
                <span>{target.name || `NORAD ${target.noradId}`}</span><small>#{target.noradId}</small>
              </button>)}
          </div>
          <div className="sampling-picker-batch">
            {!searching && !selectedOnly && rows.length > 0 && <button type="button"
              onClick={() => setDraft(new Map(rows.map(item => [item.noradId, item.name])))}>用本批替换已选</button>}
            {!selectedOnly && pages > 1 && <div className="sampling-picker-pagination">
              <button type="button" disabled={currentPage<=1} aria-label="上一批卫星" onClick={() => setPage(currentPage-1)}>上一批</button>
              <span>{currentPage} / {pages}</span>
              <button type="button" disabled={currentPage>=pages} aria-label="下一批卫星" onClick={() => setPage(currentPage+1)}>下一批</button>
            </div>}
          </div>
        </section>
      </div>
      <footer className="sampling-picker-footer">
        <span aria-live="polite">已选 <strong>{draft.size}</strong> / 12 颗</span>
        <button type="button" onClick={onClose}>取消</button>
        <button type="button" className="primary" onClick={() => onApply([...draft.keys()])}>应用选择</button>
      </footer>
    </div>
  </dialog>;
}
