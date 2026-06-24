const { handler } = require("../index");

const mockEvent = {
  Records: [
    {
      s3: {
        bucket: { name: "swiipe-prod-media" },
        object: {
          key: "original/test.jpg", // S3에 실제 존재하는 key로 변경
          size: 102400,
        },
      },
    },
  ],
};

handler(mockEvent)
  .then(() => console.log("완료"))
  .catch((err) => console.error("실패:", err));
