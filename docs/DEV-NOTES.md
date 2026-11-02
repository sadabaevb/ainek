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
