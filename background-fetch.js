// ─────────────────────────────────────────────
// 주어진 URL의 HTML을 다운로드해서 기사 본문 정보를 추출하는 함수
// ─────────────────────────────────────────────

/*
  fetchArticlePreview: 링크 주소(URL)로 직접 접속해서 HTML 문서를 받아온 뒤
  제목, 메타 설명, OG 제목, 본문 텍스트 등 분석에 필요한 정보를 꺼냅니다.
  접속 실패나 HTML이 아닌 경우에도 오류를 내지 않고 빈 값을 반환합니다.

  반환 객체:
    page_title       - <title> 태그 내용
    meta_description - <meta name="description"> 내용
    og_title         - <meta property="og:title"> 내용 (SNS 공유용 제목)
    og_image         - <meta property="og:image"> 내용, 없으면 페이지의 첫 <img> src (기사 대표 이미지 URL)
    article_text     - <p> 태그들에서 추출한 본문 텍스트
    extraction_error - 추출 중 오류가 발생했을 때의 오류 메시지
*/
async function fetchArticlePreview(url) {
  try {
    const response = await fetch(url, {
      method: "GET",
      credentials: "omit",    // 로그인 쿠키 등을 포함하지 않음 (보안 및 프라이버시)
      cache: "force-cache"    // 브라우저에 이미 캐시된 HTML이 있으면 재사용
    });

    // response.ok: HTTP 상태 코드가 200~299 사이일 때 true
    // 404(페이지 없음), 500(서버 오류) 등은 false
    if (!response.ok) {
      throw new Error(`본문 요청 실패 (${response.status})`);
    }

    // Content-Type 헤더로 HTML 문서인지 확인 (이미지, PDF 등은 파싱 불필요)
    const contentType = response.headers.get("content-type") || "";
    if (!contentType.toLowerCase().includes("text/html")) {
      throw new Error("HTML 문서가 아닙니다.");
    }

    // HTML 전체를 하나의 문자열로 읽어옴
    const html = await response.text();

    return {
      page_title:       extractTitle(html),
      meta_description: extractMetaContent(html, "name", "description"),
      og_title:         extractMetaContent(html, "property", "og:title"),
      og_image:         extractMetaContent(html, "property", "og:image") || extractFirstImage(html),
      article_text:     extractArticleText(html),
      extraction_error: ""
    };
  } catch (error) {
    // 어떤 이유로든 본문을 가져오지 못하면 빈 값들을 반환
    // 분석 자체는 링크 텍스트나 URL만으로도 진행할 수 있으므로 중단하지 않음
    return {
      page_title:       "",
      meta_description: "",
      og_title:         "",
      og_image:         "",
      article_text:     "",
      extraction_error: error instanceof Error ? error.message : "본문을 가져오지 못했습니다."
    };
  }
}


