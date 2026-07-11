/*
  content-render.js
  =====================================================================
  로딩/오류/결과 팝업의 HTML을 생성하는 렌더링 함수들과, 팝업 배율(scale)
  설정 관련 함수들을 담당합니다.
  =====================================================================
*/

// ─────────────────────────────────────────────
// HTML 조각(부품)을 만드는 렌더링 함수들
// ─────────────────────────────────────────────

/*
  renderBrandHeader: 팝업 상단의 로고 + 이름 + 상태 텍스트 영역 HTML을 반환합니다.
  chrome.runtime.getURL()은 확장 프로그램 패키지 내부 파일의 전체 URL을 반환합니다.
  예) "chrome-extension://확장ID/assets/icon48.png"
  이 URL은 manifest.json의 web_accessible_resources에 등록된 파일만 사용 가능합니다.
*/

function getCredibilityShortLabel(score) {
  const normalized = toScore(score);
  if (normalized >= 80) return "높음";
  if (normalized >= 50) return "중간";
  return "낮음";
}

function getClickbaitShortLabel(score) {
  const normalized = toScore(score);
  if (normalized <= 40) return "낮음";
  if (normalized <= 60) return "중간";
  return "높음";
}

function getCompactLoadingLabel(message) {
  const text = String(message || "");

  if (/기사|판별|뉴스|확인된/.test(text)) {
    return "기사 확인";
  }

  if (/분석|점수|신뢰|어그로|요약|AI/.test(text)) {
    return "AI 분석";
  }

  if (/링크|URL|준비|캐시|패턴|리스트/.test(text)) {
    return "준비 중";
  }

  return "분석 중";
}

function renderLoadingTopBar(message = "AI 분석 중...") {
  const logoUrl = chrome.runtime.getURL("assets/logo.png");
  const loadingLabel = getCompactLoadingLabel(message);
  return `
    <header class="inton-compact-bar inton-compact-bar--loading" aria-label="Intone 분석 진행 상태">
      <div class="inton-logo-pill" aria-hidden="true">
        <img src="${escapeHtml(logoUrl)}" alt="">
      </div>
      <div class="inton-status-pill inton-status-pill--loading">
        <span class="inton-brand">Intone</span>
        <span class="inton-loading-mini" title="${escapeHtml(message)}" aria-label="${escapeHtml(message)}">
          <span class="inton-loading-mini__spinner" aria-hidden="true"></span>
          <strong class="inton-loading-title">${escapeHtml(loadingLabel)}</strong>
        </span>
      </div>
    </header>
  `;
}

function renderCompactTopBar(credibilityLabel, clickbaitLabel) {
  const logoUrl = chrome.runtime.getURL("assets/logo.png");
  const credibilityTone = getCompactMetricTone("trust", credibilityLabel);
  const clickbaitTone = getCompactMetricTone("bait", clickbaitLabel);
  return `
    <header class="inton-compact-bar" aria-label="Intone 분석 결과 요약">
      <div class="inton-logo-pill" aria-hidden="true">
        <img src="${escapeHtml(logoUrl)}" alt="">
      </div>
      <div class="inton-status-pill">
        <span class="inton-brand">Intone</span>
        <span class="inton-metric inton-metric--trust inton-metric--${escapeHtml(credibilityTone)}" title="신뢰도 ${escapeHtml(credibilityLabel)}" aria-label="신뢰도 ${escapeHtml(credibilityLabel)}">
          ${renderMetricIcon("shield")}
          <strong>${escapeHtml(credibilityLabel)}</strong>
        </span>
        <span class="inton-divider" aria-hidden="true"></span>
        <span class="inton-metric inton-metric--bait inton-metric--${escapeHtml(clickbaitTone)}" title="어그로도 ${escapeHtml(clickbaitLabel)}" aria-label="어그로도 ${escapeHtml(clickbaitLabel)}">
          ${renderMetricIcon("fire")}
          <strong>${escapeHtml(clickbaitLabel)}</strong>
        </span>
      </div>
    </header>
  `;
}

function getCompactMetricTone(type, label) {
  if (type === "trust") {
    if (label === "높음") return "good";
    if (label === "낮음") return "bad";
    return "medium";
  }

  if (label === "낮음") return "good";
  if (label === "높음") return "bad";
  return "medium";
}

function renderMetricIcon(type) {
  if (type === "shield") {
    return `<span class="inton-icon inton-icon--shield" aria-hidden="true"><svg viewBox="0 0 24 24" role="img"><path d="M12 2.5 20 5.5V11c0 5.1-3.3 8.9-8 10.5C7.3 19.9 4 16.1 4 11V5.5l8-3Z"/><path d="M12 5v13.1c3.1-1.3 5.2-4 5.2-7.1V7.3L12 5Z" opacity=".42"/></svg></span>`;
  }
  if (type === "fire") {
    return `<span class="inton-icon inton-icon--fire" aria-hidden="true"><svg viewBox="0 0 24 24" role="img"><path d="M13.2 2.5c.6 3.2-.7 4.8-2.2 6.4-1.3 1.4-2.8 2.9-2.8 5.3 0 3.9 3.1 6.8 7 6.8s6.8-2.8 6.8-6.8c0-3.1-1.7-5.4-3.8-7.2.2 2.1-.7 3.5-2 4.5.2-3.4-1.1-6.5-3-9Z"/><path d="M12.2 13c-1.5 1.4-2.2 2.3-2.2 4 0 2 1.6 3.5 3.7 3.5s3.8-1.5 3.8-3.6c0-1.6-.9-2.8-2.1-3.8-.1 1.3-.6 2.2-1.6 3 .1-1.5-.4-2.5-1.6-3.1Z" opacity=".4"/></svg></span>`;
  }
  if (type === "warning") {
    return `<span class="inton-icon inton-icon--warning" aria-hidden="true"><svg viewBox="0 0 24 24" role="img" fill-rule="evenodd" clip-rule="evenodd"><path d="M12 3.2c.46 0 .88.25 1.1.65l8.62 15.35c.5.9-.14 2.02-1.16 2.02H3.44c-1.02 0-1.66-1.11-1.16-2.02L10.9 3.85c.22-.4.64-.65 1.1-.65Zm-1 6v5.4h2V9.2h-2Zm0 7.2v2h2v-2h-2Z"/></svg></span>`;
  }
  return `<span class="inton-icon inton-icon--summary" aria-hidden="true"><svg viewBox="0 0 24 24" role="img"><rect x="5" y="3" width="14" height="18" rx="3"/><path d="M8.5 8h7M8.5 12h7M8.5 16h4"/></svg></span>`;
}

function renderScorePanel({ type, title, score, shortLabel, breakdown = {}, rows }) {
  const isTrust = type === "credibility";
  const safeRows = Array.isArray(rows) ? rows : [];
  const iconType = isTrust ? "shield" : "fire";
  return `
    <section class="inton-score-panel inton-score-panel--${escapeHtml(type)}">
      <header class="inton-score-head">
        <div class="inton-score-title">
          ${renderMetricIcon(iconType)}
          <h3>${escapeHtml(title)}</h3>
        </div>
        <div class="inton-score-number"><span>점수</span><b data-score="${toScore(score)}">0</b><small>/100</small></div>
      </header>
      <div class="inton-score-body">
        <div class="inton-donut" style="--score:0;" data-score="${toScore(score)}" data-digits="${String(toScore(score)).length}" aria-label="${escapeHtml(title)} ${toScore(score)}점">
          <strong>0</strong>
          <span>/100</span>
        </div>
        <div class="inton-score-list">
          ${safeRows.map(([key, label, max]) => renderScoreRow(key, label, max, breakdown, type)).join("")}
        </div>
      </div>
      <div class="inton-score-note">
        <span class="inton-bulb" aria-hidden="true">💡</span>
        ${escapeHtml(isTrust
          ? `전반적으로 신뢰도는 ${shortLabel} 수준입니다.`
          : `전반적으로 어그로도는 ${shortLabel} 수준입니다.`)}
      </div>
    </section>
  `;
}

function renderScoreRow(key, label, max, breakdown, type) {
  const value = Number.isFinite(Number(breakdown?.[key])) ? Number(breakdown[key]) : 0;
  const percent = max ? Math.max(0, Math.min(100, Math.round((value / max) * 100))) : 0;
  return `
    <div class="inton-score-row inton-score-row--${escapeHtml(type)}">
      <span>${escapeHtml(label)}</span>
      <i>
        <em style="width:0%" data-target-width="${percent}%"></em>
        <b>${value}/${max}</b>
      </i>
    </div>
  `;
}

/*
  renderActions: 팝업 하단의 버튼 영역 HTML을 반환합니다.
  hasDetails가 false이면 "상세 분석 보기" 버튼을 비활성화(disabled)합니다.
  (뉴스 기사가 아닐 때는 세부 항목이 없으므로 비활성화)
*/
function renderActions(hasDetails) {
  return `
    <div class="inton-actions">
      <button class="inton-detail-button" type="button" data-ai-news-action="toggle-details" aria-expanded="false" ${hasDetails ? "" : "disabled"}>
        <span class="inton-detail-button__label">세부 분석 보기</span>
        <svg class="inton-detail-button__chevron" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
          <path d="M6 9l6 6 6-6" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
      </button>
    </div>
  `;
}

function normalizePopupScalePercent(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return DEFAULT_POPUP_SCALE_PERCENT;
  }
  return Math.max(70, Math.min(130, Math.round(numeric)));
}

function applyPopupScaleToElement(popupElement = popup) {
  if (!popupElement) {
    return;
  }

  const normalized = normalizePopupScalePercent(intonePopupScalePercent);
  popupElement.style.setProperty("--intone-user-scale", String(normalized / 100));
  popupElement.dataset.intoneScale = String(normalized);
}

function loadPopupScalePreference() {
  chrome.storage.local.get([POPUP_SCALE_STORAGE_KEY], (items) => {
    intonePopupScalePercent = normalizePopupScalePercent(items[POPUP_SCALE_STORAGE_KEY]);
    applyPopupScaleToElement();
  });
}



function showPopupElement(popupElement) {
  const wasHiddenOrClosing = popupElement.hidden || popupElement.classList.contains("ai-news-popup--closing");
  window.clearTimeout(popupHideAnimationTimer);
  cancelPendingPopupClose();
  if (wasHiddenOrClosing) {
    lastPopupPosition = null;
    cancelPopupEntryGrace();
    cancelScheduledSummaryReveal();
    armPopupGrace();
    popupHadPointerEntry = false;
    popupCompactHomePosition = null;
  }
  popupElement.hidden = false;
  popupElement.classList.remove("ai-news-popup--closing", "ai-news-popup--safe-zone-active", "ai-news-popup--moving");
  applyPopupScaleToElement(popupElement);
  if (wasHiddenOrClosing) {
    triggerPopupAppearAnimation(popupElement);
  }
  updatePopupViewportLimits();
}


function triggerPopupAppearAnimation(popupElement) {
  if (!popupElement) {
    return;
  }

  popupElement.classList.remove("ai-news-popup--appearing");
  // 강제 reflow로 이전 애니메이션 상태를 정리한 뒤, 최초 표시 때만 다시 실행합니다.
  void popupElement.offsetWidth;
  popupElement.classList.add("ai-news-popup--appearing");

  window.clearTimeout(popupAppearAnimationTimer);
  popupAppearAnimationTimer = window.setTimeout(() => {
    popupAppearAnimationTimer = null;
    popupElement?.classList.remove("ai-news-popup--appearing");
  }, POPUP_APPEAR_ANIMATION_MS + 60);
}


function updatePopupViewportLimits() {
  if (!popup || popup.hidden) {
    return;
  }

  const padding = POPUP_VIEWPORT_PADDING_PX;
  const availableWidth = Math.max(1, window.innerWidth - padding * 2);
  const availableHeight = Math.max(1, window.innerHeight - padding * 2);

  if (popup.classList.contains("ai-news-popup--separated")) {
    popup.style.height = "auto";
    popup.style.minHeight = "0";
    popup.style.maxHeight = "none";
    popup.style.overflow = "visible";
    popup.style.setProperty("--inton-popup-max-height", `${availableHeight}px`);
    popup.style.setProperty("--inton-detail-max-height", `${Math.max(170, availableHeight - 130)}px`);
    popup.style.setProperty("--inton-summary-max-height", `${Math.max(110, Math.min(340, availableHeight - 100))}px`);
    return;
  }

  popup.style.maxWidth = `${availableWidth}px`;
  popup.style.maxHeight = `${availableHeight}px`;
  popup.style.setProperty("--inton-popup-max-height", `${availableHeight}px`);

  const compactBar = popup.querySelector(".inton-compact-bar");
  const summaryCard = popup.querySelector(".inton-summary-card");
  const actions = popup.querySelector(".inton-actions");

  const compactHeight = compactBar ? compactBar.getBoundingClientRect().height : 0;
  const summaryHeight = summaryCard ? Math.min(summaryCard.scrollHeight || 0, 220) : 0;
  const actionsHeight = actions ? actions.getBoundingClientRect().height : 0;
  const chromeHeight = compactHeight + Math.min(summaryHeight, 260) + actionsHeight + 56;
  const detailMaxHeight = Math.max(160, availableHeight - chromeHeight);
  const summaryMaxHeight = Math.max(120, availableHeight - compactHeight - 32);

  popup.style.setProperty("--inton-detail-max-height", `${detailMaxHeight}px`);
  popup.style.setProperty("--inton-summary-max-height", `${summaryMaxHeight}px`);
}
