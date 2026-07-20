import fs from 'node:fs';
import path from 'node:path';
import MapCatalog from './MapCatalog.js';

// Каталог игр-плагинов мастера (Этап 6.2 плана отделения): сканирует
// games/*/dist/manifest.json (продукт `npm run game:build`, Этап 6.1) и
// строит per-game MapCatalog из games/*/dist/maps/*.json. Мастер не
// исполняет код игры (только уже собранный манифест + статичные JSON карт).
//
// В dev entries манифеста (client/host/wasm) подменяются на исходники через
// Vite `/@fs/` (HMR штатный, как у остального движка); maps/assetsBase
// остаются из уже собранного dist — как и WorkerCatalog, каталог требует
// `npm run game:build` один раз перед первым запуском (см. CLAUDE.md).
export default class GameCatalog {
  /**
   * @param {string} gamesDir - директория games/ (родитель games/<id>/)
   * @param {{dev?: boolean}} [options]
   */
  constructor(gamesDir, { dev = false } = {}) {
    this._games = new Map(); // id -> { manifest, mapCatalog }

    for (const id of this._findGameIds(gamesDir)) {
      const gameDir = path.join(gamesDir, id);
      const manifestPath = path.join(gameDir, 'dist', 'manifest.json');

      let manifest;

      try {
        manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      } catch (err) {
        continue; // игра не собрана (npm run game:build) — пропускаем
      }

      this._games.set(manifest.id, {
        manifest: dev ? this._toDevManifest(manifest, gameDir) : manifest,
        mapCatalog: new MapCatalog(
          this._readMaps(path.join(gameDir, 'dist', 'maps')),
        ),
      });
    }

    this._manifestList = JSON.stringify(
      [...this._games.values()].map(game => game.manifest),
    );
  }

  // подкаталоги games/* — кандидаты в игры; валидность подтверждает
  // наличие dist/manifest.json (проверяется отдельно, при чтении манифеста)
  _findGameIds(gamesDir) {
    try {
      return fs
        .readdirSync(gamesDir, { withFileTypes: true })
        .filter(entry => entry.isDirectory())
        .map(entry => entry.name);
    } catch (err) {
      return [];
    }
  }

  _readMaps(mapsDir) {
    const maps = {};
    let files;

    try {
      files = fs.readdirSync(mapsDir).filter(name => name.endsWith('.json'));
    } catch (err) {
      return maps;
    }

    for (const file of files) {
      const name = file.slice(0, -'.json'.length);

      maps[name] = JSON.parse(
        fs.readFileSync(path.join(mapsDir, file), 'utf8'),
      );
    }

    return maps;
  }

  // dev: entries -> Vite '/@fs/' исходники (HMR); maps/assetsBase/
  // roomDefaults/version — как в prod-манифесте, из уже собранного dist
  _toDevManifest(manifest, gameDir) {
    const src = rel => `/@fs/${path.join(gameDir, 'src', rel)}`;
    const wasm = this._findWasmBinary(path.join(gameDir, 'core', 'pkg-web'));

    return {
      ...manifest,
      entries: {
        client: src('client/index.js'),
        host: src('host/index.js'),
        wasm: wasm ? `/@fs/${wasm}` : manifest.entries.wasm,
      },
    };
  }

  _findWasmBinary(pkgWebDir) {
    try {
      const file = fs
        .readdirSync(pkgWebDir)
        .find(name => name.endsWith('_bg.wasm'));

      return file ? path.join(pkgWebDir, file) : null;
    } catch (err) {
      return null;
    }
  }

  get ids() {
    return [...this._games.keys()];
  }

  // манифесты всех известных игр — готовая JSON-строка (массив)
  get manifestList() {
    return this._manifestList;
  }

  getManifest(id) {
    return this._games.get(id)?.manifest;
  }

  getMapCatalog(id) {
    return this._games.get(id)?.mapCatalog;
  }
}
