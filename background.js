// [QWT] Service worker: перевод слов en→ru и кэширование.
// Протокол: {type: "translate", words: string[]} -> {[word]: string|null}.

const memCache = new Map(); // слово -> перевод; живёт до засыпания воркера
const inFlight = new Map(); // слово -> Promise<string|null>; защита от дублей
const queue = [];           // очередь на fetch: {word, resolve}
const MAX_CONCURRENT = 4;   // лимит параллельных запросов к Google
let active = 0;

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.type === 'translate' && Array.isArray(msg.words)) {
    translateWords(msg.words)
      .then(sendResponse)
      .catch((e) => {
        console.error('[QWT]', e);
        sendResponse({});
      });
    return true; // канал sendResponse остаётся открытым для async-ответа
  }
});

async function translateWords(words) {
  const result = {};
  await Promise.all(
    words.map(async (word) => {
      result[word] = await translateWord(word);
    })
  );
  return result;
}

// Префикс версии формата кэша: v2 = многострочный словарный формат.
// Старые записи (плоский перевод без вариантов) просто игнорируются.
const CACHE_PREFIX = 'v2:';

async function translateWord(word) {
  if (memCache.has(word)) return memCache.get(word);

  const key = CACHE_PREFIX + word;
  const stored = await chrome.storage.local.get(key);
  if (typeof stored[key] === 'string' && stored[key]) {
    memCache.set(word, stored[key]);
    return stored[key];
  }

  if (inFlight.has(word)) return inFlight.get(word);

  const promise = fetchTranslation(word).finally(() => inFlight.delete(word));
  inFlight.set(word, promise);

  const translation = await promise;
  if (translation) { // null/пустое не кэшируем — иначе слово навсегда без перевода
    memCache.set(word, translation);
    chrome.storage.local.set({ [key]: translation });
  }
  return translation;
}

// Сокращения частей речи (dt=bd возвращает английские названия).
const POS_ABBR = {
  verb: 'гл.',
  noun: 'сущ.',
  adjective: 'прил.',
  adverb: 'нар.',
  preposition: 'предл.',
  pronoun: 'мест.',
  conjunction: 'союз',
  interjection: 'межд.',
  article: 'арт.',
  numeral: 'числ.',
  particle: 'част.',
};

function fetchTranslation(word) {
  return new Promise((resolve) => {
    queue.push({ word, resolve });
    pump();
  });
}

async function pump() {
  if (active >= MAX_CONCURRENT || queue.length === 0) return;
  const { word, resolve } = queue.shift();
  active++;
  try {
    const url =
      'https://translate.googleapis.com/translate_a/single' +
      '?client=gtx&sl=en&tl=ru&dt=t&dt=bd&q=' + encodeURIComponent(word);
    const resp = await fetch(url);
    if (!resp.ok) {
      // 429 и прочие ошибки — без ретраев; повторный hover запросит заново
      resolve(null);
      return;
    }
    const data = await resp.json();
    const lines = [];
    // Основной (самый частотный) перевод — первой строкой.
    const main = data && data[0] && data[0][0] && data[0][0][0];
    if (typeof main === 'string' && main) lines.push(main);
    // Словарные варианты по частям речи (data[1] от dt=bd) —
    // чтобы при многозначном слове было из чего выбрать по контексту.
    const dict = Array.isArray(data && data[1]) ? data[1] : [];
    for (const entry of dict.slice(0, 3)) {
      const terms = Array.isArray(entry && entry[1]) ? entry[1].slice(0, 4) : [];
      if (!terms.length) continue;
      const abbr = POS_ABBR[entry[0]] || entry[0] || '';
      lines.push((abbr ? abbr + ' ' : '') + terms.join(', '));
    }
    resolve(lines.length ? lines.join('\n') : null);
  } catch (e) {
    resolve(null);
  } finally {
    active--;
    pump();
  }
}
