# Плагин simple3d для JOSM

Двусторонняя связь JOSM и 3D-редактора:

- редактор читает активный слой JOSM и узнаёт об изменениях сразу (долгий опрос, без настроек Remote Control);
- правки из 3D через ~0,3 с попадают в слой JOSM одной командой «3D editor (Simple3D)» — её видно в истории
  и отменяет Ctrl+Z (в JOSM или в редакторе, когда своих шагов истории в нём нет);
- отправка в OSM — как обычно, из JOSM.

Меню **Вид → Open in 3D editor (Simple3D)** (Ctrl+Alt+Shift+3) открывает редактор над текущим видом
(`?source=josm`). Страницу отдаёт сам плагин: `http://127.0.0.1:8112/editor/` — копия сайта редактора
(`simple3d.url`). Со страницы по https Safari не пускает запросы к `http://127.0.0.1`, а с того же адреса — пускает;
`simple3d.proxy=false` — открывать сайт напрямую (Chrome и Firefox так тоже работают). Без плагина редактор по-прежнему читает слой через Remote Control `/export` (только чтение).

## Протокол (127.0.0.1:8112, настройка `simple3d.port`)

| Запрос | Что делает |
|---|---|
| `GET /simple3d/status` | `{"plugin":"simple3d","protocol":1,"rev":N,"layer":true}` |
| `GET /simple3d/export[?since=N]` | слой в .osm, заголовок `X-Simple3D-Rev`; с `since` ждёт изменения до 25 с, иначе 204 |
| `GET /editor/…` | страница редактора с `simple3d.url` (прокси) |
| `POST /simple3d/undo`, `/simple3d/redo` | отмена и повтор в JOSM |
| `GET /api/0.6/{nodes,ways,relations}.json`, `/way/{id}/relations.json` | текущие объекты слоя (с правками) |
| `PUT /api/0.6/changeset/create`, `…/close`; `POST …/upload` | osmChange → команды JOSM, ответ diffResult (`new_id` — id в JOSM) |

Редактор отправляет в JOSM тем же кодом, что и в OSM (`src/osm/upload.ts`, параметр `to`).
Удаление — как `if-unused`: то, на что ещё ссылаются, не удаляется. Адрес редактора — настройка `simple3d.url`.

## Сборка и установка

```sh
JAVA_HOME=$(brew --prefix openjdk) ./build.sh        # JOSM_JAR=… — другой jar JOSM
cp build/simple3d.jar ~/Library/JOSM/plugins/        # Linux: ~/.local/share/JOSM/plugins/
```

Затем включить `simple3d` в Настройки → Модули и перезапустить JOSM.
