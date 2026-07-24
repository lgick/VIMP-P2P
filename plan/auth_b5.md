# B5. Команда `/rank` ✅важно

- Регистрируется как игровая chat-команда по образцу `/bot`
  (`games/tanks/src/host/botCommand.js` → `chatCommands`), либо как движковая в
  `CommandProcessor.js` (наряду с `/name`,`/timeleft`,`/mapname`). Handler читает
  rank игрока с мастера (auth-сервис) и печатает в чат.

## Критические файлы

`games/tanks/src/host/` (команда `/rank`).

## Предусловие

B4 (rank должен уже подгружаться и храниться).
