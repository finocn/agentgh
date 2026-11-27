/**
 * Чистая логика «сторожа» — без зависимостей от OpenCode, чтобы её можно было
 * прогонять обычным `node logic.test.ts`.
 */

/** Сколько автопродолжений подряд разрешено, прежде чем сторож сдаётся. */
export const MAX_ITERATIONS = 8

/** Пауза после тихого финала, перед сообщением сторожа. */
export const NUDGE_DELAY_MS = 2000

/** Пауза между итогом и автопродолжением. */
export const CONTINUE_DELAY_MS = 2000

export const NUDGE_TEXT = [
  "Ты завершил ход, но видимого текстового ответа нет — в сообщении осталось только рассуждение.",
  "Это технический сбой канала вывода, а не конец работы.",
  "Не вызывая инструментов, выдай сейчас итог текстом в таком виде:",
  "1) Сделано.",
  "2) Не сделано / ограничения.",
  "3) Проверка.",
  "4) Что дальше.",
].join("\n")

export const CONTINUE_TEXT = [
  "Продолжай работу сам, не дожидаясь ответа.",
  "Если в пункте «4) Что дальше» нет прямого вопроса к пользователю об уточнении действия — сразу выполняй этот пункт.",
  "Если прямой вопрос есть — остановись и дождись ответа пользователя.",
].join("\n")

export const FINISH_TEXT = [
  `Автопродолжение сработало ${MAX_ITERATIONS} раз подряд — это похоже на цикл.`,
  "Принудительно заверши работу: не вызывай больше инструментов и выдай финальный итог текстом.",
].join("\n")

/** Наши служебные промпты — чтобы отличать их от сообщений пользователя. */
export const OUR_PROMPTS = [NUDGE_TEXT, CONTINUE_TEXT, FINISH_TEXT]

export function isOurPrompt(text?: string): boolean {
  const value = String(text ?? "").trim()
  return OUR_PROMPTS.some((prompt) => prompt.trim() === value)
}

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

/** Текст последнего пользовательского сообщения (включая наши служебные промпты). */
export function lastUserText(messages: SessionMessage[]): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]
    if (message?.type !== "user") continue
    const parts = Array.isArray(message.content) ? message.content : []
    return parts
      .filter((part) => part?.type === "text")
      .map((part) => part?.text ?? "")
      .join("\n")
      .trim()
  }
  return undefined
}

/** Есть ли у последнего assistant-сообщения непустая текстовая часть. */
export function hasVisibleText(messages: SessionMessage[]): boolean {
  const assistant = lastAssistant(messages)
  const parts = Array.isArray(assistant?.content) ? (assistant?.content ?? []) : []
  return parts.some(
    (part) => part?.type === "text" && String(part?.text ?? "").trim().length > 0,
  )
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
    (p) => p?.type === "text" && String(p?.text ?? "").trim().length > 0,
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

export type Decision =
  | { kind: "none" }
  | { kind: "nudge"; delayMs: number }
  | { kind: "continue"; delayMs: number }
  | { kind: "finish"; delayMs: number }

/**
 * Что делать после завершения хода.
 * - тихий финал -> «толчок» с просьбой выдать итог (пауза NUDGE_DELAY_MS);
 * - получен итог и ждём продолжения -> автопродолжение (пауза CONTINUE_DELAY_MS);
 * - исчерпан лимит итераций -> принудительное завершение.
 */
export function decide(args: {
  verdict: Check
  expectingItog: boolean
  itogHasText: boolean
  iterations: number
  duplicate: boolean
}): Decision {
  if (args.verdict.act) {
    if (args.duplicate) return { kind: "none" }
    return { kind: "nudge", delayMs: NUDGE_DELAY_MS }
  }
  if (!args.expectingItog || !args.itogHasText) return { kind: "none" }
  if (args.duplicate) return { kind: "none" }
  if (args.iterations >= MAX_ITERATIONS) return { kind: "finish", delayMs: CONTINUE_DELAY_MS }
  return { kind: "continue", delayMs: CONTINUE_DELAY_MS }
}
