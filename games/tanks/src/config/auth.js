import models from '../data/models.js';

// Конфиг авторизации игры: форма (elems/params) и игровые валидаторы.
// params уходят клиенту по AUTH_DATA (порт 1); validators — код, работает
// на обеих сторонах (хост — validateAuth в Worker'е, клиент — форма).
// В этапе 6 приедет через HostPlugin.authSchema.
export default {
  elems: {
    authId: 'auth',
    formId: 'auth-form',
    errorId: 'auth-error',
    enterId: 'auth-enter',
    titleId: 'auth-title',
    informsId: 'auth-informs',
  },
  // тексты формы (заголовок + help-секции): auth.pug — нейтральный каркас,
  // игровые тексты подставляет AuthView из этих данных
  texts: {
    title: 'VIMP P2P Tank Battle',
    sections: [
      {
        heading: 'Controls',
        lines: [
          { keys: 'W, A, S, D', text: 'move the tank' },
          { keys: 'K, L', text: 'turn the gun' },
          { keys: 'U', text: 'center the gun' },
          { keys: 'J', text: 'fire' },
          { keys: 'N, P', text: 'switch weapon/player', last: true },
          { keys: 'C', text: 'chat/command line' },
          { keys: 'M', text: 'menu' },
          { keys: 'TAB', text: 'stats', last: true },
        ],
      },
      {
        heading: 'Command line',
        lines: [
          { keys: '/name <name>', text: 'change nickname' },
          { keys: '/mapname', text: 'show current map name' },
          { keys: '/timeleft', text: 'map time left' },
          { separator: true },
          { keys: '/bot <count>', text: 'add bot(s)' },
          { keys: '/bot <count> <team>', text: 'add to team' },
          { keys: '/bot 0', text: 'remove all bots' },
          { keys: '/bot 0 <team>', text: 'remove from team' },
        ],
      },
    ],
  },
  params: [
    {
      name: 'name',
      value: '',
      options: {
        validator: 'isValidName',
        storage: 'userName',
      },
    },
    {
      name: 'model',
      value: 'm1',
      options: {
        validator: 'isValidModel',
        storage: 'model',
      },
    },
  ],
  validators: {
    // валидная модель — любая из данных игры
    isValidModel: model => model in models,
  },
};
