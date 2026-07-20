import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  fetchGamesManifest,
  assertEngineApiCompatible,
  loadClientPlugin,
} from '../../packages/engine/src/lib/gamePlugin.js';
import { ENGINE_API_VERSION } from '../../packages/engine/src/config/opcodes.js';

// Динамическая загрузка игры по GameManifest мастера (Этап 6.3)

describe('gamePlugin: fetchGamesManifest', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('возвращает распарсенный JSON при успешном ответе', async () => {
    const manifests = [{ id: 'tanks' }];

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, json: async () => manifests }),
    );

    await expect(fetchGamesManifest('/games/manifest.json')).resolves.toBe(
      manifests,
    );
    expect(fetch).toHaveBeenCalledWith('/games/manifest.json');
  });

  it('бросает при неуспешном HTTP-ответе', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: false, status: 500 }),
    );

    await expect(fetchGamesManifest()).rejects.toThrow(/HTTP 500/);
  });
});

describe('gamePlugin: assertEngineApiCompatible', () => {
  it('пропускает манифест с совпадающей версией engineApi', () => {
    expect(() =>
      assertEngineApiCompatible({ id: 'tanks', engineApi: ENGINE_API_VERSION }),
    ).not.toThrow();
  });

  it('бросает при несовпадении engineApi', () => {
    expect(() =>
      assertEngineApiCompatible({ id: 'tanks', engineApi: ENGINE_API_VERSION + 1 }),
    ).toThrow(/tanks/);
  });
});

describe('gamePlugin: loadClientPlugin', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('отказывается грузить плагин с несовместимым engineApi (import не вызывается)', async () => {
    await expect(
      loadClientPlugin({
        id: 'tanks',
        engineApi: ENGINE_API_VERSION + 1,
        entries: { client: '/unreachable.js' },
      }),
    ).rejects.toThrow(/engine API/);
  });
});
