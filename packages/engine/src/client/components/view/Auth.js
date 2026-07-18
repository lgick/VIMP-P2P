import Publisher from '../../../lib/Publisher.js';

// Singleton AuthView

let authView;

export default class AuthView {
  constructor(model, elems) {
    if (authView) {
      return authView;
    }

    authView = this;

    this._mPublic = model.publisher;

    this._auth = document.getElementById(elems.authId);
    this._form = document.getElementById(elems.formId);
    this._error = document.getElementById(elems.errorId);
    this._enter = document.getElementById(elems.enterId);

    this.publisher = new Publisher();

    // действие с инпутами
    this._form.onchange = e => {
      const tg = e.target;

      if (tg.tagName === 'INPUT') {
        this.publisher.emit('input', {
          name: tg.name,
          value: tg.value,
        });
      }
    };

    // форма заполнена
    this._enter.onclick = () => {
      authView.publisher.emit('enter');
    };

    this._mPublic.on('form', 'renderData', this);
    this._mPublic.on('error', 'renderError', this);
    this._mPublic.on('ok', 'hideAuth', this);
  }

  // показывает форму
  showAuth() {
    this._auth.style.display = 'block';
  }

  // скрывает форму
  hideAuth(data) {
    if (data) {
      data.forEach(item => {
        localStorage[item.name] = item.value;
      });
    }

    this._auth.style.display = 'none';
  }

  // обновляет форму
  renderData(data) {
    const { name, value } = data;
    const inputs = this._form.querySelectorAll('input');

    this._error.textContent = '';

    // делает активным нужный инпут
    inputs.forEach(input => {
      if (input.type === 'text' && input.name === name) {
        input.value = value;
      }

      if (input.type === 'radio' && input.name === name) {
        input.checked = input.value === value ? true : false;
      }
    });
  }

  // отображает ошибки
  renderError(data) {
    this._error.textContent = '';

    data.forEach(item => {
      const name = item.name.toUpperCase();
      const err = item.error;
      const line = document.createElement('div');

      line.textContent = err ? `${name}: ${err}` : `${name} is not correctly!`;

      this._error.appendChild(line);
    });
  }
}
