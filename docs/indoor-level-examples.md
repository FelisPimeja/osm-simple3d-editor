# `indoor=level`: `height` и `level:ref` в реальных данных

Примеры для отладки отметок этажей и рендера поэтажных планов. Собрано через Overpass 2026-10-26
(`nwr["indoor"="level"]["height"]["level:ref"]`, выборка не полная — Overpass упёрся в лимит).

По вики ([Simple Indoor Tagging](https://wiki.openstreetmap.org/wiki/Simple_Indoor_Tagging),
[Tag:indoor=level](https://wiki.openstreetmap.org/wiki/Tag:indoor%3Dlevel)) `height` на `indoor=level` — высота
самого этажа, а не отметка пола. В данных встречается и то и другое, `level:ref` — то номер, то обозначение,
то название.

| Объект | Где | `level` | `height` | `level:ref` / `name` | Как читать |
|---|---|---|---|---|---|
| [way/666671144](https://www.openstreetmap.org/way/666671144)…[147](https://www.openstreetmap.org/way/666671147), здание [relation/9160538](https://www.openstreetmap.org/relation/9160538) | Москва, школа «Летово» | −1, 0, 1, 2 | 0, 4.2, 8.4, 12.6 | 0, 1, 2, 3 | `indoor=level` совмещён с `building:part` (+ `building:levels=1`): `height` — верх части по Simple 3D. Как высоту этажа не читаем и не правим |
| [way/737021540](https://www.openstreetmap.org/way/737021540), [737021539](https://www.openstreetmap.org/way/737021539), [737021541](https://www.openstreetmap.org/way/737021541) | Швейцария (47.1917, 8.4779) | 0, 1, 3 | 3, 5, 5 | Untere / Mittlere / Obere Verkaufsebene | высота этажа, как в вики; `level:ref` — название; уровня 2 нет |
| [way/762088042](https://www.openstreetmap.org/way/762088042) | Нант (47.2168, −1.5424) | 2 | `19.6 m` | 2, `name=Mezzanine` | похоже на отметку, а не высоту; с единицами. Вне 2–10 м — отбрасывается |
| [way/158249936](https://www.openstreetmap.org/way/158249936), [way/864834636](https://www.openstreetmap.org/way/864834636) | Берлин (52.364, 13.509) | 1, 0 | 10, 3 | E0, U1 | обозначения этажей (E — Erdgeschoss, U — Untergeschoss) не совпадают с `level`; 10 м — на границе |
| [way/810841014](https://www.openstreetmap.org/way/810841014), [way/810841015](https://www.openstreetmap.org/way/810841015) | Мичиган (42.492, −83.470) | 0, 1 | 5, 5 | 1, 2 | высота этажа; `level:ref` — американская нумерация (первый этаж = 1) |
| [way/1177129411](https://www.openstreetmap.org/way/1177129411) | Сан-Паулу (−23.626, −46.580) | 0 | 10 | L1, `name=Térreo` | высокий первый этаж ТЦ |

## Что из этого следует для редактора

- `height` на `indoor=level` с `building:part` или `building` — по Simple 3D, не высота этажа (`src/osm/levels.ts`).
- Высоты вне 2–10 м отбрасываются: отсекают отметки (12.6, 19.6 m) и высоту всего здания.
- `height` с единицами (`19.6 m`) — `parseFloat` читает число; метры по умолчанию.
- `level:ref` показываем как есть («Этаж E0», «Этаж Untere Verkaufsebene» — длинные названия лучше в `name`).
- Пропуски уровней (0, 1, 3) — этаж 2 достраивается от соседей.

## Дальше проверить

- Выборку целиком, когда Overpass отпустит: доля «высот» и «отметок», отношения (`relation`) с `indoor=level`.
