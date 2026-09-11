# IPAM 子网扫描管理系统

一个轻量级的 Web IPAM（IP Address Management）工具，用于管理和扫描 IPv4 子网的地址使用情况：按网段展示已用/空闲/冲突状态，悬停即可查看主机名、MAC、开放端口等常规信息。

## 功能特性

- **子网管理**：创建、编辑、删除、启用/停用 IPv4 网段（CIDR），主页直接展示单个子网，顶部下拉框快速切换
- **网段扫描**：服务端并发 TCP 探测（默认并发 64、单端口超时 800ms），带进度条与失败重试，同一网段自动互斥
- **地址状态**：已用 / 空闲 / 未知 / 冲突 四种状态，冲突自动识别同 IP 多 MAC 与同 MAC 多 IP
- **主机信息**：尽可能采集 MAC 地址（ARP）、主机名（反向 DNS）、响应耗时、探测来源与时间
- **开放端口**：记录每个在线主机探测端口列表中所有开放的 TCP 端口，悬停即览
- **地址网格**：颜色 + 图标双重视觉编码，支持状态筛选与 IP/MAC/主机名搜索，大网段分页加载
- **界面**：中文界面、亮色/暗色主题切换（跟随系统、记忆选择）、键盘可访问的悬停详情
- **持久化**：JSON 文件存储（原子写入），刷新页面不丢数据
- **后台运行**：内置守护脚本，脱离终端运行

## 快速开始

要求 Node.js >= 18。

```bash
npm install
npm start          # 默认监听 0.0.0.0:3000
```

浏览器访问 <http://localhost:3000>，点击「+ 新建子网」添加第一个网段（如 `192.168.10.0/24`），然后「立即扫描」。

### 环境变量

| 变量 | 默认值 | 说明 |
|---|---|---|
| `PORT` | `3000` | HTTP 监听端口 |
| `HOST` | `0.0.0.0` | HTTP 监听地址 |
| `IPAM_DATA_DIR` | `./data` | 数据目录（存放 `ipam.json`） |
| `LOG_LEVEL` | `info` | Fastify 日志级别 |

### 后台运行

```bash
npm run bg:start     # 后台启动（日志写入 data/ipam.log）
npm run bg:status    # 查看运行状态
npm run bg:restart   # 重启
npm run bg:stop      # 停止
```

## 工作原理

1. 解析 CIDR，生成网段内全部可用地址（默认排除网络地址与广播地址）
2. 服务端对每个地址的探测端口（默认 `22, 80, 443, 445, 3389, 8080`）发起 TCP 连接，收集全部开放端口
3. 对在线主机尝试通过 ARP 表读取 MAC、反向 DNS 解析主机名；获取不到时显示「未知」，不伪造数据
4. 结果按 已用/空闲/未知/冲突 归并，检测同 IP 多 MAC、同 MAC 多 IP 冲突
5. 扫描任务、进度、失败原因与历史发现记录全部持久化

> 同网段（二层直连）扫描可获得 MAC；跨网段扫描依赖路由可达性，且部分主机防火墙可能不响应探测端口。

## REST API

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/api/health` | 健康检查 |
| `GET` | `/api/subnets` | 子网列表（含使用率汇总） |
| `POST` | `/api/subnets` | 创建子网 `{ name, cidr, description? }` |
| `GET` | `/api/subnets/:id` | 子网详情（含地址记录，默认最多内嵌 1024 条） |
| `PUT` | `/api/subnets/:id` | 更新子网（名称/CIDR/描述/启停） |
| `DELETE` | `/api/subnets/:id` | 删除子网及其数据 |
| `POST` | `/api/subnets/:id/toggle` | 启用/停用切换 |
| `POST` | `/api/subnets/:id/scan` | 启动扫描（202 返回 jobId；重复启动返回 409） |
| `GET` | `/api/subnets/:id/scan` | 最近一次扫描任务状态与进度 |
| `GET` | `/api/subnets/:id/addresses?status=&offset=&limit=` | 地址分页查询（limit 上限 2000） |

## 开发

```bash
npm test            # 运行全部测试（node:test）
npm run typecheck   # TypeScript 类型检查
npm run build       # 编译到 dist/
```

## 目录结构

```
├── public/            # 前端 SPA（原生 JS + CSS，无构建依赖）
├── scripts/daemon.mjs # 后台运行守护脚本
├── src/
│   ├── server/        # Fastify 服务、扫描器、JSON 存储层
│   └── shared/        # CIDR 解析与状态归并（前后端共用）
└── test/              # 单元测试与 API 集成测试
```

## 已知限制

- 仅支持 IPv4；探测方式为 TCP 连接（不做 ICMP ping），不开放探测端口的主机可能漏检
- 数据存储为单文件 JSON，适合中小规模（数十个 /24 网段）场景
- 未包含用户认证与多租户，建议仅部署在内网受控环境
