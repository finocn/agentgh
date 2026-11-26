/**
 * Чистая логика «сторожа» — без зависимостей от OpenCode, чтобы её можно было
 * прогонять обычным `node logic.test.ts`.
 */

export const MAX_NUDGES = 2

export const NUDGE_TEXT = [
  "Ты завершил ход, но видимого текстового ответа нет — в сообщении осталось только рассуждение.",
  "Это технический сбой канала вывода, а не конец работы.",
  "Не вызывая инструментов, выдай сейчас итог текстом в таком виде:",
  "1) Сделано.",
  "2) Не сделано / ограничения.",
  "3) Проверка.",
  "4) Что дальше.",
].join("\n")

export type AssistantPart = {
  type?: string
  text?: string
  state?: { status?: string }
}

export type SessionMessage = {
  id?: string
  type?: string
  outcome?: string
  finish?: string
  error?: unknown
  content?: AssistantPart[]
}

export type Check =
  | { act: false }
  | { act: true; messageID: string; finish: string }

/** Последнее assistant-сообщение в транскрипте. */
export function lastAssistant(messages: SessionMessage[]): SessionMessage | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.type === "assistant") return messages[i]
  }
  return undefined
}

/** Ход закончился сам и без видимого текста -> нужен «толчок». */
export function check(messages: SessionMessage[]): Check {
  const last = messages[messages.length - 1]

  // Если ход завершился не штатно (прерван/ошибка) — не вмешиваемся.
  if (last && last.type === "idle" && last.outcome !== "succeeded") return { act: false }

  const assistant = lastAssistant(messages)
  if (!assistant) return { act: false }

  const finish = assistant.finish
  // `finish` без значения — сообщение ещё выполняется; tool-calls — агент продолжит сам.
  if (finish !== "stop" && finish !== "length") return { act: false }
  if (assistant.error) return { act: false }

  const parts = Array.isArray(assistant.content) ? assistant.content : []
  const hasText = parts.some(
    (p) => p?.type === "text" && String(p.text ?? "").trim().length > 0,
  )
  if (hasText) return { act: false }

  // Если остался незавершённый tool — это не «тихий» финал, а работа в процессе.
  const hasPendingTool = parts.some(
    (p) =>
      p?.type === "tool" &&
      p.state?.status !== "completed" &&
      p.state?.status !== "error",
  )
  if (hasPendingTool) return { act: false }

  return { act: true, messageID: String(assistant.id ?? ""), finish: String(finish) }
}
