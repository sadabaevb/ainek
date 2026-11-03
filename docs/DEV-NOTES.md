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

## 2026-11-02 — день 1, шаг 3 (Бектур): кошелёк и `/log`

Сделано: `near-connect-hooks@1.1.6` + `@hot-labs/near-connect@0.11.4` + `near-api-js@7.4.0` (точные версии; 0.12.0 коннектора
не взял, чтобы не было двух копий — hooks тянут `^0.11.1`). `NearProvider` в `app/providers.tsx` (client), страница
`app/log/page.tsx`: view `get_greeting` на `hello.near-examples.testnet` (контракт из официального quickstart), кнопка
«Connect wallet», список access-ключей аккаунта после входа, форма `set_greeting` с ссылкой на nearblocks. View call проверен
в браузере (Playwright): greeting отрисовался без кошелька, ошибок в консоли нет (кроме 404 favicon). Вход кошельком и
change call сделан Бектуром через Meteor Wallet: `set_greeting` →
tx `55VUNG7Fw3B22JJJzkRfLTDPxV9nH16g9xjrGaAxGbhT` (https://testnet.nearblocks.io/txns/55VUNG7Fw3B22JJJzkRfLTDPxV9nH16g9xjrGaAxGbhT).

**Находка про кошельки (важно для яруса 2):** Meteor при логине выдал FC-ключ с `method_names: []` (= все методы контракта),
хотя мы запрашивали только `set_greeting`. На право кошелька полагаться нельзя — ключ агента в ярусе 2 создавать через
near-cli-rs с явным `method_names: ["propose_action"]` (`near account add-key agent.ainek.testnet grant-function-call-access
--allowance '…' --receiver-account-id ainek.testnet --method-names 'propose_action' …`) и проверять результат через
`view_access_key_list` перед демо.

**Как кошелёк добавляет function-call ключ при логине.** Сам вход — это не транзакция: NEAR Connect грузит скрипт кошелька
из публичного манифеста в sandbox-iframe, кошелёк отдаёт `accountId`, и всё. Но если в `signIn` передать `addFunctionCallKey`
(у нас: контракт `hello.near-examples.testnet`, методы `['set_greeting']`, allowance 0.25 NEAR), коннектор генерирует в браузере
новую пару ed25519, кладёт приватный ключ в localStorage и просит кошелёк подписать транзакцию `AddKey` на аккаунте пользователя:
публичный ключ добавляется с правом `FunctionCall { receiver_id, method_names, allowance }`. Эту транзакцию подписывает
full-access-ключ кошелька, она стоит газ и видна в `view_access_key_list` (страница их перечисляет). Дальше вызовы, которые
попадают под право (тот контракт, те методы, нулевой депозит), подписываются локально без всплывашки кошелька; всё остальное
уходит в кошелёк. Такой ключ не может приложить депозит, перевести NEAR или вызвать другой метод, а allowance ограничивает
трату на газ. Это ровно механизм яруса 2: суб-аккаунт агента с FC-ключом только на `propose_action`, стоп-кнопка —
`DeleteKey`, и `commit_proof` FC-ключом пользователя (SPEC §4.2) — поэтому у `commit_proof` не может быть депозита, а
storage deposit кладётся заранее полным ключом.

**Чем view call отличается от change call.** View call — RPC-запрос `query` с `request_type: call_function`: узел RPC
исполняет метод на состоянии последнего (или указанного) блока у себя и отдаёт результат синхронно. Нет транзакции,
подписи и газа для вызывающего — бесплатно, кошелёк не нужен, `predecessor` пустой, менять состояние нельзя, лимит газа
на узле (~200 TGas). Так будут работать `head`, `entry`, `latest_keys`, `proof_commit` — клиент читает лог без входа.
Change call — транзакция: signer, receiver, nonce ключа, свежий block hash, список действий (`FunctionCall { method, args,
gas, deposit }`), подпись access-ключом; уходит через `send_tx`, сеть превращает её в receipt, исполняет в шарде получателя в
следующем блоке и возвращает `FinalExecutionOutcome` c `transaction.hash`, статусом, outcome'ами receipt'ов и сожжённым
газом. Стоит газ (простой вызов ≈0.0001–0.0002 NEAR), финальность ~1–2 с. Так работают `log_key`, `commit_proof`,
`propose_action`, `approve`.

**Как выглядит транзакция на testnet.nearblocks.io.** Адрес `testnet.nearblocks.io/txns/<hash>`. Свежий пример с того же
контракта (через API nearblocks): `NEmGxtT3tNXsabBSxVgQtsT2WvbsgdPabhhfgz32ugL`, блок 260 602 583, статус Success,
получатель `hello.near-examples.testnet`, одно действие `FUNCTION_CALL set_greeting` с расшифрованными аргументами
`{"greeting": "hi"}`, депозит 0, сожжено 1.22 TGas, комиссия 0.000153 NEAR. На странице: From → To, публичный ключ, которым
подписано (по нему видно, FC-ключ это или full-access), nonce, высота блока и время, действия с JSON-аргументами, вкладка
Receipts (транзакция → receipt в шарде получателя → возвратный receipt signer'у за неиспользованный газ), «gas attached»
против «gas burnt» и логи контракта — именно там судьи увидят наши NEP-297 строки `EVENT_JSON:{"event":"proof_committed"…}`.
Чего там нет: содержимого — только аргументы. Для `commit_proof` в аргументах будут видны лишь `commit`, `kind`,
`log_index`; для `propose_action` — действие целиком (сумма и получатель на публичном testnet видны, об этом честно пишем в
README, SPEC §4.3).

## 2026-11-03 — `packages/proof` (Бектур): канонические байты, схемы, локальная проверка

Пакет `@ainek/proof` (`packages/proof`), 34 теста на `node:test` поверх `docs/samples/` и `docs/test-vectors/canonical.json`:
`pnpm -F @ainek/proof test`, из корня — `pnpm test`. Без сборки: точка входа — исходный `.ts`, Node 24 исполняет его напрямую
(type stripping; поэтому в tsconfig `erasableSyntaxOnly` + `verbatimModuleSyntax`, импорты с расширением `.ts`, никаких `enum`).
Зависимости только те, что уже тянет SDK: `ethers` 6.17.0 (sha256 + EIP-191 recover для ecdsa), `tweetnacl` 1.0.3 (ed25519), `zod` 4.6.7.

**Что проверено на живых данных 2 ноября.** `verifyModelProof` на `model-proof.sample.json` + сырых байтах + `key-entry.sample.json`
даёт 8/8 ✓; тесты ломают по одному: `signature_kind: gateway` → красная строка `route`; один перевёрнутый бит в ответе →
`response-hash ✗`; подменённый `signing_address` в записи лога → `key-in-log ✗`; `logEntry = null` → `key-in-log ✗` (fail-closed);
без сырых байт — `skipped`, не `fail`, чтобы `/verify` по одному JSON тоже работал.

**Канонический JSON — две ловушки, которые тест-векторы ловят.**
1. JS `sort()` сравнивает UTF-16-единицы, Rust `BTreeMap` — байты UTF-8 (= code point). Для ключей `z`, `ﬁ` (U+FB01), `😀` (U+1F600)
   порядок отличается; вектор «key order is by code point» — ровно этот случай. Сортируем по code point явно.
2. Числа: JS печатает `1e+21`, Rust — `1e21`; дроби тоже расходятся. Канонизатор принимает только целые до 2^53−1 и бросает
   `CanonicalError` на всё остальное; U64/U128 — десятичные строки, как их и сериализует near-sdk (`observed_at`, `amount`, `expires_at`).
Независимая сверка: все 13 векторов и 3 коммит-правила совпали с Python `json.dumps(sort_keys=True, separators=(',',':'), ensure_ascii=False)`.

**Что Дастану сделать у себя (5 минут).** `serde_json::to_string(&serde_json::to_value(&x)?)` при выключенной фиче
`preserve_order` (`cargo tree -e features -i serde_json | grep preserve_order` — пусто) даёт те же байты; `to_string(&struct)`
напрямую — нет (порядок полей объявления). Юнит-тест по `docs/test-vectors/canonical.json`: `vectors[].canonical`/`sha256`,
`commits.action_commit`, `commits.entry_hash`. Проверить фичи near-sdk: не включает ли он `preserve_order` транзитивно.

**Три конвенции, которых в SPEC не было — вписал в SPEC §4.1/§4.2/§6.2, подтвердить на синке:**
- `entry_hash = sha256(prev_hash ‖ canonical_json(input) ‖ verifier)` — три UTF-8-строки подряд, `prev_hash` как hex-текст (не 32 байта),
  у первой записи `prev_hash = ""`. Альтернатива (сырые байты) — 2 строки в обоих языках, но решить надо одинаково.
- `commit` считается по proof **без** `salt`, `commit`, `commitTx` (иначе рекурсия); соль — сырые 32 байта.
- `image_digests` — строки `sha256:<hex>` как в compose (в отчёте 4 образа у модели).

**Relay (п. ROADMAP «relay без логирования тел»).** В `app/api/relay/route.ts` в лог уходят только коды ошибок SDK
(`sdk.toJSON()`, без контента) и объект ошибки; тел запросов/ответов нет. Известная дыра из шага 2 остаётся: SDK с `e2ee: true`
живёт на сервере, то есть шифрует relay, а не браузер — переезд шифрования в клиент входит в сессию 3 (`tier1-client.md`, п. 3).

Следующий шаг: replay-режим `pnpm demo` на `docs/samples/` (офлайн-проверка + печать карточки в терминал), затем сессия 3.

## 2026-11-03 — replay-режим `pnpm demo` (Бектур): проверка SDK по записи, без ключа и сети

`apps/demo` (`pnpm demo`, `pnpm demo:tamper`), ~0,8 с, выход 0/1. Главная находка: у SDK есть чистые функции
`verifyModelAttestation` / `verifyGatewayAttestation` / `verifyModelResponse` из `@nearai/inference-sdk/node` с инъекцией
`verifiers: { tdxQuote, gpuEvidence }`. Значит, replay гоняет **родной код проверки SDK** (nonce в report_data, ключ подписи в
report_data, `app_compose` ↔ MRCONFIGID, повтор RTMR3 по event log, nonce в NRAS, политика TCB, compose-manager), а подменены
только два сетевых шага: «сходить к Intel за коллатералью» и «спросить NVIDIA». Это честнее, чем своя урезанная проверка.

**Что записано в `docs/samples/` (всё публичное):** `intel-collateral.json` — коллатераль Intel PCS для трёх квот отчёта (модель,
шлюз, compose-manager), ключ — `sha256(quote hex)`; `nras-response.json` — вердикт NRAS на записанный `nvidia_payload`;
`nvidia-jwks.json` — ключи NVIDIA; `replay-manifest.json` — время записи и момент, на который replay оценивает улики.
Время берётся из манифеста, а не `Date.now()`: `dcap-qvl.verify(quote, collateral, nowSecs)` и `jose.jwtVerify(..., { currentDate })`.
Свежесть в replay не перепроверяется, и демо печатает это отдельной строкой.

**Наблюдения.**
- NRAS повторно аттестует payload суточной давности и возвращает JWT с тем же `eat_nonce`: свежесть у NVIDIA не на их стороне,
  а на нашей (nonce клиента → report_data → payload). Для replay это удобно, для CLAIMS — повод не писать «NVIDIA подтверждает,
  что железо проверено сейчас».
- Первый прогон записи упал на проверке JWT: `jwtVerify` с `currentDate` на секунду раньше `nbf` токена. В replay берём
  `currentDate = iat` из манифеста, детерминированно.
- Коллатераль Intel (TCB info, QE identity, CRL) имеет `nextUpdate` порядка месяца. Если `pnpm demo` начнёт падать на
  `quote.verification_failed` ближе к концу ноября — перезаписать `intel-collateral.json` скриптом записи (tmp, см. ниже) и
  обновить `nowSecs` в манифесте. Проверить 12 ноября перед фризом.
- `nvidia-jwks.json` — 513 КБ как есть (у NVIDIA много ключей); оставил verbatim, чтобы не объяснять обрезку.
- Весь маппинг сырого отчёта в `ModelAttestation` (`apps/demo/src/report.ts`) — копия того, что SDK делает внутри
  `AttestationClient`; пригодится клиенту в браузере, где отчёт приходит через relay.

**Fail-closed в replay.** `evaluateKeyLog` (`packages/proof/src/key-log.ts`, 6 тестов) — правило SPEC §7.1 на клиенте:
`TRUSTED_VERIFIERS` + `QUORUM`, записи незнакомых верификаторов показываются, но не считаются; split-view = два доверенных
верификатора с непересекающимися наборами ключей → отказ даже при кворуме. `compose_hash` сверяется, только если передан —
под решение синка. Лог в replay — `key-entry.sample.json`; когда `ainek.testnet` задеплоен, добавить view `latest_keys`.
`--tamper` подменяет ключ, который «видит клиент», на `abab…` → `not-logged` → REFUSED, выход 0 (так и задумано).

Перезапись улик: `pnpm -F demo record` (`apps/demo/scripts/record-evidence.mjs`, ключ не нужен): коллатераль на три квоты с
проверкой на месте, POST `nvidia_payload` в NRAS, GET JWKS, новый манифест.

Дальше: `pnpm demo:live` через `apps/web` (живой запрос с ключом, коммит в контракт), запись E2EE-сэмпла, чтобы строка
«End-to-end encryption» в карточке стала ✓, и view-вызовы лога после деплоя контракта.

## 2026-11-03 — сессия 3, часть 1 (Бектур): клиент в браузере — проверка, fail-closed, E2EE, карточка

**Главное решение: SDK работает в браузере по официальному manual-flow, без полифилов.** В verification-guide есть раздел
«Connect through an application proxy»: generic-вход `@nearai/inference-sdk` + `baseUrl` на наш прокси, который только
добавляет API-ключ. Все проверки (dcap-qvl, NRAS, привязки nonce/ключа/compose) идут на устройстве пользователя. Turbopack
собрал root-вход как есть: `crypto`/`buffer`/`stream`, которых боялся промпт, не понадобились (dcap-qvl — чистый JS, SDK
тянет `buffer`). Холодная проверка в браузере 24–29 с (PCCS/NRAS через прокси NEAR AI), повтор из кеша 0 мс.

Почему manual-flow, а не `InferenceClient` в браузере: `verifyResponse(id)` не отдаёт сырые байты, а опции `fetch` у
клиента нет; proof требует байты у пользователя. Поэтому `lib/nearai-browser.ts` — это `AttestationClient` +
`verifyGatewayAttestation` / `verifyModelAttestation` + `prepareE2eeChatRequest` + `fetch(prepared.request)` с клоном ответа
до расшифровки + `fetchCompletionSignature` + `findModelAttestationForSignature` + `verifyModelResponse`. Между
«проверил отчёт» и «отправил» встаёт сверка с логом (SPEC §7.1), чего в `InferenceClient` не вставить.

**Прокси `/api/nearai/[...path]`** (вместо старого relay, который шифровал на сервере и видел открытый текст): allow-list
`GET v1/model/*`, `GET v1/attestation/report`, `POST v1/chat/completions`, `GET v1/signature/*`; путь берётся сырым из URL,
чтобы `z-ai%2Fglm-5.3-flash` дошёл без перекодирования; `Accept-Encoding: identity` наверх; тело наверх как ArrayBuffer,
вниз — потоком без перекодирования; срезаются `content-encoding`/`content-length`; `Authorization`/`cookie` клиента не
пропускаются. Логов тел нет вовсе: сервер видит только шифртекст и размеры (таблица §8 теперь правда).

**Поток (`lib/flow.ts`), восемь шагов с живым статусом на странице:** metadata (`attestationSupported`) → attestation →
key-log (fail-closed) → send (E2EE) → signature (ретрай ×4: подпись кешируется на узле, обслужившем запрос) → sdk-check →
proof (`@ainek/proof`: пересчёт хешей, привязка к записи лога, соль + commit) → store (IndexedDB). Три исхода на карточке:
`verified` (зелёная), `refused` (красная, ничего не отправлено), `non-tee` (красная: только подпись шлюза).

**Проверено в браузере (Playwright, 3 ноября):** зелёная карточка (24 с холодная проверка, ответ «Exactly three words.»,
`provider_tee`, 8/8 проверок proof, консоль чистая); tamper → «Key not in the public log. Message not sent.» за 3 с;
Incognito `anthropic/claude-haiku-5-5` → `provider external, model attestation not supported`, plaintext, подпись `gateway`
проверена против аттестованного шлюза, красная карточка «This answer went through a non-attested model». `/verify?id=…`
перечитывает запись лога и даёт 8/8; `/log` показывает образец и баннер split-view; `/trust` — таблица §8. `next build` зелёный.

**Compose в сверке не участвует — пока.** В живом прогоне модель обслужил хост с compose `5f7ebd85…`, а в образце лога
`a0e3c6f4…`: если бы клиент требовал совпадения пары, честный запрос отказали бы. Это ровно сценарий из заметки 2 ноября;
в `evaluateKeyLog` compose сверяется только если передан, в `flow.ts` не передаётся. Решение по ABI — на синке.

**Что ещё не сделано в сессии 3:** `commit_proof` кошельком (контракт не задеплоен; FC-ключ на `commit_proof` уже
запрашивается при логине на `/log`); кеш проверки в IndexedDB (сейчас только память, перезагрузка = 24 с заново);
`/auditor`; переключатель RU покрывает чат и карточку, `/verify` и `/log` на английском; `pnpm demo:live`.

Мелочи: NEXT_PUBLIC_* из корневого `.env` в клиент не попадают (инлайн на этапе сборки) — публичная конфигурация идёт через
`/api/config`; `useEffect(() => el.scrollIntoView())` без фигурных скобок ломает React 19 («destroy is not a function»);
`allowImportingTsExtensions` нужен и в tsconfig web, раз `@ainek/proof` импортируется исходниками с `.ts`.
