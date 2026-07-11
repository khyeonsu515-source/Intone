// ─────────────────────────────────────────────
// AI에게 뉴스 기사 여부를 판별해달라고 요청하는 함수 (1차 분류)
// ─────────────────────────────────────────────

/*
  requestArticleCheck: 분석 전에 먼저 "이게 뉴스 기사가 맞아?"를 AI에게 물어봅니다.
  쇼핑 페이지, 검색 결과, SNS 글, 카테고리 목록 등은 신뢰도 분석 대상이 아니기 때문입니다.

  내부적으로 requestGroqJson()을 호출하며,
  system 역할에는 AI가 어떻게 판단해야 하는지 지침(프롬프트)을,
  user 역할에는 실제 기사 데이터를 전달합니다.
*/
async function requestArticleCheck(credentials, payload) {
  return requestGroqJson(credentials, [
    {
      role: "system",
      // buildArticleCheckPrompt()는 AI에게 주는 역할 지침 문자열을 반환
      content: buildArticleCheckPrompt()
    },
    {
      role: "user",
      // JSON.stringify(payload, null, 2): 객체를 보기 좋게 들여쓴 JSON 문자열로 변환
      content: JSON.stringify(payload, null, 2)
    }
  ]);
}


// ─────────────────────────────────────────────
// AI에게 신뢰도·어그로도 분석을 요청하는 함수 (본 분석)
// ─────────────────────────────────────────────

/*
  requestGroqAnalysis: 뉴스 기사로 판별된 링크에 대해
  신뢰도 점수, 어그로도 점수, 세부 항목 점수, 요약 등을 AI에게 요청합니다.
  requestArticleCheck와 구조는 동일하지만 다른 프롬프트를 사용합니다.

  existingTopics: Firestore에 이미 저장된 topic/core_keywords 후보 목록.
  주어지면 buildAnalysisPrompt가 "같은 사건이면 이 값을 그대로 재사용하라"는
  지시를 프롬프트에 덧붙입니다(getRecentTopicCandidates 참고).
*/
async function requestGroqAnalysis(credentials, payload, existingTopics) {
  return requestGroqJson(credentials, [
    {
      role: "system",
      content: buildAnalysisPrompt(existingTopics)
    },
    {
      role: "user",
      content: JSON.stringify(payload, null, 2)
    }
  ]);
}

async function requestNewsSitePattern(credentials, payload) {
  return requestGroqJson(credentials, [
    {
      role: "system",
      content: buildNewsSitePatternPrompt()
    },
    {
      role: "user",
      content: JSON.stringify(payload, null, 2)
    }
  ]);
}


// ─────────────────────────────────────────────
// Groq AI API를 실제로 호출하고 응답을 JSON으로 반환하는 함수
// ─────────────────────────────────────────────

/*
  requestGroqJson: 위의 두 요청 함수(requestArticleCheck, requestGroqAnalysis)가
  공통으로 사용하는 실제 API 통신 함수입니다.
  HTTP POST 요청을 보내고, 응답을 JSON 객체로 파싱해서 반환합니다.

  매개변수:
    apiKey   - Groq API 인증 키
    messages - AI에게 전달할 대화 메시지 배열 [{role, content}, ...]

  AI 응답 구조 (Groq API 형식):
    {
      choices: [
        {
          message: {
            content: "{ ...JSON 형태의 분석 결과 문자열... }"
          }
        }
      ]
    }
*/
async function requestGroqJson(credentials, messages) {
  const candidates = Array.isArray(credentials) ? credentials : [];
  const startIndex = await getActiveCredentialIndex(candidates.length);
  let lastError = null;

  for (let offset = 0; offset < candidates.length; offset += 1) {
    const index = (startIndex + offset) % candidates.length;
    try {
      const result = await requestGroqJsonWithCredential(candidates[index], messages);
      await setActiveCredentialIndex(index);
      return result;
    } catch (error) {
      lastError = error;
      if (!isRetryableGroqError(error) || offset === candidates.length - 1) {
        if (offset === candidates.length - 1) {
          await setActiveCredentialIndex((index + 1) % candidates.length);
        }
        throw error;
      }
      await setActiveCredentialIndex((index + 1) % candidates.length);
    }
  }

  throw lastError || new Error("사용할 수 있는 AI API Key가 없습니다.");
}

async function requestGroqJsonWithCredential(credential, messages) {
  const response = await fetch(credential.endpoint, {
    method: "POST",
    headers: {
      // Authorization 헤더에 API 키를 "Bearer 키값" 형식으로 포함
      "Authorization": `Bearer ${credential.key}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model:           credential.model,
      temperature:     0.1,                        // 0에 가까울수록 일관성 있는 답변, 1에 가까울수록 창의적
      response_format: { type: "json_object" },    // AI가 반드시 JSON만 반환하도록 강제
      messages
    })
  });

  // HTTP 요청 자체가 실패한 경우 (네트워크 오류, 인증 실패 등)
  if (!response.ok) {
    const errorText = await response.text().catch(() => "");
    const error = new Error(`${credential.provider} API 요청 실패 (${response.status}) ${truncate(errorText, 200)}`);
    error.status = response.status;
    throw error;
  }

  // 응답 본문을 JSON으로 파싱
  const data = await response.json();

  // data?.choices?.[0]?.message?.content
  // ?. 를 연속으로 사용해서 중간에 undefined가 있어도 오류 없이 undefined를 반환
  const content = data?.choices?.[0]?.message?.content;

  if (!content) {
    throw new Error("Groq API 응답이 비어 있습니다.");
  }

  try {
    // AI가 문자열로 반환한 JSON을 실제 JavaScript 객체로 변환
    return JSON.parse(content);
  } catch (error) {
    throw new Error("AI 응답을 JSON으로 해석하지 못했습니다.");
  }
}


