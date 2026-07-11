// ─────────────────────────────────────────────
// og:image 조회용 별도 서버(server/) 호출
// ─────────────────────────────────────────────

/*
  open-graph-scraper는 undici/Buffer 등 Node 전용 API에 의존해서 이 확장의
  서비스워커 안에서는 돌릴 수 없습니다(server/README.md 참고). 그래서 실제
  Node 런타임이 있는 별도 서버에 올려두고, 여기서는 그 서버만 호출합니다.

  아직 배포 전이라면 이 상수를 비워두세요 — fetchImageFromServer()는 빈
  문자열을 반환하고, 호출부는 기존 og:image 정규식 추출 결과로 대체합니다.
*/
const OG_IMAGE_SERVER_URL = ""; // 예: "https://intone-og-image-server.vercel.app/api/og-image"

/*
  fetchImageFromServer: 서버에 기사 URL을 보내 대표 이미지를 받아옵니다.
  서버가 아직 설정되지 않았거나 요청이 실패하면 조용히 빈 문자열을 반환합니다
  (분석 자체를 막을 이유는 아니므로).
*/
async function fetchImageFromServer(pageUrl) {
  if (!OG_IMAGE_SERVER_URL) {
    return "";
  }

  try {
    const endpoint = `${OG_IMAGE_SERVER_URL}?url=${encodeURIComponent(pageUrl)}`;
    const response = await fetch(endpoint, { signal: AbortSignal.timeout(8000) });
    if (!response.ok) {
      return "";
    }
    const data = await response.json();
    return typeof data.image === "string" ? data.image : "";
  } catch (error) {
    return "";
  }
}
