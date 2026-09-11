# 发布与搜索优化手册

## 推荐标题

> 我用一条环形路线，让贪吃蛇 AI 在规则地图上不把自己困死

## 一句话介绍

这是一个可以在线玩的贪吃蛇算法实验室：你能比较不同电脑玩家怎样找食物，也能看到一条覆盖全部格子的环形路线怎样帮助蛇安全吃满规则地图。

## 短版帖子（V2EX / 动态）

我做了一个可以在线玩的贪吃蛇 AI 实验室。最有意思的不是“蛇会找食物”，而是怎样避免它长大后把自己困死。

我的做法是先在规则地图上画一条经过所有格子的环形路线，让蛇把它当成永远有出口的跑道；确认安全时再抄近路。仓库里还可以比较直接找食物、安全找路、固定路线和动态障碍等不同玩法。

- 在线体验：https://heimixieb.github.io/perfect-snake-ai-lab/
- GitHub：https://github.com/heimixieb/perfect-snake-ai-lab

项目同时保留了限制说明：随机障碍不一定存在完整路线，动态障碍也需要提前通知。欢迎试玩、提反例或贡献新的走法。

## 长版文章结构（知乎 / 掘金 / 少数派）

1. **问题**：为什么只会找最近食物的蛇，越长反而越容易失败？
2. **动画**：先放从短蛇到吃满棋盘的 GIF，不先讲公式。
3. **生活比喻**：把完整路线解释成操场环形跑道，把安全近路解释成“确认前面没人再变道”。
4. **在线体验**：让读者分别试直接找食物、固定路线和动态障碍。
5. **怎样检查**：路线检查、备用路线、独立检查员、随机与故障测试。
6. **诚实限制**：规则地图才有路线保证；动态场景是样本结果，不是万能证明。
7. **邀请参与**：征集更难地图、反例、界面和算法改进。

## 链接追踪

不同平台使用不同来源参数，方便在在线页面的访问统计工具中区分：

```text
V2EX:   https://heimixieb.github.io/perfect-snake-ai-lab/?utm_source=v2ex&utm_medium=community&utm_campaign=launch
知乎:   https://heimixieb.github.io/perfect-snake-ai-lab/?utm_source=zhihu&utm_medium=article&utm_campaign=launch
掘金:   https://heimixieb.github.io/perfect-snake-ai-lab/?utm_source=juejin&utm_medium=article&utm_campaign=launch
少数派: https://heimixieb.github.io/perfect-snake-ai-lab/?utm_source=sspai&utm_medium=article&utm_campaign=launch
```

## 每两周复盘一次

GitHub Traffic 只保留最近 14 天数据，因此不要等满一个月再看。记录：

| 日期 | Views / Unique | Clones / Unique | 主要外部来源 | 热门页面 | Stars | Demo 访问 |
|---|---:|---:|---|---|---:|---:|
| YYYY-MM-DD |  |  |  |  |  |  |

GitHub Traffic 能看到访问、克隆、来源网站和热门内容，但不能直接显示访客搜索的具体词。具体搜索词需要在部署后将 Pages 地址加入 Google Search Console 或 Bing Webmaster Tools，并提交 `sitemap.xml`。

参考：[GitHub Traffic 文档](https://docs.github.com/en/repositories/viewing-activity-and-data-for-your-repository/viewing-traffic-to-a-repository)。
