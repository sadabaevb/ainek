# Сессия 4 (Дастан, 7–9 ноября) — ярус 2: policy job, контракт v2, агент

Запускать только после контрольной точки 6 ноября (ярус 1 бегает из чистого клона) и решения GO в docs/DECISIONS.md. Агент-сервис на TS (Telegram, structured output, вызов OutLayer) делает Бектур параллельно — ты отдаёшь ему ABI v2 и формат Decision.

---

Прочитай CLAUDE.md, docs/SPEC.md §3.5, §3.6, §4.3, §5.2, §6, §7.2 и docs/DECISIONS.md.

**`jobs/policy` (Rust, OutLayer WASI-P1):**
1. Вход/выход строго по SPEC §6.2; политика из env `POLICY_JSON`, ключ из `PROTECTED_ED25519`; `canonical_bytes(decision)`
   — та же функция, что в `packages/proof/canonical.ts`, тест-векторы общие.
2. Логика §6.2; `nonce = sha256(action_commit || now)`; `expires_at = now + 10 мин`. Выход ≤ 900 байт — проверь тестом.
3. Unit-тесты на все ветки (whitelist, per_action, per_day, needs_approval, deny_new_receivers). Детерминизм: один вход — один выход.
4. Деплой на OutLayer testnet; секреты закрыты правилом «One build only» (правило доступа, владелец может его перенести:
   SPEC §3.5). Записать `wasm_hash` и `pubkey` в docs/DEPLOY.md; в `register_agent` идёт `pubkey`.

**Контракт v2 (`contracts/ainek`):**
1. Методы SPEC §4.3. `ed25519_verify` из `near_sdk::env`. Проверки в `propose_action` — все из §4.3, каждая с отдельным тестом.
2. Cross-contract `ft_transfer` на демо-токен (`token.ainek.testnet`, NEP-141 через factory или готовый FT-контракт из
   docs.near.org/primitives/ft); 1 yocto deposit; callback обновляет статус действия; `storage_deposit` получателей
   — скрипт `scripts/register-receivers.ts`.
3. События: `action_proposed`, `action_pending`, `action_executed`, `action_denied`, `agent_paused` — без суммы и получателя.
4. Тесты инвариантов: повтор nonce → ошибка; просроченное решение → ошибка; подпись чужим ключом → ошибка;
   `policy_hash` не совпадает → ошибка; агент на паузе → ошибка; ключ агента удалён → транзакция не проходит (тест на уровне ключей).

**`services/agent` (Node 24, TS):**
1. grammY-бот: владелец пишет текст → NEAR AI через `runTier1` из `packages/tier1-node` (напрямую, TLS-пин к шлюзу, E2EE;
   structured output через function tool `tools` + `tool_choice`, не `response_format` — его SDK не шифрует; аргументы вызова
   разбираются zod-схемой `Action`; system prompt «ты казначей, извлеки действие или откажись») → model proof как в клиенте.
2. → OutLayer HTTPS API (`X-Payment-Key`, вход §6.2, `spent_today` из view контракта) → `Decision` + `sig`.
3. → `propose_action` FC-ключом агента (`near-api-js`, ключ только на этот метод, allowance выставить).
4. `NeedsApproval` → inline-кнопки «Approve / Reject» владельцу; Approve → инструкция владельцу подтвердить в кошельке
   (или `near-cli` с полным ключом) — агент не должен уметь одобрять сам.
5. Собрать `ActionProof` (SPEC §5.2), коммит, отправить карточку текстом + ссылку на web-карточку.
6. Стоп-кнопка: `scripts/stop-agent.ts` — `DeleteKey` ключа агента владельцем + `pause_agent`; затем демонстрация
   отказа следующей попытки (ошибка ончейн).

Метрики для README: время от сообщения до `action_executed`, доля ложных блокировок на 50 тестовых действий, газ.

**Воспроизводимая сборка (SPEC §3.5):** `rust-toolchain.toml` с точной версией, `Cargo.lock` в репо, профиль release с
фиксированными флагами, скрипт `scripts/wasm-hash.sh` (sha256 от .wasm), GitHub Action, который собирает и печатает хеш.
Проверить, что хеш с двух машин совпадает и равен `wasm_hash` в аттестации OutLayer и в docs/DEPLOY.md. Если OutLayer
добавляет к образу что-то своё (обёртку) — задокументировать, какой именно хеш аттестуется, и сверять его.
