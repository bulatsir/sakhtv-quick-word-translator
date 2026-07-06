// [QWT] Content script: оборачивание слов субтитров, предперевод, тултип.
(() => {
  'use strict';

  const log = (...a) => console.log('[QWT]', ...a);
  const translations = new Map(); // нормализованное слово -> перевод (только строки)

  // --- адаптер сайта: селекторы реплики и контейнера плеера ---
  const SITE = location.hostname.endsWith('netflix.com')
    ? {
        cueSelector: '.player-timedtext-text-container',
        playerSelector: '.watch-video',
        captionsRoot: '.player-timedtext',
      }
    : {
        cueSelector: '.jw-captions .jw-text-track-cue',
        playerSelector: '.jwplayer',
        captionsRoot: '.jw-captions',
      };

  // --- нормализация слова для перевода и ключа кэша ---
  // "Ran!" -> "ran"; don't/re-read сохраняют внутренние знаки; ’ -> '
  function normalize(raw) {
    return raw
      .toLowerCase()
      .replace(/’/g, "'")
      .replace(/^[^a-z0-9]+/, '')
      .replace(/[^a-z0-9]+$/, '');
  }

  // Переопределяется блоком тултипа ниже: обновление открытого тултипа,
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

  // Есть ли в реплике ещё не обёрнутый текст. Netflix может менять текст
  // в том же контейнере, поэтому одноразовой пометки недостаточно —
  // проверяем содержимое. Обёрнутые узлы не считаются, поэтому наши
  // собственные мутации не зацикливают observer.
  function needsWrap(cue) {
    const walker = document.createTreeWalker(cue, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const n = walker.currentNode;
      if (n.textContent.trim() && !n.parentElement.closest('.qwt-word')) return true;
    }
    return false;
  }

  // --- оборачивание слов одной реплики ---
  function wrapCue(cue) {
    const walker = document.createTreeWalker(cue, NodeFilter.SHOW_TEXT);
    const textNodes = [];
    while (walker.nextNode()) {
      // уже обёрнутое не трогаем
      if (!walker.currentNode.parentElement.closest('.qwt-word')) {
        textNodes.push(walker.currentNode);
      }
    }

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
    document.querySelectorAll(SITE.cueSelector).forEach((cue) => {
      if (needsWrap(cue)) wrapCue(cue);
    });
  }

  // --- наблюдение: один observer на body (стабильный предок) ---
  // Плеер может пересоздать .jw-captions при смене озвучки/эпизода —
  // observer на body переживает это.
  const observer = new MutationObserver(() => {
    try {
      processCues();
      // Плеер удалил реплику, пока курсор был на слове: mouseout в этом
      // случае не приходит, и тултип «залипает» — прячем его сами.
      if (hoveredSpan && !hoveredSpan.isConnected) hideTooltip();
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
    if (!document.querySelector(SITE.captionsRoot)) {
      log('captions container not found (yet)');
    }
  }, 60000);

  // --- тултип ---
  let tooltip = null;
  let playerEl = null;
  let hoveredWord = null; // нормализованное слово под курсором (или null)
  let hoveredSpan = null; // span под курсором — для проверки, что он ещё в DOM

  function ensureTooltip() {
    // Тултип живёт ВНУТРИ контейнера плеера — иначе невидим в fullscreen.
    const player = document.querySelector(SITE.playerSelector) || document.body;
    if (!tooltip || playerEl !== player || !player.contains(tooltip)) {
      if (tooltip) tooltip.remove();
      playerEl = player;
      tooltip = document.createElement('div');
      tooltip.className = 'qwt-tooltip';
      player.appendChild(tooltip);
    }
    return tooltip;
  }

  // Формат перевода: первая строка — основной перевод; дальше строки
  // "метка\tварианты". Рендер только через createElement/textContent.
  function renderTooltipContent(tip, text) {
    tip.textContent = '';
    String(text).split('\n').forEach((line, i) => {
      const row = document.createElement('div');
      if (i === 0) row.className = 'qwt-main';
      const tabIdx = line.indexOf('\t');
      if (i > 0 && tabIdx > -1) {
        const pos = document.createElement('span');
        pos.className = 'qwt-pos';
        pos.textContent = line.slice(0, tabIdx);
        row.appendChild(pos);
        row.appendChild(document.createTextNode(' ' + line.slice(tabIdx + 1)));
      } else {
        row.textContent = line;
      }
      tip.appendChild(row);
    });
  }

  function showTooltip(span, text) {
    const tip = ensureTooltip();
    renderTooltipContent(tip, text);
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
    hoveredSpan = null;
    if (tooltip) tooltip.style.display = 'none';
  }

  // Обновление открытого тултипа, когда перевод пришёл позже hover'а.
  onTranslationsUpdated = (resp) => {
    if (hoveredWord && typeof resp[hoveredWord] === 'string' && resp[hoveredWord]) {
      if (tooltip) renderTooltipContent(tooltip, resp[hoveredWord]);
    }
  };

  // --- делегированные hover-обработчики (mouseover/mouseout всплывают) ---
  document.addEventListener('mouseover', (e) => {
    try {
      const span = e.target.closest && e.target.closest('.qwt-word');
      if (!span || !span.dataset.qwtWord) return;
      const word = span.dataset.qwtWord;
      hoveredWord = word;
      hoveredSpan = span;
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

  processCues(); // на случай, если субтитры уже на экране
  log('content script ready');
})();
