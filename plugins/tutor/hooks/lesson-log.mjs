#!/usr/bin/env node
// Зеркало урока tutor в заметку Obsidian.
//
//   node lesson-log.mjs bind   — PostToolUse(Write|Read): наставник создал или открыл
//                                заметку урока → сессия привязывается к ней.
//   node lesson-log.mjs flush  — PostToolUse(AskUserQuestion) и Stop: всё новое из
//                                транскрипта (реплики, объяснения, тесты, ответы)
//                                дописывается в заметку.
//
// Источник правды — транскрипт сессии: он хранит всё в порядке появления.
// Транскрипт пишется с задержкой, поэтому flush на Stop ждёт, пока в нём появится
// last_assistant_message, а при таймауте дописывает его сам и помнит, что уже дописал.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const CLAUDE_DIR = path.join(os.homedir(), '.claude');
const DEFAULT_ENV = {
  configPath: path.join(CLAUDE_DIR, 'tutor.json'),
  stateDir: path.join(CLAUDE_DIR, 'tutor-state'),
  waitMs: 10_000,
  pollMs: 300,
};
const LOCK_WAIT_MS = 15_000;
const LOCK_STALE_MS = 30_000;
const STATE_TTL_MS = 14 * 24 * 60 * 60 * 1000;
const LESSON_MARKER = /^тип:\s*урок\s*$/m;

// --- разбор транскрипта ---

function parseLine(line) {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

// Только завершённые строки: последняя может быть ещё недописана.
function completeLines(transcriptPath) {
  const text = fs.readFileSync(transcriptPath, 'utf8');
  const end = text.lastIndexOf('\n');
  return end === -1 ? [] : text.slice(0, end).split('\n');
}

function shortCommand(name) {
  const [plugin, command] = name.split(':');
  return command && plugin === command ? plugin : name;
}

// Текст реплики человека или null, если запись служебная.
export function promptText(entry) {
  if (entry?.type !== 'user' || entry.isMeta || entry.isSidechain) return null;
  const content = entry.message?.content;
  let text;
  if (typeof content === 'string') {
    text = content;
  } else if (Array.isArray(content) && !content.some((block) => block.type === 'tool_result')) {
    text = content.filter((block) => block.type === 'text').map((block) => block.text).join('\n');
  } else {
    return null;
  }
  text = text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '');
  const command = text.match(/<command-name>\/?([^<]*)<\/command-name>/);
  if (command) {
    const args = text.match(/<command-args>([\s\S]*?)<\/command-args>/)?.[1] ?? '';
    return `/${shortCommand(command[1].trim())} ${args.trim()}`.trim();
  }
  text = text
    .replace(/<(local-command-[\w-]+)>[\s\S]*?<\/\1>/g, '')
    .replace(/<pasted_content[^>]*>\n?([\s\S]*?)\n?<\/pasted_content[^>]*>/g, '```\n$1\n```')
    .trim();
  return text || null;
}

// --- markdown ---

function callout(kind, title, body) {
  const lines = body.split('\n').map((line) => (line ? `> ${line}` : '>'));
  return [`> [!${kind}] ${title}`, ...lines].join('\n');
}

function questionCallout(question) {
  const lines = [`**${question.question}**`];
  (question.options ?? []).forEach((option, index) => {
    const description = option.description ? ` — ${option.description}` : '';
    lines.push(`${index + 1}. ${option.label}${description}`);
    if (option.preview) lines.push('```', ...option.preview.split('\n'), '```');
  });
  return callout('question', question.header || 'Вопрос', lines.join('\n'));
}

function answerCallout(result) {
  if (!result?.answers || !Array.isArray(result.questions)) return null;
  const single = result.questions.length === 1;
  const lines = result.questions.flatMap((question) => {
    const answer = result.answers[question.question] ?? '(без ответа)';
    const notes = result.annotations?.[question.question]?.notes;
    return [
      single ? answer : `**${question.question}** — ${answer}`,
      ...(notes ? [`Заметка: ${notes}`] : []),
    ];
  });
  return callout('example', 'Мой ответ', lines.join('\n'));
}

// Вопрос рисуется по результату, а не по вызову: вызов, упавший на проверке
// входных данных или отклонённый, не оставляет в заметке вопроса без ответа.
function quizBlocks(result) {
  const answer = answerCallout(result);
  return answer ? [...result.questions.map(questionCallout), answer] : [];
}

function assistantBlocks(entry, pendingSkip) {
  const blocks = [];
  for (const block of entry.message?.content ?? []) {
    if (block.type !== 'text') continue;
    const text = block.text.trim();
    if (text && !pendingSkip?.includes(text)) blocks.push(text);
  }
  return blocks;
}

// Записи транскрипта → markdown для заметки. Состояние не мутируется.
export function renderEntries(entries, state) {
  let { pendingSkip, lastPrompt } = state;
  const blocks = [];
  for (const entry of entries) {
    const prompt = promptText(entry);
    if (prompt !== null) {
      pendingSkip = undefined;
      if (prompt !== lastPrompt) blocks.push(callout('quote', 'Я', prompt));
      lastPrompt = prompt;
      continue;
    }
    if (!entry || entry.isSidechain) continue;
    const rendered = entry.type === 'assistant'
      ? assistantBlocks(entry, pendingSkip)
      : quizBlocks(entry.toolUseResult);
    if (rendered.length > 0) lastPrompt = undefined;
    blocks.push(...rendered);
  }
  const markdown = blocks.length > 0 ? `\n${blocks.join('\n\n')}\n` : '';
  return { markdown, state: { ...state, pendingSkip, lastPrompt } };
}

function lastAssistantText(entries) {
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const entry = entries[i];
    if (entry?.type !== 'assistant' || entry.isSidechain) continue;
    const texts = (entry.message?.content ?? []).filter((block) => block.type === 'text' && block.text.trim());
    if (texts.length > 0) return texts[texts.length - 1].text.trim();
  }
  return null;
}

function transcriptHas(lines, expected) {
  const last = lastAssistantText(lines.map(parseLine));
  return last !== null && expected.endsWith(last);
}

// --- заметка и состояние ---

function samePath(a, b) {
  const norm = (p) => (process.platform === 'win32' ? path.resolve(p).toLowerCase() : path.resolve(p));
  return norm(a) === norm(b);
}

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

export function isLessonNote(filePath, lessonsDir) {
  const note = path.resolve(filePath);
  const dir = path.resolve(lessonsDir) + path.sep;
  const inside = process.platform === 'win32'
    ? note.toLowerCase().startsWith(dir.toLowerCase())
    : note.startsWith(dir);
  if (!inside || path.extname(note).toLowerCase() !== '.md') return false;
  try {
    const frontmatter = fs.readFileSync(note, 'utf8').match(/^---\r?\n([\s\S]*?)\r?\n---/);
    return Boolean(frontmatter && LESSON_MARKER.test(frontmatter[1]));
  } catch {
    return false;
  }
}

function statePath(env, sessionId) {
  return path.join(env.stateDir, `${String(sessionId).replace(/[^\w-]/g, '_')}.json`);
}

function writeState(env, sessionId, state) {
  fs.mkdirSync(env.stateDir, { recursive: true });
  fs.writeFileSync(statePath(env, sessionId), JSON.stringify(state));
}

function removeOldStates(env) {
  const cutoff = Date.now() - STATE_TTL_MS;
  for (const name of fs.readdirSync(env.stateDir)) {
    const file = path.join(env.stateDir, name);
    if (name.endsWith('.json') && fs.statSync(file).mtimeMs < cutoff) fs.rmSync(file, { force: true });
  }
}

function sessionHeader(date) {
  const pad = (n) => String(n).padStart(2, '0');
  const day = `${pad(date.getDate())}.${pad(date.getMonth() + 1)}.${date.getFullYear()}`;
  return `\n\n### Сессия ${day} ${pad(date.getHours())}:${pad(date.getMinutes())}\n`;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Stop и PostToolUse(AskUserQuestion) асинхронны и могут пересечься.
async function withLock(env, sessionId, fn) {
  fs.mkdirSync(env.stateDir, { recursive: true });
  const lockPath = `${statePath(env, sessionId)}.lock`;
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      fs.writeFileSync(lockPath, String(process.pid), { flag: 'wx' });
      break;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const age = Date.now() - (fs.statSync(lockPath, { throwIfNoEntry: false })?.mtimeMs ?? 0);
      if (age > LOCK_STALE_MS) fs.rmSync(lockPath, { force: true });
      else if (Date.now() > deadline) throw new Error(`не дождался блокировки ${lockPath}`);
      else await sleep(env.pollMs);
    }
  }
  try {
    return fn();
  } finally {
    fs.rmSync(lockPath, { force: true });
  }
}

// --- команды хуков ---

export function bind(input, env = DEFAULT_ENV) {
  const lessons = readJson(env.configPath)?.lessons;
  const filePath = input.tool_input?.file_path;
  if (!lessons || !filePath || !isLessonNote(filePath, lessons)) return;

  const note = path.resolve(filePath);
  const current = readJson(statePath(env, input.session_id));
  if (current && samePath(current.note, note)) return;

  // Начинаем с реплики, которая запустила урок, — её тоже стоит видеть в заметке.
  const entries = completeLines(input.transcript_path).map(parseLine);
  const lastPrompt = entries.findLastIndex((entry) => promptText(entry) !== null);
  const cursor = lastPrompt === -1 ? entries.length : lastPrompt;

  fs.appendFileSync(note, sessionHeader(env.now ?? new Date()));
  writeState(env, input.session_id, { note, cursor });
  removeOldStates(env);
}

export async function flush(input, env = DEFAULT_ENV) {
  const initial = readJson(statePath(env, input.session_id));
  if (!initial) return;

  const expected = input.last_assistant_message?.trim();
  let lines = completeLines(input.transcript_path);
  const deadline = Date.now() + env.waitMs;
  while (expected && !transcriptHas(lines.slice(initial.cursor), expected) && Date.now() < deadline) {
    await sleep(env.pollMs);
    lines = completeLines(input.transcript_path);
  }
  const late = Boolean(expected) && !transcriptHas(lines.slice(initial.cursor), expected);

  await withLock(env, input.session_id, () => {
    const state = readJson(statePath(env, input.session_id));
    if (!state || !samePath(state.note, initial.note)) return;
    const { markdown, state: next } = renderEntries(lines.slice(state.cursor).map(parseLine), state);
    const output = late ? `${markdown}\n${expected}\n` : markdown;
    if (output) fs.appendFileSync(state.note, output);
    writeState(env, input.session_id, {
      ...next,
      cursor: Math.max(state.cursor, lines.length),
      pendingSkip: late ? expected : next.pendingSkip,
    });
  });
}

// --- запуск из хука ---

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

async function main() {
  const input = JSON.parse(await readStdin());
  const command = process.argv[2];
  if (command === 'bind') bind(input);
  else if (command === 'flush') await flush(input);
  else throw new Error(`неизвестная команда: ${command}`);
}

const isEntryPoint = Boolean(process.argv[1]) && samePath(fileURLToPath(import.meta.url), process.argv[1]);
if (isEntryPoint) {
  main().catch((error) => {
    // Хук не должен ломать сессию: ошибка уходит в лог, а не в разговор.
    fs.mkdirSync(DEFAULT_ENV.stateDir, { recursive: true });
    fs.appendFileSync(
      path.join(DEFAULT_ENV.stateDir, 'errors.log'),
      `${new Date().toISOString()} ${process.argv[2]} ${error.stack}\n`,
    );
  });
}
