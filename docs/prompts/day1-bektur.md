# Сессия 1a (31 октября – 1 ноября) — NEAR AI SDK своими глазами + скелет web

Открой Claude Code в корне репо и вставь целиком.

---

Прочитай CLAUDE.md и docs/SPEC.md. Я Бектур, делаю весь проект с тобой. В этой сессии — apps/web (Next.js), клиентская верификация, карточка
proof, страницы /verify, /log, /auditor, /trust и relay. Блокчейн-разработки у меня не было; NEAR новый. Контракт — в следующей сессии (docs/prompts/day1-rust-spikes.md).
Объясняй, что делаешь, короткими комментариями в коде и в docs/DEV-NOTES.md.

Задача сессии — три шага, без продакшен-UI:

**Шаг 1 — увидеть аттестацию и подпись.**
1. Установи skill `near-ai-cloud` (`npx skills add near/agent-skills --skill near-ai-cloud`) и прочитай
   https://docs.near.ai/cloud/verification/index.md, …/cloud-api/response-signatures.md,
   …/guides/e2ee-chat-completions.md и https://github.com/nearai/inference-sdk/blob/main/js/docs/verification-guide.md.
2. Склонируй https://github.com/near-examples/nearai-cloud-verification-example в tmp/, запусти на Node 24 с
   моим `NEARAI_API_KEY` (в .env, не в код). Покажи мне: отчёт аттестации (поля `signing_address`, `app_compose`,
   `tcb_status`, наличие `nvidia_payload`), ответ модели и `GET /v1/signature/{id}` с `text` и `signature`.
   Сохрани обезличенный пример отчёта в docs/samples/attestation-report.json (без ключей).

**Шаг 2 — первый E2EE-запрос через SDK.**
1. В `apps/web` создай Next.js (App Router, TypeScript strict, pnpm). Добавь `@nearai/inference-sdk` 0.2.1.
2. API-роут `app/api/relay/route.ts`: на сервере (`@nearai/inference-sdk/node`) создай `InferenceClient` с
   `e2ee: true`, `signingAlgo: 'ed25519'`, модель `z-ai/glm-5.3-flash`; `await client.verify(model)`; один
   `chat.completions.create`; `await client.verifyResponse(id)`; верни в ответ `{ completionId, signedText,
   signature, signingAddress, signatureKind, verified: true/false }`. Заголовок `x-no-aliasing: true`.
3. Страница `/` с одним полем ввода и выводом ответа + сырого результата верификации. Никакого дизайна пока.
4. Запиши в docs/DEV-NOTES.md: что именно SDK проверил на сервере, сколько заняла верификация, какие
   полифилы потребовались бы в браузере (прочитай verification-guide про browser entry и NRAS-прокси).

**Шаг 3 — NEAR quickstart.**
1. Пройди https://docs.near.org/web3-apps/quickstart.md с skill `near-dapp`: логин кошельком (testnet),
   один view call к любому существующему контракту, один change call. В `apps/web` — страница `/log`
   с кнопкой «Connect wallet» и выводом результата view call. Контракт Дастана ещё не готов — используй
   `guest-book.testnet` или другой пример из доков как заглушку.
2. Объясни мне в DEV-NOTES.md тремя абзацами: как кошелёк добавляет function-call ключ при логине,
   чем view call отличается от change call, и как выглядит транзакция на testnet.nearblocks.io.

Правила: коммить маленькими коммитами; секреты только в .env; не ставь зависимости без указания точной версии.
