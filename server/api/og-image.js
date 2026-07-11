const ogs = require("open-graph-scraper");

// 사설/루프백 대역으로 향하는 요청은 막습니다 (사용자가 임의 URL을 넘기는
// 공개 엔드포인트라 SSRF 방지 차원의 최소한의 검증입니다. DNS 리바인딩까지
// 막는 완전한 방어는 아니고, 사설 IP를 문자 그대로 넘기는 뻔한 시도만 차단합니다).
function isBlockedHost(hostname) {
  const lower = hostname.toLowerCase();
  if (lower === "localhost" || lower === "0.0.0.0" || lower === "::1") {
    return true;
  }
  return /^(127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[0-1])\.)/.test(lower);
}

module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");

  const targetUrl = req.query?.url;
  if (typeof targetUrl !== "string" || !targetUrl) {
    res.status(400).json({ error: "url 쿼리 파라미터가 필요합니다." });
    return;
  }

  let parsed;
  try {
    parsed = new URL(targetUrl);
  } catch (error) {
    res.status(400).json({ error: "유효하지 않은 URL입니다." });
    return;
  }

  if (!["http:", "https:"].includes(parsed.protocol) || isBlockedHost(parsed.hostname)) {
    res.status(400).json({ error: "허용되지 않는 URL입니다." });
    return;
  }

  try {
    const { result } = await ogs({ url: parsed.toString(), timeout: 8 });
    const firstImage = (result.ogImage || []).map((image) => image.url).filter(Boolean)[0] || null;
    res.status(200).json({ image: firstImage });
  } catch (error) {
    // 원본 페이지를 못 가져왔거나 이미지가 없는 경우 모두 image: null로 응답
    // — 호출하는 쪽(확장 프로그램)이 조용히 플레이스홀더로 넘어갈 수 있게 합니다.
    res.status(200).json({ image: null });
  }
};
