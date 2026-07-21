#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

ENDPOINT="http://localhost:4566"
BUCKET="swiipe-test-media"
REGION="ap-northeast-2"

export AWS_ACCESS_KEY_ID=test
export AWS_SECRET_ACCESS_KEY=test
export AWS_DEFAULT_REGION="$REGION"
# LocalStack 3.8 커뮤니티 버전은 최신 AWS CLI의 기본 flexible checksum(멀티파트 업로드,
# 8MB+ 파일)을 지원하지 않아 업로드가 실패한다. 큰 샘플 이미지 업로드를 위해 비활성화.
export AWS_REQUEST_CHECKSUM_CALCULATION=when_required

echo "Creating bucket: $BUCKET"
aws --endpoint-url="$ENDPOINT" s3 mb "s3://$BUCKET" 2>/dev/null || echo "Bucket already exists, continuing."

for f in sample/*.jpg sample/*.jpeg sample/*.png; do
  [ -e "$f" ] || continue
  key="original/$(basename "$f")"
  echo "Uploading $f -> s3://$BUCKET/$key"
  aws --endpoint-url="$ENDPOINT" s3 cp "$f" "s3://$BUCKET/$key"
done

echo "Done. bucket=$BUCKET"
