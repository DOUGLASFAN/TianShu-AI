import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './style.css';
import './layout.css';

const C = window.Cesium;
window.phase1Diagnostics = { activeViewers: 0, created: 0, destroyed: 0, frames: 0, errors: [], sampleCount: 0, selected: null };

function App() {
  const target = useRef(null), engine = useRef(null), lookup = useRef(new Map());
  const [scene, setScene] = useState(null), [error, setError] = useState(''), [ready, setReady] = useState(false);
  const [selected, setSelected] = useState(25544), [position, setPosition] = useState(null);
  const [rebuild, setRebuild] = useState(0), [playing, setPlaying] = useState(true), [tracking, setTracking] = useState(false);
  const [timeLabel, setTimeLabel] = useState(''), [renderHz, setRenderHz] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    fetch('/api/phase1/scene', { signal: controller.signal }).then(r => { if (!r.ok) throw Error('后端采样请求失败'); return r.json(); })
      .then(setScene).catch(e => { if (e.name !== 'AbortError') setError(e.message); });
    return () => controller.abort();
  }, []);
  useEffect(() => {
    if (!scene) return;
    let cancelled = false, v, removeRender, interval;
    setReady(false); setTracking(false);
    (async () => {
      const provider = await C.TileMapServiceImageryProvider.fromUrl('/cesium/Assets/Textures/NaturalEarthII', { maximumLevel: 2 });
      if (cancelled) return;
      v = new C.Viewer(target.current, { baseLayer: new C.ImageryLayer(provider), terrainProvider: new C.EllipsoidTerrainProvider(),
        animation: false, timeline: false, baseLayerPicker: false, geocoder: false, homeButton: false, sceneModePicker: false,
        navigationHelpButton: false, fullscreenButton: false, selectionIndicator: false, infoBox: false, shouldAnimate: true,
        skyBox: false, contextOptions: { webgl: { preserveDrawingBuffer: true } } });
      engine.current = v;
      const d = window.phase1Diagnostics; d.activeViewers++; d.created++; d.webgl = !!v.scene.context;
      v.scene.globe.enableLighting = true;
      v.scene.backgroundColor = C.Color.fromCssColorString('#050b14');
      v.clock.startTime = C.JulianDate.fromIso8601(scene.start);
      v.clock.stopTime = C.JulianDate.fromIso8601(scene.end);
      v.clock.currentTime = v.clock.startTime.clone(); v.clock.multiplier = 20; v.clock.clockRange = C.ClockRange.LOOP_STOP;
      lookup.current.clear();
      for (const sat of scene.satellites) {
        const property = new C.SampledPositionProperty(C.ReferenceFrame.FIXED);
        property.setInterpolationOptions({ interpolationDegree: 1, interpolationAlgorithm: C.LinearApproximation });
        for (const point of sat.samples) property.addSample(C.JulianDate.fromIso8601(point.time), C.Cartesian3.fromArray(point.ecef_m));
        const e = v.entities.add({ id: String(sat.noradId), name: sat.name, position: property,
          point: { pixelSize: sat.noradId === 25544 ? 9 : 5, color: C.Color.fromCssColorString(sat.noradId === 25544 ? '#ffc56b' : '#78b8e8'),
            outlineColor: C.Color.BLACK, outlineWidth: 1 },
          label: { text: sat.name, show: sat.noradId === 25544, font: '14px sans-serif', pixelOffset: new C.Cartesian2(12, -18),
            fillColor: C.Color.WHITE, showBackground: true },
          path: { show: sat.noradId === 25544, leadTime: 2400, trailTime: 2400, resolution: 20,
            material: C.Color.fromCssColorString('#ffc56b'), width: 2 } });
        lookup.current.set(sat.noradId, e);
      }
      d.sampleCount = scene.satellites.reduce((n,s) => n+s.samples.length,0); d.entityCount = v.entities.values.length;
      v.camera.setView({ destination: C.Cartesian3.fromDegrees(110, 30, 13000000) });
      removeRender = v.scene.postRender.addEventListener(() => d.frames++);
      let previousFrames = d.frames;
      interval = setInterval(() => {
        setTimeLabel(C.JulianDate.toIso8601(v.clock.currentTime, 0));
        setRenderHz(d.frames - previousFrames); previousFrames = d.frames;
        const p = lookup.current.get(d.selected ?? 25544)?.position.getValue(v.clock.currentTime);
        if (p) { const geo = C.Cartographic.fromCartesian(p); setPosition({ lat: C.Math.toDegrees(geo.latitude), lng: C.Math.toDegrees(geo.longitude), alt: geo.height / 1000 }); }
      },1000);
      d.selected = 25544; setReady(true);
    })().catch(e => { if (!cancelled) { setError(e.message); window.phase1Diagnostics.errors.push(e.message); } });
    return () => {
      cancelled = true; clearInterval(interval); removeRender?.(); lookup.current.clear();
      if (v && !v.isDestroyed()) { v.destroy(); window.phase1Diagnostics.activeViewers--; window.phase1Diagnostics.destroyed++; }
      engine.current = null;
    };
  }, [scene, rebuild]);
  useEffect(() => {
    if (!ready || !engine.current) return;
    window.phase1Diagnostics.selected = selected;
    const v = engine.current; v.trackedEntity = undefined; setTracking(false);
    for (const [id,e] of lookup.current) { e.label.show = id === selected; e.path.show = id === selected; e.point.pixelSize = id === selected ? 9 : 5; }
    v.selectedEntity = lookup.current.get(selected);
  }, [selected, ready]);
  const chosen = scene?.satellites.find(s => s.noradId === selected);
  return <main>
    <header><div className="brand">星枢 <span>STAR NEXUS</span></div><div>轨道与地球 · 可行性验证</div><small>阶段 1 · 非正式业务平台</small></header>
    <section className="workspace">
      <aside><span className="eyebrow">PUBLIC ORBIT CATALOG</span><h1>卫星探索</h1><p>公开根数 · 固定样本推演</p>
        <div className="catalog">{scene?.satellites.slice(0,3).map(s => <button key={s.noradId} className={selected===s.noradId?'selected':''} onClick={()=>setSelected(s.noradId)}><strong>{s.name}</strong><span>NORAD {s.noradId}</span></button>)}</div>
        <div className="note"><b>验证范围</b><p>后端 SGP4 采样<br/>ECEF 坐标与前端插值<br/>本地地球贴图<br/>相机定位、跟踪与销毁</p></div>
        <p className="muted">{scene?.satellites.length ?? 0} 颗卫星 · 无外部瓦片请求</p>
      </aside>
      <div className="globe" ref={target} aria-label="卫星三维地球"/>
      <aside className="details"><span className="eyebrow">SATELLITE DETAILS</span><h2>{chosen?.name ?? '加载采样…'}</h2><p>NORAD {selected}</p>
        {position && <dl><dt>纬度</dt><dd>{position.lat.toFixed(3)}°</dd><dt>经度</dt><dd>{position.lng.toFixed(3)}°</dd><dt>高度</dt><dd>{position.alt.toFixed(2)} km</dd></dl>}
        <button disabled={!ready} onClick={()=>{engine.current.trackedEntity=undefined;setTracking(false);engine.current.flyTo(lookup.current.get(selected),{duration:0.8});}}>定位卫星</button>
        <button disabled={!ready} className="primary" onClick={()=>{engine.current.trackedEntity=tracking?undefined:lookup.current.get(selected);setTracking(!tracking);}}>{tracking?'退出跟踪':'跟踪卫星'}</button>
        <button disabled={!ready} onClick={()=>{engine.current.trackedEntity=undefined;setTracking(false);engine.current.camera.setView({destination:C.Cartesian3.fromDegrees(110,30,13000000)});}}>全球视角</button>
        <div className="note"><b>数据说明</b><p>样本采集：2026-11-12<br/>位置来自后端轨道推算<br/>当前画面为时间推演<br/>未接入登录、关注或数据库</p></div>
      </aside>
    </section>
    <footer><button disabled={!ready} onClick={()=>{engine.current.clock.shouldAnimate=!playing;setPlaying(!playing);}}>{playing?'暂停':'播放'}</button><strong className="amber">时间推演 · 20×</strong><time>{timeLabel || '正在准备本地地球与轨道…'}</time><span>{ready?'地球就绪':'加载中'} · {renderHz} 帧/秒（观测值）</span><button disabled={!ready} onClick={()=>setRebuild(v=>v+1)}>重建场景</button></footer>
    {error && <div role="alert" className="error">{error}。请确认验证后端已启动，且本地资源已准备。</div>}
  </main>;
}
createRoot(document.getElementById('root')).render(<App/>);
