# Documentation

本目录是 `@mojingjing-git/dsh-subagent-antigravity` 的说明文档。两份面向使用者的
README 留在仓库根目录（发布包需要它们），其余说明集中在这里。

## 面向使用者

| 文档 | 内容 |
|---|---|
| [../README.md](../README.md) | 安装、用法、配置项、故障排查（English） |
| [../README.zh.md](../README.zh.md) | 安装、用法、配置项、故障排查（中文） |

两份 README 内容等价，改动其中一份时同步另一份，并更新
[../README.i18n.yaml](../README.i18n.yaml) 中记录的 git blob 哈希。

## 面向维护者

| 文档 | 内容 |
|---|---|
| [architecture.md](architecture.md) | 整体结构：进程模型、模块划分、数据流、生命周期 |
| [interfaces-reference.md](interfaces-reference.md) | 暴露给模型的五个工具：参数、返回值、语义 |
| [agy-integration.md](agy-integration.md) | 如何与本机 `agy` 协作：二进制定位、能力探测、线协议、结算规则 |
| [sidebar-panel.md](sidebar-panel.md) | 侧边栏面板：宿主路由、客户端契约 |
| [agy-data-sources.md](agy-data-sources.md) | 从 agy 自己的磁盘存储读什么、怎么读、有哪些陷阱 |
| [configuration.md](configuration.md) | 完整配置项参考 |
| [security.md](security.md) | 信任边界、凭证处理、面板自卫式校验 |
| [development.md](development.md) | 构建、测试、发布流程 |

## 文档约定

- **描述架构，不描述实现。** 文档说明「谁负责什么、边界在哪、为什么这么定」；
  具体的函数、行号、参数细节以代码为准，不在文档里复制。
- **不写更新历史。** 变更记录由 git 和 release notes 承担，文档只陈述当前状态。
- **不写版本号和统计数字。** 版本见 `package.json`；测试数量由各套件自行打印。
  手写这些值必然随时间漂移。
