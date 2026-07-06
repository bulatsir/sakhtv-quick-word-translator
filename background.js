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

async function translateWord(word) {
  if (memCache.has(word)) return memCache.get(word);

  const stored = await chrome.storage.local.get(word);
  if (typeof stored[word] === 'string' && stored[word]) {
    memCache.set(word, stored[word]);
    return stored[word];
  }

  if (inFlight.has(word)) return inFlight.get(word);

  const promise = fetchTranslation(word).finally(() => inFlight.delete(word));
  inFlight.set(word, promise);

  const translation = await promise;
  if (translation) { // null/пустое не кэшируем — иначе слово навсегда без перевода
    memCache.set(word, translation);
    chrome.storage.local.set({ [word]: translation });
  }
  return translation;
}

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
      '?client=gtx&sl=en&tl=ru&dt=t&q=' + encodeURIComponent(word);
    const resp = await fetch(url);
    if (!resp.ok) {
      // 429 и прочие ошибки — без ретраев; повторный hover запросит заново
      resolve(null);
      return;
    }
    const data = await resp.json();
    const t = data && data[0] && data[0][0] && data[0][0][0];
    resolve(typeof t === 'string' && t ? t : null);
  } catch (e) {
    resolve(null);
  } finally {
    active--;
    pump();
  }
}
