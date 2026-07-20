import { defineConfig } from 'vite';
import path from 'node:path';

// Сборка игры-плагина (Этап 6.1 плана отделения движка): client-entry и
// host-entry (worker-safe) собираются ДВУМЯ независимыми прогонами
// (`vite build --mode client|host`), а не одним multi-entry рollup-графом —
// общие чанки между ними утащили бы DOM-код (pixi.js) в worker-safe
// host-бандл (риск #3 PLAN.md). wasm-glue (games/tanks/core/pkg-web/) —
// общий для обоих entry: Vite хеширует .wasm по содержимому через
// встроенный `new URL('*.wasm', import.meta.url)`-ассет паттерн внутри
// самого wasm-pack-глюe-модуля, поэтому оба прогона выпускают файл с
// одинаковым hashed-именем (общий HTTP-кеш, без явного shared-чанка).
const entries = {
  client: path.resolve(import.meta.dirname, 'src/client/index.js'),
  host: path.resolve(import.meta.dirname, 'src/host/index.js'),
};

export default defineConfig(({ mode }) => {
  const entry = entries[mode];

  if (!entry) {
    throw new Error(
      `games/tanks build: unknown --mode "${mode}" (expected "client" or "host")`,
    );
  }

  return {
    build: {
      outDir: 'dist',
      emptyOutDir: false, // client- и host-прогоны пишут в один dist/ — не затирать друг друга
      // .wasm (~2MB) обязан остаться отдельным ассетом с URL, а не
      // base64-инлайном в JS (риск #3 PLAN.md: +33% размера, ломает
      // instantiateStreaming, дублирует WASM в обоих бандлах вместо
      // общего HTTP-кеша). Vite Lib-режим (build.lib) инлайнит ассеты
      // всегда (см. shouldInline() в vite/dist/node — `if (build.lib)
      // return true`, assetsInlineLimit игнорируется), поэтому lib-режим
      // не используем; вместо него — обычная сборка с явным
      // preserveEntrySignatures: без него Vite для app-сборок (не lib)
      // ставит false и выбрасывает default export entry-модуля
      // (GameManifest ClientPlugin/HostPlugin) как "неиспользуемый".
      assetsInlineLimit: 0,
      rollupOptions: {
        input: entry,
        preserveEntrySignatures: 'strict',
        output: {
          format: 'es',
          entryFileNames: `${mode}-[hash].js`,
          assetFileNames: 'assets/[name]-[hash][extname]',
          inlineDynamicImports: true,
        },
      },
    },
  };
});
