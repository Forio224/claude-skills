---
tags:
  - учёба
---

# 🕳️ Пробелы — карта

Собирается сама из строк `**Где застрял:**` в заметках папки `Журнал`. Своей базы нет: единственный источник правды — заметка дня, здесь только взгляд на неё сверху. Запросам нужен плагин Obsidian **Dataview**.

Строки пишет `/learned` в конце учебной сессии, возвращает к ним `/recall` в начале следующей.

> [!info] Как читать
> **Раз ≥ 3 по одной теме — это не «забыл», а дыра.** Такую тему разбирают отдельно и целиком, а не ещё раз по ходу задачи.

## Темы по частоте

```dataview
TABLE WITHOUT ID
  тег AS "Тема",
  length(rows) AS "Раз",
  rows.L.text AS "Остановки"
FROM "Журнал"
FLATTEN file.lists AS L
FLATTEN L.tags AS тег
WHERE startswith(тег, "#пробел/")
GROUP BY тег
SORT length(rows) DESC
```

## Вопросы без ответа

```dataview
TABLE WITHOUT ID
  file.link AS "День",
  L.text AS "Вопрос"
FROM "Журнал"
FLATTEN file.lists AS L
WHERE contains(L.tags, "#вопрос")
SORT file.name DESC
```

## Переходы, оставшиеся как `?`

Строки, где не записано, **в чём был ключевой переход**. Закрываются на `/recall`, когда ответ вспомнился.

```dataview
TABLE WITHOUT ID
  file.link AS "День",
  L.text AS "Остановка"
FROM "Журнал"
FLATTEN file.lists AS L
WHERE contains(L.text, "— ?")
SORT file.name DESC
```
