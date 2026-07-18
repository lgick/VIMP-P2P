import { defineConfig } from 'vitest/config';

// Конфигурация Vitest (этап 5 плана отделения движка).
// Тесты разделены на четыре проекта:
//   - engine-node:   мастер-сервер, хост (мета + Worker-фасад) и общие модули
//                    движка (packages/engine/src/{master,host,lib,config})
//   - engine-client: клиентский код движка (packages/engine/src/client)
//                    в окружении happy-dom (браузерный DOM)
//   - tanks:         игровые модули @vimp/tanks (host-плагин, ClientPlugin)
//   - integration:   интеграция поверх реального ядра танков
//                    (tests/host/HostGame.test.js + JS↔WASM харнесс tests/core;
//                    пропускается, если core/pkg-node не собран —
//                    см. npm run core:build)
export default defineConfig({
  test: {
    // глобальные describe/it/expect без импорта
    globals: true,

    projects: [
      {
        extends: true,
        test: {
          name: 'engine-node',
          environment: 'node',
          include: [
            'tests/master/**/*.test.js',
            'tests/lib/**/*.test.js',
            'tests/config/**/*.test.js',
            'tests/host/**/*.test.js',
          ],
          exclude: [
            'tests/host/HostGame.test.js',
            'tests/host/hostPlugin.test.js',
            'tests/host/botCommand.test.js',
            'tests/host/coreEventRouter.test.js',
            'tests/host/TanksBotManager.test.js',
          ],
        },
      },
      {
        extends: true,
        test: {
          name: 'engine-client',
          environment: 'happy-dom',
          include: ['tests/client/**/*.test.js'],
          exclude: ['tests/client/tanksClientPlugin.test.js'],
        },
      },
      {
        extends: true,
        test: {
          name: 'tanks',
          environment: 'happy-dom',
          include: [
            'tests/host/hostPlugin.test.js',
            'tests/host/botCommand.test.js',
            'tests/host/coreEventRouter.test.js',
            'tests/host/TanksBotManager.test.js',
            'tests/client/tanksClientPlugin.test.js',
          ],
        },
      },
      {
        extends: true,
        test: {
          name: 'integration',
          environment: 'node',
          include: ['tests/host/HostGame.test.js', 'tests/core/**/*.test.js'],
        },
      },
    ],

    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      include: ['packages/engine/src/**/*.js', 'games/*/src/**/*.js'],
      exclude: [
        '**/_*/**', // игнорируемые директории (префикс _)
        '**/_*.js', // игнорируемые файлы (префикс _)
        '**/index.js', // ре-экспорты
        'games/*/src/data/**', // статические игровые данные (карты, баланс)
      ],
    },
  },
});
