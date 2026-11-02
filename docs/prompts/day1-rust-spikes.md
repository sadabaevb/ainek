# Сессия 1b (Дастан, 3 ноября) — Rust-спайки: hello-контракт + OutLayer

Открой Claude Code в корне репо и вставь целиком.

---

Прочитай CLAUDE.md и docs/SPEC.md. Я Дастан, отвечаю за контракт, верификатор, OutLayer policy job и контрактную часть агента. Rust знаю, NEAR — нет, поэтому
объясняй NEAR-специфичные решения в комментариях и в docs/DEV-NOTES.md. Работаем на testnet. Ничего не деплоим на mainnet.

Задача этой сессии — два спайка, без продакшен-кода:

**Спайк A — hello-контракт на NEAR.**
1. Используй skill `near-smart-contracts` и docs-MCP (`search_near_docs`) — не угадывай API near-sdk-rs.
2. Поставь toolchain: rustup target `wasm32-unknown-unknown`, `cargo-near`, `near-cli-rs`. Создай testnet-аккаунты
   `ainek-dev-dastan.testnet` через near-cli-rs (кран для тестовых NEAR).
3. В `contracts/ainek` создай минимальный контракт с одним change-методом `log_key(entry: String) -> u64`
   (append в `Vector<String>`, эмит NEP-297 события `ainek.key_logged`) и view `head()`. Тест на `near-workspaces`.
4. `cargo near build`, деплой на testnet, вызови `log_key` и `head()` из CLI. Покажи мне tx-хеш и ссылку на
   testnet.nearblocks.io. Запиши точные команды в docs/DEV-NOTES.md.

**Спайк B — OutLayer (решает, будет ли политика в TEE).**
1. Прочитай https://app.outlayer.ai/docs/getting-started, /docs/wasi, /docs/https-api, /docs/secrets,
   /docs/tee-attestation, /docs/sdk и репо https://github.com/out-layer/skills (там Claude-skills — установи).
2. В `jobs/policy` сделай WASI-P1 job на Rust (`outlayer = "0.2"`): читает JSON из stdin
   `{"action":{"amount":"300"},"cap":"500"}` и пишет в stdout `{"verdict":"Allow"}` или `Deny`. Без HTTP.
3. Задеплой на testnet-api.outlayer.ai, вызови через HTTPS API, получи `call_id` и `attestation_url`; дождись,
   пока по `attestation_url` появится quote. Сохрани сырой ответ в docs/spike-outlayer/.
4. Проверь по докам: (а) как завести секрет `POLICY_JSON` и `PROTECTED_ED25519`, сгенерированный в TEE, и прочитать
   их в job как env; (б) реальный лимит размера выхода (≤ 900 байт?); (в) что именно видит API-шлюз OutLayer —
   открытый ввод или нет (если в доках нет ответа, так и запиши); (г) можно ли подписать выход ключом
   `PROTECTED_ED25519` внутри job (ed25519-dalek).
5. Итог — docs/DECISIONS.md: «Политика в TEE через OutLayer: GO / NO-GO», с фактами из пунктов 3–4 и
   оценкой, сколько дней займёт полный job из SPEC §6. Если NO-GO — опиши fallback «политика в контракте»
   из SPEC §4.3.

Правила: коммить маленькими коммитами по ходу; секреты только в .env (добавь в .env.example имена переменных);
перед любой тратой тестовых NEAR больше 1 NEAR или любым mainnet-действием — спроси меня.
