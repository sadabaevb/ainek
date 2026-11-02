# Сессия 2 (Дастан, 4–5 ноября) — контракт v1 + верификатор

---

Прочитай CLAUDE.md, docs/SPEC.md §3.1, §3.2, §4.1, §4.2, §5 и docs/DEV-NOTES.md. Реализуем ярус 1.

**Контракт `contracts/ainek` (near-sdk-rs):**
1. Состояние: `owner`, `verifiers: UnorderedSet<AccountId>`, `entries: Vector<KeyEntry>`, индекс
   `by_model: LookupMap<String, Vector<u64>>`, `commits: LookupMap<(AccountId, String), CommitInfo>`.
2. Методы из SPEC §4.1–4.2 с точными сигнатурами. `entry_hash = sha256(prev_hash || canonical_json(input) || verifier)`;
   `canonical_json` — ключи отсортированы, без пробелов (та же функция появится в `packages/proof/canonical.ts`;
   выпиши 5 тест-векторов в `docs/test-vectors/canonical.json`).
3. События NEP-297 (`standard: "ainek"`, `version: "1.0.0"`): `key_logged`, `proof_committed`.
4. `near-workspaces` тесты: только верификатор может `log_key`; цепочка хешей непрерывна; `latest_keys`
   фильтрует по модели и возрасту; `commit_proof` работает с function-call ключом (создай ключ в тесте);
   storage-депозит: `commit_proof` падает без предоплаченного хранилища и работает после `storage_deposit`-подобного
   пополнения владельцем (реализуй `deposit_storage()` payable).
5. Деплой на `ainek.testnet`, `register_verifier` для `v1`/`v2`. Команды — в docs/DEV-NOTES.md.

**Верификатор `services/verifier` (Node 24, TS):**
1. Конфиг: список моделей (`z-ai/glm-5.3-flash`, `deepseek-ai/DeepSeek-V4.1-Flash-1017`), интервал (15 мин),
   аккаунт верификатора и ключ из .env, RPC testnet.
2. Цикл: nonce → `client.verify(model)` с `gatewayVerification/modelVerification.policy.acceptedTcbStatuses: ['UpToDate']`
   и `deploymentPolicy`, который логирует compose hash → `KeyEntryInput` по SPEC §4.1 (хеши отчётов — sha256 от
   точных байт JSON) → `log_key` через near-api-js → сохранить полный отчёт в `data/reports/<report_hash>.json`.
3. Идемпотентность: если `signing_address + compose_hash` уже есть в `latest_keys` от этого верификатора за
   последние 6 часов — не писать повторно (экономим газ), но обновлять локальный `last_seen`.
4. Режим `--once` для `pnpm demo`; логи в stdout человекочитаемые («logged z-ai/glm-5.3-flash key …a3f1 at index 42, tx …»).
5. Скрипт `scripts/split-view-demo.ts`: второй инстанс пишет запись с намеренно другим `signing_address` —
   для демонстрации детекции split-view на клиенте. Пометить в README как демо.

После этого обнови docs/SPEC.md, если ABI изменился, и напиши в DEV-NOTES.md, что проверить Бектуру на клиенте (адрес контракта, имена view-методов, формат событий).

**Дополнительно (docs/FIELD.md, SPEC §3.2 и §4.1):**
- Верификатор должен запускаться чужими руками: Dockerfile (multi-stage, Node 24), образ `ghcr.io/sadabaevb/ainek-verifier`
  через GitHub Action, и `npx ainek-verify` (bin в `services/verifier/package.json`). Конфиг — только env:
  `VERIFIER_ACCOUNT_ID`, `VERIFIER_PRIVATE_KEY`, `AINEK_CONTRACT`, `NEARAI_API_KEY`, `MODELS`. Раздел README
  «Run a verifier in 5 minutes» с тремя командами. Проверь сам с чистой машины/контейнера.
- Если на синке принята открытая регистрация: `register_verifier` `#[payable]` со storage deposit, `pause_verifier` для owner,
  событие `verifier_registered` / `verifier_paused`; view `verifiers()`; тест в near-workspaces: чужой аккаунт регистрируется
  и пишет в лог, клиент с `TRUSTED_VERIFIERS` его записи не засчитывает.
