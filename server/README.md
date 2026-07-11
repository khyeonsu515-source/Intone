# intone-og-image-server

기사 URL을 받아 [`open-graph-scraper`](https://github.com/jshemas/openGraphScraper)로
대표 이미지(og:image, 없으면 페이지의 첫 유효 이미지)를 찾아 돌려주는 서버리스 함수입니다.

## 왜 별도 서버가 필요한가

`open-graph-scraper`는 내부적으로 `undici`(Node 전용 HTTP 클라이언트, `node:net`/`node:http` 등을
직접 사용)와 `Buffer`에 의존합니다. 둘 다 브라우저·Chrome 확장 서비스워커에는 존재하지 않는 API라
esbuild 같은 번들러로도 해결할 수 없습니다(실제로 시도해보면 100개 이상의 미해결 모듈 에러가 납니다).
그래서 이 라이브러리는 진짜 Node.js 런타임이 있는 곳에서만 돌릴 수 있고, Intone 확장은 이 서버를
호출만 하는 구조로 분리했습니다.

## 배포 (Vercel)

Vercel Serverless Function은 실제 Node.js(AWS Lambda) 런타임에서 실행되므로 별도 설정 없이
`open-graph-scraper`가 그대로 동작합니다.

```bash
cd server
npm install -g vercel   # 처음 한 번만
vercel login            # 처음 한 번만 — 브라우저로 Vercel 계정 로그인
vercel --prod
```

배포가 끝나면 `https://<프로젝트명>.vercel.app` 형태의 URL이 출력됩니다.
이 URL을 `background-image-server.js`의 `OG_IMAGE_SERVER_URL` 상수에 넣어주세요.

## API

```
GET /api/og-image?url=<기사 URL>

200 { "image": "https://..." }   // 찾은 경우
200 { "image": null }            // 이미지가 없거나 원본 페이지를 가져오지 못한 경우
400 { "error": "..." }           // url 파라미터가 없거나 형식이 잘못된 경우
```

사설/루프백 IP(예: `127.0.0.1`, `192.168.x.x`, 클라우드 메타데이터 IP `169.254.169.254`)로
향하는 요청은 SSRF 방지를 위해 400으로 거부합니다. DNS 리바인딩까지 막는 완전한 방어는 아니며,
문자 그대로 사설 IP를 넘기는 뻔한 시도만 차단하는 최소한의 검증입니다.

## 로컬 확인

```bash
cd server
npm install
node -e "require('./api/og-image.js')({query:{url:'https://example.com'}}, {setHeader(){}, status(c){this.s=c;return this;}, json(o){console.log(this.s,o);}})"
```
