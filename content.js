/*
  content.js
  =====================================================================

  이 파일은 확장 프로그램이 방문한 모든 웹페이지에 삽입되는 진입점입니다.
  실제 로직은 역할별로 나뉜 파일들에 있고(manifest.json의 content_scripts
  순서대로 로드되어 같은 전역 스코프를 공유합니다), 이 파일은 마지막에
  로드되어 전역 이벤트 리스너를 등록하는 "배선(wiring)" 역할만 합니다.

  파일 구성 (manifest.json에 로드되는 순서):
    1. content-state.js    - 상수, 전역 상태 변수
    2. content-utils.js    - 점수/등급 변환, escapeHtml 등 순수 유틸
    3. content-render.js   - 팝업 HTML 렌더링, 배율 설정
    4. content-position.js - 팝업 위치 계산 및 성장 애니메이션
    5. content-popup.js    - 팝업 DOM 생성/표시/숨김/상태머신
    6. content-hover.js    - 링크 hover 감지, 분석 요청
    7. content.js (이 파일) - 전역 이벤트 리스너 등록

  ★ 다른 파일과의 관계
     - background.js      →  분석 요청을 받아 실제 AI API를 호출함
     - popup.css          →  이 파일이 만드는 팝업 DOM의 스타일을 담당함
     - action_popup.js    →  같은 background.js 상태를 다른 화면(툴바 팝업)에 보여줌

  =====================================================================
*/


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


chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "local" || !changes[POPUP_SCALE_STORAGE_KEY]) {
    return;
  }

  intonePopupScalePercent = normalizePopupScalePercent(changes[POPUP_SCALE_STORAGE_KEY].newValue);
  applyPopupScaleToElement();
  keepPopupInViewport();
});

loadPopupScalePreference();