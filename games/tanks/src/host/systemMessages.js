// Игровые коды системных сообщений танков (группа b:* — боты).
// Merge в движковый реестр через registerCodes; в этапе 6 приедут через
// HostPlugin.systemMessages. Тексты шаблонов — на клиенте (конфиг чата).
export default {
  BOT_PLAYERS_ONLY: 'b:0', // Only active players can use /bot
  BOT_INVALID_COUNT: 'b:1', // Invalid bot count
  BOT_INVALID_TEAM: 'b:2', // Invalid team name
  BOT_CREATED_FOR_TEAM: 'b:3', // {0} bot(s) created for {1}
  BOT_REMOVED_FROM_TEAM: 'b:4', // All bots removed from {0}
  BOT_CREATED: 'b:5', // {0} bot(s) created
  BOT_REMOVED: 'b:6', // All bots removed
};
