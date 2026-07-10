// Конфиг лобби (список серверов + умный пинг). Клиент проходит лобби ДО
// подключения к хосту, поэтому эти параметры бандлятся в сборку, а не приходят
// от хоста в CONFIG_DATA (как остальной клиентский конфиг).
export default {
  // REST-эндпоинт мастера со списком серверов (GET /servers)
  serversUrl: '/servers',

  // каталог карт мастера (Этап 5.1): комната хоста стартует на актуальных
  // картах, недоступность каталога — fallback на карты из бандла
  maps: {
    manifestUrl: '/maps/manifest.json',
    baseUrl: '/maps',
  },

  // манифест worker-бандла мастера (Этап 5.2): Worker комнаты создаётся по
  // url из манифеста, расхождение codeVersion при re-register — эстафета
  // Worker'ов; недоступность манифеста — бандловый URL без обновлений кода
  worker: {
    manifestUrl: '/worker/manifest.json',
  },

  // переподключение сигнального WS хоста (комната без него выпадает из
  // выдачи мастера): экспоненциальный бэкофф от baseDelay до maxDelay (мс)
  reconnect: {
    baseDelay: 1000,
    maxDelay: 30000,
  },

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
    nameId: 'lobby-name',
    hostBtnId: 'lobby-host',
  },

  // создание комнаты (хост в этой же вкладке)
  create: {
    defaultName: 'My Server',
    maxPlayers: 8,

    // период heartbeat/актуализации комнаты у мастера (мс); должен быть
    // меньше master.host.heartbeatTimeout (30 c), иначе комнату выметет
    heartbeatInterval: 10000,

    // socketId loopback-соединения хоста-игрока: по нему Worker исключает
    // хоста из kick-политик (его отключение = смерть комнаты для всех)
    hostSocketId: 'local',
  },
};
