'use client';
// Card and page texts: English for the judges, Russian toggle (tier1-client.md). Kept flat on purpose.
import { useEffect, useState } from 'react';

export type Lang = 'en' | 'ru';

const en = {
  title: 'Ainek',
  tagline: 'Ask a private model. Get a proof you can check yourself.',
  model: 'Model',
  teeModel: 'Private TEE model',
  incognitoModel: 'Incognito model (no hardware proof): demo of the red card',
  tamper: 'Demo: swap the key before the log check (tamper)',
  placeholder: 'Type a message…',
  send: 'Send',
  working: 'Working…',
  steps: 'What happens before and after sending',
  you: 'You',
  assistant: 'Model',
  card: 'Proof',
  rowModel: 'Model',
  attested: 'attested deployment',
  rowHardware: 'Hardware',
  checkedInBrowser: 'checked in this browser',
  cached: 'from the 60-minute cache',
  rowKey: 'Key in the public log',
  keyLine: (index: number, verifiers: string, since: string) => `#${index}, logged by ${verifiers} since ${since}`,
  sampleEntry: 'sample entry until the contract is live',
  rowHashes: 'Request and response',
  hashesOk: 'hashes recomputed here match the signature made inside the model TEE',
  rowE2ee: 'End-to-end encryption',
  e2eeYes: 'yes, encrypted to the attested model key',
  e2eeNo: 'no',
  rowChain: 'On NEAR',
  chainPending: 'only a salted hash will go on-chain; contract not deployed yet',
  chainTx: (commit: string) => `only the hash ${commit}`,
  refusedTitle: 'Key not in the public log. Message not sent.',
  refusedBody: 'The model reported a signing key that no trusted verifier has logged. Ainek refuses rather than trusts.',
  nonTeeTitle: 'This answer went through a non-attested model.',
  nonTeeBody: 'Only the gateway signed it. There is no hardware proof of where it ran; privacy is contractual only.',
  failedTitle: 'Verification failed. Nothing was sent.',
  reverify: 'Re-verify yourself',
  openVc: 'Open in Verification Center',
  disclose: 'Disclose to auditor',
  details: 'Technical details',
  lang: 'RU',
};

const ru: typeof en = {
  title: 'Ainek',
  tagline: 'Спроси приватную модель. Получи proof, который проверишь сам.',
  model: 'Модель',
  teeModel: 'Приватная TEE-модель',
  incognitoModel: 'Incognito-модель (без аппаратного доказательства): демо красной карточки',
  tamper: 'Демо: подменить ключ перед сверкой с логом (tamper)',
  placeholder: 'Напиши сообщение…',
  send: 'Отправить',
  working: 'Работаю…',
  steps: 'Что происходит до и после отправки',
  you: 'Ты',
  assistant: 'Модель',
  card: 'Proof',
  rowModel: 'Модель',
  attested: 'аттестованный деплой',
  rowHardware: 'Железо',
  checkedInBrowser: 'проверено в этом браузере',
  cached: 'из кеша на 60 минут',
  rowKey: 'Ключ в публичном логе',
  keyLine: (index, verifiers, since) => `№${index}, записал ${verifiers}, с ${since}`,
  sampleEntry: 'образец записи, пока контракт не задеплоен',
  rowHashes: 'Запрос и ответ',
  hashesOk: 'хеши, пересчитанные здесь, совпадают с подписью из TEE модели',
  rowE2ee: 'Сквозное шифрование',
  e2eeYes: 'да, на аттестованный ключ модели',
  e2eeNo: 'нет',
  rowChain: 'В NEAR',
  chainPending: 'в цепочку уйдёт только солёный хеш; контракт ещё не задеплоен',
  chainTx: (commit) => `только хеш ${commit}`,
  refusedTitle: 'Ключ не в публичном логе. Сообщение не отправлено.',
  refusedBody: 'Модель назвала ключ подписи, которого нет у доверенных верификаторов. Ainek отказывает, а не доверяет.',
  nonTeeTitle: 'Этот ответ прошёл через не-аттестованную модель.',
  nonTeeBody: 'Подписал только шлюз. Аппаратного доказательства, где он выполнялся, нет; приватность только по договору.',
  failedTitle: 'Проверка не прошла. Ничего не отправлено.',
  reverify: 'Перепроверить самому',
  openVc: 'Открыть в Verification Center',
  disclose: 'Раскрыть аудитору',
  details: 'Технические детали',
  lang: 'EN',
};

export const dict = { en, ru };
export type Dict = typeof en;

export function useLang(): [Lang, Dict, () => void] {
  const [lang, setLang] = useState<Lang>('en');
  useEffect(() => {
    try {
      const saved = window.localStorage.getItem('ainek.lang');
      if (saved === 'ru' || saved === 'en') setLang(saved);
    } catch {
      /* private window */
    }
  }, []);
  const toggle = () => {
    const next: Lang = lang === 'en' ? 'ru' : 'en';
    setLang(next);
    try {
      window.localStorage.setItem('ainek.lang', next);
    } catch {
      /* ignore */
    }
  };
  return [lang, dict[lang], toggle];
}
