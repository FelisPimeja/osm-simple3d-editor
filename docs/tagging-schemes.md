# Схемы тегирования OSM в редакторе

Рабочий документ: какие схемы редактор уже читает и пишет, где в них противоречия и что можно поддержать
в будущем. Цифры использования — taginfo на 2026-11-24/25. Состояние кода — коммит `9ce0916`.

Подробности по отдельным темам: [indoor-stairs.md](indoor-stairs.md) (лестницы, эскалаторы, лифты),
[indoor-level-examples.md](indoor-level-examples.md), [3d-bridges-tunnels.md](3d-bridges-tunnels.md).

## 1. Что поддерживается сейчас

### Здания и части (Simple 3D Buildings)

- Объём: `building`, `building:part`, `height`, `min_height`, `building:levels`, `building:min_level`,
  `building:levels:underground`, `roof:levels`.
- Крыша: `roof:shape`, `roof:height`, `roof:direction`, `roof:orientation`, `roof:colour`, `roof:material`.
  На любом полигоне строятся `flat`, `pyramidal`, `cone`, `dome`, `onion`, `skillion`, `apse_gabled`
  (`src/render/building-geometry.ts`). Направление апсиды без тега выводится в `src/osm/apse.ts`.
- Отделка: `building:colour`, `building:material` (и опечатки `building:color`, `roof:color`).
- Время: `start_date`, `end_date`, `demolished:building`.

### Indoor (Simple Indoor Tagging)

- `indoor=room|area|corridor|wall|door|window`, `level`, `repeat_on`, `level:ref`.
- Вертикальные связи: `stairs=yes`, `highway=steps`, `highway=elevator`, `conveying=*`, `step_count`,
  `incline`, `handrail`, `handrail:left/right/center` — см. [indoor-stairs.md](indoor-stairs.md).

### Входы и двери

- Вход на контуре: `entrance=*`, `amenity=parking_entrance` (как `garage`), `indoor=door` на стене
  (как `entrance=yes`) — `src/osm/model.ts`, `facadeEntranceOf`.
- Карточка входа: `entrance`, `ref`, `addr:flats`, `covered` (ключи входа), затем ключи двери `door`, `door:wings`, `level`, `width`, `height`, `material`, `colour`.
- Также читаются `door:width`, `door:height`.
- `covered=yes` на входе — наша интерпретация (другие 3D-рендеры её не знают): белый козырёк над дверью шириной
  на 0,5 м больше входа (у `entrance=staircase` — на 1 м), вынос 1 м, толщина 0,2 м. Низ — 2,5 м от порога, но не выше двери + 0,3 м и не выше
  этажа − 0,2 м; не ниже верха двери. Не рисуется, если перед дверью уже есть отдельная крыша
  (`building=roof` / `building:part=roof`), у входа `indoor=yes` (вход внутри здания) или `tunnel=*`.
  Своих ключей для размеров козырька не вводим.

### Окна

- Точка окна или шаблон окон части: `window`, `window:shape`, `window:top:shape`, `window:material`,
  `window:width`, `window:height`, `window:breast`, `window:panes` (переплёт `NxM`), `level`.
- Генерация рядов окон на части по `window:*` — `src/render/window-gen.ts`.

### Проезды и тоннели

- `tunnel=building_passage`: вырез в здании по `width` и `maxheight`, форма в карточке (Shape).
- Дороги, мосты, тоннели (ветка экспериментов): `highway`, `railway`, `bridge`, `tunnel`, `layer`, `lanes`,
  ширина `width → est_width → maxwidth:physical → maxwidth → lanes × 3 м`, высота `maxheight:physical → maxheight`
  (`src/osm/roads.ts`).

### Прочее

- Ограждения: `barrier=*`, `fence_type`, `height`, `width → maxwidth:physical → maxwidth`
  (`src/osm/barriers.ts`).
- Деревья и растительность: `natural=tree`, `height`, `diameter_crown`, `diameter`.

## 2. Противоречия в существующих схемах

### Окно и дверь устроены по-разному

| Аспект | Окно | Дверь |
|---|---|---|
| Размеры | `window:width/height/breast` | голые `width`/`height` |
| Форма контура | `window:shape` | нет |
| Завершение | `window:top:shape` | нет (`door:top:shape` — 2 использования) |
| Членения | `window:panes` (596) | `door:wings` (23 тыс., только створки) |
| Заполнение | `window:material` | `material` |
| Главный ключ | `window=*` — почти без смысла | `door=*` — способ открывания и конструкция |

### Префикс нужен только на носителе

На точке `indoor=window`/`indoor=door` префикс лишний: на одном узле не бывает и окна, и двери. Голые
`width`, `height`, `material` там однозначны.

Префикс оправдан на носителе (здание, часть, стена): `window:width` на `building:part` — это шаблон окон,
а `height` там — высота самой части.

Правило: на объекте-проёме — голые ключи, на носителе — с префиксом. При чтении понимать оба варианта.
Исключение — форма: голый `shape` (77 тыс.) занят под люки, гидранты и статуи, для проёмов его брать нельзя.

### `window:shape` и `window:top:shape` пересекаются

- `window:shape` (1094): `rectangle` 822, `square` 97, `circle` 94, `semicircle` 23, а также `dome` 14 и
  `pointed` 11 — это прямоугольник с завершением, записанный как форма целиком.
- `window:top:shape` (266): `semicircle` 107, `arc` 68, `square` 41 (плоский верх), `pointed` 22,
  `gothic` 20 (= `pointed`), `triangle` 1. Словарь не устоялся.

## 3. Предложение: общий профиль проёма

Одна модель для окон, дверей, проездов и тоннелей:

- **Замкнутая форма** — для непрямоугольных проёмов: `circle`, `oval`, `semicircle` (люнет). По умолчанию
  `rectangle`.
- **Прямоугольник + завершение** — `…:top:shape` и подъём `…:top:height`.
- **Высота** — полная, до верхней точки (замка арки). `maxheight` — дорожный габарит, не высота проёма.

Значения завершения: `flat` (по умолчанию), `semicircle`, `segmental`, `pointed`, `triangle`, `ogee`/`onion`,
`horseshoe`. Синонимы при чтении: `square` → `flat`, `arc` → `segmental`, `gothic` → `pointed`;
`window:shape=pointed|dome` → прямоугольник + соответствующее завершение.

Подъём по умолчанию из формы: полукруг — `width/2`, стрельчатая — около `0.87·width`,
треугольник — около `width/3`.

| | Замкнутая форма | Завершение | Размеры | Членения |
|---|---|---|---|---|
| Окно | `window:shape` | `window:top:shape` | `window:width/height/breast` | `window:panes` |
| Дверь | — (всегда прямоугольник) | `door:top:shape` (новое) | `width`/`height` | `door:wings` |
| Проезд в здании | — | `tunnel:top:shape` (новое) | `tunnel:width`, `tunnel:height` | — |
| Тоннель | `tunnel:profile` (есть) | `tunnel:top:shape` (новое) | `tunnel:width`, `tunnel:height` | — |

### Проезды и тоннели

Подворотня — частный случай тоннеля (`tunnel=building_passage`), поэтому сечение задаётся через `tunnel:*`:

```
tunnel=building_passage
tunnel:width=3.5          ← ширина проёма (≠ width: ширина дороги)
tunnel:height=4.2         ← полная высота, в замке
tunnel:top:shape=semicircle
tunnel:top:height=1.75    ← опционально
maxheight=3.6             ← дорожный габарит
```

- Чтение ширины: `tunnel:width → width → lanes × ширина полосы → по умолчанию`.
  Высоты: `tunnel:height → maxheight:physical → maxheight`.
- Несколько линий под одной аркой (дорога и тротуар, разрезанный путь): теги дублируются, берётся максимум.
  Для настоящих тоннелей естественное место сечения — `man_made=tunnel`.
- Использование пока минимальное: `tunnel:profile` 517 (`round` 416, `rectangular` 37, `box` 23,
  `semi-elliptical` 16, `horseshoe` 15), `tunnel:height` 85, `tunnel:shape` 3, `tunnel:top:*` 0. Это по сути
  proposal. Обсуждение — ветка форума «Definitions and proposals for coding 3D renderers», пост Zkir #19
  (topic 149818).
- По умолчанию в редакторе оставить прямоугольник: подворотни советской застройки в основном прямоугольные.

## 4. TODO

- [ ] **Пожарные вертикальные лестницы на фасаде** — проработать вариант точкой на контуре здания:
  `highway=ladder` + `emergency=fire_escape` (+ `level`/`height` — верх лестницы, `min_height` — низ).
  Сейчас схемы нет: `emergency=fire_escape` 4, `fire_escape=*` 1, `emergency=ladder` 9, `ladder:type` 6,
  `ladder:cage` 0. `highway=ladder` (2,6 тыс.) обычно размечают линией маршрута, а не точкой — нужно
  решить, что такое точка на фасаде: место лестницы с высотой или вырожденный путь. Смежное и про другое:
  `emergency=ladder_site` (630, площадка для пожарной автолестницы), `emergency=rescue_ladder` (59, у воды),
  `ladder=yes` (13 тыс., почти всё — охотничьи вышки). Маршевые наружные лестницы — `highway=steps` +
  `location=outdoor`, площадки — `building:part=balcony`. Перед реализацией проверить вики и форум.
- [ ] Читать `tunnel:width`, `tunnel:height`, `tunnel:top:shape`, `tunnel:top:height` в вырезе проезда —
  после обсуждения на форуме.
- [ ] Завершение проёма у дверей (`door:top:shape`) — после согласования словаря с окнами.
- [ ] Нормализация синонимов `window:top:shape` и `window:shape=pointed|dome` при чтении.
