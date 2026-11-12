# 무치무치

나쁜 소식 없는 피드. 동물 영상 위주로 계속 이어지고, 뉴스는 제목과 출처만 보여준 뒤 원문으로 연결합니다.

## 구조
- `index.html`: 사이트 전체(정적). `feed.json`을 읽어 무한 스크롤로 보여줍니다.
- `scripts/collect.mjs`: 유튜브 채널 RSS와 구글 뉴스 RSS에서 모아 `feed.json`을 만듭니다.
- `portfolio/`: 포트폴리오 페이지(`/portfolio/`). 이미지는 `portfolio/images/`, 영상은 `portfolio/videos/`에 저장되고 `portfolio/items.json`이 목록입니다. 페이지의 “업로드 / 관리”에서 GitHub 토큰으로 바로 올릴 수 있습니다.
- `sources.json`: 채널, 뉴스 검색어, 제외 단어를 여기서 고칩니다.
- `.github/workflows/collect.yml`: 3시간마다 자동 수집해서 `feed.json`을 커밋합니다.

## 켜는 순서
1. 저장소 Settings → Pages → Source를 `main` / root로 설정합니다.
2. Actions 탭에서 `collect`를 한 번 수동 실행합니다(Run workflow).
3. 도메인을 쓰려면 Settings → Pages → Custom domain에 입력하고, 도메인 업체에서 DNS를 연결합니다.
