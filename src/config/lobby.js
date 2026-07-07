// Конфиг лобби (список серверов + умный пинг). Клиент проходит лобби ДО
// подключения к хосту, поэтому эти параметры бандлятся в сборку, а не приходят
// от хоста в CONFIG_DATA (как остальной клиентский конфиг).
export default {
  // REST-эндпоинт мастера со списком серверов (GET /servers)
  serversUrl: '/servers',

  // размер страницы для «Загрузить ещё» (offset/limit к мастеру)
  pageSize: 10,

  // минимальный интервал повторного пинга одного сервера (мс):
  // защита от спама ping_host при перерисовке/скролле списка
  pingInterval: 5000,

  // DOM-элементы лобби (из lobby.pug)
  elems: {
    lobbyId: 'lobby',
    listId: 'lobby-list',
    searchId: 'lobby-search',
    moreId: 'lobby-more',
    emptyId: 'lobby-empty',
  },
};
