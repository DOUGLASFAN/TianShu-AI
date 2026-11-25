import { cp,mkdir,readFile,writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
await mkdir(path.join(root,'public/branding'),{recursive:true});
await cp(path.join(root,'../assets/branding/auth-orbit-background-v1.png'),path.join(root,'public/branding/auth-orbit-background-v1.png'));
await cp(path.join(root,'node_modules/cesium/Build/Cesium'),path.join(root,'public/cesium'),{recursive:true});
await cp(path.join(root,'../assets/earth'),path.join(root,'public/earth'),{recursive:true});
await cp(path.join(root,'../assets/models'),path.join(root,'public/models'),{recursive:true});
await cp(path.join(root,'node_modules/three/examples/jsm/libs/draco/gltf'),path.join(root,'public/draco'),{recursive:true});
const pkg=JSON.parse(await readFile(path.join(root,'package.json'),'utf8'));
for(const group of ['dependencies','devDependencies'])for(const name of Object.keys(pkg[group]||{})){
 const installed=JSON.parse(await readFile(path.join(root,'node_modules',name,'package.json'),'utf8'));
 pkg[group][name]=installed.version;
}
await writeFile(path.join(root,'package.json'),JSON.stringify(pkg,null,2)+'\n');
console.log('Branding asset prepared and dependency versions pinned.');
