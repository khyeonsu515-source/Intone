/*
  =====================================================================
  background.js
  =====================================================================

  이 파일은 확장 프로그램의 "두뇌" 역할을 합니다.
  사용자가 보는 웹페이지와는 완전히 분리된 별도 공간(Service Worker)에서
  조용히 실행되며, 다음 세 가지 핵심 역할을 담당합니다.

  1. content.js에서 "이 링크 분석해줘"라는 요청을 받으면
     실제로 Groq AI API를 호출해서 분석 결과를 돌려줍니다.

  2. 분석 진행 상황(단계)을 저장소에 저장해두고,
     action_popup.js가 요청하면 현재 상태를 알려줍니다.

  3. 같은 링크를 반복 분석하지 않도록 결과를 메모리에 보관합니다(캐시).

  ★ 다른 파일과의 관계
     - content.js      →  background.js 에게 분석 요청을 보냄
     - action_popup.js →  background.js 에게 현재 상태를 물어봄
     - background.js   →  두 파일 모두에게 응답하고 상태를 전달함

  ★ 이 파일의 역할
  Service Worker는 manifest.json에 파일을 하나만 지정할 수 있어서
  (content_scripts처럼 배열로 여러 파일을 나열할 수 없음), importScripts()로
  역할별 파일들을 이 파일 안에서 직접 불러옵니다. importScripts는 지정한
  순서대로 각 파일을 동기적으로 실행하며, 모두 같은 전역 스코프를 공유합니다.

  파일 구성 (아래 importScripts 순서대로 로드됨):
    1. background-state.js    - 상수, 전역 상태(캐시 Map)
    2. background-router.js   - 설치 이벤트, 메시지 라우터, 분석 흐름 총괄
    3. background-status.js   - 분석 상태 저장/조회, API 키 조회
    4. background-fetch.js    - 기사 HTML 다운로드 및 본문 추출
    5. background-ai.js       - Groq/Cerebras AI 호출
    6. background-prompts.js  - AI에게 보낼 프롬프트 생성
    7. background-validate.js - AI 응답 검증 및 정제
    8. background-parse.js    - HTML 파싱 유틸리티
    9. background-learning.js - 뉴스 사이트 학습, API 키 자격 증명 관리
    10. background-utils.js   - 점수 계산, URL 정규화, 로컬 캐시, 문자열 유틸
    11. background-firebase.js - Firebase(Firestore) 공유 캐시

  =====================================================================
*/


// ─────────────────────────────────────────────
// 역할별 파일 불러오기 (실행 순서대로)
// ─────────────────────────────────────────────

importScripts(
  "background-state.js",
  "background-router.js",
  "background-status.js",
  "background-fetch.js",
  "background-ai.js",
  "background-prompts.js",
  "background-validate.js",
  "background-parse.js",
  "background-learning.js",
  "background-utils.js",
  "background-firebase.js"
);

try {
  importScripts("known_news_patterns.js");
} catch (error) {
  self.KNOWN_NEWS_URL_PREFIXES = [];
}
