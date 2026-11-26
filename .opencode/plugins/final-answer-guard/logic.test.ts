import assert from "node:assert/strict"
import { check, MAX_NUDGES, NUDGE_TEXT } from "./logic.ts"
import type { SessionMessage } from "./logic.ts"

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

assert.equal(failed, 0, "есть падающие кейсы")
assert.equal(MAX_NUDGES, 2)
assert.ok(NUDGE_TEXT.includes("Сделано"))

console.log(`\n${cases.length - failed}/${cases.length} кейсов прошло`)
