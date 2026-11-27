import { Plugin } from "@opencode/plugin"
import {
  check,
  decide,
  hasVisibleText,
  isOurPrompt,
  lastAssistant,
  lastUserText,
  CONTINUE_TEXT,
  FINISH_TEXT,
  NUDGE_TEXT,
  MAX_ITERATIONS,
} from "./logic.ts"
import type { SessionMessage } from "./logic.ts"

/**
 * final-answer-guard
 *
 * Проблема: модель `packet/nvidia-deepseek-v4-1-flash-nvfp4` иногда завершает ход
 * с `finish: "stop"`, оставляя «финальный ответ» в канале рассуждений (reasoning).
 * В транскрипте появляется assistant-сообщение без части `text`, ход считается
 * штатно завершённым (`idle outcome: "succeeded"`), и OpenCode ничего не повторяет.
 *
 * Решение: после каждого завершённого хода (`session.execution.succeeded`)
 * проверяем последнее assistant-сообщение. Если видимого текста нет — после
 * паузы просим видимый итог. Когда итог получен — после ещё одной паузы просим
 * продолжить работу автоматически (пункт «4) Что дальше»), если там нет прямого
 * вопроса к пользователю. Число автопродолжений подряд ограничено (`MAX_ITERATIONS`);
 * на исчерпании лимита принудительно завершаем работу. Серия сбрасывается, если
 * пользователь написал своё сообщение. Состояние живёт в памяти процесса.
 *
 * Важно: в OpenCode 2.4.2 ход завершает именно `session.execution.succeeded`;
 * перечисленное в схеме API событие `session.idle` на практике не приходит.
 */
const RACE_RETRY_MS = 750

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

type SessionState = {
  lastActedMessageID?: string
  lastItogMessageID?: string
  lastUserText?: string
  expectingItog: boolean
  iterations: number
  done: boolean
}

export default Plugin.define({
  id: "final-answer-guard",
  async setup(ctx) {
    const controller = new AbortController()
    const sessions = new Map<string, SessionState>()

    async function handle(sessionID: string) {
      let messages = (await ctx.session.context({ sessionID })) as SessionMessage[]
      let verdict = check(messages)

      // Гонка записи: сообщение может ещё не получить `finish`. Одна короткая проверка.
      if (!verdict.act && lastAssistant(messages)?.finish == null) {
        await sleep(RACE_RETRY_MS)
        messages = (await ctx.session.context({ sessionID })) as SessionMessage[]
        verdict = check(messages)
      }

      const state: SessionState =
        sessions.get(sessionID) ?? { expectingItog: false, iterations: 0, done: false }
      sessions.set(sessionID, state)

      // Пользователь написал что-то своё — серия автопродолжений сбрасывается.
      const userText = lastUserText(messages)
      if (userText !== state.lastUserText) {
        state.lastUserText = userText
        if (!isOurPrompt(userText)) {
          state.iterations = 0
          state.expectingItog = false
          state.done = false
        }
      }

      // После принудительного завершения молчим, пока пользователь не вмешается.
      if (state.done) return

      const assistant = lastAssistant(messages)
      const assistantID = String(assistant?.id ?? "")
      const duplicate = verdict.act
        ? state.lastActedMessageID === verdict.messageID
        : state.lastItogMessageID === assistantID

      const decision = decide({
        verdict,
        expectingItog: state.expectingItog,
        itogHasText: hasVisibleText(messages),
        iterations: state.iterations,
        duplicate,
      })

      // Ждали итог, но пришёл не он — снимаем ожидание.
      if (decision.kind === "none" && !verdict.act && state.expectingItog) {
        state.expectingItog = false
      }
      if (decision.kind === "none") return

      if (decision.kind === "nudge") {
        if (verdict.act) state.lastActedMessageID = verdict.messageID
        state.expectingItog = true
        console.log(
          `[final-answer-guard] ${sessionID}: тихий финал, пауза ${decision.delayMs} мс, прошу видимый итог`,
        )
        await sleep(decision.delayMs)
        await ctx.session.prompt({ sessionID, text: NUDGE_TEXT })
        return
      }

      if (decision.kind === "continue") {
        state.expectingItog = false
        state.lastItogMessageID = assistantID
        state.iterations += 1
        console.log(
          `[final-answer-guard] ${sessionID}: итог получен, пауза ${decision.delayMs} мс, автопродолжение ${state.iterations}/${MAX_ITERATIONS}`,
        )
        await sleep(decision.delayMs)
        await ctx.session.prompt({ sessionID, text: CONTINUE_TEXT })
        return
      }

      // finish
      state.expectingItog = false
      state.lastItogMessageID = assistantID
      state.done = true
      console.error(
        `[final-answer-guard] ${sessionID}: ${state.iterations} автопродолжений подряд — принудительно завершаю`,
      )
      await sleep(decision.delayMs)
      await ctx.session.prompt({ sessionID, text: FINISH_TEXT })
    }

    void (async () => {
      try {
        for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
          if ((event as { type?: string }).type !== "session.execution.succeeded") continue

          const sessionID = (event as { data?: { sessionID?: string } }).data?.sessionID
          if (!sessionID) continue

          try {
            await handle(sessionID)
          } catch (error) {
            console.error("[final-answer-guard]", error)
          }
        }
      } catch (error) {
        console.error("[final-answer-guard] подписка на события остановлена", error)
      }
    })()

    return () => controller.abort()
  },
})
