/*
  content-popup.js
  =====================================================================
  팝업 DOM 생성/제거, 표시/숨김, 닫힘 유예(popupGrace) 상태머신,
  요약/상세 카드 펼치기·접기 전환을 담당합니다.
  =====================================================================
*/

// ─────────────────────────────────────────────
// 팝업 DOM 요소 관리
// ─────────────────────────────────────────────

/*
  ensurePopup: 팝업 div 요소를 반환합니다.
  처음 호출될 때 한 번만 요소를 생성하고 페이지에 추가합니다.
  이후 호출에서는 이미 만든 요소를 재사용합니다.
  이렇게 하면 DOM에 같은 요소가 중복으로 생기는 것을 방지합니다.

  생성된 팝업은 id="ai-news-link-popup"을 가지며,
  popup.css가 이 id를 기준으로 스타일을 적용합니다.
*/
function ensurePopup() {
  if (popup) {
    window.clearTimeout(popupHideAnimationTimer);
    popup.classList.remove("ai-news-popup--closing", "ai-news-popup--safe-zone-active", "ai-news-popup--moving");
    return popup; // 이미 만들었으면 바로 반환
  }

  popup = document.createElement("div");
  popup.id = "ai-news-link-popup";
  popup.hidden = true; // 처음엔 숨김 상태로 생성

  // 팝업 내부 클릭 이벤트 (버튼 동작 처리)
  popup.addEventListener("click", handlePopupClick);
  // 결과 팝업 안으로 마우스가 들어오면 기사 요약 카드를 펼침
  popup.addEventListener("mouseenter", handlePopupPointerActivity);
  popup.addEventListener("pointerenter", handlePopupPointerActivity);
  popup.addEventListener("mouseover", handlePopupPointerActivity);
  // 팝업 전체 바깥으로 마우스가 나갈 때만 닫힘 판정을 실행합니다.
  // mouseout은 내부 요소 이동에도 계속 발생하므로 사용하지 않습니다.
  popup.addEventListener("mouseleave", handlePopupMouseLeave);
  // 팝업 내부 스크롤이 페이지 스크롤/위치 재계산으로 번지는 것을 막음
  popup.addEventListener("wheel", handlePopupWheel, { passive: false });

  // <html> 태그 바로 아래에 추가 (body가 아닌 이유: z-index 충돌 방지)
  document.documentElement.appendChild(popup);
  return popup;
}

/*
  handlePopupPointerActivity: 결과 팝업 안으로 마우스가 들어오거나 내부에서
  움직일 때 숨겨져 있던 기사 요약 카드를 자연스럽게 펼칩니다.
  mouseenter/pointerenter(진입 순간 한 번)와 mouseover(내부 자식 요소 사이를
  이동할 때마다) 세 이벤트 모두 같은 처리가 필요해서 한 핸들러로 등록합니다.
*/
function handlePopupPointerActivity(event) {
  if (!popup || popup.hidden || !popup.contains(event.target)) {
    return;
  }

  rememberPointerFromEvent(event);
  pointerInsidePopup = true;
  popupHadPointerEntry = true;
  lastPointerInsidePopupAt = Date.now();
  cancelPopupEntryGrace();
  cancelPendingPopupClose();

  if (popup.classList.contains("ai-news-popup--closing")) {
    window.clearTimeout(popupHideAnimationTimer);
    popup.classList.remove("ai-news-popup--closing");
    setPopupState(inferPopupStateFromClasses());
  }

  if (isSummaryRevealEnabled()) {
    if (isPopupGraceActive()) {
      scheduleSummaryRevealAfterTransition();
    } else {
      revealSummaryPanel();
    }
  }
}

function handlePopupMouseLeave(event) {
  rememberPointerFromEvent(event);
  pointerInsidePopup = false;

  if (event?.relatedTarget && popup?.contains(event.relatedTarget)) {
    return;
  }

  // 팝업이 등장/확장/접힘/위치보정되는 동안은 mouseleave가 오더라도 즉시 닫지
  // 않고, 브라우저가 잘못/일찍 보낸 것일 수 있으니 전환이 끝난 뒤 실제 좌표를
  // 다시 확인합니다.
  if (isPopupGraceActive()) {
    schedulePopupCloseFromPointerExit(getPopupGraceRemaining());
    return;
  }

  cancelPopupEntryGrace();
  closePopupImmediatelyIfPointerOutside();
}

/*
  handlePopupClick: 팝업 안의 버튼을 클릭했을 때 실행됩니다.
  어떤 버튼인지는 data-ai-news-action 속성 값으로 구분합니다.
  HTML에서 이렇게 사용합니다: <button data-ai-news-action="toggle-details">상세 정보 보기</button>

  버튼 동작:
    "toggle-details" → 세부 항목 펼치기/접기
*/
function handlePopupClick(event) {
  // event.target에서 가장 가까운 data-ai-news-action 속성을 가진 요소를 찾음
  // .dataset.aiNewsAction → data-ai-news-action 속성 값 (케밥→카멜 변환 자동)
  rememberPointerFromEvent(event);

  const button = event.target.closest("[data-ai-news-action]");
  const action = button?.dataset.aiNewsAction;


  if (action === "toggle-details") {
    toggleDetails(button);
    return;
  }

  if (action === "close") {
    closePopupFromPointerExit();
  }
}

/*
  toggleDetails: <details> 태그의 열림/닫힘 상태를 반전시킵니다.
  <details open> 이면 세부 항목이 펼쳐진 상태, open이 없으면 접힌 상태입니다.
  내용이 바뀌면 팝업 높이가 달라지므로 keepPopupInViewport()도 호출합니다.
*/

/*
  animateCountUp: 숫자 요소의 textContent를 0에서 target까지 부드럽게 증가시킵니다.
  점수 도넛/배지가 나타날 때 숫자가 카운트업되는 효과를 위해 사용합니다.
*/
function animateCountUp(el, target, duration = 900) {
  if (!el) {
    return;
  }
  const safeTarget = Number.isFinite(target) ? target : 0;
  const start = performance.now();

  function tick(now) {
    const progress = Math.min(1, (now - start) / duration);
    const eased = 1 - Math.pow(1 - progress, 3);
    el.textContent = String(Math.round(safeTarget * eased));
    if (progress < 1) {
      requestAnimationFrame(tick);
    } else {
      el.textContent = String(safeTarget);
    }
  }

  requestAnimationFrame(tick);
}

/*
  animateScoreReveal: 세부 분석 카드가 처음 펼쳐질 때 도넛 차트, 막대 그래프,
  점수 숫자가 0에서 실제 값까지 채워지는 애니메이션을 실행합니다.
  details.dataset.scoreAnimated로 팝업 하나당 한 번만 실행되도록 막습니다.
*/
function animateScoreReveal(details) {
  if (!details || details.dataset.scoreAnimated === "1") {
    return;
  }
  details.dataset.scoreAnimated = "1";

  const donuts = Array.from(details.querySelectorAll(".inton-donut"));
  const rows = Array.from(details.querySelectorAll(".inton-score-row em"));
  const scoreNumbers = Array.from(details.querySelectorAll(".inton-score-number b"));

  requestAnimationFrame(() => {
    donuts.forEach((donut, index) => {
      const target = Number(donut.dataset.score) || 0;
      window.setTimeout(() => {
        donut.style.setProperty("--score", String(target));
        animateCountUp(donut.querySelector("strong"), target, 900);
      }, index * 90);
    });

    rows.forEach((em, index) => {
      const targetWidth = em.dataset.targetWidth || "0%";
      window.setTimeout(() => {
        em.style.width = targetWidth;
      }, 140 + index * 45);
    });

    scoreNumbers.forEach((b) => {
      const target = Number(b.dataset.score) || 0;
      animateCountUp(b, target, 900);
    });
  });
}

function toggleDetails(button) {
  const details = popup?.querySelector(".ai-news-popup__details");
  if (!details || !popup || popupState === "closing") {
    return;
  }

  // 상세보기/간략히보기는 오직 이 버튼 클릭으로만 바뀝니다.
  // 마우스 이동, 스크롤, 위치 보정에서는 이 상태를 건드리지 않습니다.
  const willOpen = !details.classList.contains("is-open");

  markPopupLayoutChanging(POPUP_INTERACTION_GRACE_MS);
  details.classList.toggle("is-open", willOpen);
  details.setAttribute("aria-hidden", willOpen ? "false" : "true");
  setPopupState(willOpen ? "detail" : "summary");

  if (willOpen) {
    // 세부 카드 자체가 스크롤을 갖지 않도록, 실제 콘텐츠 높이(scrollHeight)만큼
    // max-height를 잡아줍니다. 이러면 세부 카드 안에서는 절대 넘치지 않고,
    // 넘치는 부분은 팝업 전체를 감싸는 .inton-mini-shell 스크롤 하나로만 처리됩니다.
    popup.style.setProperty("--inton-detail-max-height", `${details.scrollHeight + 4}px`);
    animateScoreReveal(details);
  }

  if (button) {
    const label = button.querySelector(".inton-detail-button__label");
    const text = willOpen ? "간략히 보기" : "세부 분석 보기";
    if (label) {
      label.textContent = text;
    } else {
      button.textContent = text;
    }
    button.setAttribute("aria-expanded", willOpen ? "true" : "false");
  }

  // 상세 카드가 펼쳐지거나 접히는 동안, 팝업 높이 변화를 따라가며 top을 매 프레임
  // 재계산합니다. 아래쪽에 공간이 있으면 간단표시창 위치가 고정된 채로 아래로만
  // 늘어나고, 화면 끝에 닿으면 그때부터 위쪽으로 밀리며 필요한 공간을 확보합니다.
  trackPopupHeightForGrowth();

  requestAnimationFrame(() => {
    // 팝업 밖이면 닫습니다. 단, 간략히 보기 직후 위치 복귀로 다시 안쪽에 들어오면 유지됩니다.
    // 방금 markPopupLayoutChanging()으로 켠 유예(popupGrace)가 아직 살아있다면,
    // 크기 변화 중 좌표가 순간적으로 밖처럼 보이는 것뿐일 수 있으므로 즉시 닫지 않고
    // 유예가 끝나는 시점까지 닫기를 미룹니다.
    requestAnimationFrame(() => {
      if (!isPointerInsideActiveAreas()) {
        if (isPopupGraceActive()) {
          schedulePopupCloseFromPointerExit(getPopupGraceRemaining());
        } else {
          closePopupFromPointerExit();
        }
      } else {
        cancelPendingPopupClose();
      }
    });
  });
}

function handlePopupWheel(event) {
  if (!popup || popup.hidden || !popup.contains(event.target)) {
    return;
  }

  rememberPointerFromEvent(event);
  suppressPopupMouseOutUntil = Math.max(suppressPopupMouseOutUntil, Date.now() + 250);

  // 상세 카드 내부에서 위/아래 끝까지 스크롤했을 때도
  // 뒤쪽 웹페이지가 같이 스크롤되며 팝업 위치가 재계산되는 문제를 막습니다.
  event.stopPropagation();

  const scrollable = findScrollablePopupParent(event.target);
  if (!scrollable) {
    event.preventDefault();
    return;
  }

  const deltaY = event.deltaY || 0;
  const atTop = scrollable.scrollTop <= 0;
  const atBottom = Math.ceil(scrollable.scrollTop + scrollable.clientHeight) >= scrollable.scrollHeight;

  if ((deltaY < 0 && atTop) || (deltaY > 0 && atBottom)) {
    event.preventDefault();
  }
}

function findScrollablePopupParent(startNode) {
  let node = startNode instanceof Element ? startNode : startNode?.parentElement;
  while (node && node !== popup) {
    const style = window.getComputedStyle(node);
    const canScroll = /(auto|scroll)/.test(style.overflowY) && node.scrollHeight > node.clientHeight + 1;
    if (canScroll) {
      return node;
    }
    node = node.parentElement;
  }

  return popup && popup.scrollHeight > popup.clientHeight + 1 ? popup : null;
}

// ─────────────────────────────────────────────
// 팝업 화면 상태 전환 함수들
// ─────────────────────────────────────────────

/*
  showLoadingPopup: 분석이 시작되면 로딩 중 팝업을 표시합니다.
  로딩 애니메이션(링)과 진행 중 메시지를 보여줍니다.
  background.js가 STATUS_BROADCAST를 보낼 때마다 updateLoadingStatus()가
  메시지 텍스트를 실시간으로 바꿔줍니다.

  innerHTML에 HTML 문자열을 직접 넣어서 내용을 한 번에 교체합니다.
  `백틱 문자열`은 ${변수}를 사용할 수 있는 템플릿 리터럴입니다.
  사용자 데이터는 반드시 escapeHtml()을 거쳐서 XSS 공격을 방지합니다.
  (XSS: 악의적인 HTML/JS 코드가 주입되는 보안 취약점)
*/
function showLoadingPopup(x, y, message = "AI 분석 중...") {
  const popupElement = ensurePopup();
  setPopupState("loading");
  popupElement.className = "ai-news-popup ai-news-popup--loading ai-news-popup--separated ai-news-popup--summary-collapsed";
  popupElement.innerHTML = `
    <section class="inton-mini-shell inton-loading-shell inton-loading-shell--compact">
      ${renderLoadingTopBar(message)}
    </section>
  `;
  showPopupElement(popupElement);
  positionPopup(x, y);
}

/*
  updateLoadingStatus: 로딩 팝업이 열려 있는 동안 진행 상황 텍스트만 교체합니다.
  innerHTML 전체를 다시 쓰지 않고 텍스트 노드만 바꿔서 효율적입니다.
  background.js에서 STATUS_BROADCAST 메시지가 올 때마다 호출됩니다.
*/
function updateLoadingStatus(message) {
  const status = popup?.querySelector(".inton-loading-title");
  // 현재 로딩 상태일 때만 텍스트 변경 (결과가 표시되고 있을 때 덮어쓰지 않도록)
  if (status && popup.classList.contains("ai-news-popup--loading")) {
    status.textContent = getCompactLoadingLabel(message);
    status.closest(".inton-loading-mini")?.setAttribute("title", message);
    status.closest(".inton-loading-mini")?.setAttribute("aria-label", message);
  }
}

/*
  showErrorPopupOnceForPersistentError:
  API Key 미등록, API 한도 초과, 인증 실패처럼 같은 원인이 계속 반복될 수 있는 오류는
  최초 1회만 화면 팝업으로 표시합니다. 이후 같은 종류의 오류는 background.js가 저장한
  상태 메시지를 action popup에서만 확인할 수 있게 하고, 화면 팝업은 띄우지 않습니다.
*/
function showErrorPopupOnceForPersistentError(message) {
  const errorKey = getPersistentErrorKey(message);

  if (!errorKey) {
    showErrorPopup(message);
    return;
  }

  wasPersistentErrorPopupShown(errorKey).then((alreadyShown) => {
    if (alreadyShown) {
      // background.js는 이미 currentAnalysisStatus에 오류 내용을 저장했습니다.
      // 반복 오류는 웹페이지 위에 계속 팝업을 띄우지 않고 조용히 닫습니다.
      hidePopup();
      clearAnalysisLock();
      analysisStartedForActiveLink = false;
      return;
    }

    markPersistentErrorPopupShown(errorKey).finally(() => {
      showErrorPopup(message);
    });
  }).catch(() => {
    // 저장소 접근에 실패하면 사용자에게 최소 한 번은 오류를 보여줍니다.
    showErrorPopup(message);
  });
}

function getPersistentErrorKey(message) {
  const text = String(message || "").toLowerCase();

  if (
    text.includes("api key") ||
    text.includes("api키") ||
    text.includes("api 키") ||
    text.includes("options에서 설정") ||
    text.includes("사용할 수 있는 ai api key")
  ) {
    return "api_key_missing_or_unavailable";
  }

  if (
    text.includes("429") ||
    text.includes("rate limit") ||
    text.includes("quota") ||
    text.includes("limit") ||
    text.includes("한도") ||
    text.includes("too many requests")
  ) {
    return "api_quota_or_rate_limit";
  }

  if (
    text.includes("401") ||
    text.includes("403") ||
    text.includes("unauthorized") ||
    text.includes("forbidden") ||
    text.includes("invalid api") ||
    text.includes("인증") ||
    text.includes("권한")
  ) {
    return "api_auth_or_permission";
  }

  if (
    text.includes("api 요청 실패") ||
    text.includes("500") ||
    text.includes("502") ||
    text.includes("503") ||
    text.includes("504") ||
    text.includes("server error")
  ) {
    return "api_provider_error";
  }

  return "";
}

function wasPersistentErrorPopupShown(errorKey) {
  return new Promise((resolve) => {
    chrome.storage.local.get([PERSISTENT_ERROR_POPUP_HISTORY_KEY], (items) => {
      if (chrome.runtime.lastError) {
        resolve(false);
        return;
      }

      const history = items[PERSISTENT_ERROR_POPUP_HISTORY_KEY] || {};
      resolve(Boolean(history && history[errorKey]));
    });
  });
}

function markPersistentErrorPopupShown(errorKey) {
  return new Promise((resolve) => {
    chrome.storage.local.get([PERSISTENT_ERROR_POPUP_HISTORY_KEY], (items) => {
      const history = items[PERSISTENT_ERROR_POPUP_HISTORY_KEY] || {};
      const nextHistory = {
        ...history,
        [errorKey]: Date.now()
      };

      chrome.storage.local.set({ [PERSISTENT_ERROR_POPUP_HISTORY_KEY]: nextHistory }, () => {
        resolve();
      });
    });
  });
}

/*
  showErrorPopup: 분석 중 오류가 발생하면 오류 메시지 팝업을 표시합니다.
*/
function showErrorPopup(message) {
  const popupElement = ensurePopup();
  setPopupState("error");
  const logoUrl = chrome.runtime.getURL("assets/logo.png");
  popupElement.className = "ai-news-popup ai-news-popup--error ai-news-popup--separated";
  popupElement.innerHTML = `
    <section class="inton-mini-shell">
      <header class="inton-compact-bar" aria-label="Intone 오류">
        <div class="inton-logo-pill" aria-hidden="true">
          <img src="${escapeHtml(logoUrl)}" alt="">
        </div>
        <div class="inton-status-pill">
          <span class="inton-brand">Intone</span>
          <span class="inton-metric inton-metric--bad" title="오류" aria-label="오류">
            ${renderMetricIcon("warning")}
            <strong>오류</strong>
          </span>
        </div>
      </header>
      <section class="inton-summary-card">
        <header class="inton-card-head">
          ${renderMetricIcon("warning")}
          <h2>분석할 수 없습니다</h2>
          <button class="inton-close" type="button" data-ai-news-action="close" aria-label="닫기">×</button>
        </header>
        <div class="inton-summary-body">
          <p>${escapeHtml(message)}</p>
        </div>
      </section>
    </section>
  `;
  showPopupElement(popupElement);
  positionFreshPopupAtOpenPoint();
}

/*
  showResultPopup: background.js로부터 분석 결과를 받아서 팝업을 완성합니다.
  result.is_article에 따라 두 가지 화면을 보여줍니다:
    - false: "뉴스 기사 아님" 간략 화면
    - true:  신뢰도·어그로도 점수 + 세부 항목 전체 화면

  화면 구성:
    - 브랜드 헤더 (로고 + inton)
    - 신뢰도 점수 카드 + 어그로도 점수 카드
    - 기사 한 줄 요약
    - 분석 요약 목록
    - 세부 항목 (접기/펼치기 가능)
    - 버튼 (세부 보기, 다시 분석)
*/
function showResultPopup(result) {
  const popupElement = ensurePopup();
  const wasLoadingPopup = popupElement.classList.contains("ai-news-popup--loading");
  setPopupState("compact");

  if (!result.is_article) {
    popupElement.className = "ai-news-popup ai-news-popup--result ai-news-popup--separated ai-news-popup--summary-collapsed";
    popupElement.innerHTML = `
      <section class="inton-mini-shell">
        ${renderCompactTopBar("중간", "중간")}
        <section class="inton-summary-card">
          <header class="inton-card-head">
            ${renderMetricIcon("summary")}
            <h2>기사 요약</h2>
            <button class="inton-close" type="button" data-ai-news-action="close" aria-label="닫기">×</button>
          </header>
          <div class="inton-summary-body">
            <p>${escapeHtml(result.summary || "이 링크는 뉴스 기사로 보기 어렵습니다.")}</p>
            <p class="inton-muted">${escapeHtml(result.warning || "뉴스 기사 링크에서 다시 시도하세요.")}</p>
          </div>
          ${renderActions(false)}
        </section>
      </section>
    `;

    if (wasLoadingPopup) {
      popupElement.classList.add("ai-news-popup--from-loading");
      window.setTimeout(() => {
        popupElement?.classList.remove("ai-news-popup--from-loading");
      }, 320);
    }

    showPopupElement(popupElement);
    positionFreshPopupAtOpenPoint({ withSummaryReveal: true });
    return;
  }

  const credibilityScore = toScore(result.credibility_score);
  const clickbaitScore   = toScore(result.clickbait_score);
  const credibilityLevel = getCredibilityLevel(credibilityScore);
  const clickbaitLevel   = getClickbaitLevel(clickbaitScore);
  const credibilityShort = getCredibilityShortLabel(credibilityScore);
  const clickbaitShort   = getClickbaitShortLabel(clickbaitScore);

  popupElement.className = "ai-news-popup ai-news-popup--result ai-news-popup--separated ai-news-popup--summary-collapsed";
  popupElement.innerHTML = `
    <section class="inton-mini-shell">
      ${renderCompactTopBar(credibilityShort, clickbaitShort)}

      <section class="inton-summary-card">
        <header class="inton-card-head">
          ${renderMetricIcon("summary")}
          <h2>기사 요약</h2>
          <button class="inton-close" type="button" data-ai-news-action="close" aria-label="닫기">×</button>
        </header>
        <div class="inton-summary-body">
          <p>${escapeHtml(result.article_summary || result.summary || "기사 요약을 생성하지 못했습니다.")}</p>
          ${result.warning ? `<p class="inton-muted">${escapeHtml(result.warning)}</p>` : ""}
        </div>
        ${renderActions(true)}
      </section>

      <section class="inton-detail-card ai-news-popup__details" aria-hidden="true">
        <h2 class="inton-detail-summary">세부 분석</h2>
        <div class="inton-detail-grid">
          ${renderScorePanel({
            type: "credibility",
            title: "신뢰도 분석",
            score: credibilityScore,
            level: credibilityLevel.label,
            shortLabel: credibilityShort,
            breakdown: result.credibility_breakdown,
            rows: [
              ["source_clarity", "공식 출처 인용", 20],
              ["title_body_match", "제목/본문 일치", 25],
              ["evidence_quality", "근거 충실도", 25],
              ["neutrality", "객관적 표현 사용", 15],
              ["context", "맥락 제공성", 15]
            ]
          })}
          ${renderScorePanel({
            type: "clickbait",
            title: "어그로도 분석",
            score: clickbaitScore,
            level: clickbaitLevel.label,
            shortLabel: clickbaitShort,
            breakdown: result.clickbait_breakdown,
            rows: [
              ["exaggeration", "과장된 표현", 20],
              ["curiosity_gap", "궁금증 유도", 20],
              ["title_body_mismatch", "선정적 제목", 25],
              ["emotional_trigger", "감정 자극", 20],
              ["hidden_key_info", "핵심 정보 은폐", 15]
            ]
          })}
        </div>
      </section>
    </section>
  `;

  if (wasLoadingPopup) {
    popupElement.classList.add("ai-news-popup--from-loading");
    window.setTimeout(() => {
      popupElement?.classList.remove("ai-news-popup--from-loading");
    }, 320);
  }

  showPopupElement(popupElement);
  positionFreshPopupAtOpenPoint({ withSummaryReveal: true });
}

