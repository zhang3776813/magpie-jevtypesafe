# 贡献说明

## 范围

本插件只做一件事：把 JEV 的 `POST /api/v1/decide` 接成 Magpie 的原生决策供应商。

明确不在范围内：

- 把 JEV 包装成聊天或代码生成模型；
- 图片 `assets`、`box` 问题、`/v1/batch/decide`、`/v1/gate`；
- 余额查询、价格或免费额度的推测；
- 任何本地代理、后台服务或定时探测。

## 开发流程

```powershell
npm run check        # 语法检查
npm test             # 42 项离线测试
npm run test:coverage
```

要求：

1. 先写测试再改实现；新增分支必须被测试覆盖。
2. 生产入口 `index.mjs` 的行、分支、函数覆盖率保持 100%。
3. 不引入运行时依赖。
4. 不把任何真实密钥写进源码、测试、文档或提交信息。测试用 `jv_live_` 开头的假密钥即可。
5. 涉及真实上游的验证必须走 `npm run verify:magpie -- --live`，并说明本次消耗。

## 提交信息

遵循 Conventional Commits，摘要用中文，不超过 72 字：

```text
fix(loader): 保留上游 429 的重试头
```

一次提交只做一件事。不要在提交信息里添加 AI 署名。

## 文档语言

**默认中文。** `README.md` 是中文，`README.zh-CN.md` 是同一份内容的中文别名，`README.en.md` 是英文版。

`README.md` 和 `README.zh-CN.md` 必须逐字节相同。改中文说明时**两个文件都要改**，用 `git diff --no-index README.md README.zh-CN.md` 确认没有差异。

为什么要两份相同的中文文件：Magpie 的 `ReadmeIn` 在中文界面下会优先找 `README.zh-CN.md`，找不到才回退到 `README.md`。只保留 `README.md` 也能显示中文，但两份能保证任何语言标签下都命中中文。英文用户则通过 `README.en.md` 获取英文说明。

英文说明改动时，注意三份文档内容是否仍一致。
