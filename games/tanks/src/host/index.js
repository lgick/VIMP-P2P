import gameConfig from '../config/game.js';
import clientConfig from '../config/client.js';
import authSchema from '../config/auth.js';
import botCommand from './botCommand.js';
import systemMessages from './systemMessages.js';
import createModules from './createModules.js';

// HostPlugin танков (Worker-safe): вся игровая половина хоста одним объектом.
// Пока импортируется статически (этап 3); в этапе 6 станет default export
// динамически загружаемого host-entry игры (плюс createCore/engineApi).
// Танки не используют 'custom'-события ядра — onCoreEvent не задан, движок
// роутит стандартный словарь (panelSet/panelActive/death/shake) сам.
export default {
  id: 'tanks',
  gameConfig,
  authSchema,
  chatCommands: [botCommand],
  systemMessages,
  createModules,
  buildClientGameConfig: () => clientConfig,
};
