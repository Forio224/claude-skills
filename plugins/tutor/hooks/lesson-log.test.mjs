// Тесты зеркала урока. Запуск: node --test "plugins/tutor/hooks/*.test.mjs"
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  promptText,
  renderEntries,
  isLessonNote,
  bind,
  flush,
} from './lesson-log.mjs';

// --- фабрики записей транскрипта ---

const userPrompt = (text, extra = {}) => ({ type: 'user', message: { role: 'user', content: text }, ...extra });
const assistantText = (text) => ({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } });
const assistantThinking = () => ({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'секрет' }] } });
const askUse = (questions) => ({
  type: 'assistant',
  message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_1', name: 'AskUserQuestion', input: { questions } }] },
});
const askResult = (questions, answers, annotations = {}) => ({
  type: 'user',
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'answered' }] },
  toolUseResult: { questions, answers, annotations },
});
const readResult = () => ({
  type: 'user',
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_2', content: 'file text' }] },
  toolUseResult: { type: 'text', file: { filePath: 'x' } },
});

const QUIZ = [{
  question: 'Что вернёт f()?',
  header: 'Замыкания',
  multiSelect: false,
  options: [
    { label: '1', description: '' },
    { label: '2', description: 'второе значение', preview: 'print(2)' },
  ],
}];

// --- promptText ---

test('promptText возвращает обычный текст пользователя', () => {
  assert.equal(promptText(userPrompt('Хочу понять декораторы')), 'Хочу понять декораторы');
});

test('promptText сворачивает слеш-команду плагина в /имя аргументы', () => {
  const entry = userPrompt('<command-message>tutor:tutor</command-message>\n<command-name>/tutor:tutor</command-name>\n<command-args>тема: декораторы</command-args>');
  assert.equal(promptText(entry), '/tutor тема: декораторы');
});

test('promptText пропускает служебные сообщения и результаты инструментов', () => {
  assert.equal(promptText(userPrompt('Base directory for this skill: ...', { isMeta: true })), null);
  assert.equal(promptText(readResult()), null);
  assert.equal(promptText(userPrompt('<local-command-stdout>ok</local-command-stdout>')), null);
  assert.equal(promptText(userPrompt('текст', { isSidechain: true })), null);
});

test('promptText вырезает system-reminder из текста', () => {
  const entry = userPrompt('ответ: 3<system-reminder>служебное</system-reminder>');
  assert.equal(promptText(entry), 'ответ: 3');
});

test('promptText превращает вставку в блок кода', () => {
  const entry = userPrompt('Вот код\n<pasted_content id="8c65">\ndef f():\n    return 1\n</pasted_content id="8c65">');
  assert.equal(promptText(entry), 'Вот код\n```\ndef f():\n    return 1\n```');
});

// --- renderEntries ---

test('renderEntries: реплика пользователя — цитата, ответ наставника — обычный markdown', () => {
  const { markdown } = renderEntries([userPrompt('почему так?'), assistantText('Потому что **замыкание**.')], {});
  assert.match(markdown, /> \[!quote\] Я\n> почему так\?/);
  assert.match(markdown, /\n\nПотому что \*\*замыкание\*\*\.\n/);
});

test('renderEntries: многострочная реплика целиком остаётся внутри цитаты', () => {
  const { markdown } = renderEntries([userPrompt('строка 1\nстрока 2')], {});
  assert.match(markdown, /> строка 1\n> строка 2/);
});

test('renderEntries: тест и ответ на него — отдельные выноски, мысли и чтение файлов не попадают', () => {
  const entries = [
    assistantThinking(),
    askUse(QUIZ),
    askResult(QUIZ, { 'Что вернёт f()?': '2' }, { 'Что вернёт f()?': { notes: 'думаю, из-за замыкания' } }),
    readResult(),
  ];
  const { markdown } = renderEntries(entries, {});
  assert.match(markdown, /> \[!question\] Замыкания\n> \*\*Что вернёт f\(\)\?\*\*\n> 1\. 1\n> 2\. 2 — второе значение/);
  assert.match(markdown, /> ```\n> print\(2\)\n> ```/);
  assert.match(markdown, /> \[!example\] Мой ответ\n> 2\n> Заметка: думаю, из-за замыкания/);
  assert.doesNotMatch(markdown, /секрет/);
  assert.doesNotMatch(markdown, /file text/);
});

test('renderEntries: повтор одной и той же реплики подряд пишется один раз', () => {
  const { markdown } = renderEntries([userPrompt('дальше'), userPrompt('дальше')], {});
  assert.equal(markdown.match(/дальше/g).length, 1);
});

test('renderEntries: та же реплика после ответа наставника пишется снова', () => {
  const { markdown } = renderEntries([userPrompt('дальше'), assistantText('Узел 2.'), userPrompt('дальше')], {});
  assert.equal(markdown.match(/дальше/g).length, 2);
});

test('renderEntries: текст, уже дописанный по таймауту, пропускается до следующей реплики', () => {
  const state = { pendingSkip: 'Итог урока.\n\nСледующий шаг.' };
  const first = renderEntries([assistantText('Итог урока.'), assistantText('Следующий шаг.')], state);
  assert.equal(first.markdown.trim(), '');
  assert.equal(first.state.pendingSkip, state.pendingSkip);
  const second = renderEntries([userPrompt('ок'), assistantText('Итог урока.')], first.state);
  assert.match(second.markdown, /Итог урока\./);
  assert.equal(second.state.pendingSkip, undefined);
});

// --- isLessonNote ---

test('isLessonNote: только заметки с тип: урок внутри папки уроков', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lessons-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const lesson = path.join(dir, 'Декораторы.md');
  const other = path.join(dir, 'Просто заметка.md');
  fs.writeFileSync(lesson, '---\nтип: урок\nтема: Декораторы\n---\n# Декораторы\n');
  fs.writeFileSync(other, '# Не урок\n');
  assert.equal(isLessonNote(lesson, dir), true);
  assert.equal(isLessonNote(other, dir), false);
  assert.equal(isLessonNote(path.join(os.tmpdir(), 'Декораторы.md'), dir), false);
});

// --- bind + flush целиком ---

function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tutor-log-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const lessons = path.join(root, 'Учёба');
  fs.mkdirSync(lessons);
  const env = {
    configPath: path.join(root, 'tutor.json'),
    stateDir: path.join(root, 'state'),
    waitMs: 200,
    pollMs: 20,
    now: new Date(2026, 8, 30, 14, 5),
  };
  fs.writeFileSync(env.configPath, JSON.stringify({ lessons }));
  const note = path.join(lessons, 'Декораторы.md');
  fs.writeFileSync(note, '---\nтип: урок\nтема: Декораторы\n---\n# Декораторы\n');
  const transcript = path.join(root, 'session.jsonl');
  const write = (entries) => fs.writeFileSync(transcript, entries.map((e) => JSON.stringify(e) + '\n').join(''));
  return { env, note, transcript, write };
}

test('flush без привязки к уроку ничего не пишет', async (t) => {
  const { env, note, transcript, write } = setup(t);
  write([userPrompt('привет'), assistantText('ответ')]);
  const before = fs.readFileSync(note, 'utf8');
  await flush({ session_id: 's1', transcript_path: transcript }, env);
  assert.equal(fs.readFileSync(note, 'utf8'), before);
});

test('bind начинает с последней реплики пользователя, flush дописывает без повторов', async (t) => {
  const { env, note, transcript, write } = setup(t);
  const entries = [userPrompt('старый разговор'), assistantText('старый ответ'), userPrompt('/tutor тема: декораторы'), assistantText('Создаю заметку урока.')];
  write(entries);
  bind({ session_id: 's1', transcript_path: transcript, tool_name: 'Write', tool_input: { file_path: note } }, env);

  entries.push(askUse(QUIZ));
  write(entries);
  await flush({ session_id: 's1', transcript_path: transcript }, env);

  entries.push(askResult(QUIZ, { 'Что вернёт f()?': '1' }), assistantText('Неверно: смотри на область видимости.'));
  write(entries);
  await flush({ session_id: 's1', transcript_path: transcript, last_assistant_message: 'Неверно: смотри на область видимости.' }, env);
  await flush({ session_id: 's1', transcript_path: transcript }, env);

  const text = fs.readFileSync(note, 'utf8');
  assert.match(text, /### Сессия 30\.09\.2026 14:05/);
  assert.doesNotMatch(text, /старый/);
  assert.equal(text.match(/тема: декораторы/g).length, 1);
  assert.equal(text.match(/Что вернёт f/g).length, 1);
  assert.equal(text.match(/Неверно: смотри/g).length, 1);
  assert.ok(text.indexOf('Создаю заметку') < text.indexOf('Что вернёт f') && text.indexOf('Что вернёт f') < text.indexOf('Неверно'));
});

test('недописанная последняя строка транскрипта ждёт следующего flush', async (t) => {
  const { env, note, transcript, write } = setup(t);
  write([userPrompt('начнём')]);
  bind({ session_id: 's1', transcript_path: transcript, tool_name: 'Write', tool_input: { file_path: note } }, env);
  const full = JSON.stringify(assistantText('Первый узел.'));
  fs.appendFileSync(transcript, full.slice(0, 20));
  await flush({ session_id: 's1', transcript_path: transcript }, env);
  assert.doesNotMatch(fs.readFileSync(note, 'utf8'), /Первый узел/);
  fs.appendFileSync(transcript, full.slice(20) + '\n');
  await flush({ session_id: 's1', transcript_path: transcript }, env);
  assert.match(fs.readFileSync(note, 'utf8'), /Первый узел/);
});

test('если транскрипт отстал, последний ответ дописывается из last_assistant_message ровно один раз', async (t) => {
  const { env, note, transcript, write } = setup(t);
  const entries = [userPrompt('объясни')];
  write(entries);
  bind({ session_id: 's1', transcript_path: transcript, tool_name: 'Write', tool_input: { file_path: note } }, env);
  await flush({ session_id: 's1', transcript_path: transcript, last_assistant_message: 'Опоздавший ответ.' }, env);
  assert.equal(fs.readFileSync(note, 'utf8').match(/Опоздавший ответ/g).length, 1);

  entries.push(assistantText('Опоздавший ответ.'));
  write(entries);
  await flush({ session_id: 's1', transcript_path: transcript }, env);
  assert.equal(fs.readFileSync(note, 'utf8').match(/Опоздавший ответ/g).length, 1);
});

test('повторный bind той же заметки не сбрасывает позицию и не дублирует заголовок сессии', async (t) => {
  const { env, note, transcript, write } = setup(t);
  const entries = [userPrompt('начнём'), assistantText('Поехали.')];
  write(entries);
  const input = { session_id: 's1', transcript_path: transcript, tool_name: 'Write', tool_input: { file_path: note } };
  bind(input, env);
  await flush({ session_id: 's1', transcript_path: transcript }, env);
  bind({ ...input, tool_name: 'Read' }, env);
  await flush({ session_id: 's1', transcript_path: transcript }, env);
  const text = fs.readFileSync(note, 'utf8');
  assert.equal(text.match(/### Сессия/g).length, 1);
  assert.equal(text.match(/Поехали/g).length, 1);
});

test('bind игнорирует файлы вне папки уроков и сессии без конфига', (t) => {
  const { env, transcript, write } = setup(t);
  write([userPrompt('x')]);
  bind({ session_id: 's1', transcript_path: transcript, tool_name: 'Read', tool_input: { file_path: path.join(os.tmpdir(), 'a.md') } }, env);
  assert.equal(fs.existsSync(path.join(env.stateDir, 's1.json')), false);
  bind({ session_id: 's2', transcript_path: transcript, tool_name: 'Read', tool_input: { file_path: 'x.md' } }, { ...env, configPath: path.join(env.stateDir, 'нет.json') });
  assert.equal(fs.existsSync(path.join(env.stateDir, 's2.json')), false);
});
