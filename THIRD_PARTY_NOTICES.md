# 第三方资源声明

> [简体中文](THIRD_PARTY_NOTICES.md) · [English](THIRD_PARTY_NOTICES.en.md)

## Naive UI

茶话间渲染层使用 Naive UI 的标准表单、搜索与常规操作组件，代码随 renderer 本地构建，运行时不访问外网。

- 来源：<https://github.com/tusen-ai/naive-ui>
- 版本：2.43.2
- 使用方式：按组件导入并通过茶话间主题 token 覆盖视觉
- 许可：MIT License
- 版权：Copyright (c) 2021 TuSimple

## Twemoji

茶话间内置头像与 emoji 兼容渲染使用 Twemoji SVG 图形子集，并随应用本地打包，不在运行时访问外网。

- 来源：<https://github.com/jdecked/twemoji>
- 版本：v15.1.0 图形子集
- 使用方式：仅选取所需 SVG 文件，未改绘
- 图形许可：Creative Commons Attribution 4.0 International（CC-BY 4.0），<https://creativecommons.org/licenses/by/4.0/>
- 版权：Copyright Twitter, Inc and other contributors

## 左侧导航图标

左侧导航使用 Lucide 0.468.0 的 `message-circle`、`users`、`package-2`、`refresh-cw`、`settings`。保留上游图形路径，统一显示尺寸与描边；仅内置这五个图标，不引入图标库运行时依赖或外网请求。

- Lucide：<https://github.com/lucide-icons/lucide/tree/0.468.0>，ISC License（部分图形源自 Feather / MIT）
- 完整版权与许可：[navigation-icons.txt](build/licenses/navigation-icons.txt)，随应用打包到 `licenses/navigation-icons.txt`。


## 内网模型客户端

Agent 托管使用官方 Anthropic TypeScript SDK 与 Node HTTP fetch 实现，依赖随应用本地打包。默认无云端连接，仅访问用户配置的合规内网模型服务。

- Anthropic SDK：<https://github.com/anthropics/anthropic-sdk-typescript>，版本 0.32.1，MIT License，Copyright 2023 Anthropic, PBC.
- node-fetch：<https://github.com/node-fetch/node-fetch>，版本 2.7.0，MIT License，Copyright (c) 2016 David Frank.
- 依赖包内均保留上游许可文件；构建不通过外部 CDN 加载 SDK。
