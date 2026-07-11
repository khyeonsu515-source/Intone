// ─────────────────────────────────────────────
// AI 응답을 검사하고 안전한 값으로 정제하는 함수들
// ─────────────────────────────────────────────

// direction.stance에 허용되는 값 목록. 부정 ~ 긍정 단일 스펙트럼이며, 순서 자체가
// 그 스펙트럼 위치를 나타냅니다. AI가 이 중 하나를 반환하지 않으면 "중립적"으로 대체합니다.
const ANALYSIS_STANCE_VALUES = ["매우 부정적", "약간 부정적", "중립적", "약간 긍정적", "매우 긍정적"];

/*
  sanitizeKeywordList: topic/core_keywords/framing_keywords처럼 문자열 배열로
  와야 하는 값을 검증합니다. 배열이 아니거나 항목이 문자열이 아니면 제외하고,
  너무 긴 항목은 잘라내며, 개수도 maxCount개까지만 남깁니다.
  이 키워드들은 화면에 표시되지 않고 Firebase 저장(기사 매칭)에만 사용됩니다.
*/
function sanitizeKeywordList(value, maxCount) {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .filter((item) => typeof item === "string" && item.trim())
    .map((item) => sanitizeText(item, 60))
    .slice(0, maxCount);
}

/*
  validateDirection: direction 객체({stance, reason})를 검증합니다.
  stance가 허용된 값이 아니면 "중립적"으로 대체합니다.
*/
function validateDirection(value) {
  const stance = ANALYSIS_STANCE_VALUES.includes(value?.stance) ? value.stance : "중립적";
  return {
    stance,
    reason: sanitizeText(value?.reason || "", 200)
  };
}

/*
  validateArticleCheck: AI가 반환한 뉴스 판별 결과를 검증합니다.
  AI가 예상치 못한 형식으로 답하거나 값이 빠져 있어도
  이 함수가 항상 올바른 형태의 객체를 반환하도록 보장합니다.
*/
function validateArticleCheck(value) {
  return {
    // Boolean()으로 감싸서 어떤 값이 들어와도 true/false로 확실하게 변환
    is_article: Boolean(value?.is_article),
    confidence: clampScore(value?.confidence), // 0~100 범위로 보정
    // 이유 텍스트가 없거나 너무 길면 기본값 또는 잘라낸 값으로 대체
    reason: sanitizeText(value?.reason || "뉴스 기사 여부를 명확히 판단하기 어렵습니다.", 180)
  };
}

/*
  buildNotArticleResult: "뉴스 기사가 아님"으로 판별됐을 때
  모든 점수를 0으로 채운 결과 객체를 만들어 반환합니다.
  content.js는 is_article이 false인 객체를 받으면 "뉴스 기사 아님" 팝업을 표시합니다.
*/
function buildNotArticleResult(articleCheck) {
  return {
    is_article:      false,
    credibility_score: 0,
    clickbait_score:   0,
    credibility_breakdown: {
      source_clarity:  0,
      title_body_match: 0,
      evidence_quality: 0,
      neutrality:      0,
      context:         0
    },
    clickbait_breakdown: {
      exaggeration:       0,
      curiosity_gap:      0,
      title_body_mismatch: 0,
      emotional_trigger:  0,
      hidden_key_info:    0
    },
    summary: articleCheck.reason || "이 링크는 뉴스 기사로 보기 어렵습니다.",
    warning: "뉴스 기사로 판별된 링크만 신뢰도와 어그로도를 분석합니다."
  };
}

/*
  validateAnalysis: AI가 반환한 본 분석 결과를 검증하고 정제합니다.
  점수를 각 항목의 최대 점수 범위 안으로 강제로 맞추고,
  텍스트 필드는 길이를 제한하며 공백을 정리합니다.
  이 과정을 거쳐야 content.js에서 안전하게 화면에 출력할 수 있습니다.

  resolvedTopic이 주어지면(키워드 인덱스에서 이미 확실한 주제를 찾은 경우)
  topic/core_keywords는 AI 응답을 쓰지 않고 이 값을 그대로 사용합니다 —
  애초에 이 경우 AI에게 그 필드를 요청하지도 않았기 때문입니다
  (buildAnalysisPrompt 참고). framing_keywords/direction은 이 기사만의
  값이라 항상 AI 응답에서 읽습니다.
*/
function validateAnalysis(value, resolvedTopic = null) {
  // 세부 항목 객체가 없으면 빈 객체로 대체해서 이후 접근 시 오류를 방지
  const credibilityBreakdown = value?.credibility_breakdown || {};
  const clickbaitBreakdown   = value?.clickbait_breakdown   || {};

  // 세부 항목 점수는 먼저 항목별 최대 배점 안으로 보정합니다.
  // 이후 이 항목 합계 80% + AI가 직접 판단한 전체 점수 20%를 더해
  // 최종 신뢰도/어그로도 점수로 사용합니다.
  const normalizedCredibilityBreakdown = {
    source_clarity:   clampScore(credibilityBreakdown.source_clarity,  20), // 최대 20점
    title_body_match: clampScore(credibilityBreakdown.title_body_match, 25), // 최대 25점
    evidence_quality: clampScore(credibilityBreakdown.evidence_quality, 25),
    neutrality:       clampScore(credibilityBreakdown.neutrality,       15),
    context:          clampScore(credibilityBreakdown.context,          15)
  };

  const normalizedClickbaitBreakdown = {
    exaggeration:        clampScore(clickbaitBreakdown.exaggeration,       20),
    curiosity_gap:       clampScore(clickbaitBreakdown.curiosity_gap,      20),
    title_body_mismatch: clampScore(clickbaitBreakdown.title_body_mismatch, 25),
    emotional_trigger:   clampScore(clickbaitBreakdown.emotional_trigger,  20),
    hidden_key_info:     clampScore(clickbaitBreakdown.hidden_key_info,    15)
  };

  const credibilityBreakdownTotal = sumScoreParts(normalizedCredibilityBreakdown);
  const clickbaitBreakdownTotal   = sumScoreParts(normalizedClickbaitBreakdown);

  const aiCredibilityScore = clampScore(value?.credibility_score);
  const aiClickbaitScore   = clampScore(value?.clickbait_score);

  const finalCredibilityScore = calculateWeightedFinalScore(credibilityBreakdownTotal, aiCredibilityScore);
  const finalClickbaitScore   = calculateWeightedFinalScore(clickbaitBreakdownTotal,   aiClickbaitScore);

  return {
    is_article:        true,
    credibility_score: finalCredibilityScore, // 세부 항목 합계 80% + AI 전체 판단 20%
    clickbait_score:   finalClickbaitScore,   // 세부 항목 합계 80% + AI 전체 판단 20%
    credibility_breakdown: normalizedCredibilityBreakdown,
    clickbait_breakdown:   normalizedClickbaitBreakdown,
    article_summary: sanitizeText(value?.article_summary || "기사 요약을 생성하지 못했습니다.",  120),
    summary:         sanitizeText(value?.summary         || "분석 요약을 생성하지 못했습니다.",  180),
    warning:         sanitizeText(value?.warning         || "AI 판단은 참고용이며 최종 팩트체크가 아닙니다.", 180),

    // 아래 네 항목은 팝업에는 표시하지 않고, 같은 사건을 다룬 다른 기사와
    // 매칭하기 위한 용도로만 Firebase(Firestore)에 저장됩니다.
    topic: resolvedTopic?.topic
      ? sanitizeText(resolvedTopic.topic, 60)
      : sanitizeText(value?.topic || "", 60),
    core_keywords: resolvedTopic?.topic
      ? sanitizeKeywordList(resolvedTopic.core_keywords, 6)
      : sanitizeKeywordList(value?.core_keywords, 6),
    framing_keywords:  sanitizeKeywordList(value?.framing_keywords, 5),
    direction:         validateDirection(value?.direction)
  };
}


