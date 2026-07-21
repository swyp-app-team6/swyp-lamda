# Thumbnail Lambda 로컬 메모리 벤치마크

`functions/thumbnail/index.js`(스트림 tee 방식)와, 원본 전체를 Buffer로 적재하는
대조군 방식들(순차 처리 / 리팩터링 이전 실제 운영 코드 재현)을 LocalStack +
Lambda RIE(Runtime Interface Emulator) 환경에서 peak RSS / heap 사용량 관점으로
비교하기 위한 로컬 검증 도구. 분석 배경과 결론은 [ANALYSIS.md](ANALYSIS.md) 참고.

운영 Lambda나 실제 S3 버킷(`swiipe-prod-media` 등)에는 전혀 접근하지 않는다.
S3처럼 보이는 모든 호출은 이 PC 안에서만 도는 LocalStack 컨테이너
(`localhost:4566`)를 향하고, 자격증명도 더미 값(`test`/`test`)만 사용한다.

## 왜 이런 구조가 필요한가

비교하려는 건 "Sharp 리사이즈 로직" 자체가 아니라, **원본 이미지를 어떻게 메모리에
들고 있느냐(스트림 tee vs 전체 Buffer)** 에 따른 메모리 사용 패턴 차이다. 이 차이를
의미 있게 재현하려면 아래 조건이 맞아야 해서 단순히 `node index.js`로 함수만 호출하는
것보다 이 정도 구성이 필요했다.

1. **S3 GetObject 호출까지 실제로 실행해야 한다.**
   tee 방식의 메모리 이점은 "S3에서 청크가 도착하는 속도에 맞춰 스트림으로 흘려보낸다"는
   전제에서 나온다. 로컬 디스크 파일을 바로 읽으면 OS 페이지 캐시 때문에 사실상
   즉시(버퍼링된 것처럼) 읽혀서 이 차이가 재현되지 않는다. `GetObjectCommand`가 반환하는
   `Body`가 실제 네트워크 스트림처럼 동작해야 tee 분기와 버퍼 적재의 메모리 프로파일이
   갈린다. → 그래서 진짜 S3 대신 **LocalStack**(로컬 목업 S3, 네트워크 스택은 실제로 탐)을
   붙였다.

2. **런타임 프로세스가 실제 Lambda와 최대한 비슷해야 한다.**
   `sharp`는 `libvips` 네이티브 바이너리를 사용하는데, 이건 OS/아키텍처에 따라 별도로
   설치된다. 개발 PC(Windows)에서 바로 실행하면 실제 Lambda(Amazon Linux, arm64/x64)와
   네이티브 바이너리 자체가 다르고, Node 런타임 오버헤드도 다르다. → 그래서 실제 Lambda가
   쓰는 것과 동일한 공식 베이스 이미지(`public.ecr.aws/lambda/nodejs:24`)로 빌드하고,
   그 이미지에 내장된 **Lambda RIE**로 로컬에서 실행했다. Docker 컨테이너 하나가 곧 하나의
   Lambda 실행 환경 프로세스라는 전제가 있어야 "peak RSS"가 의미를 가진다.

3. **측정은 컨테이너 단위가 아니라 핸들러 실행 구간 단위여야 한다.**
   `docker stats`는 컨테이너 전체(RIE 에뮬레이터 자체의 상주 메모리 포함)를 보여주므로
   핸들러 로직 차이를 가리기 쉽다. → `src/memProfiler.js`가 핸들러 실행 동안만
   `process.memoryUsage()`를 50ms 간격으로 폴링해서 그 구간의 peak RSS/heapUsed만
   `METRICS` 로그로 남긴다.

즉 "S3 업로드 결과"가 목적이 아니라, 그 호출을 통해서만 재현되는 스트리밍 백프레셔
조건 아래에서 실제 Lambda 런타임에 가까운 프로세스를 실행시켜 메모리를 재는 것이 목적이다.

## 구성

- `docker-compose.yml`: LocalStack(S3) + `lambda-stream`(9000) + `lambda-buffer`(9001) +
  `lambda-buffer-concurrent`(9002)
- `src/stream.js`: 운영 코드와 동일한 PassThrough tee 스트리밍 방식 (동시 처리)
- `src/buffer.js`: 대조군 1 — 원본 전체를 Buffer로 적재 후 variant 순차 처리
- `src/buffer-concurrent.js`: 대조군 2 — 리팩터링 이전 실제 운영 코드 재현
  (원본 전체를 Buffer로 적재 + `clone()`/`Promise.all`로 variant 동시 처리)
- `src/memProfiler.js`: 핸들러 실행 구간의 peak RSS/heapUsed를 50ms 간격으로 폴링해
  `METRICS {...}` 로그로 남기는 유틸
- `scripts/setup-bucket.sh`: LocalStack에 버킷 생성 + `sample/` 내 이미지 전체 업로드
- `scripts/invoke.sh [stream|buffer|buffer-concurrent] [s3-key]`: RIE 엔드포인트로 S3
  이벤트를 보내 Lambda 호출 + `docker stats`/METRICS 로그 캡처
- `sample/`: 테스트용 이미지
  - `sample.jpg` (3.2MB): 동작 검증용 스모크 테스트 크기
  - `large.jpg` (15.2MB): 실제 비교용 대용량 원본

## 사용법

```bash
# 1. 빌드 및 기동
docker compose up -d --build

# 2. 버킷 생성 + 샘플 이미지 업로드
./scripts/setup-bucket.sh

# 3. 각각 호출
./scripts/invoke.sh stream
./scripts/invoke.sh buffer
./scripts/invoke.sh buffer-concurrent

# 종료
docker compose down
```

## 측정 결과 요약

콜드 상태(컨테이너 재시작 후 1회 호출) 기준, large.jpg(15.2MB) 2회 반복:

| 방식 | peakRssMB | durationMs |
| --- | --- | --- |
| stream (tee, 동시) | 528 / 527.2 | 553.42 / 544.80 |
| buffer 순차 | 514.46 / 515.45 | 989.39 / 1036.69 |
| buffer 동시 (구 운영 코드 재현) | 563.66 / 561.54 | 738.94 / 621.67 |

`buffer`(순차 처리)만 새로 짠 대조군이고, `buffer-concurrent`가 리팩터링 이전 실제
운영 코드를 재현한 것이다 — **진짜 비교 대상은 `stream` vs `buffer-concurrent`이며,
이 기준으로는 stream이 메모리·속도 모두 우위**다. `buffer`(순차)가 메모리는 제일 낮지만
그 이유는 "버퍼링"이 아니라 "동시성 없음"이었다. variant 개수가 왜 이 결과에
영향을 주는지, 왜 처음 2-way 비교가 오해를 낳았는지는 [ANALYSIS.md](ANALYSIS.md)에
상세히 정리했다.

## 트러블슈팅 노트

- **`localstack/localstack:latest`가 라이선스 오류(exit 55)로 죽는 문제**: 최신 `latest`
  태그(2026.6.3 확인)는 `LOCALSTACK_AUTH_TOKEN` 없이 부팅 자체가 안 되도록 바뀌어 있었다.
  S3 같은 커뮤니티 기능만 쓰면 되므로 라이선스 체크가 없는 `3.8`(3.8.1, 커뮤니티 전용
  최신 확인 버전)로 고정했다.
- **Lambda 핸들러 문자열에 점(`.`)을 두 번 이상 쓰면 안 됨**: AWS Lambda Node 런타임의
  핸들러 파서(`/^([^.]*)\.(.*)$/`)는 **첫 번째 점까지만** 모듈명으로 인식한다.
  `index.stream.handler`처럼 파일명 자체에 점이 들어가면 모듈명이 `index`로 잘못
  잘려서 `Cannot find module 'index'` 에러가 난다. 그래서 파일명을 `stream.js`,
  `buffer.js`로(점 없이) 지었다.
- `AWS_LAMBDA_FUNCTION_MEMORY_SIZE` 같은 실제 Lambda 메모리 제한은 로컬 RIE
  컨테이너에 적용되지 않는다. 여기서 측정하는 건 컨테이너 제한이 아니라
  프로세스 실측치(peak RSS/heap)이므로, 절대값보다 두 방식 간 상대 비교에
  의미가 있다.
- `docker stats`는 컨테이너 전체(Node 런타임 + RIE 에뮬레이터 상주 비용 포함) 기준이라
  `METRICS` 로그의 프로세스 실측치보다 일반적으로 더 크게 나온다.
- 같은 컨테이너에 반복 호출(웜 상태)하면 Node/libvips가 내부 캐시를 유지해서 RSS가
  호출마다 누적되어 커지는 경향이 있다. 이건 스트림/버퍼 방식의 차이가 아니라 웜
  컨테이너의 일반적인 특성이므로, 방식 간 비교는 **컨테이너를 재시작한 콜드 상태 +
  단일 호출** 기준으로 하는 게 정확하다 (`docker restart <container>` 후 1회 호출).
- **큰 파일(8MB+) 업로드 시 `aws s3 cp`가 `Checksum algorithm provided is unsupported`로
  실패하는 문제**: 최신 AWS CLI(2.34+)는 멀티파트 업로드에 기본으로 flexible checksum을
  붙이는데, LocalStack 3.8 커뮤니티 버전은 이걸 못 받는다.
  `AWS_REQUEST_CHECKSUM_CALCULATION=when_required` 환경변수로 우회했다
  (`setup-bucket.sh`에는 3.2MB 샘플만 있어 반영 안 해도 되지만, 큰 파일을 직접
  업로드할 땐 이 환경변수를 export하고 실행할 것).
