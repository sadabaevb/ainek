# Сессия 3 (3–6 ноября) — fail-closed клиент, proof, карточка, /verify, /log

---

Прочитай CLAUDE.md, docs/SPEC.md §3.3, §3.4, §5, §7.1, §8 и docs/DEV-NOTES.md. Реализуем ярус 1 на клиенте.
Контракт из сессии 2: `ainek.testnet`, ABI в SPEC §4.1–4.2 (view-методы `latest_keys`, `entry`, `head`).

**`packages/proof`:**
- zod-схемы `ModelProof`, `ActionProof` из SPEC §5; `canonicalJson()` с теми же тест-векторами, что в
  `docs/test-vectors/canonical.json`; `sha256Hex(bytes)`; `parseSignedText()`; `verifyModelProof(proof, rawRequest, rawResponse, logEntry)`
  — пересчёт хешей, сверка с `signedText`, проверка подписи (ed25519 через tweetnacl; ecdsa — EIP-191 recover через ethers),
  сверка `signingAddress` с `logEntry.signing_address`; `commitOf(saltHex, proof)`.

**Клиентская верификация и fail-closed (`apps/web`):**
1. Браузерная сборка `@nearai/inference-sdk` (root entry): `verifyModelAttestation` с полифилами по verification-guide;
   NRAS POST через `app/api/nras/route.ts` (простой прокси). Кеш результата 60 мин в памяти + IndexedDB.
2. Перед отправкой: взять `signing_address` и `compose_hash` из проверенного отчёта → view `latest_keys(model, 24h)` →
   правило из SPEC §7.1 (есть запись с тем же ключом и compose hash; нет конфликтующих наборов у разных верификаторов).
   Нет — модалка «Ключ не в публичном логе — сообщение не отправлено» с деталями. Есть — зелёный индикатор «ключ №N, верификаторы: v1, v2».
3. Отправка через relay с E2EE: клиент сам шифрует (`prepareE2eeChatRequest` или `InferenceClient` в браузере с `e2ee: true`
   и API-ключом **только через relay** — ключ в браузер не отдаём; если SDK требует ключ на клиенте, relay подставляет
   Authorization, а шифрование остаётся на клиенте). `X-Model-Pub-Key` — из проверенного отчёта. Сырые байты запроса и
   ответа (`Accept-Encoding: identity`) — в IndexedDB.
4. После ответа: `GET /v1/signature/{id}?signing_algo=ed25519` через relay → `verifyModelProof` → `ModelProof` → соль 32 байта →
   `commit_proof(commit, "model", logIndex)` FC-ключом пользователя (логин кошельком добавляет ключ на `ainek.testnet`,
   метод `commit_proof`) → карточка.

**Страницы:**
- `/` чат + карточка proof по SPEC §5.3: строки со статусами, кнопки «Перепроверить самому» (открывает /verify с proof),
  «Открыть в Verification Center» (`https://cloud.near.ai/verify?model=…#receipt=<base64url JSON>` — формат из
  docs.near.ai/cloud/verification/verification-center.md), «Раскрыть аудитору» (экспорт proof + соль + сырые байты в файл).
- `/verify` — вставить proof JSON (и опционально сырые байты) → пошаговый отчёт проверки, ссылка на nearblocks для `commitTx`.
- `/log` — таблица записей лога по моделям, кто писал, когда; баннер split-view, если у двух верификаторов разные
  ключи за одно окно (используй скрипт `split-view-demo` из сессии 2).
- `/trust` — таблица из SPEC §8 как есть.
- `/auditor` (можно позже): загрузить файл раскрытия → пересчитать commit → сверить с `proof_commit` ончейн.

**Режим демо:** `pnpm demo:tamper` — переменная окружения подменяет `signing_address` перед сверкой → клиент отказывает.

Дизайн: спокойный, без крипто-эстетики; статусы ✓/✗ крупно; технические детали — в раскрывающихся блоках.
Мобильная вёрстка обязательна. Тексты карточки — на английском (судьи), с переключателем RU.
