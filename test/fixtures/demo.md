# mdterm 演示文档

这是一个用于验收 **粗体**、*斜体*、~~删除线~~ 与 `inline code` 的中文 Markdown 文档。

访问 [项目主页](https://example.com/mdterm)，链接地址会始终显示。图片只显示占位符：

![终端里的风景](images/terminal-landscape.png)

## 列表与任务

- 无序项目一
- 无序项目二
  - 嵌套项目：中文与 English
- [x] 已完成任务
- [ ] 尚未完成任务

3. 从三开始的有序项
4. 下一项

### 引用

> 阅读不是把文字搬进眼睛，
> 而是给思考留出空间。
>
> > 嵌套引用也应安全显示。

#### 四级标题

五、六级标题用于确认层级样式，但不会进入目录。

##### 五级标题

普通段落包含一个很长的单词以验证安全换行：supercalifragilisticexpialidocious-with-a-very-long-suffix-that-must-not-overflow-the-terminal。

###### 六级标题

样式层级到此结束。

## 代码块

带语言标记的 TypeScript：

```ts
interface Reader {
  title: string;
  lines: number;
}

const demo: Reader = {
  title: "中文 Markdown",
  lines: 42,
};
console.log(demo);
```

无语言标记时保持纯文本和原始缩进：

```
root
  child
    leaf
```

未知语言会安全降级：

```not-a-real-language
do something safely
```

## 中文表格

| 城市 | 天气 | 温度 | 备注 |
| :--- | :--: | ---: | --- |
| 上海 | 晴朗 | 28°C | 中文列宽应正确对齐 |
| Reykjavík | 多云 | 12°C | English 与中文混排 |
| 成都🙂 | 小雨 | 23°C | 这是一段会在窄终端中截断并显示省略号的很长内容 |

## 分割线与 HTML

---

<kbd>HTML 标签会作为可见文本安全降级</kbd>

<!-- 这条 HTML 注释会被忽略 -->

## 搜索验收

混合关键词 Alpha中文Beta 第一次出现。

另一个段落里再次出现 Alpha中文Beta，便于测试 `n` / `N` 循环。

### 结束

感谢使用 mdterm。
