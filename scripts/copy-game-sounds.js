import fs from 'node:fs';

// Копирует уже обработанные звуки игры (npm run audio:process →
// packages/engine/public/sounds — текущий раздающий путь движка, Этап <6)
// в dist/ игры (games/tanks/dist/sounds/) — ассет под
// GameManifest.assetsBase (Этап 6.2, GameCatalog мастера). Обработка
// (ffmpeg-нормализация громкости) общая для обоих назначений — пересчитывать
// её здесь незачем, только копия готовых файлов.
// Запуск: npm run audio:process && node scripts/copy-game-sounds.js

const sourceDir = new URL('../packages/engine/public/sounds/', import.meta.url);
const targetDir = new URL('../games/tanks/dist/sounds/', import.meta.url);

if (!fs.existsSync(sourceDir)) {
  console.error(
    `Error: '${sourceDir.pathname}' not found. Run 'npm run audio:process' first.`,
  );
  process.exit(1);
}

fs.rmSync(targetDir, { recursive: true, force: true });
fs.cpSync(sourceDir, targetDir, { recursive: true });

console.log(`copied sounds: ${sourceDir.pathname} -> ${targetDir.pathname}`);
