import { describe, it, expect, beforeEach, vi } from 'vitest';
import Publisher from '../../packages/engine/src/lib/Publisher.js';

// AuthView — синглтон, перезагружаем модуль для изоляции
let AuthView;

const elems = {
  authId: 'auth',
  formId: 'auth-form',
  errorId: 'auth-error',
  enterId: 'auth-enter',
};

const seedDom = () => {
  document.body.innerHTML = `
    <div id="auth">
      <form id="auth-form">
        <input type="text" name="login" value="" />
        <input type="radio" name="team" value="1" />
        <input type="radio" name="team" value="2" />
      </form>
      <div id="auth-error"></div>
      <button id="auth-enter">OK</button>
    </div>
  `;
};

const makeModel = () => ({ publisher: new Publisher() });

beforeEach(async () => {
  vi.resetModules();
  seedDom();
  AuthView = (await import('../../packages/engine/src/client/components/view/Auth.js')).default;
});

describe('AuthView: показ/скрытие', () => {
  it('showAuth/hideAuth переключают display', () => {
    const view = new AuthView(makeModel(), elems);

    view.showAuth();
    expect(document.getElementById('auth').style.display).toBe('block');

    view.hideAuth();
    expect(document.getElementById('auth').style.display).toBe('none');
  });

  it('hideAuth сохраняет данные в localStorage', () => {
    const store = {};
    vi.stubGlobal('localStorage', store);
    const view = new AuthView(makeModel(), elems);

    view.hideAuth([{ name: 'login', value: 'Bob' }]);
    expect(store.login).toBe('Bob');

    vi.unstubAllGlobals();
  });
});

describe('AuthView.renderData', () => {
  it('заполняет текстовый инпут и чистит ошибку', () => {
    const view = new AuthView(makeModel(), elems);
    document.getElementById('auth-error').textContent = 'старая ошибка';

    view.renderData({ name: 'login', value: 'Alice' });

    const input = document.querySelector('input[name="login"]');
    expect(input.value).toBe('Alice');
    expect(document.getElementById('auth-error').textContent).toBe('');
  });

  it('отмечает нужный radio', () => {
    const view = new AuthView(makeModel(), elems);

    view.renderData({ name: 'team', value: '2' });

    const radios = document.querySelectorAll('input[name="team"]');
    expect(radios[0].checked).toBe(false);
    expect(radios[1].checked).toBe(true);
  });
});

describe('AuthView.renderError', () => {
  it('добавляет строку ошибки с текстом', () => {
    const view = new AuthView(makeModel(), elems);

    view.renderError([{ name: 'login', error: 'too short' }]);

    const err = document.getElementById('auth-error');
    expect(err.children.length).toBe(1);
    expect(err.textContent).toBe('LOGIN: too short');
  });

  it('использует дефолтный текст при отсутствии error', () => {
    const view = new AuthView(makeModel(), elems);

    view.renderError([{ name: 'team', error: '' }]);

    expect(document.getElementById('auth-error').textContent).toBe(
      'TEAM is not correctly!',
    );
  });
});

describe('AuthView: события DOM', () => {
  it('изменение инпута эмитит input', () => {
    const model = makeModel();
    const view = new AuthView(model, elems);
    const events = [];
    view.publisher.on('input', d => events.push(d));

    const input = document.querySelector('input[name="login"]');
    input.value = 'Neo';
    // событие всплывает от инпута к форме, e.target === инпут
    input.dispatchEvent(new Event('change', { bubbles: true }));

    expect(events[0]).toEqual({ name: 'login', value: 'Neo' });
  });

  it('клик по enter эмитит enter', () => {
    const view = new AuthView(makeModel(), elems);
    const enterSpy = vi.fn();
    view.publisher.on('enter', enterSpy);

    document.getElementById('auth-enter').click();

    expect(enterSpy).toHaveBeenCalled();
  });

  it('событие ok модели скрывает форму', () => {
    const model = makeModel();
    new AuthView(model, elems);

    model.publisher.emit('ok');
    expect(document.getElementById('auth').style.display).toBe('none');
  });
});
