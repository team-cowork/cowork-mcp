# 배포

버전 변경은 릴리스 전용 PR에서 진행합니다.

1. 최신 `main`에서 `chore/release-YYYYMMDD.n` 브랜치를 만듭니다. 같은 날의 첫 배포에는 `n=0`을 사용하고, 이후 배포마다 1씩 올립니다.
2. `.github/release-tag`에 배포 태그를 적습니다. npm 버전은 변경 범위에 맞춰 SemVer로 올립니다. 패치 배포라면 `npm version patch --no-git-tag-version`으로 `package.json`과 `package-lock.json`을 함께 갱신합니다.
3. `release vYYYYMMDD.n: <변경 요약>` 형식으로 PR을 열고, 검사가 통과하면 `main`에 병합합니다.

병합 후 Release 워크플로가 npm 패키지를 게시하고, 병합된 커밋에 GitHub 태그와 릴리스를 생성합니다. 워크플로는 게시 대상과 인증에 각각 `NPM_PACKAGE_NAME` 변수와 `NPM_TOKEN` 시크릿을 사용합니다.

npm 게시 후 GitHub 릴리스 생성에 실패하면 같은 워크플로 실행을 다시 실행합니다. npm에 게시된 패키지가 이번 실행에서 만든 패키지와 같으면 GitHub 릴리스 생성을 이어서 진행합니다.
