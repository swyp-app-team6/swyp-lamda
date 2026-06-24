# SWYP-Lamda
## thumbnail Lambda

프로필 이미지 업로드 시 썸네일을 자동 생성하는 Lambda 함수입니다.  
`functions/thumbnail/` 에 위치합니다.

---

### 플로우

```
S3 original/{userId}-{uuid}.jpg 업로드
  → S3 이벤트 트리거 (PUT, prefix: original/)
    → 경로 검증 (original/ 아니면 조기 종료)
    → 확장자 검증 (jpg/jpeg/png/webp 아니면 조기 종료)
    → S3에서 원본 이미지 다운로드
    → sharp로 리사이즈 (400px) + JPEG 변환 (quality 85)
    → S3 thumbnail/{userId}-{uuid}.jpg 저장
    → 실패 시:
        영구 에러 (NoSuchKey, UnsupportedImageFormat) → 조기 종료
        일시 에러 (네트워크 등) → throw → Lambda 재시도 (최대 2회) → DLQ
```

---

### 설계 시 고려한 지점

**무한루프 방지**  
S3 트리거 prefix를 `original/`로 제한해 `thumbnail/` 저장 이벤트가 Lambda를 재트리거하지 않도록 했습니다. 코드 레벨에서도 `original/` 경로 체크를 추가해 이중으로 방어합니다.

**에러 분류**  
재시도해도 의미없는 영구 에러(잘못된 파일 경로, 지원하지 않는 포맷)는 `return`으로 조기 종료해 불필요한 재시도와 DLQ 적재를 방지합니다. 일시적 에러(네트워크, S3 일시 장애)만 `throw`로 재시도를 유도합니다.

**확장자 통일**  
입력 포맷(jpg/png/webp)에 관계없이 썸네일은 항상 `.jpg`로 저장합니다. sharp가 JPEG로 변환하기 때문에 파일명 확장자와 실제 Content-Type 불일치를 방지합니다.

**포맷 선택 (JPEG)**  
썸네일은 실사 사진 위주라 PNG 대비 용량이 5~10배 작은 JPEG를 채택했습니다. WebP는 추가 압축 효율이 있으나 React Native iOS 환경에서 버전별 호환성 이슈가 있어 클라이언트 지원 확인 후 전환을 고려합니다.

**이벤트 유실 방지 (DLQ)**  
Lambda 재시도 2회 후에도 실패한 이벤트는 SQS DLQ에 보관합니다. 이벤트가 유실되지 않아 원인 파악 및 재처리가 가능합니다.

**스트리밍 최적화** 
S3 Body → sharp 파이프 → `@aws-sdk/lib-storage` Upload 방식으로 전환했습니다. 전체 Buffer 적재 없이 청크 단위로 처리해 메모리 사용량을 줄였습니다.

---

### 향후 개선 방향

- **Spring Boot 완료 알림 연동** — 썸네일 생성 완료를 Spring Boot가 인지하는 구조가 없습니다. Lambda 완료 후 SNS/SQS 이벤트 발행으로 DB에 썸네일 URL을 저장하는 구조가 필요합니다.
- **다중 사이즈 썸네일** — 피드 리스트용(400px), 프로필 아이콘용(100px) 등 용도별 사이즈 분리를 고려합니다.
- **WebP 전환** — 클라이언트 WebP 지원 확인 후 JPEG → WebP 전환 시 동일 품질 대비 약 30% 추가 압축이 가능합니다.
