// Шапка заметки урока: дата повтора во frontmatter и сводка под заголовком.
// Обе части выводятся из последнего «## Итог», который хук дописал в заметку,
// поэтому наставнику не нужно править заметку руками.

const SUMMARY_HEADING = /^## Итог(\s|$)/;
const REVIEW_LINE = /\*\*Повтор:\*\*\s*через\s+(\d+)/;
const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;
const REVIEW_FIELD = /^повтор:.*$/m;
const SUMMARY_BLOCK = /%% сводка[^\n]*%%\n[\s\S]*?%% \/сводка %%\n*/;

const pad = (n) => String(n).padStart(2, '0');
const isoDate = (date) => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
const ruDate = (date) => `${pad(date.getDate())}.${pad(date.getMonth() + 1)}.${date.getFullYear()}`;

function addDays(date, days) {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

// Итог — список под заголовком и карта после него. Обычный абзац после
// списка или закрытая карта завершают итог.
function summaryLines(lines) {
  const body = [];
  let inFence = false;
  for (const line of lines) {
    if (inFence) {
      body.push(line);
      if (line.startsWith('```')) break;
    } else if (line.startsWith('```')) {
      inFence = true;
      body.push(line);
    } else if (line === '' || /^(\s|-)/.test(line)) {
      body.push(line);
    } else {
      break;
    }
  }
  return body;
}

// Последний итог в markdown → { body, reviewDays } или null.
export function extractSummary(markdown) {
  const lines = markdown.split('\n');
  const start = lines.findLastIndex((line) => SUMMARY_HEADING.test(line));
  if (start === -1) return null;
  const body = summaryLines(lines.slice(start + 1)).join('\n').trim();
  const days = body.match(REVIEW_LINE);
  return { body, reviewDays: days ? Number(days[1]) : null };
}

function withReviewDate(frontmatter, date) {
  const field = `повтор: ${isoDate(date)}`;
  return REVIEW_FIELD.test(frontmatter) ? frontmatter.replace(REVIEW_FIELD, field) : `${frontmatter}\n${field}`;
}

// Заголовок ищется только до первого блока кода или сессии: «# комментарий»
// внутри кода урока заголовком не считается.
function insertAfterTitle(rest, block) {
  const limit = rest.search(/^(```|### )/m);
  const head = limit === -1 ? rest : rest.slice(0, limit);
  const title = head.match(/^# .*$/m);
  if (!title) return `\n${block}\n\n${rest.replace(/^\n+/, '')}`;
  const end = title.index + title[0].length;
  return `${rest.slice(0, end)}\n\n${block}\n\n${rest.slice(end).replace(/^\n+/, '')}`;
}

// Текст заметки → новый текст с датой повтора и свежей сводкой.
export function applyHead(text, summary, now) {
  const match = text.match(FRONTMATTER);
  const frontmatter = match
    ? `---\n${summary.reviewDays === null ? match[1] : withReviewDate(match[1], addDays(now, summary.reviewDays))}\n---\n`
    : '';
  const rest = (match ? text.slice(match[0].length) : text).replace(SUMMARY_BLOCK, '');
  const block = [
    '%% сводка: хук tutor пишет её сам %%',
    `## Сводка · итог ${ruDate(now)}`,
    summary.body,
    '%% /сводка %%',
  ].join('\n');
  return frontmatter + insertAfterTitle(rest, block);
}
