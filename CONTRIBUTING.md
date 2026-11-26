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
