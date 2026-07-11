/*
  =====================================================================
  content.js
  =====================================================================

  이 파일은 사용자가 현재 보고 있는 웹페이지 위에서 직접 실행됩니다.
  쉽게 말하면, 이 코드가 뉴스 사이트, 포털 등 모든 웹페이지에 "몰래 끼어들어"
  링크에 마우스를 올렸을 때의 동작을 추가합니다.

  이 파일이 하는 일:
  1. 페이지의 모든 링크에 마우스가 올라가면 감지합니다.
  2. 1초 이상 머물면 background.js에 분석을 요청합니다.
  3. 팝업은 같은 링크 위에 2초 이상 머문 경우에만 화면에 띄웁니다.
  4. 마우스가 링크에서 벗어나면 팝업을 닫습니다.

  ★ 다른 파일과의 관계
     - manifest.json이 "모든 웹페이지에 content.js를 심어라"고 지정합니다.
     - content.js는 background.js에게 분석 요청을 보내고 결과를 받습니다.
     - popup.css는 content.js가 만드는 팝업의 스타일을 담당합니다.
     - background.js가 보내는 STATUS_BROADCAST 메시지를 받아 팝업 텍스트를 업데이트합니다.

  =====================================================================
*/


// ─────────────────────────────────────────────
// 고정 상수
// ─────────────────────────────────────────────

// 마우스를 링크 위에 이 시간(ms) 동안 올려두면 분석을 시작
const HOVER_DELAY_MS = 1000;

// 분석 요청은 1초 뒤 시작하지만, 사용자에게 보이는 팝업은
// 링크 위에 2초 이상 머문 경우에만 표시합니다.
const POPUP_DISPLAY_DELAY_MS = 2000;

const UNKNOWN_NEWS_DELAY_MS = 4000;

// AI에게 넘기는 링크 텍스트의 최대 길이 (토큰 절약용)
const MAX_LINK_TEXT_LENGTH = 300;

const POPUP_INTERACTION_GRACE_MS = 1500;

// 팝업 밖으로 나가는 즉시 닫힘 모션을 시작합니다.
const POPUP_CLOSE_DELAY_MS = 0;

// CSS 닫힘 애니메이션 시간과 맞춤
const POPUP_CLOSE_ANIMATION_MS = 210;

// 위치가 보정될 때 움직임 애니메이션 표시 시간
const POPUP_REPOSITION_ANIMATION_MS = 240;
const POPUP_APPEAR_ANIMATION_MS = 220;
const POPUP_VIEWPORT_PADDING_PX = 8;

// 요약/상세 카드가 펼쳐지거나 접힐 때, 팝업 높이 변화를 따라가며
// top 위치를 매 프레임 재계산하는 추적 애니메이션 지속 시간.
// 내부 카드의 max-height 전환(520ms, popup.css)보다 넉넉하게 잡습니다.
const POPUP_GROWTH_TRACK_MS = 600;

// 결과 팝업이 링크 옆에 뜬 직후, 사용자가 링크에서 팝업으로 이동할 시간을 짧게 허용합니다.
// 이 시간은 일반적인 닫힘 유예가 아니라, 초기 진입 안정화 전용입니다.
const POPUP_ENTRY_GRACE_MS = 900;

// 팝업이 등장하거나 compact → summary/detail로 바뀌는 짧은 순간에는
// 브라우저 좌표/rect가 흔들려 mouseleave가 잘못 들어올 수 있으므로 닫힘 판단을 0.5초 늦춥니다.
const POPUP_TRANSITION_GUARD_MS = 500;

// 간단 팝업이 떠 있는 상태에서 링크 밖으로 나갔을 때,
// 링크 → 팝업 이동 또는 다시 링크로 돌아오는 짧은 동작을 허용합니다.
const COMPACT_POPUP_LINK_EXIT_GRACE_MS = 300;

// API 한도 초과, API Key 미등록처럼 같은 원인으로 반복되는 오류는
// 최초 1회만 팝업으로 보여주고, 이후에는 action popup 상태창에만 남깁니다.
const PERSISTENT_ERROR_POPUP_HISTORY_KEY = "intonePersistentErrorPopupHistory";

// 옵션 페이지에서 선택하는 팝업 크기 배율입니다. 100은 현재 90% 크기를 의미합니다.
const POPUP_SCALE_STORAGE_KEY = "intonePopupScalePercent";
const DEFAULT_POPUP_SCALE_PERCENT = 100;


// ─────────────────────────────────────────────
// 전역 상태 변수 — 페이지에서 마우스 동작을 추적하기 위한 값들
// ─────────────────────────────────────────────

// setTimeout으로 만든 타이머의 ID. clearTimeout(hoverTimer)로 취소할 때 필요
let hoverTimer = null;
let popupDisplayTimer = null;
let activeLinkHoverStartedAt = 0;
let activeLinkPopupAllowedAt = 0;

// 현재 마우스가 올라가 있는 <a> 링크 요소
let activeLink = null;

// 마우스가 마지막으로 움직인 이벤트. 팝업을 마우스 위치에 표시할 때 사용
let lastMouseEvent = null;

// 팝업 div 요소. 처음 한 번만 만들고 계속 재사용함
let popup = null;

// 요청 순번. 마우스가 빠르게 여러 링크를 지나갈 때 오래된 응답을 무시하기 위해 사용
// 새 요청을 보낼 때마다 1씩 증가하고, 응답이 도착했을 때 현재 번호와 일치하면 처리
let currentRequestId = 0;

let analysisStartedForActiveLink = false;

let suppressPopupMouseOutUntil = 0;

let popupGraceCloseTimer = null;
let popupDeferredCloseTimer = null;
let popupHideAnimationTimer = null;
let popupRepositionTimer = null;
let popupAppearAnimationTimer = null;
let popupGrowthAnimationFrame = null;
let lastPopupPosition = null;
let lastPointerClientX = null;
let lastPointerClientY = null;
let pointerInsidePopup = false;
let lastPointerInsidePopupAt = 0;
let popupCloseCheckFrame = null;
let popupState = "hidden";
let popupHadPointerEntry = false;
let popupPreDetailPosition = null;
let popupCompactHomePosition = null;
let intonePopupScalePercent = DEFAULT_POPUP_SCALE_PERCENT;

// 현재 표시 중인 팝업이 사라지기 전까지는 이 URL만 활성 링크로 인정합니다.
// 다른 링크 hover가 기존 분석을 덮어쓰거나 새 팝업을 띄우는 것을 막기 위한 잠금값입니다.
let lockedAnalysisUrl = "";

// 팝업 잠금 때문에 바로 분석을 시작하지 못한 링크를 임시로 기억합니다.
// 팝업이 완전히 사라진 뒤에도 커서가 이 링크 위에 있으면 그때부터 hover 타이머를 시작합니다.
let pendingLockedLink = null;
let pendingLockedPoint = null;


// 팝업이 현재 어느 좌표에 표시되고 있는지 기억해두는 값 {x, y}
// 창 크기 변경/스크롤 시 팝업 위치를 재계산할 때 사용
let popupAnchor = null;

let popupOpenPoint = null;

// 결과 팝업에서 처음에는 상단 요약 바만 보이고,
// 마우스가 팝업 안으로 들어왔을 때 기사 요약 카드를 펼치기 위한 상태
let summaryRevealCloseTimer = null;
let popupEntryGraceTimer = null;
let popupEntryGraceUntil = 0;

// 팝업이 등장하거나(appear) 요약/상세가 펼쳐지고 접힐 때(layout) 잠깐 동안
// "지금 전환 중이니 mouseleave/좌표 판정을 그대로 믿지 말고 기다려라"라고
// 표시하는 단일 유예 상태입니다. 예전에는 popupTransitionGuardUntil(전환 가드,
// 최소 0.5초)과 popupLayoutMutationUntil(레이아웃 변경, 최대 1.5초) 두 개의
// 타이머로 나뉘어 있었지만, 실제로는 항상 같은 시점에 같은 값으로 설정되던
// 경우가 대부분이라 하나로 합쳤습니다.
let popupGraceTimer = null;
let popupGraceUntil = 0;
let summaryRevealAfterTransitionTimer = null;


// ─────────────────────────────────────────────
// 마우스 이벤트 감지 등록
// ─────────────────────────────────────────────

/*
  document.addEventListener: 페이지 전체에서 마우스 이벤트를 감지합니다.
  세 번째 인수 true는 "캡처 단계"에서 처리하겠다는 의미입니다.
  캡처 단계란 이벤트가 부모 요소에서 자식 요소로 내려가는 단계를 말합니다.
  true를 쓰면 페이지의 다른 스크립트보다 먼저 이벤트를 받을 수 있어서
  일부 페이지에서 이벤트를 막는 경우에도 동작합니다.
*/
document.addEventListener("mouseover",  handleMouseOver, true);  // 마우스가 요소 위로 올라갈 때
document.addEventListener("mouseout",   handleMouseOut,  true);  // 마우스가 요소에서 벗어날 때
document.addEventListener("mousemove",  handleMouseMove, true);  // 마우스가 움직일 때
document.addEventListener("click",      handleDocumentClick, true); // 링크 클릭/페이지 이동 전 팝업 상태 정리

// 창 크기가 바뀌거나 스크롤될 때 팝업이 화면 밖으로 나가지 않도록 위치 재계산
window.addEventListener("resize", keepPopupInViewport);
window.addEventListener("scroll", handleViewportScroll, true);

// 링크 클릭 뒤 기사 페이지로 이동했다가 뒤로 돌아왔을 때,
// bfcache가 이전 DOM을 복원하면서 오래된 팝업이 그대로 남는 것을 방지합니다.
window.addEventListener("pagehide", () => resetPopupStateImmediately({ sendIdle: true }), { capture: true });
window.addEventListener("pageshow", () => resetPopupStateImmediately({ sendIdle: false }), { capture: true });
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") {
    resetPopupStateImmediately({ sendIdle: true });
  }
});

/*
  chrome.runtime.onMessage: background.js가 보내는 메시지를 여기서 받습니다.
  background.js는 분석 단계가 바뀔 때마다 STATUS_BROADCAST 메시지를 전송합니다.
  이 코드는 팝업이 열려 있을 때 로딩 텍스트를 실시간으로 업데이트합니다.
  예) "AI 분석 중..." → "뉴스 판별 중..." → "신뢰도 분석 중..."
*/
chrome.runtime.onMessage.addListener((message) => {
  if (message?.type !== "STATUS_BROADCAST") {
    return;
  }

  const status = message.status || {};

  if (status.stage === "analyzing" && isStatusForActiveLink(status) && getPopupOpenPoint()) {
    suppressPopupMouseOutUntil = Date.now() + 800;
    const link = activeLink;
    const requestId = currentRequestId;
    schedulePopupDisplayWhenAllowed(link, requestId, () => {
      showLoadingPopupAtAnchor(status.label || "AI 분석 중...");
    });
    return;
  }

  if (popup && !popup.hidden) {
    updateLoadingStatus(status.label || "처리 중...");
  }
});


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
  최소 0.5초, 기본은 1.5초 동안 popupGrace를 켜서, 그 사이에 들어오는
  mouseleave나 좌표 판정을 즉시 믿지 않고 미루게 합니다.
*/
function markPopupLayoutChanging(duration = POPUP_INTERACTION_GRACE_MS) {
  cancelPendingPopupClose();
  suppressPopupMouseOutUntil = 0;
  armPopupGrace(Math.max(POPUP_TRANSITION_GUARD_MS, Math.min(duration, POPUP_INTERACTION_GRACE_MS)));
}

function requestCloseCheckAfterPointerTransition() {
  closePopupImmediatelyIfPointerOutside();
}

function isPopupInteractionGraceActive() {
  // 팝업 밖으로 나간 뒤 버티는 유예시간은 더 이상 사용하지 않습니다.
  // 상세보기/간략히보기 전환 중에도 실제 커서가 팝업 밖이면 즉시 닫습니다.
  return false;
}

function schedulePopupCloseAfterGrace() {
  // 기존 1.5초 유예 닫힘 예약을 제거하고 즉시 외부 좌표를 확인합니다.
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

function shouldHoldPopupNearSafeZone() {
  return false;
}

function shouldHoldPopupForSummaryReveal() {
  return false;
}

function handlePopupPointerSafety() {
  // 상태머신 방식으로 재작성했으므로 별도 안전영역 로직은 사용하지 않습니다.
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

function getSummaryRevealDirection() {
  return popup?.dataset.summaryDirection === "up" ? "up" : "down";
}

function isPointerInSummaryRevealCorridor() {
  return false;
}

function handleSummaryRevealPointer() {
  // 마우스 이동만으로 요약/상세 상태를 임의 변경하지 않습니다.
  // 요약은 popup의 pointerenter/mouseover에서만 compact → summary로 전환됩니다.
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

function restorePopupPosition(position) {
  if (!popup || popup.hidden || !position) {
    return;
  }
  const { left, top } = getClampedPopupPosition(position.left, position.top);
  popup.classList.add("ai-news-popup--moving");
  popup.style.left = `${left}px`;
  popup.style.top = `${top}px`;
  lastPopupPosition = { left, top };
  window.clearTimeout(popupRepositionTimer);
  popupRepositionTimer = window.setTimeout(() => {
    popup?.classList.remove("ai-news-popup--moving");
  }, POPUP_REPOSITION_ANIMATION_MS);
}

function updateSummaryRevealDirection(left, top, height) {
  if (!popup || !popup.classList.contains("ai-news-popup--result")) {
    return;
  }

  const viewportPadding = POPUP_VIEWPORT_PADDING_PX;
  const spaceAbove = Math.max(0, top - viewportPadding);
  const spaceBelow = Math.max(0, window.innerHeight - (top + height) - viewportPadding);
  const direction = spaceBelow >= 250 || spaceBelow >= spaceAbove ? "down" : "up";
  popup.dataset.summaryDirection = direction;
}

function renderSummaryRevealArrow() {
  return "";
}

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
  popup.addEventListener("mouseenter", handlePopupMouseEnter);
  popup.addEventListener("pointerenter", handlePopupMouseEnter);
  popup.addEventListener("mouseover", handlePopupMouseOver);
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
  handlePopupMouseOver: 결과 팝업 안으로 마우스가 들어오면
  숨겨져 있던 기사 요약 카드를 자연스럽게 펼칩니다.
  이제 화살표 버튼이나 방향 이동 조건은 사용하지 않습니다.
*/
function handlePopupMouseEnter(event) {
  if (!popup || popup.hidden) {
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

function handlePopupMouseOver(event) {
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

  if (willOpen) {
    // 상세보기로 커지기 전 위치를 저장합니다. 나중에 간략히 보기로 돌아갈 때 이 위치로 복귀합니다.
    popupPreDetailPosition = getCurrentPopupPosition() || popupCompactHomePosition;
  }

  markPopupLayoutChanging(POPUP_INTERACTION_GRACE_MS);
  details.classList.toggle("is-open", willOpen);
  details.setAttribute("aria-hidden", willOpen ? "false" : "true");
  setPopupState(willOpen ? "detail" : "summary");

  if (willOpen) {
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
    // 팝업 밖이면 즉시 닫습니다. 단, 간략히 보기 직후 위치 복귀로 다시 안쪽에 들어오면 유지됩니다.
    requestAnimationFrame(() => {
      if (!isPointerInsideActiveAreas()) {
        closePopupFromPointerExit();
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

  const point = getPopupOpenPoint();
  if (point) {
    positionPopup(point.x, point.y);
    rememberCompactHomePosition();
  }
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
        ${renderSummaryRevealArrow()}
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

    if (wasLoadingPopup) {
    popupElement.classList.add("ai-news-popup--from-loading");
    window.setTimeout(() => {
      popupElement?.classList.remove("ai-news-popup--from-loading");
    }, 320);
  }

  showPopupElement(popupElement);
    const point = getPopupOpenPoint();
    if (point) {
      positionPopup(point.x, point.y);
      rememberCompactHomePosition();
      armPopupEntryGrace();
      revealSummaryIfPointerAlreadyInside();
    }
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
      ${renderSummaryRevealArrow()}

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

  const point = getPopupOpenPoint();
  if (point) {
    positionPopup(point.x, point.y);
    rememberCompactHomePosition();
    armPopupEntryGrace();
    revealSummaryIfPointerAlreadyInside();
  }
}


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
  renderSummaryLines: AI가 반환한 요약(summary)과 경고(warning) 텍스트를
  "." 또는 줄바꿈 기준으로 쪼개 최대 3개 항목의 목록으로 만들어 반환합니다.
  너무 긴 텍스트를 깔끔하게 여러 줄로 분리해서 보여주기 위한 함수입니다.
*/
function renderSummaryLines(summary, warning) {
  const lines = [summary, warning]
    .flatMap((text) => String(text).split(/[.\n]/)) // "."과 줄바꿈으로 쪼갬
    .map((text) => text.trim())
    .filter(Boolean)   // 빈 문자열 제거
    .slice(0, 3);      // 최대 3개만 사용

  return `
    <div class="news-ai-summary__title">분석 요약</div>
    <ul>
      ${lines.map((line) => `<li>${escapeHtml(line)}.</li>`).join("")}
    </ul>
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

/*
  renderBreakdown: 신뢰도 또는 어그로도의 세부 항목 점수 목록 HTML을 반환합니다.

  매개변수:
    title     - 섹션 제목 ("신뢰도" 또는 "어그로도")
    breakdown - AI가 반환한 세부 점수 객체 { source_clarity: 15, ... }
    rows      - 표시할 항목 정보 배열. 각 항목은 [키, 표시명, 최대점수] 형태
                예) ["source_clarity", "출처 명확성", 20]

  각 항목을 "출처 명확성 — 15/20" 형태로 나열합니다.
*/
function renderBreakdown(title, breakdown = {}, rows) {
  const items = rows
    .map(([key, label, max]) => {
      // breakdown 객체에서 해당 키의 값을 숫자로 변환. 유효하지 않으면 0
      const value = Number.isFinite(Number(breakdown[key])) ? Number(breakdown[key]) : 0;
      return `
        <div class="news-ai-breakdown__row">
          <span>${escapeHtml(label)}</span>
          <b>${value}/${max}</b>
        </div>
      `;
    })
    .join(""); // 배열을 하나의 문자열로 합침

  return `
    <div class="news-ai-breakdown">
      <h3>${escapeHtml(title)}</h3>
      ${items}
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

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "local" || !changes[POPUP_SCALE_STORAGE_KEY]) {
    return;
  }

  intonePopupScalePercent = normalizePopupScalePercent(changes[POPUP_SCALE_STORAGE_KEY].newValue);
  applyPopupScaleToElement();
  keepPopupInViewport();
});

loadPopupScalePreference();


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
    popupPreDetailPosition = null;
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

function getClampedPopupPosition(left, top) {
  if (!popup || popup.hidden) {
    return { left, top };
  }

  updatePopupViewportLimits();
  const padding = POPUP_VIEWPORT_PADDING_PX;
  const rect = popup.getBoundingClientRect();
  const width = Math.min(rect.width, Math.max(1, window.innerWidth - padding * 2));
  const height = Math.min(rect.height, Math.max(1, window.innerHeight - padding * 2));
  const maxLeft = Math.max(padding, window.innerWidth - width - padding);
  const maxTop = Math.max(padding, window.innerHeight - height - padding);

  return {
    left: clampNumber(left, padding, maxLeft),
    top: clampNumber(top, padding, maxTop)
  };
}

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
  updateSummaryRevealDirection(left, top, height);
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
    popup.removeAttribute("data-summary-direction");
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
  popupPreDetailPosition = null;
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
      popupPreDetailPosition = null;
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


// ─────────────────────────────────────────────
// 점수를 등급으로 변환하는 함수들
// ─────────────────────────────────────────────

/*
  getCredibilityLevel: 신뢰도 점수를 받아 등급 정보 객체를 반환합니다.
  80점 이상: 높은 신뢰 (녹색)
  50~79점: 검토 필요 (노란색)
  49점 이하: 낮은 신뢰 (빨간색)

  반환 객체:
    label     - 화면에 표시할 텍스트
    className - CSS 클래스 이름 (색상 스타일 적용용)
    color     - 직접 색상 코드 (그래프 등에 사용 가능)
*/
function getCredibilityLevel(score) {
  const normalized = toScore(score);
  if (normalized >= 80) return { label: "높은 신뢰", className: "good",    color: "#22c55e" };
  if (normalized >= 50) return { label: "검토 필요", className: "caution", color: "#f59e0b" };
  return                        { label: "낮은 신뢰", className: "bad",     color: "#ef4444" };
}

/*
  getClickbaitLevel: 어그로도 점수를 받아 등급 정보 객체를 반환합니다.
  어그로도는 낮을수록 좋습니다:
  20점 이하: 낮음 (좋음)
  21~40점: 약간 있음
  41~60점: 주의
  61점 이상: 높음 (나쁨)
*/
function getClickbaitLevel(score) {
  const normalized = toScore(score);
  if (normalized <= 20) return { label: "낮음",      className: "good" };
  if (normalized <= 40) return { label: "약간 있음", className: "normal" };
  if (normalized <= 60) return { label: "주의",      className: "caution" };
  return                        { label: "높음",      className: "bad" };
}

/*
  toScore: 어떤 값이든 0~100 사이의 정수로 변환합니다.
  숫자가 아닌 값은 0으로 처리합니다.
  소수점은 반올림으로 제거합니다.
*/
function toScore(value) {
  const score = Number(value);
  if (!Number.isFinite(score)) {
    return 0;
  }
  return Math.max(0, Math.min(100, Math.round(score)));
}

/*
  escapeHtml: 문자열 안의 HTML 특수 문자를 안전한 코드로 변환합니다.
  AI 응답이나 기사 제목 등 외부 데이터를 innerHTML에 넣기 전에 반드시 거칩니다.
  이 처리 없이 바로 innerHTML에 넣으면 XSS(악성 스크립트 삽입) 취약점이 생깁니다.

  변환 대상:
    &  → &amp;   (앰퍼샌드)
    <  → &lt;    (여는 꺾쇠 → 태그로 해석되지 않도록)
    >  → &gt;    (닫는 꺾쇠)
    "  → &quot;  (큰따옴표 → 속성 값 탈출용)
    '  → &#039;  (작은따옴표)
*/
function escapeHtml(value) {
  return String(value)
    .replaceAll("&",  "&amp;")
    .replaceAll("<",  "&lt;")
    .replaceAll(">",  "&gt;")
    .replaceAll('"',  "&quot;")
    .replaceAll("'",  "&#039;");
}
