from pathlib import Path
import sys,json,hashlib,time
sys.path.insert(0,str(Path('.local/tools/sky-processing').resolve()))
import OpenEXR,numpy as np
from PIL import Image
path=Path('.local/downloads/sky/nasa-stars-8k.exr');print('source-ready',path.exists(),flush=True)
if not path.exists():raise SystemExit(2)
started=time.perf_counter();source=OpenEXR.File(str(path));channels=source.channels();print({k:str(v.pixels.shape) for k,v in channels.items()},flush=True)
rgb=np.asarray(channels['RGB'].pixels,dtype=np.float32);height,width=rgb.shape[:2];print({'shape':[height,width],'percentiles':np.percentile(rgb[::16,::16],[50,90,99,99.9]).tolist()},flush=True)
folder=Path('frontend/public/space/nasa-8k');folder.mkdir(parents=True,exist_ok=True);size=2048
faces={'positiveX':lambda u,v:(np.ones_like(u),-v,-u),'negativeX':lambda u,v:(-np.ones_like(u),-v,u),'positiveY':lambda u,v:(u,np.ones_like(u),v),'negativeY':lambda u,v:(u,-np.ones_like(u),-v),'positiveZ':lambda u,v:(u,-v,np.ones_like(u)),'negativeZ':lambda u,v:(-u,-v,-np.ones_like(u))}
outputs=[]
for name,direction in faces.items():
 output=np.empty((size,size,3),dtype=np.uint8)
 for y in range(0,size,128):
  u,v=np.meshgrid((np.arange(size,dtype=np.float32)+.5)/(size/2)-1,1-(np.arange(y,min(y+128,size),dtype=np.float32)+.5)/(size/2));a,b,c=direction(u,v);length=np.sqrt(a*a+b*b+c*c);a/=length;b/=length;c/=length
  sx=(.5-np.arctan2(b,a)/(2*np.pi))*width-.5;sy=(.5-np.arcsin(np.clip(c,-1,1))/np.pi)*height-.5;x0=np.floor(sx).astype(np.int32)%width;y0=np.clip(np.floor(sy).astype(np.int32),0,height-1);fx=(sx-np.floor(sx))[...,None];fy=(sy-np.floor(sy))[...,None];x1=(x0+1)%width;y1=np.minimum(y0+1,height-1)
  value=(rgb[y0,x0]*(1-fx)+rgb[y0,x1]*fx)*(1-fy)+(rgb[y1,x0]*(1-fx)+rgb[y1,x1]*fx)*fy
  value=np.maximum(value,0);value=value/(1+value);value=np.where(value<=.0031308,value*12.92,1.055*np.power(value,1/2.4)-.055)
  output[y:y+len(u)]=np.clip(np.rint(value*255),0,255).astype(np.uint8)
 target=folder/(name+'.webp');Image.fromarray(output).save(target,format='WEBP',lossless=True,method=6);outputs.append({'file':target.name,'width':size,'height':size,'bytes':target.stat().st_size,'sha256':hashlib.sha256(target.read_bytes()).hexdigest()});print(name,target.stat().st_size,flush=True)
manifest={'source':'https://svs.gsfc.nasa.gov/4851/','sourceFile':'https://svs.gsfc.nasa.gov/vis/a000000/a004800/a004851/starmap_2020_8k.exr','sourceSize':[width,height],'sourceBytes':path.stat().st_size,'sourceSHA256':hashlib.sha256(path.read_bytes()).hexdigest(),'credit':'NASA/Goddard Space Flight Center Scientific Visualization Studio; ESA/Gaia/DPAC; Ernie Wright','processing':'Bilinear projection to 2048px cubemap faces; Reinhard linear HDR tone mapping; IEC sRGB encoding; lossless WebP. No invented stars or AI modification. Display background, not an astrometric reference.','outputs':outputs,'seconds':time.perf_counter()-started}
(folder/'manifest.json').write_text(json.dumps(manifest,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
