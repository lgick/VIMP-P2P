import { describe, it, expect, vi, beforeEach } from 'vitest';
import HostController from '../../src/client/network/HostController.js';
import LoopbackTransport from '../../src/client/network/LoopbackTransport.js';

// Юнит-тесты моста главного потока: HostController (роутер Worker↔клиенты)
// и LoopbackTransport (транспорт хоста-игрока поверх postMessage). Worker —
// фейк, сообщения Worker→main эмулируются вызовом worker.onmessage.

const makeFakeWorker = () => ({
  postMessage: vi.fn(),
  terminate: vi.fn(),
  onmessage: null,
  // эмуляция сообщения Worker → главный поток
  emit(data) {
    this.onmessage({ data });
  },
});

describe('HostController', () => {
  let worker;
  let controller;

  beforeEach(() => {
    worker = makeFakeWorker();
    controller = new HostController(
      { name: 'Room', map: 'pool_mini' },
      { workerFactory: () => worker },
    );
  });

  it('при создании шлёт init с настройками комнаты', () => {
    expect(worker.postMessage).toHaveBeenCalledWith({
      type: 'init',
      room: { name: 'Room', map: 'pool_mini' },
    });
  });

  it('open до ready ставит connect в очередь, после ready — отправляет', () => {
    controller.open('local', { onMessage: vi.fn(), onClose: vi.fn() });

    // до ready connect не ушёл
    expect(
      worker.postMessage.mock.calls.some(c => c[0].type === 'connect'),
    ).toBe(false);

    worker.emit({ type: 'ready' });

    expect(worker.postMessage).toHaveBeenCalledWith({
      type: 'connect',
      socketId: 'local',
    });
  });

  it('open после ready отправляет connect сразу', () => {
    worker.emit({ type: 'ready' });
    controller.open('s2', { onMessage: vi.fn(), onClose: vi.fn() });

    expect(worker.postMessage).toHaveBeenCalledWith({
      type: 'connect',
      socketId: 's2',
    });
  });

  it('to_client роутит payload и флаг reliable зарегистрированному клиенту', () => {
    const onMessage = vi.fn();

    controller.open('local', { onMessage, onClose: vi.fn() });
    worker.emit({
      type: 'to_client',
      socketId: 'local',
      payload: 'hello',
      reliable: true,
    });

    expect(onMessage).toHaveBeenCalledWith('hello', true);
  });

  it('close_client уведомляет клиента', () => {
    const onClose = vi.fn();

    controller.open('local', { onMessage: vi.fn(), onClose });
    worker.emit({
      type: 'close_client',
      socketId: 'local',
      code: 4005,
      data: [3],
    });

    expect(onClose).toHaveBeenCalledWith(4005, [3]);
  });

  it('send пересылает сообщение клиента в Worker', () => {
    controller.send('local', '[5,"1:down:forward"]');

    expect(worker.postMessage).toHaveBeenCalledWith({
      type: 'message',
      socketId: 'local',
      data: '[5,"1:down:forward"]',
    });
  });

  it('disconnect убирает клиента и шлёт в Worker', () => {
    const onMessage = vi.fn();

    controller.open('local', { onMessage, onClose: vi.fn() });
    controller.disconnect('local');

    expect(worker.postMessage).toHaveBeenCalledWith({
      type: 'disconnect',
      socketId: 'local',
    });

    // после отключения доставка не идёт
    worker.emit({ type: 'to_client', socketId: 'local', payload: 'x' });
    expect(onMessage).not.toHaveBeenCalled();
  });

  it('destroy останавливает Worker', () => {
    controller.destroy();
    expect(worker.terminate).toHaveBeenCalled();
  });
});

describe('LoopbackTransport', () => {
  let worker;
  let controller;
  let transport;

  beforeEach(() => {
    worker = makeFakeWorker();
    controller = new HostController(
      { name: 'Room' },
      { workerFactory: () => worker },
    );
    transport = new LoopbackTransport(controller, 'local');
    worker.emit({ type: 'ready' });
  });

  it('connect регистрирует клиента и поднимает соединение', () => {
    transport.connect();

    expect(worker.postMessage).toHaveBeenCalledWith({
      type: 'connect',
      socketId: 'local',
    });
  });

  it('входящие кадры Worker эмитятся событием message', () => {
    const onMessage = vi.fn();

    transport.publisher.on('message', onMessage);
    transport.connect();

    worker.emit({ type: 'to_client', socketId: 'local', payload: 'frame' });

    expect(onMessage).toHaveBeenCalledWith('frame');
  });

  it('send пересылает данные через контроллер', () => {
    transport.connect();
    transport.send('[6,"hi"]');

    expect(worker.postMessage).toHaveBeenCalledWith({
      type: 'message',
      socketId: 'local',
      data: '[6,"hi"]',
    });
  });

  it('close эмитит close один раз и отключает клиента', () => {
    const onClose = vi.fn();

    transport.publisher.on('close', onClose);
    transport.connect();

    transport.close();
    transport.close();

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(worker.postMessage).toHaveBeenCalledWith({
      type: 'disconnect',
      socketId: 'local',
    });
  });

  it('close_client из Worker закрывает транспорт', () => {
    const onClose = vi.fn();

    transport.publisher.on('close', onClose);
    transport.connect();

    worker.emit({ type: 'close_client', socketId: 'local', code: 4005 });

    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
