# Stretch (Дастан, 10–11 ноября, только при зелёном статусе) — второй провайдер в логе

---

Прочитай services/verifier и SPEC §3.2, §4.1. Задача — адаптер Venice для верификатора, чтобы лог содержал ключи двух
провайдеров и тезис стал «публичный лог для всей индустрии приватного ИИ».

1. Прочитай https://docs.venice.ai/overview/privacy.md и https://docs.venice.ai/guides/features/tee-e2ee-models.md:
   эндпоинт `/api/v1/tee/attestation` (nonce 32 байта, `intel_quote`, `nvidia_payload`, `signing_key`) и
   `/api/v1/tee/signature`. Нужен API-ключ Venice и небольшой баланс.
2. Вынеси в верификаторе провайдер-независимое ядро (dcap-qvl, NRAS, проверка подписи) и интерфейс `ProviderAdapter`
   { fetchReport(nonce, model), parseKey(report), fetchSignature(id) }. Реализация `nearai` уже есть; добавь `venice`.
3. `KeyEntryInput.model` для Venice — с префиксом провайдера (`venice:<model>`); в контракт изменений не нужно.
4. Один прогон → записи в логе от двух провайдеров; скрин для README; раздел «Adding a provider» в README.
Если за день не заводится — откатить, в README оставить как next step с описанием интерфейса адаптера.
