/*
  content-position.js
  =====================================================================
  팝업을 커서 근처에 배치하고, 화면 안에 유지하며, 요약/상세 카드가
  펼쳐지고 접힐 때 높이 변화를 따라 부드럽게 애니메이션하는 함수들.
  =====================================================================
*/

// ─────────────────────────────────────────────
// 팝업 위치를 계산하고 화면 안에 유지하는 함수들
// ─────────────────────────────────────────────

/*
  positionPopup: 팝업을 마우스 커서 근처에 표시합니다.
  단순히 커서 오른쪽 아래에만 놓으면 화면 오른쪽/아래 가장자리에서 잘릴 수 있습니다.
  그래서 커서를 기준으로 4방향(우하/우상/좌하/좌상) 후보를 모두 계산하고,
  화면 밖으로 가장 적게 나가는 위치를 선택합니다.

  positionPopup은 아래 세 곳에서 호출됩니다:
    - showLoadingPopup: 로딩 팝업 처음 표시할 때
    - showErrorPopup / showResultPopup: 내용 업데이트 후
    - keepPopupInViewport: 스크롤/리사이즈 시 재계산
*/
function positionPopup(clientX, clientY) {
  const popupElement = ensurePopup();
  // 커서 대각선 방향으로 이 정도는 떨어뜨려야 팝업이 뜨자마자 커서 스프라이트에
  // 바로 맞닿지 않습니다 (8px는 화살표 커서 몸통과 거의 겹쳐 보였습니다).
  const margin = 16;
  const viewportPadding = POPUP_VIEWPORT_PADDING_PX;
  popupAnchor = { x: clientX, y: clientY };
  updatePopupViewportLimits();

  const availableWidth = Math.max(1, window.innerWidth - viewportPadding * 2);
  const availableHeight = Math.max(1, window.innerHeight - viewportPadding * 2);
  if (popupElement.classList.contains("ai-news-popup--separated")) {
    popupElement.style.height = "auto";
    popupElement.style.minHeight = "0";
    popupElement.style.maxHeight = "none";
    popupElement.style.overflow = "visible";
  } else {
    popupElement.style.maxWidth = `${availableWidth}px`;
    popupElement.style.maxHeight = `${availableHeight}px`;
  }

  const rect = popupElement.getBoundingClientRect();
  const width = Math.min(rect.width, availableWidth);
  const height = Math.min(rect.height, availableHeight);

  const candidates = [
    { name: "right-bottom", left: clientX + margin, top: clientY + margin },
    { name: "right-top", left: clientX + margin, top: clientY - height - margin },
    { name: "left-bottom", left: clientX - width - margin, top: clientY + margin },
    { name: "left-top", left: clientX - width - margin, top: clientY - height - margin }
  ];

  const best = candidates
    .map((candidate) => {
      const overflow =
        Math.max(0, viewportPadding - candidate.left) +
        Math.max(0, viewportPadding - candidate.top) +
        Math.max(0, candidate.left + width - (window.innerWidth - viewportPadding)) +
        Math.max(0, candidate.top + height - (window.innerHeight - viewportPadding));
      return { ...candidate, overflow };
    })
    .sort((a, b) => a.overflow - b.overflow)[0];

  const minLeft = viewportPadding;
  const minTop = viewportPadding;
  const maxLeft = Math.max(minLeft, window.innerWidth - width - viewportPadding);
  const maxTop = Math.max(minTop, window.innerHeight - height - viewportPadding);
  const left = clampNumber(best.left, minLeft, maxLeft);
  const top = clampNumber(best.top, minTop, maxTop);

  const hadPosition = Boolean(lastPopupPosition);
  const moved = hadPosition && (Math.abs(lastPopupPosition.left - left) > 1 || Math.abs(lastPopupPosition.top - top) > 1);

  popupElement.dataset.placement = best.name;
  if (moved) {
    popupElement.classList.add("ai-news-popup--moving");
    window.clearTimeout(popupRepositionTimer);
    popupRepositionTimer = window.setTimeout(() => {
      popupElement.classList.remove("ai-news-popup--moving");
    }, POPUP_REPOSITION_ANIMATION_MS);
  }

  popupElement.style.left = `${left}px`;
  popupElement.style.top = `${top}px`;
  lastPopupPosition = { left, top };
}

function stopPopupGrowthTracking() {
  if (popupGrowthAnimationFrame) {
    window.cancelAnimationFrame(popupGrowthAnimationFrame);
    popupGrowthAnimationFrame = null;
  }
}

/*
  trackPopupHeightForGrowth: 요약/상세 카드가 펼쳐지거나(늘어남) 접힐 때(줄어듦)
  팝업의 top 위치를 매 프레임 다시 계산해서, 위쪽 간단표시창(compact bar)의
  화면 위치가 최대한 고정된 채로 팝업이 "아래로 늘어나고 위로 줄어드는" 것처럼 보이게 합니다.

  알고리즘:
    - homeTop: 간단표시창이 원래 있던(고정하고 싶은) 화면 위치
    - limit: 팝업 아래쪽 가장자리가 넘으면 안 되는 화면 최대 y좌표
    - 매 프레임 실제 렌더링된 팝업 높이(getBoundingClientRect)를 읽어서
      top = min(homeTop, limit - 현재 높이) 로 계산합니다.

  이렇게 하면 자동으로 2단계 동작이 나옵니다:
    1) 아래쪽에 공간이 남아있는 동안에는 top이 homeTop에 고정된 채 아래로만 늘어남
    2) 팝업 아래쪽이 화면 끝(limit)에 닿으면, 그 이후로는 top이 위로 밀리면서
       (= 간단표시창 위치 고정이 풀리면서) 필요한 공간을 위쪽에서 확보함
    3) 다시 줄어들 때는 같은 공식으로 top이 자연스럽게 homeTop 쪽으로 복귀함
       (= 팝업이 위로 줄어드는 것처럼 보임)
*/
function trackPopupHeightForGrowth(durationMs = POPUP_GROWTH_TRACK_MS) {
  if (!popup || popup.hidden) {
    return;
  }

  stopPopupGrowthTracking();

  const rect = popup.getBoundingClientRect();
  const homeTop = popupCompactHomePosition && Number.isFinite(popupCompactHomePosition.top)
    ? popupCompactHomePosition.top
    : (Number.parseFloat(popup.style.top) || rect.top);

  const padding = POPUP_VIEWPORT_PADDING_PX;
  const startedAt = performance.now();

  function tick(now) {
    if (!popup || popup.hidden) {
      popupGrowthAnimationFrame = null;
      return;
    }

    const currentHeight = popup.getBoundingClientRect().height;
    const limit = window.innerHeight - padding;
    const desiredTop = Math.min(homeTop, limit - currentHeight);
    const nextTop = Math.max(padding, desiredTop);

    const currentTop = Number.parseFloat(popup.style.top);
    if (!Number.isFinite(currentTop) || Math.abs(currentTop - nextTop) > 0.4) {
      popup.style.top = `${nextTop}px`;
      lastPopupPosition = { left: Number.parseFloat(popup.style.left) || rect.left, top: nextTop };
    }

    if (now - startedAt < durationMs) {
      popupGrowthAnimationFrame = window.requestAnimationFrame(tick);
    } else {
      popupGrowthAnimationFrame = null;
      clampPopupToViewport();
    }
  }

  popupGrowthAnimationFrame = window.requestAnimationFrame(tick);
}

function clampPopupToViewport() {
  if (!popup || popup.hidden) {
    return;
  }

  const viewportPadding = POPUP_VIEWPORT_PADDING_PX;
  updatePopupViewportLimits();
  const rect = popup.getBoundingClientRect();
  const currentLeft = Number.parseFloat(popup.style.left) || rect.left;
  const currentTop = Number.parseFloat(popup.style.top) || rect.top;
  const maxLeft = Math.max(viewportPadding, window.innerWidth - rect.width - viewportPadding);
  const maxTop = Math.max(viewportPadding, window.innerHeight - rect.height - viewportPadding);

  const nextLeft = clampNumber(currentLeft, viewportPadding, maxLeft);
  const nextTop = clampNumber(currentTop, viewportPadding, maxTop);
  const moved = Math.abs(currentLeft - nextLeft) > 1 || Math.abs(currentTop - nextTop) > 1;

  if (moved) {
    popup.classList.add("ai-news-popup--moving");
    window.clearTimeout(popupRepositionTimer);
    popupRepositionTimer = window.setTimeout(() => {
      popup?.classList.remove("ai-news-popup--moving");
    }, POPUP_REPOSITION_ANIMATION_MS);
  }

  popup.style.left = `${nextLeft}px`;
  popup.style.top = `${nextTop}px`;
  lastPopupPosition = { left: nextLeft, top: nextTop };
}

function clampNumber(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function handleViewportScroll(event) {
  // 팝업 내부 스크롤은 페이지 위치 변화가 아니므로 위치 보정을 하지 않습니다.
  // 이걸 막지 않으면 상세 카드 맨 위/아래에서 스크롤할 때 팝업이 튈 수 있습니다.
  if (popup && event?.target instanceof Node && popup.contains(event.target)) {
    return;
  }
  keepPopupInViewport();
}

function keepPopupInViewport() {
  if (!popup || popup.hidden || !popupAnchor) {
    return;
  }

  window.requestAnimationFrame(() => {
    if (popup && !popup.hidden && popupAnchor) {
      clampPopupToViewport();
    }
  });
}

function resetPopupStateImmediately(options = {}) {
  const { sendIdle = false } = options;

  clearHoverTimer();
  cancelPendingPopupDisplay();
  cancelPendingPopupClose();
  cancelPopupEntryGrace();
  cancelScheduledSummaryReveal();
  cancelPopupGrace();

  window.clearTimeout(summaryRevealCloseTimer);
  window.clearTimeout(popupHideAnimationTimer);
  window.clearTimeout(popupRepositionTimer);
  stopPopupGrowthTracking();

  if (popupCloseCheckFrame) {
    cancelAnimationFrame(popupCloseCheckFrame);
    popupCloseCheckFrame = null;
  }

  if (popup) {
    popup.hidden = true;
    popup.classList.remove(
      "ai-news-popup--closing",
      "ai-news-popup--safe-zone-active",
      "ai-news-popup--moving",
      "ai-news-popup--appearing",
      "ai-news-popup--summary-expanded",
      "ai-news-popup--summary-collapsed",
      "ai-news-popup--loading",
      "ai-news-popup--error",
      "ai-news-popup--result"
    );
  }

  activeLink = null;
  activeLinkHoverStartedAt = 0;
  activeLinkPopupAllowedAt = 0;
  analysisStartedForActiveLink = false;
  popupAnchor = null;
  popupOpenPoint = null;
  lastPopupPosition = null;
  pointerInsidePopup = false;
  popupHadPointerEntry = false;
  popupCompactHomePosition = null;
  suppressPopupMouseOutUntil = 0;
  currentRequestId += 1;
  clearAnalysisLock();
  clearPendingLockedLink();
  setPopupState("hidden");

  if (sendIdle) {
    sendStatus("idle", "대기 중", "");
  }
}

/*
  hidePopup: 팝업을 화면에서 숨깁니다.
  hidden = true 로 설정하면 display: none과 유사하게 보이지 않게 되고,
  스크린 리더 같은 접근성 도구도 이 요소를 무시합니다.
*/
function hidePopup() {
  setPopupState("closing");
  window.clearTimeout(summaryRevealCloseTimer);
  cancelPopupEntryGrace();
  cancelScheduledSummaryReveal();
  cancelPopupGrace();
  cancelPendingPopupDisplay();
  window.clearTimeout(popupGraceCloseTimer);
  window.clearTimeout(popupDeferredCloseTimer);
  window.clearTimeout(popupHideAnimationTimer);
  if (popupCloseCheckFrame) {
    cancelAnimationFrame(popupCloseCheckFrame);
    popupCloseCheckFrame = null;
  }

  if (popup && !popup.hidden) {
    popup.classList.remove("ai-news-popup--safe-zone-active", "ai-news-popup--moving", "ai-news-popup--appearing");
    popup.classList.add("ai-news-popup--closing");
    popupHideAnimationTimer = window.setTimeout(() => {
      if (!popup) {
        return;
      }
      popup.hidden = true;
      popup.classList.remove(
        "ai-news-popup--closing",
        "ai-news-popup--summary-expanded",
        "ai-news-popup--summary-collapsed"
      );
      lastPopupPosition = null;
      pointerInsidePopup = false;
      popupHadPointerEntry = false;
      popupCompactHomePosition = null;
      activeLinkHoverStartedAt = 0;
      activeLinkPopupAllowedAt = 0;
      clearAnalysisLock();
      setPopupState("hidden");
      startPendingLockedLinkIfStillHovered();
    }, POPUP_CLOSE_ANIMATION_MS);
  } else {
    clearAnalysisLock();
    setPopupState("hidden");
    startPendingLockedLinkIfStillHovered();
  }

  popupAnchor = null;
  popupOpenPoint = null;
}

