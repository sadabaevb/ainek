# Поле хакатона — кто рядом с нами (срез 2 ноября 2026, 58 заявок)

Источник: `GET https://nearhackathon.com/api/projects?page=N` (только имя, треки и ссылка на демо-пост), демо-посты в X,
README репозиториев. Обновлять срез 6 и 10 ноября — список растёт на десятки в день.

## Что видно сразу

- **AI Security & Defense завален «охранниками кошелька агента».** Veto, Semilla1 Guard, Allowance, LeashPay, Spend Guard,
  SpendGuard AI, Leash, Agent Leash, Tollgate (два разных), Tripwire, Claw Guard, PayGuard, Payrein, Arkhe Guard, Agent Toll,
  Approval Moment, IntentGuard, Sentinel, EarnScout, agent-pay, PinPay… — около 25 из 58. Источник — официальный AI-промпт
  трека (`nearai/near-hackathon-prompt-examples/tracks/06-security.md`): «проверка получателя перед оплатой, FC-ключ,
  инъекция остановлена, покажи лог». Любой проект, который *продаёт себя* как «лимиты + whitelist для агента», — один из 25.
- **Официальный промпт трека Privacy** — «private expense auditor» (загрузка чеков, модель в TEE, панель Verified, ничего не
  хранить на сервере). Нашей идеи в официальных промптах нет; те, кто рядом, пришли к ней сами.
- Прямого аналога связки «публичный лог ключей от независимых верификаторов → fail-closed → E2EE → приватная политика
  в TEE → контракт» и «трёх поимок» в списке нет. Но каждая половина по отдельности уже есть — см. ниже.

## Ближайшие проекты и чем мы отличаемся

| Проект | Что у них (по их словам) | Что остаётся нашим |
| --- | --- | --- |
| **TEE Receipts** (@chamdom, `tmdry4530/tee-receipts`, подан 2.11) | NEAR AI Cloud; dcap-qvl + NRAS офлайн; контракт `register_signer` (**owner only**) с историей ключей и TTL 7 дней; `submit_receipt`; ecrecover/ed25519 ончейн; пересчёт хешей в браузере; replay на фикстурах; «flip one byte → NOT VERIFIED». Честно пишут: «trust in a signer rests on the owner who registered it», «does not prove the answer is correct». Тот же автор — `agent-pay`. | Реестр пишут **независимые верификаторы**, не владелец; клиент **fail-closed до отправки** (у них «prove later»); **E2EE** incl. tool calls; детектор не-TEE маршрута; на цепочке **солёный коммит**, а не `sha256(prompt)` — короткий промпт из голого хеша брутфорсится; селективное раскрытие аудитору; агент + политика в TEE. |
| **PrivatePay Agent** (@hassan_samimi + @Arashb122, `Nassami1/privatepay-agent`, подан 2.11, самый заметный пост) | «Redacted locally. Attested in a TEE. Capped onchain.» Инвойс редактируется локально → sanitized текст в NEAR AI TEE, аттестация и подпись проверяются → агент может только `try_pay` → контракт: дневной лимит, whitelist, дубли инвойсов; отказ пишется ончейн; CLI + read-only дашборд; testnet tUSDC. | Политика **приватна**, решение **подписано внутри TDX** (их лимиты публичны в контракте); **E2EE вместо редактирования** (редактирование теряет данные, шлюз всё равно видит текст); proof без суммы и получателя; NeedsApproval + Telegram; стоп-кнопка `DeleteKey`; «ретеншн невозможен по конструкции» для policy job; публичный лог ключей — у них проверка аттестации только своя. |
| **AgentGuard** (@MyCryptoWallet, `CodeMasterLabs/agentguard`) | «Budget, not keys»: агент только просит, on-chain vault решает paid / held / refused; «TEE risk oracle ловит prompt injection до движения денег»; NEAR Intents для кросс-чейна; алерты на телефон; MCP для Claude Code/Codex. | У них TEE — детектор инъекций поверх публичного vault; у нас **вся политика** вычисляется и подписывается в TEE, контракт проверяет подпись; решение проверяемо третьей стороной; модельный слой верифицирован и зашифрован. |
| **Black box** (@mr_ghdc, `tenxagent/blackbox`) | «Flight recorder» агента: каждое решение в хеш-цепочке, якорь на NEAR ключом, который не может двигать деньги. | Наш action proof по форме похож (хеш-цепочка, коммит), но привязан к **подписанному в TDX** решению и к model proof; плюс всё остальное. |
| **Approval Moment**, **Claw Guard**, **Veto**, **Spend Guard** и др. | Независимый верификатор платежей / signing gate / firewall: правило → allow / block, инъекция блокируется, FC-ключ. | Не конкурируем на их поле: мы не «ещё один гард», мы — проверяемость маршрута модель→политика→цепочка. |

Прочее для контекста: Veridom Pay, Throughput Treasury, Morrowseal (наследственный сейф), Jurat, DeadDrop, ÁUREA — трек Privacy,
не про проверяемый ИИ. Treasury/thesis-проекты — Investment Thesis.

## Что это меняет в плане (решения — в DECISIONS.md)

1. **Внешний верификатор обязателен.** Пока оба верификатора наши, наш лог отличается от owner-only реестра TEE Receipts
   только словами. Цель: к 10 ноября в логе есть записи от `v3`, который запускает человек не из команды, по одной команде
   из README. Для этого верификатор пакуется как `docker run …` / `npx ainek-verify` (SPEC §3.2).
2. **Открытая регистрация верификаторов** (предложение к синку 3.11): `register_verifier` без owner — любой аккаунт
   со storage deposit; доверие решает клиент (`TRUSTED_VERIFIERS`, кворум). Это и есть разница «лог» vs «реестр владельца».
3. **Не продаваться как спенд-гард.** В README, посте и видео первое — «ответ пришёл из аттестованного анклава, и это
   проверил не вендор, а публичный лог»; агент и лимиты — следствие. Слово «firewall» не используем.
4. **Раздел «Prior art in this hackathon» в README** с этой таблицей в сжатом виде. Судьи увидят эти проекты в любом
   случае; тот, кто сам разметил поле и честно сказал, чем отличается, выглядит сильнее.
5. **Сроки.** TEE Receipts и PrivatePay поданы на 2-й день. Это не значит, что они победят (первые — часто самые
   сырые), но значит, что «мы единственные, кто это сделал» говорить нельзя. Говорим «единственные, у кого проверяет не вендор».

## Ссылки

- TEE Receipts: пост https://x.com/chamdom/status/2117060976700997909 · репо https://github.com/tmdry4530/tee-receipts
- PrivatePay Agent: пост https://x.com/hassan_samimi/status/2117164751662858404 · репо https://github.com/Nassami1/privatepay-agent
- AgentGuard: пост https://x.com/MyCryptoWallet/status/2116833046041416166 · репо https://github.com/CodeMasterLabs/agentguard
- Black box: пост https://x.com/mr_ghdc/status/2116851371207012835 · репо https://github.com/tenxagent/blackbox
- Approval Moment: https://github.com/minotorxbt/approval-moment · Claw Guard: https://x.com/RUNECLAW_AI/status/2116940411423924311
- Официальные AI-промпты треков: https://github.com/nearai/near-hackathon-prompt-examples/tree/main/tracks
- Список заявок: https://nearhackathon.com/#projects (API: `/api/projects?page=1..`)
