"""yt-dlp 下载器 - 后端"""

import json, uuid, threading, subprocess, re, os, signal, shutil, time, queue, logging, select
from concurrent.futures import ThreadPoolExecutor
from urllib.request import Request, urlopen
from flask import Flask, request, jsonify, render_template, make_response, Response
import yt_dlp as yt_dlp_mod

logger = logging.getLogger(__name__)

# ======================== 常量 ========================

YTDLP = "/usr/local/bin/yt-dlp"
CONFIG_FILE = "/app/config/config.json"
TASK_FILE = "/app/config/tasks.json"

DEFAULT_CONFIG = {
    "download_dir": "/app/downloads",
    "max_tasks": 3,
    "thread_count": 16,
    "concurrent_fragments": 4,
    "cookies_file": "",
    "routing_rules": [
        {"match_type": "url_type", "pattern": "m3u8", "dir": "/app/downloads-m3u8"},
        {"match_type": "domain", "pattern": "video.twimg.com", "dir": "/app/downloads-X"},
        {"match_type": "domain", "pattern": "youtu.be", "dir": "/app/downloads-hdr"},
    ]
}

# 进度正则
RE_PROGRESS = re.compile(r'\[download\]\s+(\d+\.?\d*)%')
RE_SPEED = re.compile(r'at\s+(\d+\.?\d*\s*[KMG]i?B/s)')
RE_ETA = re.compile(r'ETA\s+(\d+:\d+(?::\d+)?)')
RE_MERGE = re.compile(r'\[Merger\]|\[FixupM3u8\]|\[FixupTimestamp\]|\[ExtractAudio\]')
# aria2c 输出格式: [#hash 1.9MiB/3.0GiB(0%) CN:16 DL:1.6MiB ETA:32m14s]
RE_ARIA2C = re.compile(r'\[#\w+\s+[\d.]+[KMG]?i?B/([\d.]+[KMG]?i?B)\((\d+)%\).*?DL:([\d.]+\s*[KMG]?i?B)(?:\s+ETA:(\S+?))?\]')


def _get_url_type(url):
    """判断链接类型：m3u8 / direct / other"""
    if not url:
        return 'other'
    path = url.split('?')[0].split('#')[0].lower()
    if path.endswith('.m3u8'):
        return 'm3u8'
    if any(path.endswith(ext) for ext in ('.mp4', '.webm', '.mkv', '.avi', '.mov', '.flv', '.ts')):
        return 'direct'
    return 'other'


def _resolve_download_dir(url, default_dir):
    """根据配置中的路由规则决定下载目录，匹配不到则用默认目录"""
    cfg = load_config()
    rules = cfg.get("routing_rules", [])
    url_type = None
    for rule in rules:
        mt = rule.get("match_type", "")
        pattern = rule.get("pattern", "")
        d = rule.get("dir", "")
        if not pattern or not d:
            continue
        if mt == "url_type":
            if url_type is None:
                url_type = _get_url_type(url)
            if url_type == pattern:
                return d
        elif mt == "domain":
            if pattern in url:
                return d
    return default_dir

# ======================== 工具函数 ========================

def _translate_exit(code):
    """将退出码翻译成中文"""
    signal_map = {
        -2: "中断信号(SIGINT)，进程被Ctrl+C终止",
        -6: "中止信号(SIGABRT)，进程异常终止",
        -9: "强制杀死(SIGKILL)，进程被系统强制终止",
        -11: "段错误(SIGSEGV)，内存访问异常",
        -13: "管道破裂(SIGPIPE)，写入已关闭的管道",
        -15: "终止信号(SIGTERM)，进程被正常终止（暂停下载）",
    }
    if code in signal_map:
        return signal_map[code]
    code_map = {
        1: "通用错误，通常是地址无效、网络不通或资源不存在",
        2: "参数错误，下载参数不合法",
        3: "磁盘错误，空间不足或无写入权限",
        4: "网络错误，连接超时或被拒绝",
        5: "协议错误，服务器返回异常响应",
        6: "认证失败，需要登录或提供cookies",
        7: "文件错误，输出路径不可写或已损坏",
        8: "资源不存在，视频已被删除或设为私密",
    }
    if code in code_map:
        return code_map[code]
    return f"未知错误（退出码:{code}）"


def safe_name(name, max_len=200):
    if not name:
        return "video"
    name = re.sub(r'[\\/:*?"<>|]', '_', name)
    ext = os.path.splitext(name)[1]
    base = os.path.splitext(name)[0]
    ext_len = len(ext.encode('utf-8'))
    # 扩展名本身超过限制时，直接截断扩展名前的文件名留 10 字节
    max_base = max(10, max_len - ext_len) if ext_len < max_len else 10
    b = base.encode('utf-8')[:max_base]
    while True:
        try:
            return b.decode('utf-8') + ext
        except UnicodeDecodeError:
            b = b[:-1]
            if not b:
                return "video" + ext


def fmt_duration(sec):
    if not sec:
        return ""
    sec = int(sec)
    h, r = divmod(sec, 3600)
    m, s = divmod(r, 60)
    return f"{h}:{m:02d}:{s:02d}" if h else f"{m}:{s:02d}"


def _is_valid_url(url):
    """基本 URL 格式校验"""
    return bool(re.match(r'^https?://\S+$', url))


# ======================== 文件初始化 ========================

def init_files():
    for d in [os.path.dirname(CONFIG_FILE), os.path.dirname(TASK_FILE)]:
        os.makedirs(d, exist_ok=True)
    if not os.path.exists(CONFIG_FILE):
        with open(CONFIG_FILE, "w") as f:
            json.dump(DEFAULT_CONFIG, f, indent=2)
    if not os.path.exists(TASK_FILE):
        with open(TASK_FILE, "w") as f:
            json.dump({}, f)

init_files()


def _cleanup_orphan_tmp():
    """启动时清理所有下载目录中无主的临时目录"""
    # 所有可能的下载目录（默认 + 专用）
    ALL_DL_DIRS = [
        "/app/downloads",
        "/app/downloads-m3u8",
        "/app/downloads-X",
        "/app/downloads-hdr",
    ]
    try:
        with open(TASK_FILE, "r") as f:
            tasks = json.load(f)
        active_tmps = {t.get("tmp_dir") for t in tasks.values() if t.get("tmp_dir")}
    except Exception:
        active_tmps = set()

    for dl_dir in ALL_DL_DIRS:
        if not os.path.isdir(dl_dir):
            continue
        for name in os.listdir(dl_dir):
            if not name.startswith(".tmp_"):
                continue
            full = os.path.join(dl_dir, name)
            if full not in active_tmps:
                try:
                    shutil.rmtree(full)
                except Exception:
                    pass

_cleanup_orphan_tmp()


_config_cache = None
_config_mtime = 0
_config_lock = threading.RLock()

def load_config():
    global _config_cache, _config_mtime
    with _config_lock:
        try:
            mtime = os.path.getmtime(CONFIG_FILE)
            if _config_cache and mtime == _config_mtime:
                return _config_cache
            with open(CONFIG_FILE, "r") as f:
                cfg = json.load(f)
            _config_cache = {**DEFAULT_CONFIG, **cfg}
            _config_mtime = mtime
            return _config_cache
        except (FileNotFoundError, json.JSONDecodeError):
            with open(CONFIG_FILE, "w") as f:
                json.dump(DEFAULT_CONFIG, f, indent=2)
            _config_cache = DEFAULT_CONFIG.copy()
            _config_mtime = os.path.getmtime(CONFIG_FILE)
            return _config_cache


def save_config(cfg):
    global _config_cache, _config_mtime
    with _config_lock:
        cur = load_config()
        for k, v in cfg.items():
            cur[k] = v
        with open(CONFIG_FILE, "w") as f:
            json.dump(cur, f, indent=2)
        _config_cache = cur
        _config_mtime = os.path.getmtime(CONFIG_FILE)
        return cur


# ======================== TaskManager ========================

MAX_SSE_CLIENTS = 20

class SSEManager:
    """SSE 事件管理器"""
    def __init__(self):
        self.clients = []
        self.lock = threading.Lock()
    
    def subscribe(self):
        """订阅 SSE 事件，超过上限时拒绝"""
        q = queue.Queue(maxsize=100)
        with self.lock:
            if len(self.clients) >= MAX_SSE_CLIENTS:
                return None
            self.clients.append(q)
        return q
    
    def unsubscribe(self, q):
        """取消订阅"""
        with self.lock:
            if q in self.clients:
                self.clients.remove(q)
    
    def publish(self, event_type, data):
        """发布事件到所有客户端"""
        with self.lock:
            for q in self.clients[:]:
                try:
                    q.put_nowait((event_type, data))
                except queue.Full:
                    # 队列满了，丢弃旧消息
                    try:
                        q.get_nowait()
                        q.put_nowait((event_type, data))
                    except Exception:
                        pass


class TaskManager:
    def __init__(self, sse_manager):
        self.tasks = {}
        self.lock = threading.Lock()
        self.dirty = False
        self.sse = sse_manager
        self._load()
        threading.Thread(target=self._auto_save, daemon=True).start()

    def _load(self):
        try:
            with open(TASK_FILE, "r") as f:
                self.tasks = json.load(f)
            for t in self.tasks.values():
                if t["status"] in ("queued", "downloading", "merging"):
                    t["status"] = "failed"
                    t["error"] = "服务重启，任务中断"
                t["pid"] = None
                t["pgid"] = None
                t["stop_requested"] = False
                t.setdefault("eta", "")
        except Exception as e:
            logger.warning("加载任务文件失败，使用空任务列表: %s", e)
            self.tasks = {}

    def _auto_save(self):
        while True:
            time.sleep(10)
            if self.dirty:
                self._save()

    def _save(self):
        tmp = TASK_FILE + ".tmp"
        try:
            with open(tmp, "w") as f:
                json.dump(self.tasks, f, indent=2, ensure_ascii=False)
            os.replace(tmp, TASK_FILE)
            self.dirty = False
        except Exception as e:
            logger.error("保存任务文件失败: %s", e)
            try:
                os.remove(tmp)
            except OSError:
                pass

    def create(self, url, title, format_spec="bestvideo*+bestaudio/best", format_info=None):
        cfg = load_config()
        dl_dir = _resolve_download_dir(url, cfg.get("download_dir", "/app/downloads"))

        os.makedirs(dl_dir, exist_ok=True)
        tid = str(uuid.uuid4())
        tmp_dir = os.path.join(dl_dir, f".tmp_{tid[:8]}")
        os.makedirs(tmp_dir, exist_ok=True)
        task = {
            "id": tid, "url": url, "title": title or "video",
            "format_spec": format_spec, "format_info": format_info or {},
            "download_dir": dl_dir, "tmp_dir": tmp_dir,
            "status": "queued", "progress": 0, "speed": "", "eta": "", "error": "",
            "pid": None, "pgid": None, "stop_requested": False,
            "created_at": time.time()
        }
        with self.lock:
            self.tasks[tid] = task
            self.dirty = True
        # 不在这里发 SSE，由 try_submit 发送最终状态（避免 queued→downloading 闪烁）
        return tid

    def get(self, tid):
        with self.lock:
            return self.tasks.get(tid)

    def all(self):
        with self.lock:
            return list(self.tasks.values())

    def update(self, tid, **kw):
        with self.lock:
            if tid in self.tasks:
                self.tasks[tid].update(kw)
                self.dirty = True
        # SSE 推送 - 发送完整任务数据
        with self.lock:
            task_data = self.tasks.get(tid, {})
            sse_data = {k: v for k, v in task_data.items() if k not in ("pid", "pgid", "stop_requested")}
        self.sse.publish("task_update", sse_data)

    def stop(self, tid):
        with self.lock:
            t = self.tasks.get(tid)
            if not t:
                return
            t["stop_requested"] = True
            pgid = t.get("pgid")
            if pgid:
                try:
                    os.killpg(pgid, signal.SIGTERM)
                except ProcessLookupError:
                    pass
                # 后台等 2 秒，没退出则强杀
                def _force_kill():
                    time.sleep(2)
                    try:
                        os.killpg(pgid, signal.SIGKILL)
                    except (ProcessLookupError, OSError):
                        pass
                threading.Thread(target=_force_kill, daemon=True).start()

    def stop_and_update(self, tid, status="stopped", speed="", eta=""):
        """原子：设置 stop_requested + 发信号 + 更新状态，防止与 queue_start 竞态"""
        sse_data = None
        with self.lock:
            t = self.tasks.get(tid)
            if not t:
                return
            t["stop_requested"] = True
            pgid = t.get("pgid")
            if pgid:
                try:
                    os.killpg(pgid, signal.SIGTERM)
                except ProcessLookupError:
                    pass
                def _force_kill():
                    time.sleep(2)
                    try:
                        os.killpg(pgid, signal.SIGKILL)
                    except (ProcessLookupError, OSError):
                        pass
                threading.Thread(target=_force_kill, daemon=True).start()
            t["status"] = status
            t["speed"] = speed
            t["eta"] = eta
            self.dirty = True
            sse_data = {k: v for k, v in t.items() if k not in ("pid", "pgid", "stop_requested")}
        if sse_data:
            self.sse.publish("task_update", sse_data)

    def delete(self, tid):
        with self.lock:
            t = self.tasks.get(tid)
            if not t:
                return
            if t["status"] in ("queued", "downloading", "merging"):
                t["stop_requested"] = True
                pgid = t.get("pgid")
                if pgid:
                    try:
                        os.killpg(pgid, signal.SIGTERM)
                    except ProcessLookupError:
                        pass
            # 直接删除整个临时目录
            tmp_dir = t.get("tmp_dir", "")
            if tmp_dir and os.path.exists(tmp_dir):
                try:
                    shutil.rmtree(tmp_dir)
                except Exception:
                    pass
            del self.tasks[tid]
            self.dirty = True
        # SSE 推送
        self.sse.publish("task_delete", {"id": tid})


# ======================== yt-dlp 解析 ========================

def parse_url(url):
    cfg = load_config()
    cmd = [YTDLP, "--dump-json", "--no-download", "--no-warnings",
           "--no-playlist", "--no-check-certificates"]
    cookies = cfg.get("cookies_file", "")
    if cookies and os.path.exists(cookies):
        cmd.extend(["--cookies", cookies])
    cmd.append(url)

    r = subprocess.run(cmd, capture_output=True, text=True, timeout=60)
    if r.returncode != 0:
        raise Exception(r.stderr.strip() or "解析失败")
    info = json.loads(r.stdout.strip().split('\n')[0])
    return _build_info(info, url)


def _build_info(info, url=""):
    formats = info.get("formats", [])
    video, audio, combined = [], [], []
    seen = set()
    for f in formats:
        fid = f.get("format_id", "")
        if fid in seen:
            continue
        seen.add(fid)
        vc = f.get("vcodec", "none") or "none"
        ac = f.get("acodec", "none") or "none"
        hv, ha = vc != "none", ac != "none"
        if f.get("format_note", "").lower() in ("storyboard", "default"):
            continue
        w, h = f.get("width"), f.get("height")
        res = f"{w}x{h}" if w and h else ("audio only" if not hv else "?")
        size = f.get("filesize") or f.get("filesize_approx")
        entry = {
            "id": fid, "ext": f.get("ext", ""), "resolution": res,
            "width": w, "height": h, "fps": f.get("fps"),
            "vcodec": vc if hv else None, "acodec": ac if ha else None,
            "vbr": f.get("vbr"), "abr": f.get("abr"), "tbr": f.get("tbr"),
            "filesize": size, "note": f.get("format_note", ""),
            "hdr": f.get("dynamic_range", ""),
        }
        if hv and ha:
            combined.append(entry)
        elif hv:
            video.append(entry)
        elif ha:
            audio.append(entry)

    video.sort(key=lambda x: (x.get("height") or 0, x.get("vbr") or 0), reverse=True)
    audio.sort(key=lambda x: (x.get("abr") or 0), reverse=True)
    combined.sort(key=lambda x: (x.get("height") or 0, x.get("tbr") or 0), reverse=True)

    dur = info.get("duration")
    return {
        "title": info.get("title", "video"), "duration": dur,
        "duration_str": fmt_duration(dur) if dur else "",
        "thumbnail": info.get("thumbnail", ""),
        "uploader": info.get("uploader", ""),
        "webpage_url": info.get("webpage_url", url),
        "extractor": info.get("extractor", ""),
        "video_formats": video, "audio_formats": audio, "combined_formats": combined,
    }


# ======================== yt-dlp 下载 ========================

def _build_download_cmd(task, cfg, tmp_dir, dl_dir):
    """组装 yt-dlp 命令行参数"""
    thread_count = cfg.get("thread_count", 16)
    frag = cfg.get("concurrent_fragments", 4)
    fname = safe_name(task["title"])

    cmd = [
        YTDLP, "--continue", "--newline", "--no-color", "--no-warnings",
        "--no-playlist", "--no-check-certificates",
        "--concurrent-fragments", str(frag),
        "-P", f"temp:{tmp_dir}",
        "-P", f"home:{dl_dir}",
        "-o", f"{fname}.%(ext)s",
        "-f", task.get("format_spec") or "bestvideo*+bestaudio/best",
    ]
    # m3u8 用 yt-dlp 原生下载器（连接复用好），非 m3u8 用 aria2c 多线程
    if _get_url_type(task["url"]) != "m3u8":
        cmd.extend([
            "--downloader", "http:aria2c",
            "--downloader", "https:aria2c",
            "--downloader-args", f"aria2c:-x{thread_count} -s{thread_count} -k1M --file-allocation=none --summary-interval=1",
        ])
    cookies = cfg.get("cookies_file", "")
    if cookies and os.path.exists(cookies):
        cmd.extend(["--cookies", cookies])
    cmd.append(task["url"])
    return cmd


def _parse_output_line(line, task_mgr, tid, last_prog, is_m3u8=False):
    """解析一行 yt-dlp/aria2c 输出，更新进度，返回 (last_prog, has_progress)"""
    if RE_MERGE.search(line):
        task_mgr.update(tid, status="merging", progress=99, speed="", eta="")
        return last_prog, True

    am = RE_ARIA2C.search(line)
    if am:
        prog = float(am.group(2))
        spd = (am.group(3) or "") + "/s"
        eta = am.group(4) or ""
        if prog >= last_prog:
            last_prog = prog
        task_mgr.update(tid, progress=last_prog, speed=spd, eta=eta)
        return last_prog, True

    pm = RE_PROGRESS.search(line)
    if pm:
        prog = float(pm.group(1))
        sm = RE_SPEED.search(line)
        em = RE_ETA.search(line)
        spd = sm.group(1) if sm else ""
        eta = em.group(1) if em else ""
        if prog >= last_prog:
            last_prog = prog
        # m3u8 进度 99%+ 说明分片已基本下完，接下来是合并，直接切 merging
        if last_prog >= 99 and is_m3u8:
            task_mgr.update(tid, progress=100, speed="", eta="", status="merging")
        else:
            task_mgr.update(tid, progress=last_prog, speed=spd, eta=eta)
        return last_prog, True

    return last_prog, False


def _wait_and_kill(process, timeout=10):
    """等待进程结束，超时则强制杀死"""
    try:
        process.wait(timeout=timeout)
    except subprocess.TimeoutExpired:
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        process.wait()


def _finalize_download(task_mgr, tid, process, was_stopped):
    """根据进程结果设置任务最终状态"""
    cur = task_mgr.get(tid)
    if not cur:
        return
    # 如果任务已被新下载接管（resume），PID 会变，不覆盖状态
    if cur.get("pid") and cur.get("pid") != process.pid:
        return
    if was_stopped:
        # 如果 stop_requested 已被 resume 重置，说明任务已被接管，不覆盖状态
        if not cur.get("stop_requested"):
            return
        task_mgr.update(tid, status="stopped", speed="", eta="")
    elif process.returncode == 0:
        task_mgr.update(tid, status="finished", progress=100, speed="", eta="")
    else:
        # 如果任务已被 resume 接管（try_submit 已设 status=downloading），旧进程被杀不算失败
        if cur.get("status") in ("downloading", "merging"):
            return
        task_mgr.update(tid, status="failed", error=_translate_exit(process.returncode))


def _cleanup_download(task_mgr, tid, process, tmp_dir):
    """清理下载残留：清除 pid、保存任务、清理无主临时目录"""
    with task_mgr.lock:
        cur = task_mgr.tasks.get(tid)
        if cur and process and cur.get("pid") == process.pid:
            cur["pid"] = None
            cur["pgid"] = None
            task_mgr.dirty = True
    task_mgr._save()
    # 如果任务已被删除，清理可能残留的临时目录
    if not task_mgr.get(tid):
        if tmp_dir and os.path.exists(tmp_dir):
            try:
                shutil.rmtree(tmp_dir)
            except Exception:
                pass


def _fetch_title_if_needed(task_mgr, tid, task):
    """如果标题是占位符，尝试获取真实标题，失败则标记任务失败"""
    if task.get("title") != "获取中...":
        return True
    for _ in range(5):
        try:
            real_title = _get_title(task["url"])
        except Exception as e:
            logger.debug("获取标题异常: %s", e)
            real_title = None
        if real_title:
            task_mgr.update(tid, title=real_title)
            task["title"] = real_title
            return True
    task_mgr.update(tid, status="failed", error="获取文件名失败，请检查链接是否有效")
    return False


def _probe_format_async(task_mgr, tid, task):
    """后台线程获取格式信息（不阻塞下载）"""
    if task.get("format_info"):
        return
    def _do():
        try:
            fmt_info = _get_format_info(task["url"])
            if fmt_info:
                task_mgr.update(tid, format_info=fmt_info)
                logger.info("[probe] %s 格式信息获取成功: %s", tid[:8], list(fmt_info.keys()))
            else:
                logger.warning("[probe] %s 格式信息为空", tid[:8])
        except Exception as e:
            logger.warning("[probe] %s 格式信息获取异常: %s", tid[:8], e)
    threading.Thread(target=_do, daemon=True).start()


def run_download(task_mgr, tid):
    """下载主流程：准备 → 启动进程 → 读取输出 → 收尾清理"""
    t = task_mgr.get(tid)
    if not t or t.get("stop_requested"):
        return

    cfg = load_config()
    dl_dir = t.get("download_dir", cfg.get("download_dir", "/app/downloads"))
    tmp_dir = t.get("tmp_dir", dl_dir)

    # 二次检查（防止删除后仍启动）
    t = task_mgr.get(tid)
    if not t or t.get("stop_requested"):
        return

    os.makedirs(dl_dir, exist_ok=True)
    os.makedirs(tmp_dir, exist_ok=True)

    # 获取真实标题
    if not _fetch_title_if_needed(task_mgr, tid, t):
        return

    # 后台获取格式信息
    _probe_format_async(task_mgr, tid, t)

    cmd = _build_download_cmd(t, cfg, tmp_dir, dl_dir)
    process = None
    try:
        # 检查 + 更新状态必须原子，防止与 stop_all 竞态
        with task_mgr.lock:
            t = task_mgr.tasks.get(tid)
            if not t or t.get("stop_requested"):
                return
            t["status"] = "downloading"
            t["speed"] = ""
            t["eta"] = ""
            t["error"] = ""
            task_mgr.dirty = True
            task_mgr.sse.publish("task_update",
                {k: v for k, v in t.items() if k not in ("pid", "pgid", "stop_requested")})
        env = os.environ.copy()
        env["PYTHONUNBUFFERED"] = "1"
        process = subprocess.Popen(
            cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
            text=True, encoding='utf-8', errors='replace', bufsize=1,
            preexec_fn=os.setsid, env=env
        )
        task_mgr.update(tid, pid=process.pid, pgid=process.pid)

        last_prog = 0
        buf = ""
        fd = process.stdout.fileno()
        was_stopped = False
        last_progress_time = time.time()
        STALE_THRESHOLD = 5  # 秒，超过此时间无进度输出则清空速度和剩余
        is_m3u8 = _get_url_type(t["url"]) == "m3u8"
        while True:
            cur = task_mgr.get(tid)
            if not cur or cur.get("stop_requested"):
                was_stopped = True
                break
            # 用 select 等待输出，2 秒超时
            ready, _, _ = select.select([fd], [], [], 2)
            if not ready:
                # 无输出，检查是否卡住
                if time.time() - last_progress_time > STALE_THRESHOLD:
                    cur2 = task_mgr.get(tid)
                    if cur2 and cur2.get("speed"):
                        task_mgr.update(tid, speed="", eta="")
                continue
            try:
                chunk = os.read(fd, 4096)
            except OSError:
                break
            if not chunk:
                break
            buf += chunk.decode('utf-8', errors='replace')
            while '\n' in buf:
                line, buf = buf.split('\n', 1)
                line = line.strip()
                if line:
                    last_prog, has_progress = _parse_output_line(line, task_mgr, tid, last_prog, is_m3u8)
                    if has_progress:
                        last_progress_time = time.time()

        # 进程可能先于循环退出，再检查一次
        if not was_stopped:
            cur = task_mgr.get(tid)
            if cur and cur.get("stop_requested"):
                was_stopped = True

        _wait_and_kill(process)
        _finalize_download(task_mgr, tid, process, was_stopped)

    except Exception as e:
        try:
            if process and process.poll() is None:
                os.killpg(os.getpgid(process.pid), signal.SIGKILL)
                process.wait(timeout=2)
        except Exception:
            pass
        task_mgr.update(tid, status="failed", error=str(e)[:200])

    finally:
        _cleanup_download(task_mgr, tid, process, tmp_dir)
        # 下载结束，触发补位（启动排队中的任务）
        try:
            scheduler.queue_start()
        except Exception:
            pass


# ======================== 调度器 ========================

class Scheduler:
    """事件驱动调度器：无轮询，通过 try_submit / queue_start 驱动"""
    def __init__(self, task_mgr):
        self.tm = task_mgr
        self.executor = ThreadPoolExecutor(max_workers=20)
        self._submit_lock = threading.Lock()
        self._pause_at = 0  # stop_all 后置为时间戳；> 0 时 try_submit 拦截新任务为 stopped，queue_start 不补位

    def try_submit(self, tid, force=False):
        """提交任务：有空位则下载，无空位则排队。
        force=True 用于单个恢复/重试，忽略暂停状态。
        暂停期间（_pause_at > 0）非 force 提交直接标记 stopped。
        """
        with self._submit_lock:
            t = self.tm.tasks.get(tid)
            if not t:
                return False
            cfg = load_config()
            max_t = cfg.get("max_tasks", 3)
            active = sum(1 for t2 in self.tm.tasks.values()
                        if t2["status"] in ("downloading", "merging"))
            # 暂停期间：非 force 直接标记 stopped（不是 queued）
            if not force and self._pause_at > 0:
                self.tm.update(tid, status="stopped", speed="", eta="", error="", stop_requested=True)
                return False
            if active < max_t:
                self.tm.update(tid, status="downloading", speed="", eta="", error="", stop_requested=False)
                self.executor.submit(run_download, self.tm, tid)
                return True
            else:
                self.tm.update(tid, status="queued", speed="", eta="", error="", stop_requested=False)
                return False

    def queue_start(self):
        """补位：任务完成后调用，按创建顺序启动排队中的任务"""
        with self._submit_lock:
            # 暂停期间不自动补位
            if self._pause_at > 0:
                return
            cfg = load_config()
            max_t = cfg.get("max_tasks", 3)
            active = sum(1 for t in self.tm.tasks.values()
                        if t["status"] in ("downloading", "merging"))
            available = max_t - active
            if available <= 0:
                return
            queued = sorted(
                [t for t in self.tm.tasks.values()
                 if t["status"] == "queued"],
                key=lambda t: t.get("created_at", 0)
            )[:available]
            for t in queued:
                # 原子检查+认领：防止与 stop_all/pause 竞态覆盖 stop_requested
                claimed = False
                sse_data = None
                with self.tm.lock:
                    task = self.tm.tasks.get(t["id"])
                    if task and task["status"] == "queued" and not task.get("stop_requested"):
                        task["status"] = "downloading"
                        task["speed"] = ""
                        task["eta"] = ""
                        task["error"] = ""
                        task["stop_requested"] = False
                        self.tm.dirty = True
                        claimed = True
                        sse_data = {k: v for k, v in task.items() if k not in ("pid", "pgid", "stop_requested")}
                if claimed:
                    self.tm.sse.publish("task_update", sse_data)
                    self.executor.submit(run_download, self.tm, t["id"])


# ======================== Flask ========================

app = Flask(__name__, static_folder="static", template_folder="templates")
sse_manager = SSEManager()
tm = TaskManager(sse_manager)
scheduler = Scheduler(tm)

@app.after_request
def add_cors(resp):
    resp.headers["Access-Control-Allow-Origin"] = "*"
    resp.headers["Access-Control-Allow-Methods"] = "GET, POST, OPTIONS"
    resp.headers["Access-Control-Allow-Headers"] = "Content-Type"
    return resp


def _get_title(url):
    """快速获取视频标题"""
    cfg = load_config()
    cmd = [YTDLP, "--get-title", "--no-download", "--no-warnings", "--no-playlist", "--no-check-certificates"]
    cookies = cfg.get("cookies_file", "")
    if cookies and os.path.exists(cookies):
        cmd.extend(["--cookies", cookies])
    cmd.append(url)
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=15)
        if r.returncode == 0 and r.stdout.strip():
            return r.stdout.strip()[:200]
    except Exception as e:
        logger.debug("获取标题失败 %s: %s", url[:80], e)
    return None


def _get_format_info(url):
    """获取视频格式信息（时长、分辨率、HDR、帧率、编码、码率、大小）"""
    cfg = load_config()
    cookies = cfg.get("cookies_file", "")
    cookies_ok = cookies and os.path.exists(cookies)
    result = {}

    # ============ 第一步：yt-dlp ============
    try:
        ydl_opts = {
            'quiet': True, 'no_warnings': True, 'noplaylist': True,
            'skip_download': True, 'simulate': True,
        }
        if cookies_ok:
            ydl_opts['cookiefile'] = cookies
        info = yt_dlp_mod.YoutubeDL(ydl_opts).extract_info(url, download=False)
        if info:
            formats = info.get("formats", [])
            best_video = None
            for f in formats:
                vc = f.get("vcodec", "none") or "none"
                if vc == "none":
                    continue
                if not best_video or (f.get("height") or 0) > (best_video.get("height") or 0) or \
                   ((f.get("height") or 0) == (best_video.get("height") or 0) and (f.get("tbr") or 0) > (best_video.get("tbr") or 0)):
                    best_video = f
            if not best_video:
                vc = info.get("vcodec", "none") or "none"
                if vc != "none" and info.get("width") and info.get("height"):
                    best_video = info
            src = best_video or info

            w, h = src.get("width"), src.get("height")
            if w and h:
                result["resolution"] = f"{w}x{h}"
            if src.get("fps"):
                result["fps"] = src["fps"]
            vc = src.get("vcodec", "")
            if vc and vc != "none":
                result["vcodec"] = vc
            if src.get("tbr"):
                result["tbr"] = src["tbr"]
            hdr = src.get("dynamic_range", "")
            if hdr:
                result["hdr"] = hdr
            dur = info.get("duration") or src.get("duration")
            if dur:
                result["duration"] = round(dur)
                result["duration_str"] = fmt_duration(dur)
            size = src.get("filesize") or src.get("filesize_approx") or info.get("filesize") or info.get("filesize_approx")
            if size:
                result["filesize"] = size

            need_keys = {"resolution", "fps", "vcodec", "hdr", "tbr", "duration", "filesize"}
            if need_keys <= result.keys():
                return result
    except Exception:
        pass

    # ============ 第二步：HEAD 补文件大小（m3u8 跳过，HEAD 返回的是播放列表大小，不准确） ============
    if "filesize" not in result and _get_url_type(url) != 'm3u8':
        try:
            req = Request(url, method='HEAD')
            req.add_header('User-Agent', 'Mozilla/5.0')
            with urlopen(req, timeout=5) as resp:
                cl = resp.headers.get('Content-Length')
                if cl and int(cl) > 0:
                    result["filesize"] = int(cl)
        except Exception:
            pass

    # ============ 第三步：ffprobe 补分辨率/帧率/编码/HDR ============
    need_video = {"resolution", "fps", "vcodec", "hdr"} - result.keys()
    if need_video:
        tmp_probe = os.path.join("/tmp", f"probe_{uuid.uuid4().hex[:8]}.mp4")
        try:
            probe_cmd = [
                YTDLP, "--no-warnings", "--no-check-certificates", "--no-playlist",
                "-o", tmp_probe, "--download-sections", "*0-1",
            ]
            if cookies_ok:
                probe_cmd.extend(["--cookies", cookies])
            probe_cmd.append(url)
            subprocess.run(probe_cmd, capture_output=True, text=True, timeout=30)
            if os.path.exists(tmp_probe):
                fr = subprocess.run(
                    ["ffprobe", "-v", "quiet", "-print_format", "json", "-show_streams", tmp_probe],
                    capture_output=True, text=True, timeout=10
                )
                if fr.returncode == 0:
                    for s in json.loads(fr.stdout).get("streams", []):
                        if s.get("codec_type") == "video":
                            w, h = s.get("width"), s.get("height")
                            if w and h:
                                result["resolution"] = f"{w}x{h}"
                            fps_str = s.get("r_frame_rate", "")
                            if fps_str and "/" in fps_str:
                                num, den = fps_str.split("/")
                                if int(den) > 0:
                                    result["fps"] = round(int(num) / int(den))
                            vc = s.get("codec_name", "")
                            if vc:
                                result["vcodec"] = vc
                            pix = s.get("pix_fmt", "")
                            ct = s.get("color_transfer", "")
                            cp = s.get("color_primaries", "")
                            if "dolby" in ct or "dolby" in cp or "smpte2094" in ct:
                                result["hdr"] = "Dolby Vision"
                            elif "smpte2084" in ct or "pq" in pix:
                                result["hdr"] = "HDR10"
                            elif "arib-std-b67" in ct or "hlg" in pix:
                                result["hdr"] = "HDR HLG"
                            elif "p010" in pix:
                                result["hdr"] = "HDR"
                            else:
                                result["hdr"] = "SDR"
                            break
        except Exception:
            pass
        finally:
            try:
                os.remove(tmp_probe)
            except Exception:
                pass

    return result if result else None


@app.route("/")
def index():
    return render_template("index.html")


@app.route("/api/parse", methods=["POST"])
def api_parse():
    url = (request.json.get("url") or "").strip()
    if not url:
        return jsonify({"status": "error", "msg": "URL 不能为空"})
    if not _is_valid_url(url):
        return jsonify({"status": "error", "msg": "URL 格式无效，请检查是否包含多余空格或特殊字符"})
    try:
        info = parse_url(url)
        return jsonify({"status": "ok", "data": info})
    except subprocess.TimeoutExpired:
        return jsonify({"status": "error", "msg": "解析超时"})
    except Exception as e:
        return jsonify({"status": "error", "msg": str(e)[:200]})


@app.route("/api/download", methods=["POST"])
def api_download():
    data = request.json
    url = (data.get("url") or "").strip()
    title = (data.get("title") or "").strip()
    fmt = data.get("format_spec", "bestvideo*+bestaudio/best")
    format_info = data.get("format_info") or {}
    if not url:
        return jsonify({"status": "error", "msg": "链接不能为空"})
    if not _is_valid_url(url):
        return jsonify({"status": "error", "msg": "URL 格式无效，请检查是否包含多余空格或特殊字符"})
    if not title:
        title = "获取中..."
    tid = tm.create(url, title, fmt, format_info)
    if not tid:
        return jsonify({"status": "error", "msg": "创建任务失败"})

    # 先提交调度（设状态 + 发 SSE），再获取标题和参数
    scheduler.try_submit(tid)

    t = tm.get(tid)
    if t:
        _fetch_title_if_needed(tm, tid, t)
        _probe_format_async(tm, tid, t)

    return jsonify({"status": "ok", "data": {"task_id": tid}})


@app.route("/api/tasks")
def api_tasks():
    tasks = {}
    for t in tm.all():
        c = {k: v for k, v in t.items() if k not in ("pid", "pgid", "stop_requested")}
        tasks[t["id"]] = c
    resp = jsonify({"status": "ok", "data": tasks})
    resp.headers["Cache-Control"] = "no-store, no-cache, must-revalidate, max-age=0"
    resp.headers["Pragma"] = "no-cache"
    return resp


@app.route("/api/pause", methods=["POST"])
def api_pause():
    tid = request.json.get("task_id")
    tm.stop_and_update(tid)
    return jsonify({"status": "ok"})


@app.route("/api/resume", methods=["POST"])
def api_resume():
    tid = request.json.get("task_id")
    t = tm.get(tid)
    if not t or t["status"] != "stopped":
        return jsonify({"status": "error", "msg": "只能恢复已暂停的任务"})
    scheduler.try_submit(tid, force=True)
    return jsonify({"status": "ok"})


@app.route("/api/retry", methods=["POST"])
def api_retry():
    tid = request.json.get("task_id")
    t = tm.get(tid)
    if not t or t["status"] not in ("failed", "stopped"):
        return jsonify({"status": "error", "msg": "只能重试失败或暂停的任务"})
    scheduler.try_submit(tid, force=True)
    return jsonify({"status": "ok"})


@app.route("/api/delete", methods=["POST"])
def api_delete():
    tid = request.json.get("task_id")
    tm.delete(tid)
    return jsonify({"status": "ok"})


@app.route("/api/stop_all", methods=["POST"])
def api_stop_all():
    scheduler._pause_at = time.time()
    for t in tm.all():
        if t["status"] in ("queued", "downloading", "merging"):
            tm.stop_and_update(t["id"])
    return jsonify({"status": "ok"})


@app.route("/api/resume_all", methods=["POST"])
def api_resume_all():
    """批量恢复暂停的任务，按创建时间顺序启动"""
    scheduler._pause_at = 0
    stopped_tasks = sorted(
        [t for t in tm.all() if t["status"] == "stopped"],
        key=lambda t: t.get("created_at", 0)
    )
    if not stopped_tasks:
        return jsonify({"status": "ok", "msg": "没有需要继续的任务"})

    started = 0
    queued = 0
    for t in stopped_tasks:
        if scheduler.try_submit(t["id"]):
            started += 1
        else:
            queued += 1

    return jsonify({"status": "ok", "started": started, "queued": queued})


@app.route("/api/clear", methods=["POST"])
def api_clear():
    # 只清除已完成的任务记录（不删除文件）
    for t in tm.all():
        if t["status"] == "finished":
            tm.delete(t["id"])
    return jsonify({"status": "ok"})


@app.route("/api/config", methods=["GET"])
def api_get_config():
    return jsonify({"status": "ok", "data": load_config()})


@app.route("/api/config", methods=["POST"])
def api_set_config():
    data = request.json
    if not data:
        return jsonify({"status": "error", "msg": "无效数据"}), 400
    # 校验字段
    errors = []
    if "max_tasks" in data:
        try:
            v = int(data["max_tasks"])
            if not (1 <= v <= 20):
                errors.append("max_tasks 需在 1-20 之间")
        except (ValueError, TypeError):
            errors.append("max_tasks 必须是整数")
    if "thread_count" in data:
        try:
            v = int(data["thread_count"])
            if not (1 <= v <= 64):
                errors.append("thread_count 需在 1-64 之间")
        except (ValueError, TypeError):
            errors.append("thread_count 必须是整数")
    if "concurrent_fragments" in data:
        try:
            v = int(data["concurrent_fragments"])
            if not (1 <= v <= 32):
                errors.append("concurrent_fragments 需在 1-32 之间")
        except (ValueError, TypeError):
            errors.append("concurrent_fragments 必须是整数")
    if "download_dir" in data:
        d = data["download_dir"]
        if not d or not isinstance(d, str):
            errors.append("download_dir 不能为空")
        elif os.path.isabs(d) and not d.startswith("/app/downloads"):
            errors.append("download_dir 仅允许在 /app/downloads 下")
    if "routing_rules" in data:
        rules = data["routing_rules"]
        if not isinstance(rules, list):
            errors.append("routing_rules 必须是数组")
        else:
            for i, r in enumerate(rules):
                if not isinstance(r, dict):
                    errors.append(f"路由规则第{i+1}条格式错误")
                    continue
                if r.get("match_type") not in ("url_type", "domain"):
                    errors.append(f"路由规则第{i+1}条匹配类型必须是 url_type 或 domain")
                if not r.get("pattern"):
                    errors.append(f"路由规则第{i+1}条缺少匹配关键词")
                d = r.get("dir", "")
                if not d or not isinstance(d, str):
                    errors.append(f"路由规则第{i+1}条缺少目录路径")
                elif os.path.isabs(d) and not d.startswith("/app/downloads"):
                    errors.append(f"路由规则第{i+1}条目录仅允许在 /app/downloads 下")
    if errors:
        return jsonify({"status": "error", "msg": "；".join(errors)}), 400
    cfg = save_config(data)
    return jsonify({"status": "ok", "data": cfg})


@app.route("/api/events")
def api_events():
    """SSE 事件流"""
    def generate():
        q = sse_manager.subscribe()
        if q is None:
            yield "event: error\ndata: {\"msg\":\"连接数已满\"}\n\n"
            return
        try:
            # 发送初始连接成功消息
            yield "event: connected\ndata: {}\n\n"
            
            while True:
                try:
                    event_type, data = q.get(timeout=30)
                    yield f"event: {event_type}\ndata: {json.dumps(data, ensure_ascii=False)}\n\n"
                except queue.Empty:
                    # 心跳，保持连接
                    yield ": heartbeat\n\n"
        except GeneratorExit:
            pass
        finally:
            sse_manager.unsubscribe(q)
    
    return Response(
        generate(),
        mimetype='text/event-stream',
        headers={
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
            'X-Accel-Buffering': 'no'
        }
    )
