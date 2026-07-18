import gameConfig from '../config/game.js';
import clientConfig from '../config/client.js';
import authSchema from '../config/auth.js';
import coreEventRouter from './coreEventRouter.js';
import botCommand from './botCommand.js';
import systemMessages from './systemMessages.js';
import createModules from './createModules.js';

// HostPlugin танков (Worker-safe): вся игровая половина хоста одним объектом.
// Пока импортируется статически (этап 3); в этапе 6 станет default export
// динамически загружаемого host-entry игры (плюс createCore/engineApi).
// coreEventRouter станет onCoreEvent (только 'custom'-события) после
// стандартизации словаря событий ядра в этапе 4a.
export default {
  id: 'tanks',
  gameConfig,
  authSchema,
  coreEventRouter,
  chatCommands: [botCommand],
  systemMessages,
  createModules,
  buildClientGameConfig: () => clientConfig,
};
