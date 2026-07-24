import { isValidNick } from '../../packages/auth/src/lib/validators.js';

describe('validators (auth)', () => {
  it('принимает корректный ник', () => {
    expect(isValidNick('Player1')).toBe(true);
    expect(isValidNick('a')).toBe(false); // короче двух символов не пропускает regexp
    expect(isValidNick('Ab')).toBe(true);
  });

  it('отклоняет ник с недопустимыми символами или неверным началом', () => {
    expect(isValidNick('1Player')).toBe(false); // не начинается с буквы
    expect(isValidNick('Pla!yer')).toBe(false); // недопустимый символ
    expect(isValidNick('')).toBe(false);
  });

  it('отклоняет не-строки', () => {
    expect(isValidNick(undefined)).toBe(false);
    expect(isValidNick(null)).toBe(false);
    expect(isValidNick(123)).toBe(false);
  });
});
