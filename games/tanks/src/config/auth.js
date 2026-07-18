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
