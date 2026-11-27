import assert from "node:assert/strict"
import {
  check,
  decide,
  hasVisibleText,
  isOurPrompt,
  lastUserText,
  CONTINUE_DELAY_MS,
  CONTINUE_TEXT,
  FINISH_TEXT,
  MAX_ITERATIONS,
  NUDGE_DELAY_MS,
  NUDGE_TEXT,
} from "./logic.ts"
import type { Check, SessionMessage } from "./logic.ts"

const assistant = (over: Partial<SessionMessage>): SessionMessage => ({
  id: "msg_1",
  type: "assistant",
  content: [],
  ...over,
})

const reasoning = (text = "…план: сейчас напишу итог…") => ({ type: "reasoning", text })
const text = (value: string) => ({ type: "text", text: value })
const tool = (status: string) => ({ type: "tool", state: { status } })

type Case = { name: string; messages: SessionMessage[]; act: boolean }

const cases: Case[] = [
  {
    name: "тихий финал stop без текста -> толчок",
    messages: [assistant({ finish: "stop", content: [reasoning()] })],
    act: true,
  },
  {
    name: "тихий финал после idle(succeeded) -> толчок",
    messages: [
      assistant({ finish: "stop", content: [reasoning()] }),
      { id: "msg_i", type: "idle", outcome: "succeeded" },
    ],
    act: true,
  },
  {
    name: "idle(interrupted) -> не вмешиваемся",
    messages: [
      assistant({ finish: "stop", content: [reasoning()] }),
      { id: "msg_i", type: "idle", outcome: "interrupted" },
    ],
    act: false,
  },
  {
    name: "stop с видимым текстом -> не вмешиваемся",
    messages: [assistant({ finish: "stop", content: [reasoning(), text("Готово.")] })],
    act: false,
  },
  {
    name: "пустая текстовая часть не считается ответом",
    messages: [assistant({ finish: "stop", content: [reasoning(), text("   ")] })],
    act: true,
  },
  {
    name: "tool-calls -> агент продолжит сам",
    messages: [assistant({ finish: "tool-calls", content: [reasoning(), tool("completed")] })],
    act: false,
  },
  {
    name: "finish не задан (ход в процессе) -> ждём",
    messages: [assistant({ content: [reasoning(), tool("running")] })],
    act: false,
  },
  {
    name: "незавершённый tool при stop -> не толкаем",
    messages: [assistant({ finish: "stop", content: [reasoning(), tool("streaming")] })],
    act: false,
  },
  {
    name: "finish=length без текста -> толчок",
    messages: [assistant({ finish: "length", content: [reasoning()] })],
    act: true,
  },
  {
    name: "ошибка в сообщении -> не толкаем",
    messages: [assistant({ finish: "stop", error: { message: "boom" }, content: [reasoning()] })],
    act: false,
  },
  {
    name: "нет assistant-сообщений -> не толкаем",
    messages: [{ id: "msg_u", type: "user" }],
    act: false,
  },
  {
    name: "последний assistant — более ранний с текстом, затем tool-шаг",
    messages: [
      assistant({ id: "a1", finish: "tool-calls", content: [reasoning(), tool("completed")] }),
      assistant({ id: "a2", finish: "stop", content: [text("Итог.")] }),
    ],
    act: false,
  },
]

let failed = 0
for (const c of cases) {
  const got = check(c.messages)
  const pass = got.act === c.act
  if (!pass) failed++
  console.log(`${pass ? "ok  " : "FAIL"} ${c.name} -> act=${got.act}`)
}

// --------------------------------------------------------------- decide / help

const silent: Check = { act: true, messageID: "m1", finish: "stop" }
const normal: Check = { act: false }

type DecideCase = {
  name: string
  args: Parameters<typeof decide>[0]
  kind: ReturnType<typeof decide>["kind"]
  delayMs?: number
}

const decideCases: DecideCase[] = [
  {
    name: "тихий финал -> nudge с паузой",
    args: { verdict: silent, expectingItog: false, itogHasText: false, iterations: 0, duplicate: false },
    kind: "nudge",
    delayMs: NUDGE_DELAY_MS,
  },
  {
    name: "тихий финал (дубликат) -> ничего",
    args: { verdict: silent, expectingItog: true, itogHasText: false, iterations: 0, duplicate: true },
    kind: "none",
  },
  {
    name: "итог получен -> continue с паузой",
    args: { verdict: normal, expectingItog: true, itogHasText: true, iterations: 0, duplicate: false },
    kind: "continue",
    delayMs: CONTINUE_DELAY_MS,
  },
  {
    name: "обычный ход без ожидания итога -> ничего",
    args: { verdict: normal, expectingItog: false, itogHasText: true, iterations: 0, duplicate: false },
    kind: "none",
  },
  {
    name: "ждали итог, но текста нет -> ничего",
    args: { verdict: normal, expectingItog: true, itogHasText: false, iterations: 0, duplicate: false },
    kind: "none",
  },
  {
    name: "итог повторно (дубликат) -> ничего",
    args: { verdict: normal, expectingItog: true, itogHasText: true, iterations: 1, duplicate: true },
    kind: "none",
  },
  {
    name: "лимит итераций исчерпан -> finish",
    args: { verdict: normal, expectingItog: true, itogHasText: true, iterations: MAX_ITERATIONS, duplicate: false },
    kind: "finish",
    delayMs: CONTINUE_DELAY_MS,
  },
  {
    name: "на грани лимита -> continue",
    args: { verdict: normal, expectingItog: true, itogHasText: true, iterations: MAX_ITERATIONS - 1, duplicate: false },
    kind: "continue",
  },
]

for (const c of decideCases) {
  const got = decide(c.args)
  const pass = got.kind === c.kind && (c.delayMs === undefined || got.delayMs === c.delayMs)
  if (!pass) failed++
  console.log(
    `${pass ? "ok  " : "FAIL"} decide: ${c.name} -> kind=${got.kind}${"delayMs" in got ? ` delay=${got.delayMs}` : ""}`,
  )
}

// ------------------------------------------------------------------ helpers

const user = (value: string, id = "u1"): SessionMessage => ({
  id,
  type: "user",
  content: [text(value)],
})

assert.equal(isOurPrompt(NUDGE_TEXT), true, "NUDGE_TEXT распознаётся")
assert.equal(isOurPrompt(CONTINUE_TEXT), true, "CONTINUE_TEXT распознаётся")
assert.equal(isOurPrompt(FINISH_TEXT), true, "FINISH_TEXT распознаётся")
assert.equal(isOurPrompt(`  ${NUDGE_TEXT}  `), true, "пробелы не мешают")
assert.equal(isOurPrompt("привет, продолжай"), false, "чужой текст — не наш")

assert.equal(
  lastUserText([user("первый"), assistant({ finish: "stop" }), user("последний", "u2")]),
  "последний",
)
assert.equal(lastUserText([assistant({ finish: "stop" })]), undefined)

assert.equal(hasVisibleText([assistant({ finish: "stop", content: [text("Итог.")] })]), true)
assert.equal(hasVisibleText([assistant({ finish: "stop", content: [reasoning(), text("  ")] })]), false)

assert.equal(MAX_ITERATIONS, 8, "лимит автопродолжений")
assert.equal(NUDGE_DELAY_MS, 2000, "пауза перед сообщением сторожа")
assert.equal(CONTINUE_DELAY_MS, 2000, "пауза перед автопродолжением")
assert.ok(NUDGE_TEXT.includes("Сделано"), "NUDGE_TEXT просит итог")
assert.ok(CONTINUE_TEXT.includes("Продолжай"), "CONTINUE_TEXT просит продолжение")
assert.ok(FINISH_TEXT.includes("Принудительно"), "FINISH_TEXT завершает работу")

assert.equal(failed, 0, "есть падающие кейсы")

const total = cases.length + decideCases.length
console.log(`\n${total - failed}/${total} кейсов прошло`)
