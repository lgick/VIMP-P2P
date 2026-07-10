const MESSAGE_CODES = {
  TEAMS_TEAM_FULL: 's:0', // Team {0} is full. Your current team: {1}
  TEAMS_YOUR_TEAM: 's:1', // Your team: {0}
  TEAMS_NEW_TEAM: 's:2', // Your new team: {0}
  TEAMS_NOW_SPECTATOR: 's:3', // Your new status: spectator
  REPORT_KILL: 's:4', // ⚔️  {0} killed {1}!
  USER_JOINED: 's:5', // ⚡ {0} joined the game
  USER_LEFT: 's:6', // 👋  {0} left the game

  VOTE_CREATED: 'v:0', // A vote has been created
  VOTE_STARTED: 'v:1', // Voting has started
  VOTE_ACCEPTED: 'v:2', // Your vote has been accepted
  VOTE_UNAVAILABLE: 'v:3', // Voting is temporarily unavailable
  VOTE_PASSED: 'v:4', // Vote passed
  VOTE_FAILED: 'v:5', // Vote failed

  MAP_CURRENT: 'm:0', // Current map: {0}
  MAP_NEXT: 'm:1', // Next map: {0}

  COMMANDS_NOT_FOUND: 'c:0', // Command not found

  NAME_INVALID: 'n:0', // Invalid name
  NAME_CHANGED: 'n:1', // {0} changed name to {1}

  BOT_PLAYERS_ONLY: 'b:0', // Only active players can use /bot
  BOT_INVALID_COUNT: 'b:1', // Invalid bot count
  BOT_INVALID_TEAM: 'b:2', // Invalid team name
  BOT_CREATED_FOR_TEAM: 'b:3', // {0} bot(s) created for {1}
  BOT_REMOVED_FROM_TEAM: 'b:4', // All bots removed from {0}
  BOT_CREATED: 'b:5', // {0} bot(s) created
  BOT_REMOVED: 'b:6', // All bots removed
};

/**
 * Собирает финальную строку системного сообщения из ключа и параметров.
 * @param {string} messageKey - Ключ из объекта MESSAGE_CODES
 * @param {Array<string>} [params=[]] - Массив с параметрами для сообщения.
 * @returns {string|null} Готовая строка для отправки клиенту
 * (например, 'n:1:Player1,Player2')
 */
export function buildSystemMessage(key, params = []) {
  return params.length
    ? `${MESSAGE_CODES[key]}:${params.join(',')}`
    : MESSAGE_CODES[key];
}
