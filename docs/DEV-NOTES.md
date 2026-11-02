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
