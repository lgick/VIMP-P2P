import gameConfig from './game.js';

// Схема авторизации фикстуры (HostPlugin.authSchema, PLAN.md §3.2) —
// зеркало games/tanks/src/config/auth.js с единственной моделью.
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
    isValidModel: model => model in gameConfig.parts.models,
  },
};
