# B3. Проброс токена в игру + верификация хостом ✅критично

- **Клиент** прикладывает JWT к входу в игру: в `webrtc_offer`
  (`client/network/SignalingClient.js` / `WebRtcManager`) и/или в payload
  `AUTH_RESPONSE` (`client/main.js`, обработчик `PC_AUTH_RESPONSE`).
- **Хост** (точка верификации): `packages/engine/src/host/host.worker.js`
  (порт 1, где сейчас `validateAuth` + `host.createUser`) — вместо доверия
  свободному вводу проверяет подпись JWT по публичному ключу мастера
  (`/auth/jwks`, мастер проксирует ключ auth-сервиса) и берёт ник из claim.
  `HostGame.createUser` / `ParticipantManager.createHuman`
  (`meta/player/ParticipantManager.js`) используют проверенный ник; пер-комнатный
  дедуп `checkName` больше не нужен для людей (ник уже глобально уникален), но
  остаётся для scripted-участников.
- Игровая `authSchema` (`games/tanks/src/config/auth.js`) теряет поле `name` как
  вводимое (ник приходит из токена); остаётся выбор `model` и прочие
  игро-специфичные поля.

## Критические файлы

`packages/engine/src/host/host.worker.js` + `HostGame.js` +
`meta/player/ParticipantManager.js` (верификация, ник из токена);
`packages/engine/src/master/main.js` + `SignalingServer.js` (проксирование `/jwks`);
`games/tanks/src/config/auth.js` (убрать ввод name).

## Предусловие

B2 (клиент должен уже нести JWT).
