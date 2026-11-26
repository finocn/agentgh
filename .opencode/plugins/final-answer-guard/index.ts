import { Plugin } from "@opencode/plugin"
import { check, lastAssistant, MAX_NUDGES, NUDGE_TEXT } from "./logic.ts"
import type { SessionMessage } from "./logic.ts"

/**
 * final-answer-guard
 *
 * Проблема: модель `packet/nvidia-deepseek-v4-1-flash-nvfp4` иногда завершает ход
 * с `finish: "stop"`, оставляя «финальный ответ» в канале рассуждений (reasoning).
 * В транскрипте появляется assistant-сообщение без части `text`, ход считается
 * штатно завершённым (`idle outcome: "succeeded"`), и OpenCode ничего не повторяет:
 * для него это не ошибка провайдера, а «успешный», просто пустой ответ.
 *
 * Решение: после каждого завершённого хода (событие `session.execution.succeeded`)
 * проверяем последнее assistant-сообщение. Если видимого текста нет — отправляем
 * в сессию подталкивающий промпт с просьбой выдать итог. Число подталкиваний
 * ограничено; успешный ход сбрасывает счётчик. Состояние живёт в памяти процесса.
 *
 * Важно: в OpenCode 2.4.2 ход завершает именно `session.execution.succeeded`;
 * перечисленное в схеме API событие `session.idle` на практике не приходит.
 */
const RACE_RETRY_MS = 750

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

export default Plugin.define({
  id: "final-answer-guard",
  async setup(ctx) {
    const controller = new AbortController()
    const sessions = new Map<string, { lastMessageID?: string; nudges: number }>()

    void (async () => {
      try {
        for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
          if ((event as { type?: string }).type !== "session.execution.succeeded") continue

          const sessionID = (event as { data?: { sessionID?: string } }).data?.sessionID
          if (!sessionID) continue

          try {
            let messages = (await ctx.session.context({ sessionID })) as SessionMessage[]
            let verdict = check(messages)

            // Гонка записи: сообщение может ещё не получить `finish`. Одна короткая проверка.
            if (!verdict.act && lastAssistant(messages)?.finish == null) {
              await sleep(RACE_RETRY_MS)
              messages = (await ctx.session.context({ sessionID })) as SessionMessage[]
              verdict = check(messages)
            }

            const state = sessions.get(sessionID) ?? { nudges: 0 }

            // Ход закончился нормально — сбрасываем серию.
            if (!verdict.act) {
              sessions.set(sessionID, { nudges: 0 })
              continue
            }

            // Событие могло прийти повторно для того же сообщения — не считаем дважды.
            if (state.lastMessageID === verdict.messageID) continue
            state.lastMessageID = verdict.messageID

            if (state.nudges >= MAX_NUDGES) {
              sessions.set(sessionID, state)
              console.error(
                `[final-answer-guard] ${sessionID}: тихий финал повторился ${state.nudges} раз, дальше не толкаю (msg ${verdict.messageID})`,
              )
              continue
            }

            state.nudges += 1
            sessions.set(sessionID, state)
            console.log(
              `[final-answer-guard] ${sessionID}: тихий финал (finish=${verdict.finish}), подталкивание ${state.nudges}/${MAX_NUDGES}`,
            )
            await ctx.session.prompt({ sessionID, text: NUDGE_TEXT })
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
