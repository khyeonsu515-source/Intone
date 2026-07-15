// ─────────────────────────────────────────────
// AI에게 줄 지침(프롬프트) 생성 함수들
// ─────────────────────────────────────────────

/*
  buildArticleCheckPrompt: AI에게 "너는 뉴스 기사 판별기야"라고 역할을 부여하고
  어떤 형식으로 답해야 하는지 지정하는 지침 문자열을 반환합니다.
  백틱(`)으로 감싼 문자열은 여러 줄을 그대로 쓸 수 있는 템플릿 리터럴입니다.
  .trim()은 앞뒤 불필요한 줄바꿈을 제거합니다.
*/
function buildArticleCheckPrompt() {
  return `
너는 링크가 뉴스 기사인지 먼저 판별하는 분류기다.
제공된 URL, 링크 텍스트, title, meta, og:title, 본문 일부만 사용해 판단한다.
일반 쇼핑, 광고, 검색 결과, SNS 글, 영상 페이지, 게시판 목록, 언론사 홈, 카테고리 페이지는 뉴스 기사로 보지 않는다.
개별 사건이나 이슈를 다루는 기사 본문으로 보이면 뉴스 기사로 본다.
응답은 오직 JSON 객체 하나만 반환한다.

형식:
{
  "is_article": true,
  "confidence": 84,
  "reason": "개별 기사 제목과 본문 단락이 확인됨"
}
`.trim();
}

/*
  buildAnalysisPrompt: AI에게 신뢰도·어그로도 분석 기준과
  반환 형식을 상세하게 알려주는 지침 문자열을 반환합니다.
  각 항목의 배점 기준도 포함되어 있어 AI가 일관된 기준으로 채점하도록 유도합니다.
*/
function buildNewsSitePatternPrompt() {
  return `
너는 아직 등록되지 않은 사이트가 뉴스 전문 사이트인지 판단하는 분류기다.
제공된 host, 확인된 기사 URL 목록, 현재 URL, title, meta, 본문 일부만 근거로 사용한다.
뉴스 전문 사이트이거나 기사 페이지를 꾸준히 제공하는 언론/매체 사이트라면, 기사 URL을 식별할 수 있는 접두어를 알려 준다.
홈페이지 전체를 뜻하는 "https://example.com/" 같은 너무 넓은 접두어는 피한다.
"/news/", "/article/", "/view/", "/articles/"처럼 기사 페이지에 반복되는 경로 접두어를 우선한다.
확신이 낮거나 기사 URL 형식을 특정하기 어렵다면 is_news_site를 false로 반환한다.
응답은 오직 JSON 객체 하나만 반환한다.

형식:
{
  "is_news_site": true,
  "confidence": 86,
  "url_prefixes": [
    "https://example.com/news/",
    "https://example.com/article/"
  ],
  "reason": "확인된 URL들이 같은 매체의 개별 기사 페이지 형식과 일치함"
}
`.trim();
}

/*
  buildAnalysisPrompt: 신뢰도·어그로도 분석 기준과
  반환 형식을 상세하게 알려주는 지침 문자열을 반환합니다.
  각 항목의 배점 기준도 포함되어 있어 AI가 일관된 기준으로 채점하도록 유도합니다.
*/
function buildAnalysisPrompt() {
  const scoringSections = `
[신뢰도 credibility_score: 0~100점]
- 출처 명확성: 20점
  기자명, 언론사, 작성일, 공식 출처 존재 여부
- 제목/본문 일치도: 25점
  제목이 본문 내용을 정확히 반영하는 정도
- 근거 충실도: 25점
  통계, 공식 발표, 전문가 인용, 자료 출처 존재 여부
- 표현 중립성: 15점
  감정적·선동적 표현이 적은 정도
- 맥락 제공성: 15점
  사건의 배경, 반대 의견, 한계, 추가 설명 제공 여부

[어그로도 clickbait_score: 0~100점]
높을수록 나쁨.
- 과장 표현: 20점
  "충격", "경악", "역대급", "난리", "소름" 같은 표현
- 궁금증 유도: 20점
  "알고 보니", "이유는?", "결과는?", "정체는?" 같은 표현
- 제목/본문 불일치: 25점
  제목이 본문보다 과장되거나 다른 인상을 주는 정도
- 감정 자극: 20점
  분노, 공포, 혐오, 불안, 논란을 과도하게 유도하는 정도
- 핵심 정보 은폐: 15점
  제목에서 중요한 주어·대상·결과를 숨기는 정도
`;

  const baseFields = `  "is_article": true,
  "credibility_score": 72,
  "clickbait_score": 38,
  "credibility_breakdown": {
    "source_clarity": 15,
    "title_body_match": 20,
    "evidence_quality": 18,
    "neutrality": 10,
    "context": 9
  },
  "clickbait_breakdown": {
    "exaggeration": 8,
    "curiosity_gap": 10,
    "title_body_mismatch": 7,
    "emotional_trigger": 8,
    "hidden_key_info": 5
  },
  "article_summary": "정부 발표에 따른 정책 변화와 관련 반응을 다룬 기사입니다.",
  "summary": "공식 자료 인용은 있으나 제목에 약간의 클릭 유도 표현이 있음",
  "warning": "제목만 보고 판단하지 말고 본문 근거를 확인하세요."`;

  return `
너는 뉴스 링크의 신뢰도와 어그로도를 평가하는 분석기다.
이미 뉴스 기사로 판별된 링크만 입력된다.
반드시 사용자가 제공한 제목, URL, 메타 정보, 본문 일부만 근거로 삼아라.
정보가 부족하면 임의로 사실을 추정하지 말고 낮은 확신을 반영해라.
article_summary는 기사 내용을 1문장으로 짧게 요약해라.
응답은 설명 문장 없이 오직 JSON 객체 하나만 반환해라.
${scoringSections}
아래 형식과 키를 그대로 사용해라.
{
${baseFields}
}
`.trim();
}


