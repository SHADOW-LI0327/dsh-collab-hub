# dsh-collab-hub

一个跑在内网的轻量协作 Hub：让 3–5 人的前后端团队共享 **项目 / feature 上下文**，而不用把设计文件在聊天里反复发、也不用让两个 Agent 互相重新讲一遍。

它只做四件事：

- **成员状态**：A 在做前端弹窗、B 在做后端接口，卡在哪；
- **设计产物**：图片 / HTML / Markdown 上传成不可变版本，带三行摘要；
- **问题**：把“要对方确认”的事留在 feature 上，而不是猜；
- **看板**：浏览器打开就能看到项目、feature、状态和产物。

Agent 通过 MCP 或 `dsh-process-kit` 的 `hub_*` 工具读写同一份上下文；服务器不跑 Agent，也不碰代码仓库。

## 快速开始

### 1. 在服务器上启动 Hub

```bash
cd dsh-collab-hub
node bin/collab.mjs hub --host 0.0.0.0 --port 8787 --data ./data
```

- 默认只监听 `127.0.0.1`；团队使用加 `--host 0.0.0.0`。
- 数据在 `./data`：`state.json` + `blobs/`，备份这个目录即可。
- 内网没有 TLS 时，建议只绑定内网网卡；要跨网段再加 Caddy/Nginx。

打开 `http://<server>:8787`，注册姓名和角色即可。

### 2. 创建项目 / feature

```bash
# 成员各自注册一次（token 存在 ~/.dsh/collab.json，0600）
node bin/collab.mjs register --name A --role frontend --hub http://<server>:8787

# 负责人创建项目和 feature
node bin/collab.mjs project create shop --name "电商平台" --repos web,api
node bin/collab.mjs feature create shop FEAT-001 --title "退款流程" --brief "支持全额/部分退款"
```

项目是产品级容器（一个项目可以有多个 repo）；feature 是双方共享的工作单元（例如 `FEAT-001`）。

### 3. 成员发布设计和状态

```bash
node bin/collab.mjs status FEAT-001 --state designing --focus "退款弹窗三态"
node bin/collab.mjs publish FEAT-001 ./design/refund.html --kind design --summary "退款弹窗三态 + 空态"
node bin/collab.mjs question FEAT-001 "部分退款需要审批吗？"
node bin/collab.mjs context FEAT-001
```

另一边：

```bash
node bin/collab.mjs context FEAT-001      # 看到 A 的设计摘要、状态、未决问题
node bin/collab.mjs answer <question-id> "部分退款不审批"
node bin/collab.mjs delta FEAT-001 --since 12
```

### 4. 让 Agent 用起来

#### 方式 A：MCP（Claude / Codex / 其他 MCP 客户端）

```json
{
  "mcpServers": {
    "collab": {
      "command": "node",
      "args": ["/absolute/path/dsh-collab-hub/mcp/server.mjs"]
    }
  }
}
```

MCP 会读 `~/.dsh/collab.json`；也可以显式给 `COLLAB_HUB_URL` + `COLLAB_TOKEN`。

工具：`collab_context`、`collab_delta`、`collab_publish`、`collab_status`、`collab_question`、`collab_answer`、`collab_handoff`、`collab_project_create`、`collab_feature_create`、`collab_register`。

#### 方式 B：dsh-process-kit（DSH 里直接用）

`dsh-process-kit >= 0.12.0` 自带 `hub_*` 工具。每个成员：

```bash
node bin/collab.mjs register --name A --role frontend --hub http://<server>:8787
```

在仓库里绑定一次：

```text
hub_link(project="shop", feature="FEAT-001")
```

它会写 `docs/process/.hub.json`（只有 project/feature，不含 token）。之后 Agent 在 DSH 里：

- `hub_context`：开工先看对方状态 / 问题 / 产物；
- `hub_health`：不确定 Hub 是否可达时做一次非阻塞检测；
- `hub_status`：更新“我在做什么”；
- `hub_publish`：发布设计，带摘要；
- `hub_question` / `hub_answer`：留问题、回答；
- `hub_handoff`：交接；
- `hub_board`：团队总览。

`docs/process` 和 journal 仍是每个仓库的真源；Hub 只做跨仓库的上下文层。

## 数据模型

```text
Member       id, name, role, token_hash
Project      id, name, description, repos[], owner
Feature      id, projectId, title, repos[], owner, brief
Status       featureId, memberId, state, focus, blocker, updatedAt
Artifact     featureId, memberId, kind, filename, mime, size,
             sha256, summary, version
Question     featureId, authorId, text, status, answer, answeredBy
Event        id, projectId, featureId, actorId, type, payload, createdAt
```

- Artifact 内容按 sha256 去重存 `data/blobs/`；元数据保留每个版本；
- 支持 png/jpeg/webp/gif、html、markdown、txt、pdf，单文件 25MB；
- event 只追加，`context?since=` / `delta` 用它做增量。

## 安全边界

- 成员 token 自动注册、只存 hash；token 在 `~/.dsh/collab.json`，权限 0600；
- token 丢失：在服务器上跑 `node bin/collab.mjs member reset --name A --data ./data`，拿新 token 写回成员本机；
- 所有 API 除 `/api/register` / `/api/health` / 签名 raw URL 外都要求 Bearer token；
- 图片/HTML 通过 10 分钟签名 URL 读取，不把长期 token 放进 URL；
- HTML 产物用 sandbox CSP + 无 `allow-same-origin` 的读取方式，避免读到 Hub 的 token；
- 这是内网工具：没有内置 TLS / SSO / 细粒度权限，别直接暴露到公网。

## 开发 / 测试

```bash
npm test
node bin/collab.mjs hub --data /tmp/collab-data --port 8787
```

零运行时依赖，Node >= 22。
