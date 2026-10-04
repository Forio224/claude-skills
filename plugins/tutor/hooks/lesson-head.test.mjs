// Тесты шапки заметки урока. Запуск: node --test "plugins/tutor/hooks/*.test.mjs"
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractSummary, applyHead } from './lesson-head.mjs';

const SUMMARY = [
  '## Итог',
  '- **Цель:** узнавать окно',
  '- **Держится:**',
  '  - подмассив = отрезок подряд',
  '- **Повтор:** через 3 дн.',
  '',
  '```mermaid',
  'graph TD',
  '',
  '    A["✓ Подмассив"] --> B["~ Монотонность"]',
  '```',
].join('\n');

const NOTE = '---\nтип: урок\nтема: Окно\ncreated: 2026-10-04\n---\n\n# Скользящее окно\n\n### Сессия 04.10.2026 14:13\n\nтекст урока\n';
const NOW = new Date(2026, 9, 4, 18, 30);

// --- extractSummary ---

test('extractSummary: итог от заголовка до конца карты, текст после неё не входит', () => {
  const markdown = `\nВопрос был такой.\n\n${SUMMARY}\n\nХук перенесёт это в заметку.\n`;
  const summary = extractSummary(markdown);
  assert.equal(summary.body, SUMMARY.split('\n').slice(1).join('\n'));
  assert.equal(summary.reviewDays, 3);
});

test('extractSummary: без карты итог кончается вместе со списком', () => {
  const markdown = '## Итог\n- **Цель:** x\n  - вложенный пункт\n\nДальше обычный текст.';
  assert.equal(extractSummary(markdown).body, '- **Цель:** x\n  - вложенный пункт');
});

test('extractSummary: берётся последний итог, «Итог (обновлён)» тоже итог', () => {
  const markdown = '## Итог\n- **Повтор:** через 1 дн.\n\nещё урок\n\n## Итог (обновлён)\n- **Повтор:** через 7 дн.';
  const summary = extractSummary(markdown);
  assert.equal(summary.body, '- **Повтор:** через 7 дн.');
  assert.equal(summary.reviewDays, 7);
});

test('extractSummary: нет итога — null; нет строки повтора — reviewDays null', () => {
  assert.equal(extractSummary('просто объяснение\n\n## Узел 2'), null);
  assert.equal(extractSummary('## Итог\n- **Цель:** x').reviewDays, null);
});

// --- applyHead ---

test('applyHead: ставит повтор в шапку и сводку под заголовком', () => {
  const text = applyHead(NOTE, { body: '- **Цель:** x', reviewDays: 3 }, NOW);
  assert.match(text, /^---\nтип: урок\nтема: Окно\ncreated: 2026-10-04\nповтор: 2026-10-07\n---\n/);
  assert.match(text, /# Скользящее окно\n\n%% сводка: хук tutor пишет её сам %%\n## Сводка · итог 04\.10\.2026\n- \*\*Цель:\*\* x\n%% \/сводка %%\n\n### Сессия/);
});

test('applyHead: повторный вызов заменяет и дату, и сводку, а не дописывает', () => {
  const first = applyHead(NOTE, { body: 'старая', reviewDays: 1 }, NOW);
  const second = applyHead(first, { body: 'новая', reviewDays: 7 }, new Date(2026, 9, 6, 9, 0));
  assert.equal(second.match(/повтор:/g).length, 1);
  assert.match(second, /повтор: 2026-10-13/);
  assert.equal(second.match(/%% сводка/g).length, 1);
  assert.doesNotMatch(second, /старая/);
  assert.match(second, /## Сводка · итог 06\.10\.2026\nновая/);
  assert.match(second, /текст урока\n$/);
});

test('applyHead: без строки повтора дата в шапке не трогается', () => {
  const withDate = NOTE.replace('created: 2026-10-04', 'created: 2026-10-04\nповтор: 2026-10-05');
  const text = applyHead(withDate, { body: 'x', reviewDays: null }, NOW);
  assert.match(text, /повтор: 2026-10-05/);
});

test('applyHead: заметка без заголовка — сводка сразу после шапки', () => {
  const text = applyHead('---\nтип: урок\n---\nтекст\n', { body: 'x', reviewDays: null }, NOW);
  assert.match(text, /^---\nтип: урок\n---\n\n%% сводка: хук tutor пишет её сам %%\n## Сводка · итог 04\.10\.2026\nx\n%% \/сводка %%\n\nтекст\n$/);
});
