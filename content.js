// [QWT] Content script: оборачивание слов субтитров, предперевод, тултип.
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

  processCues(); // на случай, если субтитры уже на экране
  log('content script ready');
})();
