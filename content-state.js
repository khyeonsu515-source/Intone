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

const POPUP_INTERACTION_GRACE_MS = 2000;

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
// 내부 카드의 max-height 전환(280ms, popup.css)보다 넉넉하게 잡습니다.
const POPUP_GROWTH_TRACK_MS = 360;

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

