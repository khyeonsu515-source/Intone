// ─────────────────────────────────────────────
// HTML에서 필요한 정보를 꺼내는 파싱 함수들
// ─────────────────────────────────────────────

/*
  extractTitle: HTML 문자열에서 <title>...</title> 사이의 텍스트를 꺼냅니다.
  정규 표현식(regex)을 사용해서 태그를 찾습니다.
  /i 플래그는 대소문자 구분 없이 검색하겠다는 의미입니다.
*/
function extractTitle(html) {
  // .match()는 정규식과 일치하는 첫 번째 결과를 반환합니다.
  // [\\s\\S]*? 는 줄바꿈 포함 아무 문자나 (최대한 적게) 매칭하는 패턴입니다.
  const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  // match?.[1] : 첫 번째 캡처 그룹 (괄호 안의 내용). 없으면 ""
  return decodeHtml(stripTags(match?.[1] || ""));
}

/*
  extractMetaContent: HTML에서 특정 <meta> 태그의 content 값을 추출합니다.
  예) extractMetaContent(html, "name", "description")
      → <meta name="description" content="기사 설명..."> 에서 "기사 설명..."을 반환

  매개변수:
    html           - HTML 전체 문자열
    attributeName  - 찾을 속성 이름 ("name" 또는 "property")
    attributeValue - 속성 값 ("description", "og:title" 등)
*/
function extractMetaContent(html, attributeName, attributeValue) {
  // HTML에서 모든 <meta ...> 태그를 배열로 추출. 없으면 빈 배열
  const metaTags = html.match(/<meta\b[^>]*>/gi) || [];
  const normalizedAttributeName  = attributeName.toLowerCase();
  const normalizedAttributeValue = attributeValue.toLowerCase();

  // 모든 meta 태그를 하나씩 검사해서 원하는 태그를 찾음
  for (const tag of metaTags) {
    // parseAttributes()로 태그 속성을 {이름: 값} 객체로 변환
    const attributes = parseAttributes(tag);
    if ((attributes[normalizedAttributeName] || "").toLowerCase() === normalizedAttributeValue) {
      return decodeHtml(attributes.content || ""); // content 속성 값 반환
    }
  }

  return ""; // 해당하는 meta 태그가 없으면 빈 문자열 반환
}

/*
  extractArticleText: HTML에서 실제 기사 본문 텍스트를 추출합니다.
  우선 <article> 태그 안에서 찾고, 없으면 전체 HTML에서 <p> 태그를 수집합니다.
  30자 미만의 짧은 단락(메뉴 항목 등)은 제외하고, 최대 12개 단락만 사용합니다.
*/
function extractArticleText(html) {
  // <article>...</article> 블록 전체를 배열로 찾음 (본문이 여기 들어있는 경우가 많음)
  const articleMatches = html.match(/<article\b[^>]*>[\s\S]*?<\/article>/gi) || [];
  // <article>이 있으면 그 안에서만 <p>를 찾고, 없으면 HTML 전체에서 찾음
  const sourceHtml     = articleMatches.length > 0 ? articleMatches.join("\n") : html;

  const paragraphMatches = sourceHtml.match(/<p\b[^>]*>[\s\S]*?<\/p>/gi) || [];
  const paragraphs = paragraphMatches
    .map((paragraph) => decodeHtml(stripTags(paragraph))) // HTML 태그 제거 후 엔티티 디코딩
    .map((text) => text.replace(/\s+/g, " ").trim())      // 연속 공백을 하나로 정리
    .filter((text) => text.length >= 30)                   // 너무 짧은 단락 제거
    .slice(0, 12);                                          // 최대 12개 단락만 사용

  // 단락들을 줄바꿈으로 이어붙이고, 전체 5000자를 초과하면 잘라냄
  return paragraphs.join("\n").slice(0, 5000);
}

/*
  parseAttributes: HTML 태그 하나를 받아서 그 안의 모든 속성을 {이름: 값} 객체로 반환합니다.
  예) <meta name="description" content="설명">
      → { name: "description", content: "설명" }

  HTML 속성 값은 큰따옴표, 작은따옴표, 따옴표 없음 세 가지 방식이 있어서
  정규식이 세 경우를 모두 처리합니다.
*/
function parseAttributes(tag) {
  const attributes = {};
  // 정규식 설명:
  // ([a-zA-Z_:][-a-zA-Z0-9_:.]*) → 속성 이름 (캡처 그룹 1)
  // \s*=\s*                       → 등호 (앞뒤 공백 허용)
  // "([^"]*)"                     → 큰따옴표로 감싼 값 (캡처 그룹 3)
  // '([^']*)'                     → 작은따옴표로 감싼 값 (캡처 그룹 4)
  // ([^\s"'=<>`]+)                → 따옴표 없는 값 (캡처 그룹 5)
  const regex = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/g;
  let match = regex.exec(tag);

  while (match) {
    // ?? (Nullish Coalescing): 왼쪽이 null/undefined이면 오른쪽 값 사용
    // 세 캡처 그룹 중 실제로 매칭된 것을 선택
    attributes[match[1].toLowerCase()] = match[3] ?? match[4] ?? match[5] ?? "";
    match = regex.exec(tag); // 같은 태그에서 다음 속성으로 이동
  }

  return attributes;
}

/*
  stripTags: HTML 문자열에서 모든 태그를 제거하고 텍스트만 남깁니다.
  <script>와 <style> 블록은 그 안의 내용까지 통째로 제거합니다.
  나머지 태그(<p>, <span> 등)는 태그만 제거하고 안의 내용은 보존합니다.
*/
function stripTags(value) {
  return String(value || "")
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ") // <script>...</script> 전체 제거
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi,  " ") // <style>...</style>  전체 제거
    .replace(/<[^>]+>/g, " ");                            // 나머지 모든 태그를 공백으로 대체
}

/*
  decodeHtml: HTML 특수 문자 코드를 실제 문자로 변환합니다.
  예) &amp; → &, &lt; → <, &gt; → >, &quot; → ", &#39; → '
  웹에서 가져온 텍스트에는 이런 코드들이 섞여 있어서 정리가 필요합니다.
*/
function decodeHtml(value) {
  return String(value || "")
    .replace(/&nbsp;/gi, " ")  // 줄바꿈 없는 공백
    .replace(/&amp;/gi,  "&")
    .replace(/&lt;/gi,   "<")
    .replace(/&gt;/gi,   ">")
    .replace(/&quot;/gi, "\"")
    .replace(/&#39;/gi,  "'")
    .replace(/&#x27;/gi, "'")
    .replace(/\s+/g, " ")     // 연속된 공백/줄바꿈을 하나의 공백으로
    .trim();                   // 앞뒤 공백 제거
}

