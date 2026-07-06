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

// Префикс версии формата кэша: v5 = добавлена строка «→ лемма» для
// слов-двойников. Записи старых форматов игнорируются.
const CACHE_PREFIX = 'v5:';

// Одноразовая уборка записей старых форматов кэша (v1:..v4:).
chrome.storage.local.get(null).then((all) => {
  const stale = Object.keys(all).filter(
    (k) => /^v\d+:/.test(k) && !k.startsWith(CACHE_PREFIX)
  );
  if (stale.length) chrome.storage.local.remove(stale);
}).catch(() => {});

// Неудавшиеся переводы (офлайн/429) не переспрашиваем FAIL_TTL_MS,
// чтобы активное наведение не бомбило Google во время бана.
const failedAt = new Map(); // слово -> время неудачи
const FAIL_TTL_MS = 30000;

function recentlyFailed(word) {
  const t = failedAt.get(word);
  if (!t) return false;
  if (Date.now() - t > FAIL_TTL_MS) {
    failedAt.delete(word);
    return false;
  }
  return true;
}

// Формы неправильных глаголов, совпадающие с другим словом: для них Google
// показывает статью «двойника» («left» → «левый») и теряет глагол.
// Дописываем в тултип глагольную статью начальной формы.
// Object.create(null): слова приходят из субтитров, обычный {} отдал бы
// унаследованные свойства для слов вроде "constructor".
// Инвариант: значения не должны сами быть ключами таблицы (иначе рекурсия).
const HOMOGRAPH_LEMMA = Object.assign(Object.create(null), {
  left: 'leave',
  saw: 'see',
  rose: 'rise',
  broke: 'break',
  found: 'find',
  ground: 'grind',
  bore: 'bear',
  wound: 'wind',
  bound: 'bind',
  bit: 'bite',
  shot: 'shoot',
  lit: 'light',
  fell: 'fall',
  lay: 'lie',
});

async function translateWord(word) {
  if (memCache.has(word)) return memCache.get(word);
  // Бронируем inFlight синхронно, ДО первого await: иначе предперевод
  // реплики и hover на то же слово успевают оба пройти проверку и сделать
  // два HTTP-запроса.
  if (inFlight.has(word)) return inFlight.get(word);
  const promise = resolveWord(word).finally(() => inFlight.delete(word));
  inFlight.set(word, promise);
  return promise;
}

async function resolveWord(word) {
  const key = CACHE_PREFIX + word;
  const stored = await chrome.storage.local.get(key);
  if (typeof stored[key] === 'string' && stored[key]) {
    memCache.set(word, stored[key]);
    return stored[key];
  }

  if (recentlyFailed(word)) return null;

  const translation = await buildEntry(word);
  if (translation) { // null/пустое не кэшируем — иначе слово навсегда без перевода
    memCache.set(word, translation);
    chrome.storage.local.set({ [key]: translation }).catch(() => {});
  } else {
    failedAt.set(word, Date.now());
  }
  return translation;
}

// Статья слова + для двойников строка «→ лемма: глагольные значения».
async function buildEntry(word) {
  let translation = await fetchTranslation(word);

  const lemma = HOMOGRAPH_LEMMA[word];
  // Проверка `lemma in HOMOGRAPH_LEMMA` — страховка от рекурсии, если при
  // будущем редактировании таблицы значение совпадёт с чьим-то ключом.
  if (lemma && !(lemma in HOMOGRAPH_LEMMA)) {
    // Лемма переводится обычным путём и оседает в кэше как своё слово.
    const lemmaEntry = await translateWord(lemma);
    if (lemmaEntry) {
      const lines = lemmaEntry.split('\n');
      const verbLine = lines.find((l) => l.startsWith('гл.\t'));
      const terms = verbLine ? verbLine.slice(verbLine.indexOf('\t') + 1) : lines[0];
      if (terms) {
        translation = (translation ? translation + '\n' : '') +
          '→ ' + lemma + '\t' + terms;
      }
    }
  }
  return translation;
}

// Сокращения частей речи (dt=bd возвращает английские названия).
// Object.create(null) — по той же причине, что и HOMOGRAPH_LEMMA.
const POS_ABBR = Object.assign(Object.create(null), {
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
});

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
      // hl=en фиксирует язык метаданных ответа: иначе названия частей речи
      // приходят на языке браузера (Accept-Language) и не сокращаются.
      '?client=gtx&sl=en&tl=ru&hl=en&dt=t&dt=bd&q=' + encodeURIComponent(word);
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
      // Таб отделяет метку части речи — content.js рисует её приглушённой.
      lines.push((abbr ? abbr + '\t' : '') + terms.join(', '));
    }
    resolve(lines.length ? lines.join('\n') : null);
  } catch (e) {
    resolve(null);
  } finally {
    active--;
    pump();
  }
}
