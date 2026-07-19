/*
npx eslint . eslint.config.js
npx eslint --print-config src/host/meta/modules/Panel.js > log
*/

import js from '@eslint/js';
import eslintConfigPrettier from 'eslint-config-prettier';
import noConsecutiveCapsPlugin from 'eslint-plugin-no-consecutive-caps';
import globals from 'globals';

export default [
  // базовые рекомендованные правила ESLint
  js.configs.recommended,

  // отключение правил ESLint, конфликтующих с Prettier
  eslintConfigPrettier,

  {
    plugins: {
      'no-consecutive-caps': noConsecutiveCapsPlugin,
    },
  },

  // конфигурация для конфигов корня и воркспейсов (vite.config.js и т.д.)
  {
    files: ['*.js', '*.cjs', '*.mjs', 'packages/*/*.js', 'games/*/*.js'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: {
        ...globals.node, // глобальные переменные Node.js
      },
    },
    rules: {
      'no-console': 'off', // в файлах конфигурации console.log
    },
  },

  // конфигурация серверного кода Node.js
  {
    files: [
      'packages/engine/src/master/**/*.js', // мастер-сервер (Node.js)
    ],
    languageOptions: {
      ecmaVersion: 'latest', // последний ECMAScript
      sourceType: 'module', // "type": "module" в package.json
      globals: {
        ...globals.node, // глобальные переменные Node.js (console, process...)
      },
    },
    rules: {
      'no-console': process.env.NODE_ENV === 'production' ? 'warn' : 'off',
    },
  },

  // конфигурация для клиентского кода
  {
    files: [
      // клиент движка и клиентская часть игры (parts/bakers)
      'packages/engine/src/client/**/*.js',
      'games/*/src/client/**/*.js',
    ],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: {
        ...globals.browser, // глобальные переменные браузера
      },
    },
    rules: {
      'no-alert': 'warn', // предупреждать об alert, confirm, prompt
    },
  },
  // конфигурация для кода браузерного хоста (Web Worker: WASM-ядро + мета)
  {
    files: [
      'packages/engine/src/host/**/*.js', // Worker хоста и его модули
    ],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: {
        ...globals.browser, // structuredClone, queueMicrotask, console...
        ...globals.worker, // self, postMessage, importScripts
      },
    },
    rules: {
      'no-console': process.env.NODE_ENV === 'production' ? 'warn' : 'off',
    },
  },

  {
    files: [
      'packages/engine/src/lib/**/*.js',
      'packages/engine/src/config/**/*.js',
      'packages/engine/src/gameRegistry.static.js',
      'scripts/*.js',
      'games/*/src/**/*.js', // игровые данные/конфиги (@vimp/tanks)
    ],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: {
        ...globals.es2023,
        ...globals.node,
        ...globals.browser,
      },
    },
    rules: {
      'no-console': 'off',
    },
  },

  // ESLint-граница движок↔игра (этап 5 плана отделения):
  // движок не импортирует игру (единственное исключение —
  // gameRegistry.static.js, временная статическая композиция до этапа 6)
  {
    files: ['packages/engine/**/*.js'],
    ignores: ['packages/engine/src/gameRegistry.static.js'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@vimp/tanks', '@vimp/tanks/*', '@vimp/tanks/**'],
              message:
                'Движок не импортирует игру напрямую — только через gameRegistry.static.js (до этапа 6).',
            },
            {
              group: ['**/games/**'],
              message:
                'Движок не импортирует файлы games/** — только через gameRegistry.static.js (до этапа 6).',
            },
          ],
        },
      ],
    },
  },

  // игра импортирует движок только через публичные entry @vimp/engine
  {
    files: ['games/**/*.js'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/packages/engine/**'],
              message:
                'Игра импортирует движок только через публичные entry @vimp/engine.',
            },
          ],
        },
      ],
    },
  },

  // конфигурация для тестов (Vitest)
  {
    files: ['tests/**/*.js'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: {
        ...globals.node,
        ...globals.browser,
        // глобалы Vitest (globals: true в vitest.config.js)
        describe: 'readonly',
        it: 'readonly',
        expect: 'readonly',
        vi: 'readonly',
        beforeEach: 'readonly',
        afterEach: 'readonly',
        beforeAll: 'readonly',
        afterAll: 'readonly',
      },
    },
    rules: {
      'no-console': 'off',
    },
  },

  // общие правила для всего проекта
  // (применяются ко всем JS файлам, если не переопределены выше)
  {
    rules: {
      // предупреждать о неиспользуемых переменных (используется tsserver)
      'no-unused-vars': 'off',
      // требовать === и !==
      eqeqeq: ['error', 'always'],
      // требовать фигурные скобки для всех блоков if, for, while и т.д.
      curly: ['error', 'all'],
      // предупреждать о ненужных else после return
      'no-else-return': 'warn',
      // использовать let/const вместо var
      'no-var': 'error',
      // предлагать использовать const, если переменная не переназначается
      'prefer-const': 'warn',
      // рекомендовать короткий синтаксис для свойств объектов
      'object-shorthand': ['warn', 'properties'],
      // тело стрелочной функции без {} если возможно
      'arrow-body-style': ['warn', 'as-needed'],
      // требовать camelCase именования
      camelcase: 'error',
      // плагин с запретом на caps в названиях
      'no-consecutive-caps/no-consecutive-caps': [
        'error',
        // VX/VY/RTT — свои; URL/RTC/URI — имена Web API (URLSearchParams,
        // RTCPeerConnection, encodeURIComponent), переименовать нельзя
        { exceptions: ['VX', 'VY', 'RTT', 'URL', 'RTC', 'URI'] },
      ],
    },
  },

  // игнорируемые файлы и директории
  {
    ignores: [
      'node_modules/**',
      'dist/**', // результаты сборки Vite
      'packages/*/dist/**', // сборка Vite движка
      'games/*/dist/**', // сборка бандлов игры (этап 6)
      'public/**', // статика, которую не нужно линтить
      'build/**',
      'games/*/core/pkg-node/**', // сгенерированный wasm-pack glue (nodejs)
      'games/*/core/pkg-web/**', // сгенерированный wasm-pack glue (web)
      'target/**', // артефакты cargo (workspace)
      'games/*/src/data/maps/json/**', // сгенерированные JSON-карты (maps:export)
      '**/.*', // игнорировать все файлы/директории, начинающиеся с '.'
      '**/_*', // игнорировать все файлы/директории, начинающиеся с '_'
    ],
  },
];
