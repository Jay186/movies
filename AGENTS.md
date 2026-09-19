# AGENTS.md — 分镜项目 AI 行为规范
> 约束 WorkBuddy（二宝）在本项目的行为。涉及写代码/建文件/动数据/起服务/改配置时先读并遵守；纯问答不读。任务中可用 `@AGENTS.md` 强化。

## 1. 文档纪律
- 未经布哥明确要求，禁止创建任何 `.md`/README/随手记/说明/总结。需产出文档先确认标题、路径、格式。本文件除外。

## 2. 产物落盘
- 生成过程文件一律进 `generated/`，不散落根目录或 `src/`、`server/`、`public/`。
- 子目录约定：`generated/images/`（生成的图片/素材）、`generated/videos/`（生成的视频）；其他过程产物（分镜草稿、报告、临时 JSON 等）可在 `generated/` 内自建子目录，项目根保持干净。

## 3. 源码保护
- 不动工程文件，除非任务明确要求改代码/配置；改前先讲清改什么、为什么。

## 4. 数据与安全红线（绝不越界）
- 生产库 `*.db`/`*.db-wal`/`*.db-shm`：不读不改不删不迁移，不执行任何写 SQL（DELETE/DROP/UPDATE/INSERT），除非布哥明确要求并确认范围。
- 密钥 `server/.env` 及含 key 的配置：只取必要值，不打印/回显/提交/入日志；回复不出密钥原文。
- `uploads/`、`_backup*/`、`_snapshots/`、`_video_trash/`：不删不改不移动；清理类操作先列清单确认。

## 5. 依赖、构建、服务
- 装/升依赖、改 `package.json`/锁文件前先告知。
- 本地开发：`npm run dev`（前端 5173）+ `npm run start`（后端 node 3000）；Vite 已代理 `/api`、`/uploads`→3000，`/rh-api`→runninghub.cn，整链不走 `dist/`，**不打包**。
- `npm run build` 仅部署用且须经布哥同意，默认不跑；耗时命令放后台。
- 不随意 kill/重启/改端口/绑 `0.0.0.0`；禁用 `rm -rf`、递归删、`git reset --hard`、`git clean -f` 等不可逆操作。

## 6. 代码通用性
- 端口/主机/API 地址/超时/分页/状态码等走 env 或配置（`server/.env`、`import.meta.env`、`process.env`），不裸写字面量。
- 环境差异走 env，不写 `if(localhost)` 式硬编码分支。
- 重复逻辑抽函数/组件/工具，禁复制粘贴；魔法值抽具名常量；路径用相对/统一 base，不写死绝对路径。
- 业务固定值写具名常量即可，不必强求配置。

## 7. 版本与自检
- 不主动 `git commit`/`push`/建分支/合并/强推，除非布哥要求。
- 拿不准该不该建文件、放哪、怎么写时，先读本文件再简短问一句。
