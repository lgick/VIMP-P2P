import { ENGINE_API_VERSION } from '../config/opcodes.js';

// Динамическая загрузка игры по GameManifest мастера (Этап 6.3): клиент
// больше не импортирует игру статически (gameRegistry.static.js) — вместо
// этого он читает каталог игр мастера и подгружает ClientPlugin по
// entries.client из манифеста.

// каталог всех игр мастера (GameCatalog, см. Этап 6.2)
export async function fetchGamesManifest(url = '/games/manifest.json') {
  const res = await fetch(url);

  if (!res.ok) {
    throw new Error(`games manifest: HTTP ${res.status}`);
  }

  return res.json();
}

// несовпадение engineApi — плагин собран под другую версию контрактов
// движка (§3.7 PLAN.md); загружать его небезопасно
export function assertEngineApiCompatible(manifest) {
  if (manifest.engineApi !== ENGINE_API_VERSION) {
    throw new Error(
      `game "${manifest.id}" requires engine API v${manifest.engineApi}, ` +
        `this engine build is v${ENGINE_API_VERSION}`,
    );
  }
}

// динамический import ClientPlugin игры (client-entry её сборки)
export async function loadClientPlugin(manifest) {
  assertEngineApiCompatible(manifest);

  const module = await import(/* @vite-ignore */ manifest.entries.client);

  return module.default;
}
