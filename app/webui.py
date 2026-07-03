from app import app
import socket
import os
import logging

# 只屏蔽 werkzeug 的 HTTP 请求日志（GET /api/xxx 之类），保留 WARNING 以上的重要日志
logging.getLogger('werkzeug').setLevel(logging.ERROR)

def get_ip():
    # 方法1: UDP connect（最可靠，不需要实际网络）
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.settimeout(0.5)
        s.connect(("8.8.8.8", 80))
        ip = s.getsockname()[0]
        s.close()
        if ip and ip != "0.0.0.0":
            return ip
    except Exception:
        pass
    # 方法2: 遍历网络接口
    try:
        import netifaces
        for iface in netifaces.interfaces():
            addrs = netifaces.ifaddresses(iface).get(netifaces.AF_INET, [])
            for a in addrs:
                ip = a.get("addr", "")
                if ip and ip != "127.0.0.1" and not ip.startswith("169.254"):
                    return ip
    except Exception:
        pass
    # 方法3: hostname 解析
    try:
        ip = socket.gethostbyname(socket.gethostname())
        if ip and ip != "127.0.0.1":
            return ip
    except Exception:
        pass
    return "127.0.0.1"

if __name__ == "__main__":
    ip = get_ip()
    print(f"\n{'='*50}")
    print(f"  yt-dlp 下载器")
    print(f"  本地: http://127.0.0.1:5000")
    print(f"  局域网: http://{ip}:5000")
    print(f"{'='*50}\n")
    app.run(host="0.0.0.0", port=5000, debug=False, threaded=True)
