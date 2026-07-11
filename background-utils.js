// ─────────────────────────────────────────────
// 범용 유틸리티 함수들 (여러 곳에서 공통으로 사용)
// ─────────────────────────────────────────────

/*
  clampScore: 숫자 값을 0 이상 max 이하 범위로 강제로 조정합니다.
  AI가 범위를 벗어난 값(예: 150점, -5점)을 반환해도 안전하게 처리됩니다.
  숫자가 아닌 값(undefined, 문자열 등)은 0으로 처리합니다.
  Math.round()로 소수점도 제거합니다.
*/
function clampScore(value, max = 100) {
  const number = Number(value); // 어떤 값이든 숫자로 변환 시도
  if (!Number.isFinite(number)) {
    return 0; // NaN(숫자 아님), Infinity(무한대) 등 비정상 값은 0 반환
  }
  return Math.max(0, Math.min(max, Math.round(number)));
}

/*
  sumScoreParts: 세부 항목 점수를 모두 더합니다.
  각 항목은 validateAnalysis()에서 이미 배점 안으로 보정된 값입니다.
*/
function sumScoreParts(parts) {
  return Object.values(parts || {}).reduce((total, value) => total + clampScore(value), 0);
}

/*
  calculateWeightedFinalScore: 최종 표시 점수를 계산합니다.
  - 세부 항목 합계: 80%
  - AI가 직접 판단한 전체 점수: 20%
  예) 세부 항목 합계 70점, AI 전체 판단 90점이면
      70 * 0.8 + 90 * 0.2 = 74점
*/
function calculateWeightedFinalScore(breakdownTotal, aiOverallScore) {
  const breakdownScore = clampScore(breakdownTotal);
  const aiScore = clampScore(aiOverallScore);
  return clampScore((breakdownScore * 0.8) + (aiScore * 0.2));
}

/*
  normalizeUrl: URL을 표준 형식으로 정리합니다.
  http, https만 허용하고 나머지 프로토콜(ftp://, file:// 등)은 막습니다.
  URL 끝의 #anchor(페이지 내 위치 표시) 부분을 제거합니다.
  같은 기사를 #section1, #section2 등 다른 앵커로 접근해도 같은 URL로 취급하기 위함입니다.
  파싱에 실패하면 빈 문자열을 반환합니다.
*/
function normalizeUrl(url) {
  try {
    const parsed = new URL(url); // URL을 구성 요소(프로토콜, 호스트, 경로 등)로 분해
    if (!["http:", "https:"].includes(parsed.protocol)) {
      return ""; // http/https 외 차단
    }
    parsed.hash = ""; // #anchor 제거
    return parsed.toString(); // 다시 문자열로 조합해서 반환
  } catch (error) {
    return ""; // URL 형식이 잘못된 경우
  }
}

/*
  resolveImageUrl: og:image의 content 값은 상대 경로("/img/a.jpg")로 오는
  경우도 있어서, 기사 페이지 URL을 기준으로 절대 URL로 변환합니다.
  http/https가 아니거나 형식이 잘못된 경우 빈 문자열을 반환합니다.
*/
function resolveImageUrl(rawImageUrl, pageUrl) {
  if (!rawImageUrl) {
    return "";
  }
  try {
    const resolved = new URL(rawImageUrl, pageUrl);
    if (!["http:", "https:"].includes(resolved.protocol)) {
      return "";
    }
    return resolved.toString();
  } catch (error) {
    return "";
  }
}

/*
  getCachedResult: 메모리 캐시에서 해당 URL의 분석 결과를 찾아봅니다.
  결과가 있어도 저장된 지 6시간이 지났으면 삭제하고 null을 반환합니다.
  결과가 없으면 null을 반환합니다.
*/
async function getCachedResult(url) {
  if (!url) {
    return null;
  }

  const memoryEntry = analysisCache.get(url);
  if (memoryEntry) {
    if (Date.now() - memoryEntry.savedAt <= CACHE_TTL_MS) {
      return memoryEntry.data;
    }
    analysisCache.delete(url);
  }

  const storageCache = await readPersistentAnalysisCache();
  const storedEntry = storageCache[url];

  if (!storedEntry) {
    return null;
  }

  if (Date.now() - Number(storedEntry.savedAt || 0) > CACHE_TTL_MS) {
    delete storageCache[url];
    await writePersistentAnalysisCache(storageCache);
    return null;
  }

  analysisCache.set(url, {
    savedAt: storedEntry.savedAt,
    data: storedEntry.data
  });

  return storedEntry.data;
}

/*
  setCachedResult: 분석 결과를 현재 시각과 함께 메모리 캐시와
  chrome.storage.local 영구 캐시에 동시에 저장합니다.
  Service Worker가 종료되어 메모리 Map이 초기화되어도,
  저장 기간 안에는 chrome.storage.local에서 다시 불러와 재사용합니다.
*/
async function setCachedResult(url, data) {
  if (!url || !data) {
    return;
  }

  const entry = {
    savedAt: Date.now(),
    data
  };

  analysisCache.set(url, entry);

  const storageCache = await readPersistentAnalysisCache();
  storageCache[url] = entry;

  prunePersistentAnalysisCache(storageCache);
  await writePersistentAnalysisCache(storageCache);
}

async function readPersistentAnalysisCache() {
  return new Promise((resolve) => {
    chrome.storage.local.get([ANALYSIS_CACHE_STORAGE_KEY], (items) => {
      if (chrome.runtime.lastError) {
        resolve({});
        return;
      }

      const cache = items?.[ANALYSIS_CACHE_STORAGE_KEY];
      if (!cache || typeof cache !== "object" || Array.isArray(cache)) {
        resolve({});
        return;
      }

      resolve(cache);
    });
  });
}

async function writePersistentAnalysisCache(cache) {
  return new Promise((resolve) => {
    chrome.storage.local.set({ [ANALYSIS_CACHE_STORAGE_KEY]: cache }, () => resolve());
  });
}

function prunePersistentAnalysisCache(cache) {
  const now = Date.now();

  for (const [url, entry] of Object.entries(cache)) {
    if (!entry || typeof entry !== "object" || now - Number(entry.savedAt || 0) > CACHE_TTL_MS) {
      delete cache[url];
    }
  }

  const entries = Object.entries(cache)
    .sort((a, b) => Number(b[1]?.savedAt || 0) - Number(a[1]?.savedAt || 0));

  for (const [url] of entries.slice(ANALYSIS_CACHE_MAX_ENTRIES)) {
    delete cache[url];
  }
}


/*
  sanitizeText: 문자열의 연속 공백을 하나로 정리하고,
  maxLength를 초과하면 truncate()로 잘라냅니다.
  AI 응답 텍스트를 화면에 표시하기 전에 정제할 때 사용합니다.
*/
function sanitizeText(value, maxLength) {
  return truncate(String(value).replace(/\s+/g, " ").trim(), maxLength);
}

/*
  truncate: 문자열이 maxLength보다 길면 그 길이에서 잘라내고 "..."를 붙입니다.
  짧으면 그대로 반환합니다.
  AI 입력 한도 초과를 방지하거나 UI에서 너무 긴 텍스트를 방지할 때 사용합니다.
*/
function truncate(value, maxLength) {
  const text = String(value || "");
  return text.length > maxLength ? `${text.slice(0, maxLength)}...` : text;
}
