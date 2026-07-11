/*
  content-utils.js
  =====================================================================
  점수를 등급으로 바꾸거나 HTML을 이스케이프하는 등, 다른 파일들이
  공통으로 쓰는 순수 유틸리티 함수들.
  =====================================================================
*/

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
