# SWYP-Lamda
## thumbnail Lambda

프로필 이미지 업로드 시 썸네일을 자동 생성하는 Lambda 함수입니다.  
`functions/thumbnail/`, `functions/main/` 에 위치합니다.

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
