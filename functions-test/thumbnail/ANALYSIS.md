# 스트림 tee vs 버퍼: 메모리 분석 (variant 개수라는 숨은 변수)

## 1. 원래 설계 의도

[functions/thumbnail/index.js](../../functions/thumbnail/index.js)는 커밋 `0e57b6e`(`refactor: 버퍼 방식 ->
스트림 tee 방식으로 전환`)에서 버퍼 방식을 스트림 tee 방식으로 바꿨다. 커밋 메시지가
이유를 명확히 밝히고 있다.

> PassThrough 스트림으로 원본을 tee, 원본 전체를 메모리에
> 올리지 않고 청크 단위로 두 variant 동시 생성

즉 설계 가설은 단순했다: **"원본 전체를 Buffer로 들고 있지 않으면, 그만큼 메모리를
아낀다."** 이 가설은 직관적으로 타당해 보이고, variant가 1개뿐이라면 실제로 맞다 —
스트림은 원본을 흘려보내기만 하고, 버퍼는 원본 전체(파일 크기만큼)를 추가로 들고 있으니까.

## 2. 실측에서 드러난 모순

이 벤치마크 프로젝트(`functions-test/thumbnail`)로 스트림 vs 버퍼(순차 처리) 2-way
비교를 해보니, 정반대 결과가 나왔다.

| 방식 | large.jpg(15.2MB) peakRssMB | durationMs |
| --- | --- | --- |
| stream (tee, 동시) | ~527~528 | ~545~553 |
| buffer (순차) | ~514~515 | ~989~1037 |

**stream이 buffer보다 메모리를 더 쓴다.** "원본을 안 들고 있으면 항상 이긴다"는
가설과 어긋난다. 원인을 파고들어보니, 애초에 비교 자체가 공정하지 않았다.

## 3. 숨어있던 두 번째 변수: 동시성

`src/buffer.js`(순차 처리, `for` 루프)는 내가 대조군으로 새로 짠 코드였고,
**리팩터링 전 실제 운영 코드와 다른 처리 방식**이었다. `git show 0e57b6e`로 이전 코드를
보면:

```js
// 리팩터링 이전 실제 운영 코드 (buffer, 요약)
const originalBuffer = await streamToBuffer(s3Object.Body);
const baseImage = sharp(originalBuffer);

await Promise.all(
  VARIANTS.map(async (variant) => {
    const pipeline = baseImage.clone().resize(...).webp(...);
    const outputBuffer = await pipeline.toBuffer();
    await new Upload({ ... Body: outputBuffer }).done();
  })
);
```

리팩터링 전 버퍼 방식도 `Promise.all` + `sharp().clone()`으로 variant 2개를 **동시에**
처리하고 있었다. 즉 버퍼 → 스트림 전환은 "원본을 버퍼로 들고 있느냐"뿐 아니라
"variant를 순차로 도느냐 동시에 도느냐"까지 같이 안 건드린 게 아니라 원래도 동시였다 —
**내가 처음 만든 `buffer.js` 대조군만 순차 처리였던 것**. 그래서 최초 2-way 비교는

- 버퍼링 여부 (전체 보관 vs tee)
- 동시성 여부 (내 대조군만 순차, 나머지 둘은 동시)

두 변수를 한 번에 바꿔버린 비교였고, 어느 쪽 효과인지 분리가 안 되는 상태였다.

## 4. 변수 분리: 세 번째 대조군 추가

실제 이전 운영 코드를 그대로 재현한 `src/buffer-concurrent.js`
(전체 Buffer 보관 + `clone()` + `Promise.all` 동시 처리)를 추가해서, 2×2 중 3칸을
채웠다 (stream을 순차로 도는 조합은 자연스럽지 않아 제외).

|  | 순차 처리 | 동시 처리 (`Promise.all`) |
| --- | --- | --- |
| **전체 Buffer 보관** | `buffer.js` (내가 만든 대조군) | `buffer-concurrent.js` (실제 이전 운영 코드 재현) |
| **스트림 tee (원본 미보관)** | — (해당 없음) | `stream.js` (현재 운영 코드) |

### 측정 결과 (콜드 상태, 컨테이너 재시작 후 1회, large.jpg 15.2MB 기준 2회 반복)

| 방식 | peakRssMB (run1 / run2) | durationMs (run1 / run2) |
| --- | --- | --- |
| stream (tee, 동시) | 528 / 527.2 | 553.42 / 544.80 |
| buffer 순차 | 514.46 / 515.45 | 989.39 / 1036.69 |
| buffer 동시 (실제 구 운영 코드) | 563.66 / 561.54 | 738.94 / 621.67 |

### sample.jpg (3.2MB, 스모크 테스트) 참고치

| 방식 | peakRssMB | durationMs |
| --- | --- | --- |
| stream (tee, 동시) | 113.72 / 114.09 | 129.85 / 143.16 |
| buffer 순차 | 108.68 / 108.69 | 175.61 / 192.79 |
| buffer 동시 | 119.98 | 174.75 |

## 5. 해석

두 사이즈 모두에서 같은 순서가 재현된다.

- **메모리(peak RSS) 순위**: `buffer 순차` < `stream` < `buffer 동시`
- **속도(duration) 순위**: `stream` < `buffer 동시` < `buffer 순차`

여기서 읽어낼 수 있는 건, **메모리를 실제로 지배하는 변수는 "버퍼링 여부"가 아니라
"동시에 활성화된 디코딩 파이프라인 개수"** 라는 것이다.

- `sharp`가 이미지를 처리하려면 압축 파일을 픽셀 버퍼로 디코딩해야 하는데, 이 픽셀
  버퍼는 파일 크기가 아니라 **해상도**에 비례해서 훨씬 크다. variant마다 별도
  파이프라인이 동시에 돌면, 그만큼 디코딩된 픽셀 버퍼도 동시에 여러 개 떠 있게 된다.
- `stream`과 `buffer 동시` 둘 다 variant 2개를 동시에 처리하므로 이 "동시 디코딩
  비용"을 똑같이 지고 있다. 그 위에 `buffer 동시`는 원본 전체(15.2MB)까지 추가로
  들고 있어서 `stream`보다 peak가 더 높다 — **원본을 버퍼로 들고 있는 비용(+30~35MB
  수준)은 실재하지만, 동시성 비용에 비하면 부가적인 크기**다.
- `buffer 순차`는 원본을 들고 있는데도 오히려 가장 메모리가 낮다. 동시에 활성화된
  디코딩 파이프라인이 항상 1개뿐이기 때문이다. 대신 병렬성이 없어서 처리 시간은
  가장 길다(약 2배).

### 속도는 다른 축의 변수다: "동시 처리"가 아니라 "다운로드-처리 겹침"

메모리 순위와 달리 속도 순위는 `stream`이 가장 빠르고 `buffer 동시`가 중간이다
(`stream` 545~553ms < `buffer 동시` 622~739ms < `buffer 순차` 989~1037ms). `stream`과
`buffer 동시` 둘 다 "variant 2개를 동시 처리"한다는 점은 같은데도 속도 차이가 나는 건,
"동시성"이 가리키는 범위가 서로 다르기 때문이다.

- `buffer-concurrent.js`는 `await streamToBuffer(s3Object.Body)`로 **원본을 끝까지
  전부 받아 Buffer로 완성한 뒤에야** `sharp(originalBuffer)`로 처리를 시작한다.
  즉 "다운로드 완료 대기 → variant 2개 동시 처리"가 **직렬로 이어지는 두 단계**다.
- `stream.js`는 S3 청크가 도착하는 즉시 PassThrough로 두 Sharp 파이프라인에
  흘려보내면서 동시에 처리를 시작하고, 결과가 나오는 대로 `Upload`로 즉시
  업로드한다. 다운로드 시간과 처리 시간이 **겹쳐서(pipelined)** 진행된다.

그래서 `buffer 동시`의 총 소요시간은 대략 `다운로드 시간 + 처리 시간`(직렬)에
가깝고, `stream`은 `max(다운로드 시간, 처리 시간)`에 가까워 더 짧게 나온다.
정리하면 이번 측정에서 드러난 두 가지는 서로 다른 축의 변수다:

| 축 | 지배 변수 | 영향받는 지표 |
| --- | --- | --- |
| variant를 동시에 몇 개 디코딩하는가 | `stream`/`buffer 동시` vs `buffer 순차` | peak RSS |
| 다운로드와 처리가 겹치는가(파이프라이닝) | `stream` vs `buffer 동시`/`buffer 순차` | durationMs |

즉 애초에 "버퍼링 vs 스트리밍"이 메모리 경쟁의 본질이 아니라, **"몇 개의 variant를
동시에 디코딩·인코딩하느냐"**가 진짜 변수였고, 이게 variant 개수(현재 2개: thumbnail,
main)와 직결된다. variant가 1개였다면 동시성 비용 자체가 없으므로 스트림이 버퍼보다
메모리에서 순수하게 이겼을 것이다 — 원래 설계 가설이 맞았을 상황. variant가 2개가 되며
"동시 디코딩"이라는 새 비용이 생겼고, 이게 "원본 미보관"의 이득을 상당 부분 상쇄한다.

## 6. variant가 더 늘어난다면?

지금 구조(모든 variant를 항상 동시에 처리)를 유지한 채 variant가 3개, 4개로 늘어나면:

- `stream`과 `buffer 동시` 모두 동시 디코딩 파이프라인 수가 그만큼 늘어나서 peak RSS가
  선형적으로 더 증가할 가능성이 높다. 다만 `stream`은 원본 보관 비용이 없으므로 격차
  자체는 (동시 파이프라인 수와 무관하게) `buffer 동시` 대비 대략 원본 크기만큼
  일정하게 유지될 것으로 예상된다 — 즉 variant가 늘어나도 stream이 buffer-concurrent
  보다 나쁠 이유는 없다. (`stream` vs `buffer 순차` 비교만 뒤집힌다.)
- `buffer 순차`는 여전히 동시 파이프라인이 1개뿐이라 peak RSS는 variant 개수와 거의
  무관하게 유지되겠지만, 처리 시간은 variant 개수에 비례해서 계속 늘어난다.

## 7. 결론

- 리팩터링(버퍼 → 스트림)의 원래 동기였던 "원본을 안 들고 있으면 메모리를 아낀다"는
  가설은 **variant가 1개일 때만 순수하게 성립**한다. variant가 2개 이상으로 늘면서
  "동시 처리로 인한 디코딩 파이프라인 중복"이라는 새 비용이 끼어들어, 실측 peak RSS는
  오히려 `stream`이 `buffer 순차`보다 높게 나온다.
- 다만 **진짜 비교 대상(실제 이전 운영 코드, `buffer 동시`)** 기준으로 보면 `stream`이
  메모리·속도 둘 다 우위다 (562MB/622~739ms vs 528MB/545~553ms). 즉 **리팩터링 자체는
  틀리지 않았다** — 이전 코드 대비 메모리도, 속도도 개선됐다.
- 다만 "왜 개선됐는가"에 대한 실제 이유는 원래 알려진 가설("원본 미보관")이 아니라,
  이번 측정으로 새로 드러난 사실에 더 가깝다: **원본을 버퍼로 들고 있는 비용을 없앤
  효과(수십 MB) + 스트리밍 파이프라이닝으로 인한 지연시간 감소**의 조합이지,
  "동시 처리 자체의 메모리 비용"은 여전히 stream에도 그대로 남아있다.
- 앞으로 variant 수를 늘릴 계획이 있다면, `stream` 방식이라도 동시 디코딩 파이프라인
  수가 늘어나는 만큼 peak RSS가 계속 올라갈 것이라는 점을 감안해야 한다. 메모리가
  타이트한 상황(Lambda 메모리 설정을 낮게 유지하고 싶은 경우)이라면 variant를 일정
  개수씩 나눠서(batch) 동시 처리 수를 제한하는 방식을 고려할 수 있다.

## 8. 실제 배포 권장사항

지금 variant 2개 조건에서는 **현재 운영 중인 stream 방식을 그대로 유지하는 게 맞다.**
근거는 peak RSS 최소화가 아니라 AWS Lambda의 과금/실행 구조에 있다.

- Lambda는 `설정한 메모리 × 실행시간(GB-s)`으로 과금되고, 메모리 설정에 비례해서
  CPU도 같이 배정된다(메모리를 낮추면 CPU도 줄어 sharp 같은 CPU-bound 작업이 더
  느려짐). `buffer 순차`는 peak RSS는 가장 낮지만 실행시간이 거의 2배라, 메모리를
  약간 아끼자고 과금(GB-s)과 사용자 체감 지연을 모두 손해 보는 트레이드오프다.
  이번 측정 크기대(15.2MB)에서는 안 맞는 선택.
- `stream`은 진짜 비교 대상인 `buffer 동시`(구 운영 코드) 대비 메모리·속도 둘 다
  우위이고, `buffer 순차` 대비로도 메모리 차이(+13MB 수준)보다 속도 차이(-2배)가
  훨씬 크다. 세 방식 중 실질 비용(GB-s)이 가장 낮은 선택지다.
- 즉 목표는 "peak RSS를 최소화"가 아니라 **"OOM이 안 나는 선에서 duration을
  최소화"** 여야 한다.

### 실무 체크리스트

1. **Lambda 메모리 설정에 여유를 둘 것.** 이번 15.2MB 샘플 기준 peak가 ~528MB인데,
   실제 원본은 더 크거나 고해상도일 수 있으므로 운영 트래픽의 실제 최대 크기
   이미지로 재측정한 뒤 128~256MB 정도 마진을 두고 설정(예: 768MB~1GB 대). 너무
   타이트하게 잡으면 OOM 위험이 커지고 CPU 배정도 줄어 역효과가 난다.
2. **CloudWatch `Max Memory Used` 지표를 모니터링**해서 실제 운영 트래픽에서의
   peak를 계속 검증할 것.
3. **variant 개수를 늘릴 계획이 있다면 재검토가 필요하다.** `stream`의 동시 디코딩
   비용은 variant 수에 비례해서 커지므로(6장 참고), 그때는 `p-limit` 같은 걸로
   동시 처리 개수를 2~3개로 제한하는 하이브리드(파이프라이닝은 유지하되 동시성만
   캡)를 고려하는 게 좋다.

## 부록: 재현 방법

```bash
cd functions-test/thumbnail
docker compose up -d --build
./scripts/setup-bucket.sh   # sample/*.jpg 전부 업로드
docker restart thumbnail-bench-lambda-stream-1 && \
  ./scripts/invoke.sh stream original/large.jpg
docker restart thumbnail-bench-lambda-buffer-1 && \
  ./scripts/invoke.sh buffer original/large.jpg
docker restart thumbnail-bench-lambda-buffer-concurrent-1 && \
  ./scripts/invoke.sh buffer-concurrent original/large.jpg
```

컨테이너를 재시작하지 않고 반복 호출하면 Node/libvips의 웜 캐시 때문에 RSS가 호출마다
누적되므로, 방식 간 비교는 항상 콜드 재시작 + 단일 호출 기준으로 해야 한다
(자세한 내용은 [README.md](README.md)의 트러블슈팅 노트 참고).
