<h1 align="center">Meet Video</h1>
<p align="center">
  <em>一个功能强大的视频下载工具，支持多种视频网站和流媒体格式。</em>
</p>
<p align="center">
  <a href="https://github.com/wuanqicll-del/Meet-Video"><img src="https://img.shields.io/github/v/release/wuanqicll-del/Meet-Video?logo=github" alt="GitHub releases" /></a>
  <a href="https://hub.docker.com/r/wuanqicll/meet-video"><img src="https://img.shields.io/docker/pulls/wuanqicll/meet-video?logo=docker&logoColor=white" alt="Docker pulls" /></a>
</p>

---

**如果好用，请 Star！非常感谢！** [GitHub](https://github.com/wuanqicll-del/Meet-Video) · [DockerHub](https://hub.docker.com/r/wuanqicll/meet-video)

---

## 功能特点

**核心功能**
- 支持多种视频网站（YouTube、Twitter、Bilibili 等）
- 支持 m3u8/HLS/DASH 流媒体下载
- 支持多线程下载（aria2c）
- 支持格式选择（不同画质、音频）
- 支持批量下载（多个链接一行一个）
- 支持 Cookies（需要登录的网站）

**任务管理**
- 实时进度显示（速度、进度、剩余时间）
- 支持暂停、继续、重试、删除任务
- 支持批量操作（全部暂停、全部继续、清除已完成）
- 任务状态实时更新（SSE 推送）

**智能路由**
- 根据 URL 类型自动选择下载目录（m3u8、直链、其他）
- 根据域名自动选择下载目录
- 支持自定义路由规则

**配置管理**
- 可配置下载目录
- 可配置最大并发任务数
- 可配置 m3u8 线程数
- 可配置 aria2c 下载线程数
- 可配置 Cookies 文件路径

---

## 用途举例

**1. 视频下载**

从各种视频网站下载视频，支持选择不同画质和格式。

**2. 批量下载**

同时粘贴多个链接，一键批量下载。

**3. 流媒体下载**

支持 m3u8/HLS/DASH 流媒体格式，自动合并分片。

---

## 特性

- 开源免费，接受任意审查
- [Github Actions](https://docs.github.com/zh/actions) 自动打包与发布，过程公开透明
- 支持 Docker，下载即用（支持 AMD64 和 ARM64 架构）
- 干净卸载，不用的时候删掉即可，无任何残留
- 完全离线运行，永不上传用户隐私
- 完善的错误处理，稳定可靠
- 完善的日志，所有错误都会被记录
- 支持多种下载方式（yt-dlp 原生、aria2c 多线程）
- 支持多种视频格式（mp4、webm、mkv、avi、mov、flv 等）
- 支持多种流媒体格式（m3u8、HLS、DASH）
- 实时进度显示（速度、进度、剩余时间）
- 支持任务暂停、继续、重试、删除
- 支持批量操作
- 支持自定义下载路由规则
- 支持 Cookies（需要登录的网站）

---

## 使用方法

### Docker 部署（推荐）

```bash
# 创建数据目录（用于持久化配置和下载文件）
mkdir -p /path/to/config
mkdir -p /path/to/downloads

# 运行容器
docker run -d \
  --name meet-video \          # 容器名称
  -p 5052:5000 \               # 端口映射：宿主机端口:容器端口
  -v /path/to/config:/app/config \      # 配置文件挂载
  -v /path/to/downloads:/app/downloads \ # 下载目录挂载
  --restart unless-stopped \           # 重启策略：除非手动停止，否则总是重启
  wuanqicll/meet-video:latest          # 镜像名称:标签
```

### Docker Compose 部署

创建 `docker-compose.yml`：

```yaml
services:
  meet-video:
    image: wuanqicll/meet-video:latest  # 镜像名称:标签
    container_name: meet-video          # 容器名称
    restart: always                     # 重启策略：总是重启
    network_mode: "bridge"              # 网络模式：桥接模式
    environment:
      - TZ=Asia/Shanghai                # 时区设置：亚洲/上海
    ports:
      - "5052:5000"                     # 端口映射：宿主机端口:容器端口
    volumes:
      - ./config:/app/config            # 配置文件挂载
      - ./downloads:/app/downloads      # 下载目录挂载
```

启动服务：

```bash
docker-compose up -d
```

### 访问 WebUI

打开浏览器访问：`http://你的IP:5052`

---

## 配置说明

配置文件位于 `/app/config/config.json`，包含以下选项：

| 配置项 | 说明 | 默认值 |
| :--- | :--- | :--- |
| download_dir | 默认下载目录 | /app/downloads |
| max_tasks | 最大并发任务数 | 3 |
| thread_count | aria2c 下载线程数 | 16 |
| concurrent_fragments | m3u8 线程数 | 4 |
| cookies_file | Cookies 文件路径 | 空 |
| routing_rules | 下载路由规则 | 见下方 |

**路由规则配置：**

```json
{
  "routing_rules": [
    {
      "match_type": "url_type",
      "pattern": "m3u8",
      "dir": "/app/downloads-m3u8"
    },
    {
      "match_type": "domain",
      "pattern": "video.twimg.com",
      "dir": "/app/downloads-X"
    },
    {
      "match_type": "domain",
      "pattern": "youtu.be",
      "dir": "/app/downloads-hdr"
    }
  ]
}
```

**匹配类型：**
- `url_type`：按 URL 类型匹配（m3u8、direct、other）
- `domain`：按域名匹配

---

## 技术栈

**后端**
- Python 3
- Flask Web 框架
- yt-dlp 视频下载
- aria2c 多线程下载
- ffmpeg 视频处理

**前端**
- 原生 HTML/CSS/JavaScript
- 响应式设计（支持移动端）
- SSE 实时进度推送

**部署**
- Docker 容器化
- 多架构支持（AMD64/ARM64）
- GitHub Actions 自动构建

---

## 目录结构

```
meet-video/
├── app/
│   ├── app.py          # 主应用（后端逻辑）
│   ├── webui.py        # WebUI 入口
│   ├── static/         # 静态文件（CSS、JS）
│   └── templates/      # 模板文件（HTML）
├── Dockerfile          # Docker 构建文件
└── README.md           # 说明文档
```

---

## 常见问题

**1. 如何更新版本？**

```bash
# 拉取最新镜像
docker pull wuanqicll/meet-video:latest

# 重启容器
docker-compose down
docker-compose up -d
```

**2. 如何备份数据？**

备份 `/app/config` 目录（配置文件）和 `/app/downloads` 目录（下载文件）。

**3. 支持哪些网站？**

支持所有 yt-dlp 支持的网站，包括 YouTube、Twitter、Bilibili、抖音等。

**4. 如何使用 Cookies？**

将 Cookies 文件放到 `/app/config/cookies.txt`，然后在设置中配置路径。

**5. 下载速度慢怎么办？**

- 增加 `thread_count`（aria2c 线程数）
- 增加 `concurrent_fragments`（m3u8 线程数）
- 检查网络连接

---

## 许可证

MIT License

---

## 项目地址

- GitHub：https://github.com/wuanqicll-del/Meet-Video
- DockerHub：https://hub.docker.com/r/wuanqicll/meet-video
