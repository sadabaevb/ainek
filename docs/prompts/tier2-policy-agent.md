# Сессия 4 (5–9 ноября) — ярус 2: policy job, контракт v2, агент

Запускать только после контрольной точки 4 ноября (ярус 1 бегает из чистого клона), решения GO в docs/DECISIONS.md и ревью контракта v1 Дастаном.

---

Прочитай CLAUDE.md, docs/SPEC.md §3.5, §3.6, §4.3, §5.2, §6, §7.2 и docs/DECISIONS.md.

**`jobs/policy` (Rust, OutLayer WASI-P1):**
1. Вход/выход строго по SPEC §6.2; политика из env `POLICY_JSON`, ключ из `PROTECTED_ED25519`; `canonical_bytes(decision)`
   — та же функция, что в `packages/proof/canonical.ts`, тест-векторы общие.
2. Логика §6.2; `nonce = sha256(action_commit || now)`; `expires_at = now + 10 мин`. Выход ≤ 900 байт — проверь тестом.
3. Unit-тесты на все ветки (whitelist, per_action, per_day, needs_approval, deny_new_receivers). Детерминизм: один вход — один выход.
4. Деплой на OutLayer testnet; секреты привязаны к `wasm_hash` («One build only»). Записать `wasm_hash` и `pubkey`
   в docs/DEPLOY.md — они идут в `register_agent`.

**Контракт v2 (`contracts/ainek`):**
1. Методы SPEC §4.3. `ed25519_verify` из `near_sdk::env`. Проверки в `propose_action` — все из §4.3, каждая с отдельным тестом.
2. Cross-contract `ft_transfer` на демо-токен (`token.ainek.testnet`, NEP-141 через factory или готовый FT-контракт из
   docs.near.org/primitives/ft); 1 yocto deposit; callback обновляет статус действия; `storage_deposit` получателей
   — скрипт `scripts/register-receivers.ts`.
3. События: `action_proposed`, `action_pending`, `action_executed`, `action_denied`, `agent_paused` — без суммы и получателя.
4. Тесты инвариантов: повтор nonce → ошибка; просроченное решение → ошибка; подпись чужим ключом → ошибка;
   `policy_hash` не совпадает → ошибка; агент на паузе → ошибка; ключ агента удалён → транзакция не проходит (тест на уровне ключей).

**`services/agent` (Node 24, TS):**
1. grammY-бот: владелец пишет текст → NEAR AI через relay-логику (E2EE, structured output по zod-схеме `Action`, system prompt
   «ты казначей, извлеки действие или откажись») → model proof как в клиенте (переиспользуй `packages/proof`).
2. → OutLayer HTTPS API (`X-Payment-Key`, вход §6.2, `spent_today` из view контракта) → `Decision` + `sig`.
3. → `propose_action` FC-ключом агента (`near-api-js`, ключ только на этот метод, allowance выставить).
4. `NeedsApproval` → inline-кнопки «Approve / Reject» владельцу; Approve → инструкция владельцу подтвердить в кошельке
   (или `near-cli` с полным ключом) — агент не должен уметь одобрять сам.
5. Собрать `ActionProof` (SPEC §5.2), коммит, отправить карточку текстом + ссылку на web-карточку.
6. Стоп-кнопка: `scripts/stop-agent.ts` — `DeleteKey` ключа агента владельцем + `pause_agent`; затем демонстрация
   отказа следующей попытки (ошибка ончейн).

Метрики для README: время от сообщения до `action_executed`, доля ложных блокировок на 50 тестовых действий, газ.
