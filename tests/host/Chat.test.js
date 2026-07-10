import { describe, it, expect, beforeEach, vi } from 'vitest';
import { buildSystemMessage } from '../../src/host/meta/modules/chat/systemMessages.js';

// Chat — синглтон, перезагружаем модуль для изоляции
let Chat;

beforeEach(async () => {
  vi.resetModules();
  Chat = (await import('../../src/host/meta/modules/chat/Chat.js')).default;
});

describe('buildSystemMessage', () => {
  it('без параметров возвращает код сообщения', () => {
    expect(buildSystemMessage('USER_JOINED')).toBe('s:5');
  });

  it('с параметрами добавляет их через запятую', () => {
    expect(buildSystemMessage('NAME_CHANGED', ['Alice', 'Bob'])).toBe(
      'n:1:Alice,Bob',
    );
  });

  it('неизвестный ключ даёт undefined (текущее поведение)', () => {
    expect(buildSystemMessage('NOPE')).toBeUndefined();
  });
});

describe('Chat: общий список', () => {
  it('push/shift в порядке FIFO', () => {
    const chat = new Chat();
    chat.push('hello', 'Alice', 1);
    chat.push('world', 'Bob', 2);

    expect(chat.shift()).toEqual(['hello', 'Alice', 1]);
    expect(chat.shift()).toEqual(['world', 'Bob', 2]);
    expect(chat.shift()).toBeUndefined();
  });

  it('pushSystem со строкой разворачивает шаблон', () => {
    const chat = new Chat();
    chat.pushSystem('USER_LEFT', ['Carol']);
    expect(chat.shift()).toBe('s:6:Carol');
  });

  it('pushSystem с массивом сохраняет как есть', () => {
    const chat = new Chat();
    chat.pushSystem(['raw message']);
    expect(chat.shift()).toEqual(['raw message']);
  });
});

describe('Chat: персональные списки', () => {
  it('pushSystemByUser/shiftByUser по gameId', () => {
    const chat = new Chat();
    chat.addUser('g1');

    chat.pushSystemByUser('g1', 'VOTE_ACCEPTED');
    expect(chat.shiftByUser('g1')).toBe('v:2');
  });

  it('removeUser удаляет персональный список', () => {
    const chat = new Chat();
    chat.addUser('g1');
    chat.removeUser('g1');
    expect(chat._userList.g1).toBeUndefined();
  });
});
