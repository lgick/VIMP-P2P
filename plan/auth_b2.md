# B2. Вход + выбор ника (лобби UI) ✅критично

- Лобби (`packages/engine/src/client/main.js`, `initLobby`) получает состояние
  «залогинен/нет». Кнопки входа Google/Apple/GitHub → редирект на auth-сервис →
  callback возвращает JWT. При первом входе — экран «придумай ник» (глобальная
  уникальность проверяется сервисом).
- JWT хранится клиентом; ник отображается в лобби. Логаут/refresh — по сроку
  токена.
- CSP (`config/master.js` `security.csp`) расширить: `connect-src`/`form-action`/
  при необходимости `frame-src`/`script-src` для доменов провайдеров и
  auth-сервиса. Сейчас политика жёсткая (`default-src 'self'`).

## Критические файлы

`packages/engine/src/client/main.js` + `components/{model,view,controller}/Auth.js`
+ `views/includes/auth.pug` (логин, экран ника, проброс JWT);
`packages/engine/src/config/master.js` (CSP).

## Предусловие

B1 (auth-сервис и его REST-эндпоинты должны существовать).
