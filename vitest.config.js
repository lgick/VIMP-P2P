import { defineConfig } from 'vitest/config';

// Конфигурация Vitest.
// Тесты разделены на два окружения через `projects`:
//   - node:   мастер-сервер, хост (мета + Worker-фасад) и общие модули
//             (src/master, src/host, src/lib, src/config) +
//             JS↔WASM харнесс Rust-ядра (tests/core; пропускается,
//             если core/pkg-node не собран — см. npm run core:build)
//   - client: клиентский код (src/client) в окружении happy-dom (браузерный DOM)
export default defineConfig({
  test: {
    // глобальные describe/it/expect без импорта
    globals: true,

    projects: [
      {
        extends: true,
        test: {
          name: 'node',
          environment: 'node',
          include: [
            'tests/master/**/*.test.js',
            'tests/lib/**/*.test.js',
            'tests/config/**/*.test.js',
            'tests/core/**/*.test.js',
            'tests/host/**/*.test.js',
          ],
        },
      },
      {
        extends: true,
        test: {
          name: 'client',
          environment: 'happy-dom',
          include: ['tests/client/**/*.test.js'],
        },
      },
    ],

    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      include: ['src/**/*.js', 'games/*/src/**/*.js'],
      exclude: [
        '**/_*/**', // игнорируемые директории (префикс _)
        '**/_*.js', // игнорируемые файлы (префикс _)
        '**/index.js', // ре-экспорты
        'games/*/src/data/**', // статические игровые данные (карты, баланс)
      ],
    },
  },
});
