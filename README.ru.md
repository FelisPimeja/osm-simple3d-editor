# OSM Simple 3D Editor

[English](README.md) · **Русский**

Браузерный 3D-редактор зданий для OpenStreetMap по схеме [Simple 3D Buildings](https://wiki.openstreetmap.org/wiki/Simple_3D_Buildings).
Также работает с OpenHistoricalMap и OpenGeofiction.

Открыть редактор: https://felispimeja.github.io/osm-simple3d-editor/

## Языки интерфейса

Русский и английский. Язык выбирается в панели настроек; при первом запуске — по языку браузера и системы
(русский для ru, иначе английский).

Строки интерфейса пишутся в коде по-русски через `tr('…')` / `trn(n, '…')` (см. `src/i18n/index.ts`) и служат
ключами перевода. Словари — плоские JSON в `src/i18n/locales/`: `ru.json` — исходный файл (собирается из кода
командой `npm run i18n:extract`), `en.json` — перевод. `npm run i18n:check` проверяет, что английский перевод
полный, лишних строк нет, а подстановки `{…}` совпадают. Строки с числом содержат формы через `|`
(русские — для 1, 2, 5; английские — для 1 и остальных).

## Лицензия

Код распространяется по лицензии [ISC](LICENSE). Данные карты — по лицензиям соответствующих проектов
(ODbL у OpenStreetMap и OpenHistoricalMap, своя у OpenGeofiction).
