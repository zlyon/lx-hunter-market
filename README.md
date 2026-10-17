# lx-hunter-market · 音源猎手社区精选

收录经人工审核的音源仓库、音源脚本链接、音源发布页，构建为 `community.json` 供 [lx-hunter 音源猎手](https://github.com/zlyon/lx-hunter) 插件订阅，并提供在线列表页。

## 投稿

在 [Issues](https://github.com/zlyon/lx-hunter-market/issues/new?template=source-submit.yml) 使用「音源收录投稿」模板提交：

- 每行一个链接，支持 .js 直链、GitHub 仓库、音源发布页（挂着多个 .js 的列表页）；
- 提交前请如实勾选确认项，未全勾会被预检拦截。

## 审核流程

1. **自动预检**：提交后机器人自动下载全部脚本，做恶意特征扫描 + 疑似音源判定 + 沙箱试听实测（任意平台取链成功即算可用），统计报告直接评论在 issue 里；编辑修改链接会自动重跑，同一 issue 最多预检 3 次；
2. **人工审核**：审核通过即收录，发现问题的投稿会被撤下；
3. **自动构建**：收录内容每日定时构建进 `community.json` 并更新展示页；插件订阅后每个链接入库前还会再做一次沙箱实测。

> 「可用 N/M」是审核时的实测快照：云端（Actions）网络环境与客户端不同，部分平台可能被风控误判为不可用，仅供参考。音源后续更新内容会由插件端每次爬取时重新扫描与沙箱实测，插件端才是持续防线。

## 订阅地址

```
https://raw.githubusercontent.com/zlyon/lx-hunter-market/main/data/community.json
```

## 展示页

<https://zlyon.github.io/lx-hunter-market/>
