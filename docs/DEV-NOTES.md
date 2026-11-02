# Dev notes (append as you go — commands that worked, gotchas, what the other person must know)

## 2026-10-30
- Kit created. Next: day-1 sessions (docs/prompts/day1-*.md).

## 2026-11-02 — день 1, шаг 1 (Бектур): NEAR AI SDK своими глазами

Что прочитано: skill `near-ai-cloud` (уже в `.claude/skills`), docs.near.ai/cloud/verification, response-signatures,
e2ee-chat-completions, `js/docs/verification-guide.md` из inference-sdk. Пример `near-examples/nearai-cloud-verification-example`
склонирован в `tmp/` (gitignored), зависимости поставлены с `--ignore-scripts`. Spike-скрипт: `tmp/spike/attest-and-sign.mjs`
(запуск `tmp/spike/run.sh`, читает `NEARAI_API_KEY` из корневого `.env`).

Факты, которые надо помнить:
- Ссылка в промпте `cloud/cloud-api/response-signatures.md` даёт 404; рабочая —
  `https://docs.near.ai/cloud/verification/cloud-api/response-signatures.md`.
- `tcb_status` — НЕ поле сырого отчёта `/v1/attestation/report`. Его выдаёт проверка TDX-квоты (`dcap-qvl`); в SDK это
  `verify(model).gateway.tcbStatus` / `.models[i].tcbStatus`. Официальный пример его не показывает (он проверяет только NRAS).
- Сырой отчёт: `gateway_attestation{signing_address, signing_algo, intel_quote, event_log, request_nonce, info.tcb_info.app_compose}`
  + `model_attestations[]{… + signing_public_key, nvidia_payload}`. `signing_public_key` — ed25519-ключ модели для E2EE
  (`X-Model-Pub-Key`). `app_compose` — сырая строка; хешировать как есть, без пересериализации; MRCONFIGID = `01 || sha256 || 15×00`.
- Дефолты `signing_algo` разные: отчёт шлюза ed25519, отчёт модели ecdsa, `/v1/signature` ecdsa. Всегда передаём явно.
- Подписанный `text`: `provider_tee` → `<model_id>:<sha256 req>:<sha256 resp>`; `gateway` → `<sha256 req>:<sha256 resp>` (без модели).
  Хеши — от точных байт тела, поэтому `Accept-Encoding: identity` и никакого JSON re-serialize. `signature_kind == gateway`
  бывает и на не-стриминговых запросах через cloud-api (например, при алиасинге) — отсюда `x-no-aliasing: true`.
- `/v1/signature/{id}` может вернуть 404, если запрос попал на другой TEE-узел модели — ретраим.
- `@nearai/inference-sdk@0.2.1`: `engines.node >= 24.22.1`, у нас 24.15.0 — импорт работает, живой прогон покажет. Зависимости
  SDK уже тянут `@phala/dcap-qvl`, `tweetnacl`, `ethers`, `jose` — свои не добавляем. Для браузера SDK по умолчанию ходит в
  прокси NEAR AI (`cloud.near.ai/api/proxy/{pccs,nras}`), TLS-биндинга в браузере нет (`tlsBinding.kind: 'none'`).
- Блокер на 2 ноября: `.env` — копия `.env.example`, `NEARAI_API_KEY` пуст; живой прогон ждёт ключ.

### Живой прогон (ключ появился вечером 2 ноября)

Официальный пример (`tmp/spike/run-example.sh`, ecdsa): 7/7 ✅ — nonce эхом в отчёте шлюза и модели, NRAS
`x-nvidia-overall-att-result=true`, `eat_nonce` совпал, 8 × GH100 (`secboot=true`, `dbgstat=disabled`, driver 595.58.03),
`signature_kind=provider_tee`, хеши совпали, подписант восстановлен в адрес модели из отчёта.

Spike (`tmp/spike/run.sh`, ed25519) — что увидели:
- `GET /v1/attestation/report` → 200 за 3.4 с, 317 КБ. Верх: `gateway_attestation`, `model_attestations[1]`,
  `ohttp_key_config`, `ohttp_attestation`. У модели плюс `model_name`, `compose_manager_attestation`
  (журнал `compose_up` с тегом/коммитом/`file_sha256`), `ohttp_attestation`. `event_log` у шлюза — строка, у модели — массив из 31 записи.
- Для ed25519 `signing_address` == `signing_public_key` == hex 32-байтного ключа (у шлюза `signing_public_key` нет).
  Для ecdsa это eth-адрес и secp256k1-ключ соответственно. В `KeyEntryInput` поле `signing_public_key` при ed25519 дублирует адрес — ок.
- `app_compose` лежит в `info.tcb_info.app_compose` (строка JSON манифеста dstack: `name: dstack-nvidia-0.5.11`,
  `docker_compose_file`, `kms_enabled`, `allowed_envs`…). `info.tcb_info.compose_hash` = sha256 этой строки; SDK независимо
  проверяет, что MRCONFIGID квоты = `01 || sha256(app_compose) || 00×15`.
- `client.verify()` (dcap-qvl + NRAS + биндинг) — 14.4 с первый раз, 7.3 с второй (сеть; кэш SDK 60 мин внутри процесса).
  Результат: `gateway.tcbStatus=UpToDate`, `tlsBinding.kind=attested` (SPKI-пин в Node), `models[0].tcbStatus=UpToDate`,
  `gpuEvidence=verified`, `advisoryIds=[]`. Строгая политика `acceptedTcbStatuses:['UpToDate'], gpuEvidence:'required'` прошла.
- Node 24.15.0 при `engines >=24.22.1` — всё отработало, включая TLS-пин. Поднимать Node пока не нужно.
- Чат 7 с. `GET /v1/signature/{id}?signing_algo=ed25519` → `{text, signature, signing_address, signing_algo, signature_kind}`,
  `signature` — 128 hex-символов (64 байта, без `0x`). Проверил `node:crypto` (`verify(null, utf8(text), spki(pubkey), sig)`) — valid,
  хеши запроса/ответа совпали с `text`, подписант = `model_attestations[0].signing_address`.
- `client.verifyResponse(id)` для запроса, отправленного НЕ через клиент → `api.completion_not_found`: SDK верифицирует только
  те ответы, байты которых он сам захватил. Для нашего relay это значит: либо чат идёт через `client.chat.completions.create`
  на сервере (шаг 2), либо верифицируем сами по сырым байтам (как в spike) — для /verify по вставленному JSON нужен второй путь.

**Находка для схемы лога (Дастану):** два `verify()` подряд дали для одной модели одинаковый `signing_address`
(`5a0210f2…caff`), но разный `composeHash` (`5f7ebd85…efa6` и `a0e3c6f4…8c5f`). Модель обслуживают несколько узлов
с разными деплоями (у одного в `compose_manager_attestation` тег `gpu23-glm53-bench-r3`), а ключ подписи у инстансов одной
модели общий (так и написано в доках SDK). Следствие: SPEC §7.1 шаг 2 «требуется запись с тем же `signing_address` и
`compose_hash`» будет ложно срабатывать, когда клиент попал на узел, чей compose верификатор ещё не видел. Варианты:
(а) верификатор логирует каждую пару (адрес, compose) — тогда `log_key` надо звать на каждый новый compose, а клиент
сверяет пару; (б) fail-closed только по `signing_address` (+`tcb_status`), а `compose_hash` показываем в карточке как
«деплой X, виден верификатором/нет». Склоняюсь к (а) с дедупликацией по `(signing_address, compose_hash)` в контракте. Решить 3 ноября.

**Мини-спайк: 20 отчётов подряд (2.11, 22:30, `tmp/spike/fleet-scan.mjs`, сырые строки в `tmp/spike/out/fleet-scan.json`).**
20 вызовов `GET /v1/attestation/report?model=z-ai/glm-5.3-flash&signing_algo=ed25519&nonce=<свежий>` с параллельностью 4.
В каждом отчёте ровно один `model_attestations[]` — шлюз отдаёт узел, который ответил, а не весь флот. Nonce эхом 20/20,
`tcb_info.compose_hash == sha256(app_compose)` 20/20, латентность 274–8782 мс.

| compose_hash | signing_address | попаданий | instance_id | app_name | последний `compose_up` (compose_manager) |
| --- | --- | --- | --- | --- | --- |
| `a0e3c6f4…8c5f` | `5a0210f2…caff` | 3/20 | `19aea169` | dstack-nvidia-0.5.11 | v0.0.521 `prod/GLM-5.3-Flash-SGL-TP2x4-W4AFP8-V12Q8.yaml`, 2026-10-28 |
| `5f7ebd85…efa6` | `5a0210f2…caff` | 17/20 | `7bb9af0a` | dstack-nvidia-0.5.11 | тот же файл и тег, 2026-10-29 |

Итого: distinct `signing_address` = 1, distinct `compose_hash` = 2, distinct пар (адрес, compose) = 2, distinct `instance_id` = 2,
distinct `rtmr3` = 2. Diff двух `app_compose` (`tmp/spike/out/compose-*.yaml`) — **одна строка** внутри docker-compose:
`INSTANCE_LABEL=gpu03` против `INSTANCE_LABEL=gpu04` (метка хоста для Slack-уведомлений). Всё остальное байт-в-байт одинаково,
образы те же.

Что это значит для ABI (к синку 3.11):
- `compose_hash` (= MRCONFIGID) — идентичность **хоста**, не деплоя. Пар (адрес, compose) столько, сколько хостов; чтобы залогировать
  все, верификатору нужно «дождаться» каждого хоста (второй попался 3 раза из 20; третий с долей 5% потребовал бы ~60 вызовов).
- Ключ подписи один на модель, он и есть то, что подтверждает подпись ответа. Предлагаю: fail-closed клиента — по `signing_address`
  (+ `tcb_status`, + `image_digests` из compose, которые у хостов совпадают); `compose_hash` в `KeyEntry` оставляем как факт
  («хост с таким MRCONFIGID видел верификатор»), и несовпадение показываем жёлтым «хост ещё не виден верификаторами», а не красным.
- Если Дастан хочет пару (адрес, compose) как ключ записи — тогда `log_key` с дедупликацией по паре и `latest_keys` возвращает все
  пары за окно; `image_digests` обязательны в сверке в любом случае.

Сохранено в `docs/samples/` (см. README там): сырой отчёт, сырые байты запроса/ответа, `signature.json`. Ключа API в файлах нет (проверено grep).

## 2026-11-02 — день 1, шаг 2 (Бектур): первый E2EE-запрос через SDK в `apps/web`

Как запустить: `pnpm i && pnpm -F web dev` → http://localhost:3000 → ввести текст → увидеть ответ и сырой результат
верификации. Relay: `apps/web/app/api/relay/route.ts` (`POST {message}`), страница `apps/web/app/page.tsx` (без дизайна).
Ответ relay: `{ completionId, model, content, signedText, signature, signingAddress, signingAlgo, signatureKind, verified,
failure?, timingsMs, attestation }` — `signatureKind` клиенту нужен для детектора маршрута (SPEC §3.9).

**Что именно SDK проверил на сервере** (`InferenceClient` из `@nearai/inference-sdk/node`, `verify(model)` + `verifyResponse(id)`):
1. Отчёт шлюза: TDX-квота через `@phala/dcap-qvl` с коллатералью Intel PCS (`api.trustedservices.intel.com`), `tcbStatus`
   против политики (дефолт `UpToDate | OutOfDate | TDRelaunchAdvised`), `report_data` = nonce + ключ подписи, replay `event_log`
   → RTMR3, MRCONFIGID = `01 || sha256(app_compose) || 00×15`, SPKI-отпечаток TLS-пира совпал с квотой (`tlsBinding=attested`,
   дальше запросы к шлюзу идут через pinned TLS).
2. Отчёт модели: то же + `nvidia_payload` в NRAS (JWT NVIDIA ES384, issuer, `eat_nonce`, verdict; per-GPU claims SDK не читает),
   `gpuEvidence=verified` (я поставил `gpuEvidence: 'required'`), `signingPublicKey` = ed25519-ключ модели для E2EE.
3. Чат: SDK сам шифрует поля к проверенному ключу модели и сам ставит заголовки `X-Signing-Algo`, `X-Client-Pub-Key`,
   `X-Model-Pub-Key`, `X-Encryption-Version: 2`, `x-no-aliasing: true`, **`X-Encrypt-All-Fields: true`** — и шифрует
   `tools[]`, `tool_calls`, `refusal`, `name` (проверил по бандлу 0.2.1). Требования CLAUDE.md по заголовкам выполняются SDK,
   руками ничего добавлять не надо. Сырые байты запроса/ответа SDK удерживает в памяти 60 мин.
4. `verifyResponse(id)`: `GET /v1/signature/{id}?signing_algo=ed25519`, sha256 по удержанным байтам = `text`, подпись ed25519
   под `signing_address` из *того же* отчёта, что использовался для запроса; `signatureKind=provider_tee`.

**Сколько заняло** (dev-сервер, 2.11 ~22:45): холодный `verify()` 40.8 с (в спайках днём 7–14 с; Intel PCS сегодня то медленный,
то отдаёт `quote.collateral_unavailable` — SDK помечает это `retryable`, relay повторяет до 3 раз), чат 4.6–7.8 с,
`verifyResponse` 0.6 с, тёплый `verify()` 0 мс (кэш 60 мин внутри процесса — один клиент на процесс). Прокси PCCS NEAR
(`cloud.near.ai/api/proxy/pccs`) работает, но 36 с против 12 с у Intel напрямую — оставил Intel.

**Честно про этот relay.** Шифрует и расшифровывает *сервер*, значит relay видит открытый текст — это противоречит SPEC §3.4.
Это шаг 1 из промпта, не продукт. В сессии tier1-client шифрование уезжает в браузер, relay только форвардит шифртекст и
подставляет API-ключ.

**Что нужно браузеру** (`js/docs/verification-guide.md`, раздел «Connect through an application proxy»):
- Корневой entry `@nearai/inference-sdk` с `baseUrl` = наш relay; relay форвардит `GET /v1/model/{model}`,
  `GET /v1/attestation/report`, `POST /v1/chat/completions`, `GET /v1/signature/{id}`, сохраняя тела и заголовки шифрования
  байт-в-байт и URL-кодирование id; при cross-origin — `Access-Control-Expose-Headers: X-Generation-Id`.
- Полифилы: «default Intel verifier may need `crypto`, `buffer`, and `stream` polyfills» (зависит от сборки; SDK тянет `buffer`
  сам). В браузере нет TLS-биндинга (`tlsBinding.kind='none'`): fetch не отдаёт сертификат пира.
- PCCS и NRAS в браузере по умолчанию идут через прокси NEAR (`cloud.near.ai/api/proxy/{pccs,nras/v3/attest/gpu}`), JWKS NVIDIA —
  напрямую. Прокси не может подделать вердикт (JWT подписан NVIDIA, коллатераль подписана Intel), может только отказать;
  наш `/api/nras` (SPEC §3.3) нужен, чтобы не зависеть от доступности прокси вендора, а не ради доверия.
- `verifyResponse` работает только для ответов, отправленных тем же клиентом → в браузере чат должен идти через SDK-клиент
  браузера, а `/verify` по вставленному JSON — своя проверка по сырым байтам (`tweetnacl`/`node:crypto`, как в spike).

**Гочи Next.js 16.4 / pnpm 10** (чтобы не наступать второй раз):
- Корневой `.env`: Next читает только `apps/web/.env*`. Решение — `apps/web/instrumentation.ts` → `instrumentation-node.ts` с
  `process.loadEnvFile(<root>/.env)` при старте сервера. Не работает: `@next/env.loadEnvConfig` из `next.config.ts` (no-op после
  того, как Next загрузил своё), `NODE_OPTIONS=--env-file…` (флаг запрещён в NODE_OPTIONS), `node --env-file… next dev`
  (Next копирует `execArgv` родителя в `NODE_OPTIONS` дочернего процесса → та же ошибка).
- `serverExternalPackages: ['@nearai/inference-sdk']` — SDK ESM с wasm `dcap-qvl`, бандлить не надо.
- Next 16 на каждый `next dev` пишет `apps/web/AGENTS.md` — выключено `agentRules: false`.
- Typecheck: `next typegen && tsc --noEmit` (первый прогон переписывает `tsconfig`: `jsx: react-jsx`, include `.next/dev/types`).
- `pnpm -F web dev -- -p 3999` передаёт `--` буквально; правильно `pnpm -F web dev -p 3999`.
- Node 24.15.0 при `engines >=24.22.1` у SDK — всё работает и внутри Next.

**Для DEMO-SCRIPT.md (перенести при правке сценария):**
- Холодная аттестация занимает до 40 с, когда Intel PCS медленный. Перед записью видео и перед прогоном судей прогреть кеш:
  один запрос в relay заранее (кеш живёт 60 мин в процессе; рестарт `next dev` его сбрасывает).
- Корневой `.env` читается через `apps/web/instrumentation.ts` — упомянуть в README «Try it»: один `.env` в корне, в `apps/web`
  ничего класть не нужно.
