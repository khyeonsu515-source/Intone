/*
  content-hover.js
  =====================================================================
  링크 hover 감지, 분석 요청 트리거, background.js 상태 브로드캐스트 처리.
  content-state.js에 정의된 상수/전역 상태를 사용합니다.
  =====================================================================
*/

// ─────────────────────────────────────────────
// 마우스 이벤트 핸들러 함수들
// ─────────────────────────────────────────────

/*
  handleMouseOver: 마우스가 페이지의 어떤 요소 위로 올라갈 때마다 호출됩니다.
  올라간 요소가 링크(<a href="...">)인지 확인하고,
  맞으면 1초짜리 타이머를 시작합니다.
  타이머가 끝나기 전에 마우스가 벗어나면(handleMouseOut) 타이머를 취소합니다.
*/
function handleMouseOver(event) {
  // event.target: 마우스가 올라간 실제 요소 (이미지, span 등일 수 있음)
  // .closest("a[href]"): 자기 자신 또는 부모 중에서 href 속성이 있는 <a> 태그를 찾음
  // 예) 링크 안의 이미지에 마우스를 올려도 감지됨
  const link = event.target.closest("a[href]");

  // 링크가 아니거나 DOM에서 분리된 유령 요소이면 아무것도 안 함
  if (!link || !document.documentElement.contains(link)) {
    return;
  }

  const href = link.href;
  // 정규 표현식 (/^https?:\/\//i)으로 http:// 또는 https://로 시작하는지 확인
  // javascript:, mailto: 등의 링크는 무시
  if (!href || !/^https?:\/\//i.test(href)) {
    return;
  }

  if (shouldIgnoreLinkBecausePopupIsLocked(href)) {
    // 팝업이 떠 있는 동안 다른 링크를 완전히 버리지 않고,
    // 마지막으로 마우스가 올라간 링크를 기억만 해둡니다.
    // 팝업이 닫힌 뒤에도 커서가 이 링크 위에 있으면 그때부터 1초 타이머를 시작합니다.
    rememberPendingLockedLink(link, event);
    return;
  }

  if (isAnalysisLockActive() && isUrlLockedToCurrentAnalysis(href) && popup && !popup.hidden) {
    // 같은 기사 링크 위로 다시 올라온 경우에는 기존 팝업을 유지하고
    // 새 hover 타이머/API 요청을 만들지 않습니다.
    activeLink = link;
    if (!activeLinkHoverStartedAt) {
      activeLinkHoverStartedAt = Date.now();
      activeLinkPopupAllowedAt = activeLinkHoverStartedAt + POPUP_DISPLAY_DELAY_MS;
    }
    lastMouseEvent = event;
    popupOpenPoint = popupOpenPoint || { x: event.clientX, y: event.clientY };
    cancelPendingPopupClose();
    return;
  }

  beginHoverTrackingForLink(link, event.clientX, event.clientY);
}

/*
  handleMouseOut: 마우스가 요소에서 벗어날 때 호출됩니다.
  활성 링크에서 벗어난 경우 타이머를 취소하고 팝업을 닫습니다.
  단, 팝업 위로 이동하거나 링크 안의 자식 요소로 이동한 경우는 무시합니다.
*/
function handleMouseOut(event) {
  const link = event.target.closest("a[href]");

  // 벗어난 요소가 현재 활성 링크가 아니면 무시
  if (!link || link !== activeLink) {
    return;
  }

  rememberPointerFromEvent(event);

  // 링크 내부 이동 또는 링크에서 팝업으로 이동하는 경우는 유지합니다.
  if (event.relatedTarget && (link.contains(event.relatedTarget) || popup?.contains(event.relatedTarget))) {
    return;
  }

  // 팝업이 아직 화면에 표시되기 전이라면, 링크를 벗어난 순간
  // 대기 중인 표시 타이머와 분석 응답 표시를 모두 무효화합니다.
  if (!popup || popup.hidden) {
    clearHoverTimer();
    cancelPendingPopupDisplay();
    activeLink = null;
    popupOpenPoint = null;
    activeLinkHoverStartedAt = 0;
    activeLinkPopupAllowedAt = 0;
    analysisStartedForActiveLink = false;
    currentRequestId += 1;
    clearAnalysisLock();
    sendStatus("idle", "대기 중", "");
    return;
  }

  if (popup && !popup.hidden && !popupHadPointerEntry && isPopupEntryGraceActive()) {
    // 결과 팝업이 막 뜬 직후 link → popup 이동 중에 발생하는 mouseout은 바로 닫지 않습니다.
    // 다만 실제로 링크와 팝업 밖에 머문 상태라면 grace가 끝난 뒤 한 번만 닫힘 검사를 합니다.
    cancelPendingPopupClose();
    const remaining = Math.max(0, popupEntryGraceUntil - Date.now() + 30);
    popupDeferredCloseTimer = window.setTimeout(() => {
      if (!popupHadPointerEntry) {
        closePopupImmediatelyIfPointerOutside();
      }
    }, remaining);
    return;
  }

  if (isCompactResultPopupVisible()) {
    schedulePopupCloseFromPointerExit(COMPACT_POPUP_LINK_EXIT_GRACE_MS);
    return;
  }

  requestCloseCheckAfterPointerTransition();
}

/*
  handleMouseMove: 마우스가 움직일 때마다 호출됩니다.
  실제로 어떤 처리를 하지는 않고, 마지막 마우스 위치만 기록합니다.
  팝업을 오류나 재분석 결과로 업데이트할 때 위치 계산에 사용됩니다.
*/
function handleMouseMove(event) {
  rememberPointerFromEvent(event);

  if (pendingLockedLink && !isPointInsideElementRect(pendingLockedLink, event.clientX, event.clientY, 0)) {
    clearPendingLockedLink();
  }

  if (popup && !popup.hidden && isPointInsideElementRect(popup, event.clientX, event.clientY, 0)) {
    // 팝업 내부 이동은 상태를 바꾸지 않습니다. 닫힘 예약만 취소합니다.
    cancelPendingPopupClose();
  }
}

function handleDocumentClick(event) {
  const clickedLink = event.target?.closest?.("a[href]");
  if (!clickedLink || !/^https?:\/\//i.test(clickedLink.href || "")) {
    return;
  }

  // 팝업 내부 버튼/링크 클릭은 팝업 자체 UI 조작일 수 있으므로 여기서 강제 종료하지 않습니다.
  if (popup && popup.contains(event.target)) {
    return;
  }

  // 기사 링크를 클릭해 페이지를 이동하면 mouseout이 발생하지 않거나,
  // 뒤로가기로 돌아왔을 때 bfcache가 기존 팝업 DOM을 그대로 복원할 수 있습니다.
  // 클릭 순간에 모든 팝업/락/타이머를 즉시 정리해서 오래된 팝업이 남지 않게 합니다.
  resetPopupStateImmediately({ sendIdle: true });
}

/*
  clearHoverTimer: 1초 타이머를 취소합니다.
  window.clearTimeout()에 타이머 ID를 넘기면 예약된 실행이 취소됩니다.
*/
function clearHoverTimer() {
  if (hoverTimer) {
    window.clearTimeout(hoverTimer);
    hoverTimer = null;
  }
}

function cancelPendingPopupDisplay() {
  if (popupDisplayTimer) {
    window.clearTimeout(popupDisplayTimer);
    popupDisplayTimer = null;
  }
}

function cancelPopupEntryGrace() {
  window.clearTimeout(popupEntryGraceTimer);
  popupEntryGraceTimer = null;
  popupEntryGraceUntil = 0;
}

function isPopupEntryGraceActive() {
  return Date.now() < popupEntryGraceUntil;
}

/*
  popupGrace: 팝업이 등장/이동하거나 요약·상세 카드가 펼쳐지고 접힐 때 잠깐 동안
  "지금은 mouseleave나 좌표 판정을 곧이곧대로 믿지 말라"고 표시하는 유예 상태입니다.
  이 유예가 켜져 있는 동안에는 팝업이 시각적으로 움직이거나 크기가 바뀌는 중이라,
  브라우저가 mouseleave를 잘못/일찍 보내거나 커서가 일시적으로 밖에 있는 것처럼
  보일 수 있어서 실제로 닫을지 판단하는 걸 미룹니다.
*/
function cancelPopupGrace() {
  window.clearTimeout(popupGraceTimer);
  popupGraceTimer = null;
  popupGraceUntil = 0;
}

function isPopupGraceActive() {
  return Date.now() < popupGraceUntil;
}

function armPopupGrace(duration = POPUP_TRANSITION_GUARD_MS) {
  window.clearTimeout(popupGraceTimer);
  popupGraceUntil = Date.now() + duration;
  popupGraceTimer = window.setTimeout(() => {
    popupGraceTimer = null;
    popupGraceUntil = 0;
  }, duration);
}

function getPopupGraceRemaining(extra = 30) {
  return Math.max(0, popupGraceUntil - Date.now() + extra);
}

function cancelScheduledSummaryReveal() {
  window.clearTimeout(summaryRevealAfterTransitionTimer);
  summaryRevealAfterTransitionTimer = null;
}

function scheduleSummaryRevealAfterTransition() {
  cancelScheduledSummaryReveal();
  const remaining = isPopupGraceActive()
    ? getPopupGraceRemaining(20)
    : 0;
  summaryRevealAfterTransitionTimer = window.setTimeout(() => {
    summaryRevealAfterTransitionTimer = null;
    const x = lastPointerClientX ?? lastMouseEvent?.clientX;
    const y = lastPointerClientY ?? lastMouseEvent?.clientY;
    if (!popup || popup.hidden || popupState === "closing" || typeof x !== "number" || typeof y !== "number") {
      return;
    }
    if (!isPointInsideElementRect(popup, x, y, 0)) {
      return;
    }
    pointerInsidePopup = true;
    popupHadPointerEntry = true;
    lastPointerInsidePopupAt = Date.now();
    cancelPopupEntryGrace();
    cancelPendingPopupClose();
    if (isSummaryRevealEnabled()) {
      revealSummaryPanel();
    }
  }, remaining);
}

function armPopupEntryGrace() {
  window.clearTimeout(popupEntryGraceTimer);
  popupEntryGraceUntil = Date.now() + POPUP_ENTRY_GRACE_MS;
  popupEntryGraceTimer = window.setTimeout(() => {
    // 결과 팝업이 막 뜬 직후에는 브라우저가 link mouseout / popup mouseleave를
    // 순서가 엇갈리게 발생시키는 경우가 있습니다. 여기서 직접 닫지 않고,
    // 실제 mouseout/mouseleave/mousemove에서 밖으로 나간 것이 확인될 때만 닫습니다.
    popupEntryGraceTimer = null;
    popupEntryGraceUntil = 0;
  }, POPUP_ENTRY_GRACE_MS);
}

function revealSummaryIfPointerAlreadyInside() {
  window.requestAnimationFrame(() => {
    const x = lastPointerClientX ?? lastMouseEvent?.clientX;
    const y = lastPointerClientY ?? lastMouseEvent?.clientY;
    if (!popup || popup.hidden || typeof x !== "number" || typeof y !== "number") {
      return;
    }
    if (!isPointInsideElementRect(popup, x, y, 0)) {
      return;
    }

    // 캐시 결과처럼 결과가 즉시 뜨는 경우, 팝업 생성 위치가 커서와 겹치면
    // compact 팝업을 보기도 전에 바로 요약 카드가 펼쳐질 수 있습니다.
    // 그래서 등장 후 0.5초 동안은 compact 상태를 먼저 유지하고,
    // 그 뒤에도 커서가 팝업 안에 있을 때만 요약을 펼칩니다.
    scheduleSummaryRevealAfterTransition();
  });
}

function beginHoverTrackingForLink(link, clientX, clientY) {
  if (!link || !document.documentElement.contains(link)) {
    return;
  }

  const href = link.href;
  if (!href || !/^https?:\/\//i.test(href)) {
    return;
  }

  activeLink = link;
  activeLinkHoverStartedAt = Date.now();
  activeLinkPopupAllowedAt = activeLinkHoverStartedAt + POPUP_DISPLAY_DELAY_MS;
  lastMouseEvent = { clientX, clientY };
  popupOpenPoint = { x: clientX, y: clientY };
  analysisStartedForActiveLink = false;
  clearHoverTimer();
  cancelPendingPopupDisplay();

  sendStatus("link_detected", "링크 인식", href);

  hoverTimer = window.setTimeout(() => {
    handleInitialHoverDelay(link, { clientX, clientY });
  }, HOVER_DELAY_MS);
}

function rememberPendingLockedLink(link, event) {
  if (!link || !document.documentElement.contains(link)) {
    clearPendingLockedLink();
    return;
  }

  pendingLockedLink = link;
  pendingLockedPoint = {
    x: event?.clientX ?? lastPointerClientX ?? 0,
    y: event?.clientY ?? lastPointerClientY ?? 0
  };
}

function clearPendingLockedLink() {
  pendingLockedLink = null;
  pendingLockedPoint = null;
}

function startPendingLockedLinkIfStillHovered() {
  if (!pendingLockedLink || !document.documentElement.contains(pendingLockedLink)) {
    clearPendingLockedLink();
    return false;
  }

  const x = lastPointerClientX ?? pendingLockedPoint?.x;
  const y = lastPointerClientY ?? pendingLockedPoint?.y;
  if (!isPointInsideElementRect(pendingLockedLink, x, y, 0)) {
    clearPendingLockedLink();
    return false;
  }

  const link = pendingLockedLink;
  const point = { x, y };
  clearPendingLockedLink();
  beginHoverTrackingForLink(link, point.x, point.y);
  return true;
}

function getRemainingPopupDisplayDelay() {
  return Math.max(0, activeLinkPopupAllowedAt - Date.now());
}

function canDisplayPopupForLink(link, requestId) {
  const isSameActiveLink = Boolean(link && activeLink === link);
  const isSameLockedUrl = Boolean(link && isAnalysisLockActive() && isUrlLockedToCurrentAnalysis(link.href));

  return Boolean(
    link &&
    (isSameActiveLink || isSameLockedUrl) &&
    requestId === currentRequestId &&
    analysisStartedForActiveLink &&
    Date.now() >= activeLinkPopupAllowedAt
  );
}

function schedulePopupDisplayWhenAllowed(link, requestId, callback) {
  cancelPendingPopupDisplay();

  const run = () => {
    popupDisplayTimer = null;
    if (!canDisplayPopupForLink(link, requestId)) {
      return;
    }
    callback();
  };

  const remaining = getRemainingPopupDisplayDelay();
  if (remaining <= 0) {
    run();
    return;
  }

  popupDisplayTimer = window.setTimeout(run, remaining);
}

function handleInitialHoverDelay(link, event) {
  hoverTimer = null;
  if (activeLink !== link) {
    return;
  }

  lockAnalysisToUrl(link.href);
  analysisStartedForActiveLink = true;
  popupOpenPoint = { x: event.clientX, y: event.clientY };
  sendStatus("hover_confirmed", "1초 머무름 확인", link.href);

  // 언론사 리스트 대조나 뉴스 판별 API 요청보다 먼저 캐시를 확인합니다.
  // 이미 분석한 URL이면 저장된 결과를 즉시 사용하고, API 요청을 새로 만들지 않습니다.
  checkAnalysisCache(link.href, (cachedResult) => {
    if (activeLink !== link) {
      return;
    }

    if (cachedResult) {
      if (cachedResult.is_article) {
        const requestId = currentRequestId;
        schedulePopupDisplayWhenAllowed(link, requestId, () => {
          showResultPopup(cachedResult);
        });
      } else {
        hidePopup();
        clearAnalysisLock();
        analysisStartedForActiveLink = false;
      }
      return;
    }

    checkKnownNewsLink(link.href, (isKnownNews) => {
      if (activeLink !== link) {
        return;
      }

      if (isKnownNews) {
        // 등록된 대표 언론사/학습된 뉴스 사이트는 기사 여부 판별을 건너뛰고
        // 1초 시점에 바로 분석은 시작하되, 화면 팝업은 2초 이상 머문 경우에만 표시합니다.
        analyzeHoveredLink(link, event, { skipArticleCheck: true, suppressInitialPopup: false });
        return;
      }

      // 등록되지 않은 사이트는 1초 확인 직후 바로 API에 요청하지 않습니다.
      // 사용자가 같은 링크 위에 총 4초(기본 1초 + 추가 3초) 머물렀을 때만
      // background에서 조용히 뉴스 기사 여부 판별을 시작합니다.
      hoverTimer = window.setTimeout(() => {
        hoverTimer = null;
        if (activeLink !== link) {
          return;
        }
        analyzeHoveredLink(link, event, { suppressInitialPopup: true });
      }, Math.max(0, UNKNOWN_NEWS_DELAY_MS - HOVER_DELAY_MS));
    });
  });
}

function checkAnalysisCache(url, callback) {
  chrome.runtime.sendMessage(
    {
      type: "CHECK_ANALYSIS_CACHE",
      payload: { url }
    },
    (response) => {
      if (chrome.runtime.lastError || !response?.ok) {
        callback(null);
        return;
      }
      callback(response.cached || null);
    }
  );
}

function checkKnownNewsLink(url, callback) {
  chrome.runtime.sendMessage(
    {
      type: "CHECK_KNOWN_NEWS_LINK",
      payload: { url }
    },
    (response) => {
      if (chrome.runtime.lastError || !response?.ok) {
        callback(false);
        return;
      }
      callback(Boolean(response.is_known_news));
    }
  );
}


// ─────────────────────────────────────────────
// 실제 분석을 요청하는 핵심 함수
// ─────────────────────────────────────────────

/*
  analyzeHoveredLink: 1초 이상 마우스가 머문 링크를 분석합니다.
  background.js에 메시지를 보내고, 결과가 오면 팝업을 업데이트합니다.

  매개변수:
    link    - 분석할 <a> 요소
    event   - 마우스 이벤트 (팝업 위치 계산용)
    options - { forceRefresh: true } 이면 캐시를 무시하고 재분석

  동작 흐름:
    ① 로딩 팝업을 띄움
    ② background.js에 ANALYZE_NEWS_LINK 메시지 전송 (분석 요청)
    ③ background.js가 분석을 완료하면 콜백으로 결과 수신
    ④ 결과에 따라 팝업을 성공/오류 화면으로 전환
*/
function analyzeHoveredLink(link, event, options = {}) {
  const href = link.href;

  if (!href || !/^https?:\/\//i.test(href)) {
    return;
  }

  lockAnalysisToUrl(href);

  // 요청 ID를 1 올림. 이 값을 나중에 응답이 왔을 때와 비교해서
  // 이미 다른 링크로 이동했으면 이전 응답을 무시할 수 있음
  const requestId = ++currentRequestId;

  // 링크 안의 텍스트를 추출하고 공백을 정리한 뒤 최대 300자로 자름
  // innerText: 렌더링된 텍스트 (줄바꿈, 숨겨진 요소 반영)
  // textContent: 렌더링과 무관한 원시 텍스트 (fallback으로 사용)
  const linkText = normalizeText(link.innerText || link.textContent || "").slice(0, MAX_LINK_TEXT_LENGTH);

  // 등록되지 않은 사이트는 기사 여부가 확인되기 전까지 화면 팝업을 띄우지 않습니다.
  // background가 실제 뉴스 기사라고 판별해 analyzing 상태를 보내면 그때 로딩 팝업이 열립니다.
  analysisStartedForActiveLink = true;
  popupOpenPoint = popupOpenPoint || { x: event.clientX, y: event.clientY };
  if (!options.suppressInitialPopup && (!popup || popup.hidden)) {
    schedulePopupDisplayWhenAllowed(link, requestId, () => {
      showLoadingPopup(event.clientX, event.clientY, "분석 준비 중...");
    });
  }
  sendStatus("hover_confirmed", "1초 머무름 확인", href);

  /*
    chrome.runtime.sendMessage: background.js에 분석 요청 메시지를 보냅니다.
    첫 번째 인수: 보낼 메시지 객체
    두 번째 인수: background.js가 sendResponse()를 호출하면 이 콜백이 실행됨

    메시지 구조:
      type    - "ANALYZE_NEWS_LINK" (background.js의 메시지 분류에 사용)
      payload - 분석에 필요한 데이터
        url           - 분석할 링크 주소
        link_text     - 링크 텍스트
        force_refresh - 캐시 무시 여부
  */
  chrome.runtime.sendMessage(
    {
      type: "ANALYZE_NEWS_LINK",
      payload: {
        url:           href,
        link_text:     linkText,
        force_refresh: Boolean(options.forceRefresh),
        skip_article_check: Boolean(options.skipArticleCheck)
      }
    },
    (response) => {
      // 응답이 왔을 때 이미 다른 링크로 이동했거나 마우스가 벗어났으면 무시
      // requestId가 currentRequestId와 다르면 이 응답은 오래된 것임
      if (requestId !== currentRequestId || !(activeLink === link || isUrlLockedToCurrentAnalysis(link.href))) {
        return;
      }

      // chrome.runtime.lastError: 메시지 전송 자체가 실패했을 때 세팅됨
      // 예) background.js가 아직 실행되지 않았거나, 확장 프로그램이 업데이트된 경우
      if (chrome.runtime.lastError) {
        schedulePopupDisplayWhenAllowed(link, requestId, () => {
          showErrorPopupOnceForPersistentError("확장 프로그램과 통신하지 못했습니다. 페이지를 새로고침한 뒤 다시 시도하세요.");
        });
        return;
      }

      // background.js가 { ok: false, error: "..." } 로 응답한 경우
      if (!response || !response.ok) {
        schedulePopupDisplayWhenAllowed(link, requestId, () => {
          showErrorPopupOnceForPersistentError(response?.error || "AI 분석 중 문제가 발생했습니다.");
        });
        return;
      }

      if (!response.data?.is_article) {
        // 기사로 판별되지 않은 링크는 사용자 화면에 아무 팝업도 표시하지 않습니다.
        // 잠금도 즉시 풀어 다음 링크를 정상적으로 인식할 수 있게 합니다.
        hidePopup();
        clearAnalysisLock();
        analysisStartedForActiveLink = false;
        return;
      }

      // 성공! response.data에 분석 결과 객체가 담겨 있음
      schedulePopupDisplayWhenAllowed(link, requestId, () => {
        showResultPopup(response.data);
      });
    }
  );
}


// ─────────────────────────────────────────────
// background.js에 현재 상태를 알리는 함수
// ─────────────────────────────────────────────

/*
  sendStatus: content.js가 현재 어느 단계인지를 background.js에 알립니다.
  background.js는 이 정보를 저장소에 기록하고, action_popup.js가 읽어서 단계 표시를 업데이트합니다.

  매개변수:
    stage - 단계 식별자 (예: "link_detected", "idle")
    label - 화면에 보여줄 텍스트 (예: "링크 인식")
    url   - 현재 분석 중인 URL
*/
function sendStatus(stage, label, url) {
  chrome.runtime.sendMessage({
    type:    "STATUS_UPDATE",
    payload: { stage, label, url }
  });
}

/*
  normalizeText: 문자열 안의 연속된 공백, 줄바꿈 등을 하나의 공백으로 정리하고
  앞뒤 공백도 제거합니다.
  링크 텍스트에 줄바꿈이나 탭 문자가 섞여 있을 때 깔끔하게 만들기 위해 사용합니다.
*/
function normalizeText(text) {
  return text.replace(/\s+/g, " ").trim();
}

function isStatusForActiveLink(status) {
  return activeLink && normalizeUrlForCompare(status.url) === normalizeUrlForCompare(activeLink.href);
}

function normalizeUrlForCompare(url) {
  try {
    const parsed = new URL(url);
    parsed.hash = "";
    return parsed.toString();
  } catch (error) {
    return "";
  }
}

function lockAnalysisToUrl(url) {
  lockedAnalysisUrl = normalizeUrlForCompare(url);
}

function clearAnalysisLock() {
  lockedAnalysisUrl = "";
}

function isAnalysisLockActive() {
  return Boolean(lockedAnalysisUrl);
}

function isUrlLockedToCurrentAnalysis(url) {
  return Boolean(lockedAnalysisUrl && normalizeUrlForCompare(url) === lockedAnalysisUrl);
}

function shouldIgnoreLinkBecausePopupIsLocked(url) {
  if (!isAnalysisLockActive()) {
    return false;
  }

  // 현재 팝업의 원래 링크는 계속 허용합니다.
  if (isUrlLockedToCurrentAnalysis(url)) {
    return false;
  }

  // 팝업이 화면에 있거나 닫힘 애니메이션 중이면 다른 링크 인식을 차단합니다.
  return Boolean(popup && !popup.hidden) || popupState === "closing" || analysisStartedForActiveLink;
}

function rememberPointerFromEvent(event) {
  if (!event) {
    return;
  }
  lastMouseEvent = event;
  if (typeof event.clientX === "number" && typeof event.clientY === "number") {
    lastPointerClientX = event.clientX;
    lastPointerClientY = event.clientY;
    refreshPopupPointerState(event.clientX, event.clientY);
  }
}

function refreshPopupPointerState(clientX, clientY) {
  if (!popup || popup.hidden) {
    pointerInsidePopup = false;
    popupHadPointerEntry = false;
    return false;
  }

  const isInside = isPointInsideElementRect(popup, clientX, clientY, 0);
  pointerInsidePopup = isInside;

  if (isInside) {
    popupHadPointerEntry = true;
    lastPointerInsidePopupAt = Date.now();
    cancelPendingPopupClose();
    return true;
  }

  if (!popupHadPointerEntry && isPopupEntryGraceActive()) {
    return false;
  }

  // 한 번이라도 팝업 안에 들어온 뒤에는, 팝업 밖 좌표가 감지되는 즉시 닫습니다.
  // mouseleave가 누락되는 브라우저/레이아웃 변화 상황까지 막기 위한 보조 안전장치입니다.
  if (popupHadPointerEntry && popupState !== "closing") {
    // 요약/상세 전환이나 위치 보정 중에는 팝업 rect가 순간적으로 변해서
    // 커서가 밖에 있는 것처럼 보일 수 있으므로 즉시 닫지 않습니다.
    if (isPopupGraceActive()) {
      schedulePopupCloseFromPointerExit(getPopupGraceRemaining());
      return false;
    }
    closePopupFromPointerExit();
  }

  return false;
}

function cancelPendingPopupClose() {
  window.clearTimeout(popupGraceCloseTimer);
  window.clearTimeout(popupDeferredCloseTimer);
  if (popupCloseCheckFrame) {
    cancelAnimationFrame(popupCloseCheckFrame);
    popupCloseCheckFrame = null;
  }
}

function isPointInsideElementRect(element, x, y, padding = 0) {
  if (!element || typeof x !== "number" || typeof y !== "number") {
    return false;
  }

  const rect = element.getBoundingClientRect();
  return (
    x >= rect.left - padding &&
    x <= rect.right + padding &&
    y >= rect.top - padding &&
    y <= rect.bottom + padding
  );
}

function setPopupState(nextState) {
  popupState = nextState;
}

function inferPopupStateFromClasses() {
  if (!popup || popup.hidden) {
    return "hidden";
  }
  if (popup.classList.contains("ai-news-popup--loading")) {
    return "loading";
  }
  if (popup.classList.contains("ai-news-popup--error")) {
    return "error";
  }
  if (popup.querySelector(".ai-news-popup__details.is-open")) {
    return "detail";
  }
  if (popup.classList.contains("ai-news-popup--summary-expanded")) {
    return "summary";
  }
  if (popup.classList.contains("ai-news-popup--summary-collapsed")) {
    return "compact";
  }
  return "open";
}

/*
  markPopupLayoutChanging: 요약/상세 카드가 펼쳐지거나 접히기 시작할 때 호출합니다.
  최소 POPUP_TRANSITION_GUARD_MS, 기본은 POPUP_INTERACTION_GRACE_MS 동안
  popupGrace를 켜서, 그 사이에 들어오는 mouseleave나 좌표 판정을 즉시
  믿지 않고 미루게 합니다.
*/
function markPopupLayoutChanging(duration = POPUP_INTERACTION_GRACE_MS) {
  cancelPendingPopupClose();
  suppressPopupMouseOutUntil = 0;
  armPopupGrace(Math.max(POPUP_TRANSITION_GUARD_MS, Math.min(duration, POPUP_INTERACTION_GRACE_MS)));
}

function requestCloseCheckAfterPointerTransition() {
  closePopupImmediatelyIfPointerOutside();
}

function schedulePopupCloseFromPointerExit(delay = POPUP_CLOSE_DELAY_MS) {
  cancelPendingPopupClose();
  if (delay > 0) {
    popupDeferredCloseTimer = window.setTimeout(closePopupImmediatelyIfPointerOutside, delay);
    return;
  }
  closePopupImmediatelyIfPointerOutside();
}

function closePopupImmediatelyIfPointerOutside() {
  if (popupCloseCheckFrame) {
    cancelAnimationFrame(popupCloseCheckFrame);
    popupCloseCheckFrame = null;
  }

  popupCloseCheckFrame = requestAnimationFrame(() => {
    popupCloseCheckFrame = null;
    if (!popup || popup.hidden || popupState === "closing") {
      return;
    }

    if (isPointerInsideActiveAreas()) {
      cancelPendingPopupClose();
      return;
    }

    if (isPopupGraceActive()) {
      popupDeferredCloseTimer = window.setTimeout(closePopupImmediatelyIfPointerOutside, getPopupGraceRemaining());
      return;
    }

    if (!popupHadPointerEntry && isPopupEntryGraceActive()) {
      const remaining = Math.max(0, popupEntryGraceUntil - Date.now() + 30);
      popupDeferredCloseTimer = window.setTimeout(closePopupImmediatelyIfPointerOutside, remaining);
      return;
    }

    closePopupFromPointerExit();
  });
}

function isPointerInsideActiveAreas() {
  const x = lastPointerClientX ?? lastMouseEvent?.clientX;
  const y = lastPointerClientY ?? lastMouseEvent?.clientY;
  if (typeof x !== "number" || typeof y !== "number") {
    return false;
  }

  if (popup && !popup.hidden && isPointInsideElementRect(popup, x, y, 0)) {
    pointerInsidePopup = true;
    lastPointerInsidePopupAt = Date.now();
    return true;
  }

  if (activeLink && isPointInsideElementRect(activeLink, x, y, 0)) {
    return true;
  }

  return false;
}

function closePopupFromPointerExit() {
  const shouldSendIdle = analysisStartedForActiveLink;
  clearHoverTimer();
  cancelPendingPopupClose();
  cancelPendingPopupDisplay();
  activeLinkHoverStartedAt = 0;
  activeLinkPopupAllowedAt = 0;
  pointerInsidePopup = false;
  activeLink = null;
  analysisStartedForActiveLink = false;
  popupOpenPoint = null;
  currentRequestId += 1;
  hidePopup();
  if (shouldSendIdle) {
    sendStatus("idle", "대기 중", "");
  }
}

/*
  getPopupOpenPoint: 팝업을 어디에 띄울지 결정하는 기준 좌표를 반환합니다.
  링크 위에서 처음 마우스가 멈춘 지점(popupOpenPoint)이 아니라,
  팝업이 실제로 화면에 나타나는 "지금 이 순간"의 실제 커서 좌표를 우선 사용합니다.
  hover 대기 시간(2초) 동안 커서가 링크를 따라 움직였다면, 대기 시작 지점이 아니라
  현재 커서 위치 근처에 팝업이 뜨도록 하기 위함입니다.
*/
function getPopupOpenPoint() {
  if (typeof lastPointerClientX === "number" && typeof lastPointerClientY === "number") {
    return { x: lastPointerClientX, y: lastPointerClientY };
  }
  return popupOpenPoint || popupAnchor;
}

/*
  positionFreshPopupAtOpenPoint: showErrorPopup/showResultPopup이 내용을 채운
  직후 공통으로 실행하는 마무리 단계입니다. 커서 근처에 팝업을 배치하고,
  요약 카드가 있는 결과 팝업이라면(withSummaryReveal) 등장 직후 커서가 이미
  팝업 안에 들어와 있는 경우를 대비한 진입 유예/요약 펼침 확인까지 처리합니다.
*/
function positionFreshPopupAtOpenPoint({ withSummaryReveal = false } = {}) {
  const point = getPopupOpenPoint();
  if (!point) {
    return;
  }
  positionPopup(point.x, point.y);
  rememberCompactHomePosition();
  if (withSummaryReveal) {
    armPopupEntryGrace();
    revealSummaryIfPointerAlreadyInside();
  }
}

function showLoadingPopupAtAnchor(message) {
  const point = getPopupOpenPoint();
  if (point) {
    showLoadingPopup(point.x, point.y, message);
  }
}


function isCompactResultPopupVisible() {
  return Boolean(
    popup &&
    !popup.hidden &&
    popup.classList.contains("ai-news-popup--result") &&
    popup.classList.contains("ai-news-popup--summary-collapsed") &&
    popupState !== "closing"
  );
}

function isSummaryRevealEnabled() {
  return Boolean(
    popup &&
    !popup.hidden &&
    popupState === "compact" &&
    popup.classList.contains("ai-news-popup--result") &&
    popup.classList.contains("ai-news-popup--summary-collapsed")
  );
}

function revealSummaryPanel() {
  if (!isSummaryRevealEnabled() || !popup) {
    return;
  }

  markPopupLayoutChanging(POPUP_INTERACTION_GRACE_MS);
  setPopupState("summary");

  popup.classList.add("ai-news-popup--anchoring-summary");
  popup.classList.remove("ai-news-popup--summary-collapsed");
  popup.classList.add("ai-news-popup--summary-expanded");
  trackPopupHeightForGrowth();

  requestAnimationFrame(() => {
    popup?.classList.remove("ai-news-popup--anchoring-summary");

    // 요약 확장은 사용자가 팝업에 진입했을 때만 실행됩니다.
    // 카드가 펼쳐지며 위치가 순간 보정되는 동안 커서가 새 rect 밖으로 보이는 경우가 있어도
    // 여기서 즉시 닫지 않고 mouseleave가 실제 발생했을 때만 닫습니다.
    popupHadPointerEntry = true;
    pointerInsidePopup = true;
    cancelPendingPopupClose();
  });
}

function getCurrentPopupPosition() {
  if (!popup || popup.hidden) {
    return null;
  }
  const rect = popup.getBoundingClientRect();
  const left = Number.parseFloat(popup.style.left);
  const top = Number.parseFloat(popup.style.top);
  return {
    left: Number.isFinite(left) ? left : rect.left,
    top: Number.isFinite(top) ? top : rect.top
  };
}

function rememberCompactHomePosition() {
  const position = getCurrentPopupPosition();
  if (position) {
    popupCompactHomePosition = position;
  }
}
