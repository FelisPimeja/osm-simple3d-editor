# Плагин simple3d — разработка

Для пользователей — [README.md](README.md). Здесь — как плагин устроен, протокол, выпуск и сборка.

Двусторонняя связь JOSM и 3D-редактора:

- редактор читает активный слой JOSM и узнаёт об изменениях сразу (долгий опрос, без настроек Remote Control);
- правки из 3D через ~0,3 с попадают в слой JOSM одной командой «3D editor (Simple3D)» — её видно в истории
  и отменяет Ctrl+Z (в JOSM или в редакторе, когда своих шагов истории в нём нет);
- отправка в OSM — как обычно, из JOSM.

Меню **Вид → Open in 3D editor (Simple3D)** (Ctrl+Alt+Shift+3) открывает редактор над текущим видом
(`?source=josm`). Страницу отдаёт сам плагин: `http://127.0.0.1:8112/editor/` — копия сайта редактора
(`simple3d.url`). Со страницы по https Safari не пускает запросы к `http://127.0.0.1`, а с того же адреса — пускает;
`simple3d.proxy=false` — открывать сайт напрямую (Chrome и Firefox так тоже работают). Без плагина редактор по-прежнему читает слой через Remote Control `/export` (только чтение).

Выделение общее: выбранное в JOSM выделяется в 3D и наоборот (объект, которого нет в 3D, там просто снимает
выделение). Панель правок в редакторе показывает неотправленные объекты слоя JOSM, кнопки отмены — команды JOSM
(имя команды — комментарий, который редактор предлагает к правке). Вместо входа в OSM — пользователь JOSM.

Обращаться к плагину могут только сайт редактора (`simple3d.url`), страницы с `localhost`/`127.0.0.1` и сайты из
`simple3d.origins` (через запятую): иначе любой открытый сайт мог бы читать и менять данные в JOSM.

## Протокол (127.0.0.1:8112, настройка `simple3d.port`)

| Запрос | Что делает |
|---|---|
| `GET /simple3d/status` | `{"plugin":"simple3d","protocol":1,"rev":N,"layer":true}` |
| `GET /simple3d/export[?since=N]` | слой в .osm, заголовок `X-Simple3D-Rev`; с `since` ждёт изменения до 25 с, иначе 204 |
| `GET /editor/…` | страница редактора с `simple3d.url` (прокси) |
| `GET /simple3d/selection[?since=N]`, `POST /simple3d/selection` | выделение в JOSM (ключи `way/1,relation/2`); GET с `since` ждёт изменения |
| `POST /simple3d/undo`, `/simple3d/redo` | отмена и повтор в JOSM |
| `GET /api/0.6/{nodes,ways,relations}.json`, `/way/{id}/relations.json` | текущие объекты слоя (с правками) |
| `PUT /api/0.6/changeset/create`, `…/close`; `POST …/upload` | osmChange → команды JOSM, ответ diffResult (`new_id` — id в JOSM) |

Редактор отправляет в JOSM тем же кодом, что и в OSM (`src/osm/upload.ts`, параметр `to`).
Удаление — как `if-unused`: то, на что ещё ссылаются, не удаляется. Адрес редактора — настройка `simple3d.url`.

## Выпуск

Тег `josm-plugin-vN` или `josm-plugin-vN.M` (`Plugin-Version` = `N` / `N.M`; JOSM обновляет модуль, если версия в списке
не совпадает с установленной — сравнивает как строки, поэтому номер только растёт и не повторяется) — workflow
[josm-plugin.yml](../.github/workflows/josm-plugin.yml) собирает jar на `josm-tested.jar` и выкладывает релиз:

```sh
git tag josm-plugin-v3 && git push origin josm-plugin-v3
```

Без тега workflow только проверяет сборку (изменения в `josm-plugin/`). Сайт редактора от плагина не зависит:
`pages.yml` такие изменения пропускает.

**Протокол.** `PROTOCOL` в `BridgeServer.java` растёт, когда редактору нужно новое от плагина; минимальная версия,
с которой работает редактор, — `MIN_PROTOCOL` в `src/osm/josm.ts`. Со старым плагином редактор просит обновить его.
Поднимая `MIN_PROTOCOL`, сначала выпустите плагин: сайт обновляется сразу, плагин у пользователей — нет.

## Сборка вручную

```sh
JAVA_HOME=$(brew --prefix openjdk) ./build.sh        # JOSM_JAR=… — другой jar JOSM, PLUGIN_VERSION=… — версия
cp build/simple3d.jar ~/Library/JOSM/plugins/
```
