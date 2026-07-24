// продублировано из packages/engine/src/lib/validators.js (plan/auth_b1.md:
// "вынести в общий пакет или продублировать") — auth-сервис живёт в
// отдельном workspace без рантайм-зависимости на движок, дублирование проще
// общего пакета на этом этапе
const NAME_REGEXP = new RegExp('^[a-zA-Z]([\\w\\s#]{0,13})[\\w]{1}$');

export const isValidNick = nick => typeof nick === 'string' && NAME_REGEXP.test(nick);
