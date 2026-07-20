import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { ENGINE_API_VERSION } from '../packages/engine/src/config/opcodes.js';
import hostDefaults from '../packages/engine/src/config/hostDefaults.js';
import gameConfig from '../games/tanks/src/config/game.js';

// Генерация GameManifest (docs/{en,ru}/plugin-api.md) после сборки
// client/host-бандлов игры (games/tanks/vite.config.js, уже хеширует имена
// entry-файлов и общий .wasm-ассет) и постшагов maps:export/copy-game-sounds.
// Запуск (в порядке зависимостей) — см. games/tanks/package.json "build".

const distDir = new URL('../games/tanks/dist/', import.meta.url);
const distPath = fileURLToPath(distDir);
const assetsPath = path.join(distPath, 'assets');
const mapsPath = path.join(distPath, 'maps');

function hashFile(filePath) {
  return createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function findOne(dir, pattern) {
  const files = fs.readdirSync(dir).filter(name => pattern.test(name));

  if (files.length !== 1) {
    throw new Error(
      `expected exactly one file matching ${pattern} in ${dir}, found: ${files.join(', ') || 'none'}`,
    );
  }

  return files[0];
}

const clientFile = findOne(distPath, /^client-.+\.js$/);
const hostFile = findOne(distPath, /^host-.+\.js$/);
const wasmFile = findOne(assetsPath, /\.wasm$/);

const version = createHash('sha256')
  .update(hashFile(path.join(distPath, clientFile)))
  .update(hashFile(path.join(distPath, hostFile)))
  .update(hashFile(path.join(assetsPath, wasmFile)))
  .digest('hex')
  .slice(0, 16);

const mapNames = fs
  .readdirSync(mapsPath)
  .filter(name => name.endsWith('.json'))
  .map(name => name.slice(0, -'.json'.length))
  .sort();

const mapsHash = createHash('sha256');

for (const name of mapNames) {
  mapsHash.update(name).update(fs.readFileSync(path.join(mapsPath, `${name}.json`)));
}

const manifest = {
  id: 'tanks',
  engineApi: ENGINE_API_VERSION,
  version,
  title: 'VIMP Tanks',
  entries: {
    client: `/games/tanks/${clientFile}`,
    host: `/games/tanks/${hostFile}`,
    wasm: `/games/tanks/assets/${wasmFile}`,
  },
  assetsBase: '/games/tanks/',
  maps: {
    version: mapsHash.digest('hex').slice(0, 16),
    list: mapNames,
  },
  roomDefaults: {
    maxPlayers: gameConfig.roomDefaults.maxPlayers,
    roundTime: hostDefaults.timers.roundTime,
    mapTime: hostDefaults.timers.mapTime,
    friendlyFire: gameConfig.parts.friendlyFire,
    map: gameConfig.currentMap,
  },
};

fs.writeFileSync(
  path.join(distPath, 'manifest.json'),
  JSON.stringify(manifest, null, 2),
);

console.log(`manifest written: ${path.join(distPath, 'manifest.json')}`);
console.log(`  version: ${version}`);
console.log(`  maps: ${mapNames.join(', ')}`);
