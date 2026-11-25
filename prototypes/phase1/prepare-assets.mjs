import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
await mkdir('public/cesium', { recursive: true });
await cp('node_modules/cesium/Build/Cesium', 'public/cesium', { recursive: true });
const pkg = JSON.parse(await readFile('package.json', 'utf8'));
for (const group of ['dependencies', 'devDependencies']) {
  for (const name of Object.keys(pkg[group] || {})) {
    const installed = JSON.parse(await readFile(`node_modules/${name}/package.json`, 'utf8'));
    pkg[group][name] = installed.version;
  }
}
await writeFile('package.json', JSON.stringify(pkg, null, 2) + '\n');
console.log('Cesium local assets copied; installed versions pinned.');
