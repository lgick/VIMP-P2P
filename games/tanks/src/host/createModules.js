import TanksBotManager from './TanksBotManager.js';

// Фабрика игровых host-модулей (будущий HostPlugin.createModules, этап 6).
// ctx — движковый контекст: participants, coreAdapter, panel, stat, chat,
// socketManager, timerManager, voteCoordinator, scripted.
export default function createModules(ctx) {
  return { bots: new TanksBotManager(ctx) };
}
