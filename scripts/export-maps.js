import { mkdir, writeFile } from 'node:fs/promises';
import maps from '../src/data/maps/index.js';

// Экспорт карт из JS-модулей (src/data/maps/*.js) в статичные .json —
// формат загрузки load_map Rust-ядра (core/) и будущей раздачи карт
// мастер-сервером без пересборки (Этап 5.1 P2P-плана).
// Запуск: npm run maps:export → src/data/maps/json/<имя>.json

const outDir = new URL('../src/data/maps/json/', import.meta.url);

await mkdir(outDir, { recursive: true });

for (const [name, map] of Object.entries(maps)) {
  // конструктор URL кодирует пробелы, fs декодирует их обратно
  const file = new URL(`${name}.json`, outDir);

  await writeFile(file, JSON.stringify(map));
  console.log(`exported: ${name}.json`);
}
