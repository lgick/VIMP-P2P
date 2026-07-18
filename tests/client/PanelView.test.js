import { describe, it, expect, beforeEach, vi } from 'vitest';
import Publisher from '../../src/lib/Publisher.js';

// PanelView — синглтон, перезагружаем модуль для изоляции
let PanelView;

// схема панели: контейнер — движок, ячейки генерирует view по схеме игры
const config = {
  containerId: 'panel',
  elems: {
    time: 'panel-time',
    health: 'panel-health',
    weapons: { w1: 'panel-w1', w2: 'panel-w2' },
  },
};

const seedDom = () => {
  document.body.innerHTML = '<div id="panel"></div>';
};

const makeModel = () => ({ publisher: new Publisher() });

beforeEach(async () => {
  vi.resetModules();
  seedDom();
  PanelView = (await import('../../src/client/components/view/Panel.js'))
    .default;
});

describe('PanelView: генерация DOM по схеме', () => {
  it('строит ячейки в порядке health → оружие → time', () => {
    new PanelView(makeModel(), config);

    const cells = document.querySelectorAll('#panel table td');
    expect([...cells].map(c => c.id)).toEqual([
      'panel-health',
      'panel-w1',
      'panel-w2',
      'panel-time',
    ]);
  });
});

describe('PanelView.initHealthBar', () => {
  it('создаёт 30 блоков здоровья внутри обёртки', () => {
    new PanelView(makeModel(), config);

    const wrapper = document.querySelector('.panel-health-wrapper');
    expect(wrapper).not.toBeNull();
    expect(wrapper.querySelectorAll('.panel-health-block').length).toBe(30);
  });
});

describe('PanelView.update', () => {
  it('текстовая панель получает значение', () => {
    const view = new PanelView(makeModel(), config);

    view.update({ name: 'time', value: '02:30' });

    // happy-dom не хранит display: table-cell, проверяем смысловую часть
    expect(document.getElementById('panel-time').textContent).toBe('02:30');
  });

  it('полное здоровье подсвечивает все блоки', () => {
    const view = new PanelView(makeModel(), config);

    view.update({ name: 'health', value: 100 });

    const blocks = document.querySelectorAll('#panel-health div div');
    const filled = [...blocks].filter(
      b => b.className === 'panel-health-block',
    );
    expect(filled.length).toBe(30);
  });

  it('половина здоровья заполняет половину блоков', () => {
    const view = new PanelView(makeModel(), config);

    view.update({ name: 'health', value: 50 });

    const blocks = [...document.querySelectorAll('#panel-health div div')];
    const empty = blocks.filter(
      b => b.className === 'panel-health-block-empty',
    );
    expect(empty.length).toBe(15);
  });
});

describe('PanelView.hidePanel / setCurrentWeapon', () => {
  it('hidePanel скрывает указанную панель', () => {
    const view = new PanelView(makeModel(), config);

    view.hidePanel('time');
    expect(document.getElementById('panel-time').style.display).toBe('none');
  });

  it('setCurrentWeapon помечает активное оружие классом active', () => {
    const view = new PanelView(makeModel(), config);

    view.setCurrentWeapon('w2');

    expect(
      document.getElementById('panel-w1').classList.contains('active'),
    ).toBe(false);
    expect(
      document.getElementById('panel-w2').classList.contains('active'),
    ).toBe(true);
  });
});

describe('PanelView: события модели', () => {
  it('data → update, activeWeapon → setCurrentWeapon', () => {
    const model = makeModel();
    new PanelView(model, config);

    model.publisher.emit('data', { name: 'time', value: '01:00' });
    model.publisher.emit('activeWeapon', 'w1');

    expect(document.getElementById('panel-time').textContent).toBe('01:00');
    expect(
      document.getElementById('panel-w1').classList.contains('active'),
    ).toBe(true);
  });
});
