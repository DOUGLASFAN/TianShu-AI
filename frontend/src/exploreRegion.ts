import type {SceneData} from './orbitScene';
export type GeoPoint={lat:number;lng:number};
export type Region={south:number;north:number;west:number;east:number};
export type RegionHit={norad:number;name:string;entry:string;exit:string;entryClipped:boolean;exitClipped:boolean;orbitEpoch?:string};

export function regionFrom(a:GeoPoint,b:GeoPoint):Region{
 const west=Math.min(a.lng,b.lng),east=Math.max(a.lng,b.lng);
 return {south:Math.min(a.lat,b.lat),north:Math.max(a.lat,b.lat),
  west:east-west<=180?west:east,east:east-west<=180?east:west};
}

export function findRegionTracks(scene:SceneData,region:Region,start:number,end:number,convert:(xyz:number[])=>GeoPoint){
 const hits:RegionHit[]=[];
 const inside=({lat,lng}:GeoPoint)=>lat>=region.south&&lat<=region.north&&
  (region.west<=region.east?lng>=region.west&&lng<=region.east:lng>=region.west||lng<=region.east);
 for(const track of scene.satellites){
  let entry:number|null=null,last:number|null=null,wasCovered=false,entryClipped=false;
  const close=(exitClipped:boolean)=>{
   if(entry===null||last===null)return;
   hits.push({norad:track.noradId,name:track.name,entry:new Date(entry).toISOString(),exit:new Date(last).toISOString(),
    entryClipped,exitClipped,orbitEpoch:track.dataQuality?.epoch});
   entry=null;last=null;
  };
  for(const sample of track.samples){
   const time=Date.parse(track.start)+sample[0]*1000;
   if(time<start||time>end)continue;
   if(inside(convert(sample))){
    if(entry===null){entry=time;entryClipped=!wasCovered}
    last=time;
   }else close(false);
   wasCovered=true;
  }
  close(true);
 }
 return hits.sort((a,b)=>a.entry.localeCompare(b.entry));
}
