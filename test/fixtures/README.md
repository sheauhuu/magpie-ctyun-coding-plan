# SSE 回归样本

来自 2026-10-31 对天翼云 Coding Plan 的已授权实测响应体，仅包含固定测试提示产生的模型输出；不含请求头、API Key、登录 Cookie 或账号密码。本目录重放不连接天翼云。公开样本中的响应 ID、工具调用 ID 和错误请求 ID 已替换为明确的测试值，created 时间戳已固定为测试时间；正文、推理、工具参数、用量和结束原因保留原有测试输出。

| 文件 | 原始样本 | 用途 |
| --- | --- | --- |
| glm-text.sse | 01-oai-glm-stream-default.raw | 首帧空 ID、文本、推理、usage |
| deepseek-tool.sse | 14-oai-deep-tool-stream.raw | 首帧空 ID、工具参数分片中空 type/id |
| deepseek-length.sse | 18-oai-deep-low-output-stream.raw | 正常 length 截断和 usage |
| deepseek-error.sse | 25-oai-deep-effort-invalid_probe_value.raw | HTTP 200 中的 SSE 上游错误 |

样本中的工具参数 `key` 是固定测试输入，与 API Key 无关。

`npm test` 验证流解析与全部有效数据保留；`scripts/sdk-replay.py` 通过插件的实际 fetch 包装器和 OpenAI Python SDK 聚合流，使用 MockTransport，网络请求数为零。
