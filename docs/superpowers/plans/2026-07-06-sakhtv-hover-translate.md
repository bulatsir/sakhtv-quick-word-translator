# SakhTV Quick Word Translator — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Chrome-расширение (MV3): перевод en→ru слова в субтитрах JW Player на sakh.tv по наведению мыши.

**Architecture:** Content script наблюдает за `.jw-captions` через MutationObserver, оборачивает слова реплики в `<span>`, предзапрашивает переводы у service worker'а (двухуровневый кэш + бесплатный endpoint Google Translate) и показывает тултип по hover. Спека: `docs/superpowers/specs/2026-07-06-sakhtv-hover-translate-design.md`.

**Tech Stack:** Ванильный JS, Manifest V3, без сборщиков и зависимостей. 4 файла в корне репозитория.

## Global Constraints

- Никаких автотестов в v1 (решение спеки): каждая задача завершается ручной проверкой в Chrome («Load unpacked», страница sakh.tv). Проверку можно выполнять через Chrome-автоматизацию на залогиненной сессии пользователя.
- Любая вставка внешнего текста в DOM — только `createElement` + `textContent`. `innerHTML`/`insertAdjacentHTML` запрещены.
- Все console-сообщения расширения — с префиксом `[QWT]`.
- Ошибки расширения никогда не ломают плеер: обработчики обёрнуты в try/catch.
- `matches`: `https://sakh.tv/watch/*` и `https://www.sakh.tv/watch/*`.
- Перевод — строго один запрос на одно слово (batched запрещён — риск тихой порчи кэша).
- В кэш (память и `chrome.storage.local`) пишутся только непустые строки.
- Протокол сообщений: запрос `{type: "translate", words: string[]}` → ответ `{[word]: string|null}`.

---

### Task 1: Каркас расширения (manifest + styles + заглушки скриптов)

**Files:**
- Create: `manifest.json`
- Create: `styles.css`
- Create: `content.js` (заглушка)
- Create: `background.js` (заглушка)

**Interfaces:**
- Produces: манифест, подключающий `content.js`/`styles.css` на страницах просмотра и `background.js` как service worker; CSS-классы `.qwt-word`, `.qwt-tooltip` и переопределение `pointer-events` для `.jw-captions`.

- [ ] **Step 1: Создать manifest.json**

```json
{
  "manifest_version": 3,
  "name": "SakhTV Quick Word Translator",
  "version": "0.1.0",
  "description": "Перевод слов в субтитрах sakh.tv по наведению мыши (en → ru)",
  "content_scripts": [
    {
      "matches": ["https://sakh.tv/watch/*", "https://www.sakh.tv/watch/*"],
      "js": ["content.js"],
      "css": ["styles.css"],
      "run_at": "document_idle"
    }
  ],
  "background": { "service_worker": "background.js" },
  "permissions": ["storage"],
  "host_permissions": ["https://translate.googleapis.com/*"]
}
```

- [ ] **Step 2: Создать styles.css**

```css
/* JW Player ставит pointer-events: none на субтитры — мышь проходит сквозь.
   Без этого переопределения hover не работает вовсе (см. спеку, блокер B1).
   Побочный эффект: клик по субтитрам больше не ставит видео на паузу. */
.jw-captions,
.jw-captions * {
  pointer-events: auto;
}

.qwt-word:hover {
  background: rgba(255, 220, 0, 0.35);
  border-radius: 2px;
  cursor: pointer;
}

.qwt-tooltip {
  display: none;
  position: absolute;
  transform: translateX(-50%);
  background: rgba(20, 20, 20, 0.95);
  color: #fff;
  padding: 4px 10px;
  border-radius: 6px;
  font-size: 18px;
  line-height: 1.4;
  white-space: nowrap;
  z-index: 10000;
  pointer-events: none; /* тултип не перехватывает мышь — иначе мерцание */
}
```

- [ ] **Step 3: Создать заглушки content.js и background.js**

`content.js`:
```js
console.log('[QWT] content script loaded');
```

`background.js`:
```js
console.log('[QWT] service worker loaded');
```

- [ ] **Step 4: Проверить загрузку расширения**

1. `chrome://extensions` → включить «Режим разработчика» → «Загрузить распакованное» → выбрать папку проекта.
2. Ожидаемо: расширение появляется без ошибок (красной плашки «Errors» нет).
3. Открыть любую страницу `https://sakh.tv/watch/...` → в DevTools Console видно `[QWT] content script loaded`.

- [ ] **Step 5: Commit**

```bash
git add manifest.json styles.css content.js background.js
git commit -m "feat: extension skeleton (MV3 manifest, styles, stub scripts)"
```

---

### Task 2: background.js — перевод и кэш

**Files:**
- Modify: `background.js` (полная замена заглушки)

**Interfaces:**
- Consumes: манифест из Task 1 (`permissions: storage`, `host_permissions` на translate.googleapis.com).
- Produces: обработчик `chrome.runtime.onMessage` для `{type: "translate", words: string[]}`, отвечающий `{[word]: string|null}`. Это единственный контракт, на который опирается content.js.

- [ ] **Step 1: Написать background.js целиком**

```js
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
```

- [ ] **Step 2: Проверить перевод через консоль**

1. `chrome://extensions` → карточка расширения → кнопка ⟳ (перезагрузить).
2. Открыть страницу `https://sakh.tv/watch/...`, в DevTools выбрать контекст
   «SakhTV Quick Word Translator» (выпадающий список контекстов Console) и выполнить:
   ```js
   chrome.runtime.sendMessage({type: 'translate', words: ['ran', 'house']}, console.log)
   ```
3. Ожидаемо: `{ran: "побежал"|похожее, house: "дом"}` (точный текст перевода может отличаться).
4. Повторный вызов — мгновенный ответ (кэш). Проверка storage:
   ```js
   chrome.storage.local.get(null, console.log)
   ```
   Ожидаемо: объект содержит ключи `ran`, `house`.

- [ ] **Step 3: Commit**

```bash
git add background.js
git commit -m "feat: translation service worker with two-level cache and rate limiting"
```

---

### Task 3: content.js — наблюдение за субтитрами, оборачивание слов, предперевод

**Files:**
- Modify: `content.js` (полная замена заглушки)

**Interfaces:**
- Consumes: протокол `{type: "translate", words: string[]}` → `{[word]: string|null}` из Task 2; классы `.qwt-word` из Task 1.
- Produces: спаны `.qwt-word` с `dataset.qwtWord` (нормализованное слово) в DOM субтитров; локальная `Map` `translations`; функции `normalize(raw)`, `prefetch(words)`, на которые Task 4 навешивает hover. В этом Task тултипа ещё нет.

- [ ] **Step 1: Написать content.js**

```js
// [QWT] Content script: оборачивание слов субтитров и предперевод.
(() => {
  'use strict';

  const log = (...a) => console.log('[QWT]', ...a);
  const translations = new Map(); // нормализованное слово -> перевод (только строки)

  // --- нормализация слова для перевода и ключа кэша ---
  // "Ran!" -> "ran"; don't/re-read сохраняют внутренние знаки; ’ -> '
  function normalize(raw) {
    return raw
      .toLowerCase()
      .replace(/’/g, "'")
      .replace(/^[^a-z0-9]+/, '')
      .replace(/[^a-z0-9]+$/, '');
  }

  // Переопределяется блоком тултипа (Task 4): обновление открытого тултипа,
  // когда перевод пришёл позже hover'а.
  let onTranslationsUpdated = () => {};

  // --- предперевод: спрашиваем background только о новых словах ---
  function prefetch(words) {
    const missing = words.filter((w) => !translations.has(w));
    if (!missing.length) return;
    try {
      chrome.runtime.sendMessage({ type: 'translate', words: missing }, (resp) => {
        if (chrome.runtime.lastError || !resp) return;
        for (const [word, t] of Object.entries(resp)) {
          if (t) translations.set(word, t);
        }
        onTranslationsUpdated(resp);
      });
    } catch (e) {
      log(e);
    }
  }

  // --- оборачивание слов одной реплики ---
  function wrapCue(cue) {
    if (cue.dataset.qwtDone) return;
    cue.dataset.qwtDone = '1'; // помечаем ДО мутаций — защита от зацикливания

    const walker = document.createTreeWalker(cue, NodeFilter.SHOW_TEXT);
    const textNodes = [];
    while (walker.nextNode()) textNodes.push(walker.currentNode);

    const words = new Set();
    for (const node of textNodes) {
      const parts = node.textContent.split(/(\s+)/);
      const frag = document.createDocumentFragment();
      for (const part of parts) {
        if (!part) continue;
        if (/^\s+$/.test(part)) {
          frag.appendChild(document.createTextNode(part));
          continue;
        }
        const span = document.createElement('span');
        span.className = 'qwt-word';
        span.textContent = part; // только textContent — никакого innerHTML
        const norm = normalize(part);
        if (norm) {
          span.dataset.qwtWord = norm;
          words.add(norm);
        }
        frag.appendChild(span);
      }
      node.parentNode.replaceChild(frag, node);
    }
    if (words.size) prefetch([...words]);
  }

  function processCues() {
    document
      .querySelectorAll('.jw-captions .jw-text-track-cue:not([data-qwt-done])')
      .forEach(wrapCue);
  }

  // --- наблюдение: один observer на body (стабильный предок) ---
  // Плеер может пересоздать .jw-captions при смене озвучки/эпизода —
  // observer на body переживает это.
  const observer = new MutationObserver(() => {
    try {
      processCues();
    } catch (e) {
      log(e);
    }
  });
  observer.observe(document.body, {
    childList: true,
    subtree: true,
    characterData: true,
  });

  // Диагностика медленного старта (поиск при этом продолжается).
  setTimeout(() => {
    if (!document.querySelector('.jw-captions')) {
      log('captions container not found (yet)');
    }
  }, 60000);

  processCues(); // на случай, если субтитры уже на экране
  log('content script ready');
})();
```

- [ ] **Step 2: Проверить оборачивание на живой странице**

1. Перезагрузить расширение (⟳), открыть серию с оригинальной озвучкой,
   включить английские субтитры (клавиша `c` или меню CC).
2. Во время реплики выполнить в консоли страницы:
   ```js
   document.querySelectorAll('.qwt-word').length
   ```
   Ожидаемо: число > 0 (по количеству слов реплики); слова в субтитрах
   визуально не изменились.
3. В контексте расширения:
   ```js
   chrome.storage.local.get(null, o => console.log(Object.keys(o).length))
   ```
   Ожидаемо: число растёт по мере реплик — предперевод работает.
4. Дать плееру поиграть 2–3 минуты: ошибок `[QWT]` в консоли нет,
   субтитры сменяются нормально.

- [ ] **Step 3: Commit**

```bash
git add content.js
git commit -m "feat: wrap subtitle words in spans and prefetch translations"
```

---

### Task 4: Тултип и hover

**Files:**
- Modify: `content.js` (добавить блок тултипа и hover-обработчиков внутрь IIFE, перед строкой `log('content script ready');`)

**Interfaces:**
- Consumes: переменные того же IIFE из Task 3 — `translations`, `prefetch`, `onTranslationsUpdated` (объявлена как `let`, здесь переопределяется); CSS `.qwt-tooltip` из Task 1; одиночные запросы `{type:"translate", words:[слово]}` из Task 2.
- Produces: готовый пользовательский сценарий «навёл — увидел перевод».

- [ ] **Step 1: Добавить в content.js блок тултипа и hover**

Вставить внутрь IIFE (после определения `processCues`/observer, перед `processCues();` и `log('content script ready');`):

```js
  // --- тултип ---
  let tooltip = null;
  let playerEl = null;
  let hoveredWord = null; // нормализованное слово под курсором (или null)

  function ensureTooltip() {
    // Тултип живёт ВНУТРИ контейнера плеера — иначе невидим в fullscreen.
    const player = document.querySelector('.jwplayer') || document.body;
    if (!tooltip || playerEl !== player || !player.contains(tooltip)) {
      if (tooltip) tooltip.remove();
      playerEl = player;
      tooltip = document.createElement('div');
      tooltip.className = 'qwt-tooltip';
      player.appendChild(tooltip);
    }
    return tooltip;
  }

  function showTooltip(span, text) {
    const tip = ensureTooltip();
    tip.textContent = text; // только textContent
    tip.style.display = 'block';
    const wordRect = span.getBoundingClientRect();
    const playerRect = playerEl.getBoundingClientRect();
    tip.style.left = wordRect.left - playerRect.left + wordRect.width / 2 + 'px';
    let top = wordRect.top - playerRect.top - tip.offsetHeight - 8;
    if (top < 0) top = wordRect.bottom - playerRect.top + 8; // у края — под словом
    tip.style.top = top + 'px';
  }

  function hideTooltip() {
    hoveredWord = null;
    if (tooltip) tooltip.style.display = 'none';
  }

  // Обновление открытого тултипа, когда перевод пришёл позже hover'а.
  onTranslationsUpdated = (resp) => {
    if (hoveredWord && typeof resp[hoveredWord] === 'string' && resp[hoveredWord]) {
      if (tooltip) tooltip.textContent = resp[hoveredWord];
    }
  };

  // --- делегированные hover-обработчики (mouseover/mouseout всплывают) ---
  document.addEventListener('mouseover', (e) => {
    try {
      const span = e.target.closest && e.target.closest('.qwt-word');
      if (!span || !span.dataset.qwtWord) return;
      const word = span.dataset.qwtWord;
      hoveredWord = word;
      showTooltip(span, translations.get(word) || '…');
      if (!translations.has(word)) prefetch([word]); // промах кэша — одиночный запрос
    } catch (err) {
      log(err);
    }
  });

  document.addEventListener('mouseout', (e) => {
    try {
      if (e.target.closest && e.target.closest('.qwt-word')) hideTooltip();
    } catch (err) {
      log(err);
    }
  });
```

- [ ] **Step 2: Проверить полный сценарий**

1. Перезагрузить расширение, открыть серию с субтитрами.
2. **Первым делом** (проверка блокера из спеки): навести курсор на слово —
   слово подсвечивается. Если нет — проверить в DevTools, что
   `getComputedStyle(document.querySelector('.qwt-word')).pointerEvents === 'auto'`.
3. Тултип с переводом появляется над словом мгновенно (слова реплики уже
   предпереведены); увёл курсор — тултип исчез.
4. Слово у верхнего края области субтитров — тултип показывается снизу.
5. Fullscreen (двойной клик по видео) — тултип виден.
6. DevTools → Network → Offline: hover по новому слову показывает «…»,
   плеер работает; вернуть Online — повторный hover показывает перевод.

- [ ] **Step 3: Commit**

```bash
git add content.js
git commit -m "feat: hover tooltip with translation"
```

---

### Task 5: Полный прогон чек-листа спеки и README

**Files:**
- Create: `README.md`

**Interfaces:**
- Consumes: всё готовое расширение (Task 1–4).
- Produces: проверенная v1 и инструкция по установке для пользователя.

- [ ] **Step 1: Прогнать чек-лист тестирования из спеки (раздел «Тестирование», 9 пунктов)**

По порядку из спеки: hover срабатывает; перевод показывается без задержек;
смена реплик; смена озвучки/эпизода без перезагрузки; fullscreen; перемотка/
пауза/качество; офлайн; страница без субтитров (нет ошибок в консоли);
пунктуация (`don't`, `re-read`, `"Ran!"`, `’`).
Каждый провал — фикс и повторная проверка пункта.

- [ ] **Step 2: Написать README.md**

```markdown
# SakhTV Quick Word Translator

Chrome-расширение: наведите мышь на слово в субтитрах на sakh.tv —
увидите его перевод на русский.

## Установка

1. Откройте `chrome://extensions`.
2. Включите «Режим разработчика» (переключатель справа сверху).
3. Нажмите «Загрузить распакованное» и выберите папку этого проекта.

## Использование

1. Откройте серию на sakh.tv с **оригинальной озвучкой** и включите
   английские субтитры (клавиша `c` или кнопка CC в плеере).
2. Наведите курсор на любое слово в субтитрах — появится перевод.

Переводы кэшируются: однажды встреченное слово показывается мгновенно
и без интернет-запроса.

## Ограничения v1

- Только en → ru.
- Видео не ставится на паузу при наведении.
- У дорожек с дубляжом субтитров обычно нет — расширение бездействует.
```

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs: README with install and usage instructions"
```
