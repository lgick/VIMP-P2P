// Сборка клиентского CONFIG_DATA (порт 0): базовый client-конфиг +
// время голосования и данные client-side prediction из game-конфига.
// Используется Worker'ом хоста (src/host/host.worker.js).
//
// Возвращает новый объект (клон), не мутируя переданный client-конфиг.
export const buildClientConfig = (game, client) => {
  const config = structuredClone(client);

  // время ожидания vote-модуля
  config.modules.vote.params.time = game.timers.voteTime;

  // данные для client-side prediction (реплика движения своего танка
  // и визуального спавна его снарядов)
  config.prediction = {
    timeStep: game.timers.timeStep,
    playerKeys: game.playerKeys,
    models: game.parts.models,
    weapons: game.parts.weapons,
  };

  return config;
};
