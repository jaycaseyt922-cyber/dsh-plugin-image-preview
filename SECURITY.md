# Security

这是一个本地工具，不是网络服务；威胁模型按此假设写。

## 报告

请用 GitHub 的**私密**漏洞报告（仓库页 Security → Report a vulnerability），不要开公开 issue。

## 攻击面

- 插件只在宿主的 webServer 上注册 `/image-preview/*` 路由，**不开新端口**、不对外监听。
- 所有能读到文件的接口（`/read`、`/file`、`/blob`）都先过 `connection.requestRejection`（Host/Origin + 会话凭证）。拿不到这个服务时**失败关闭**：503，宁可不可用也不裸奔。
- `/diag` 不带凭证时只回存活与各面挂载状态，不回任何路径；带凭证才回 `recent` 与路径探测结果。`/client-report` 是写请求，未授权直接 401。
- 路径来自会话文本，所以任意"扩展名是图片"的本地文件都可能被读：这是功能（预览本地图），边界靠"只有本机会话能调"。
- 返回的头带 `x-content-type-options: nosniff`，且只回 PNG/JPEG/WebP/GIF/BMP/AVIF（按文件头判定），不会把别的内容当图片喂给页面。

## 探针（`tools/`，不入发布包）

- 它会复制真实 profile 的 `.credentials.yaml` 到 `%TEMP%\dsh-probe-imgprev`，所以 `-Stop` 与自停**默认整目录删除**；这是硬要求，不是洁癖。
- 探针是"配置级隔离"，不是安全边界：它继承本进程环境、可读写你的整个用户目录。
