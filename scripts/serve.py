"""一键启动：开伺服器、开对外通道、印出网址与 QR code。

用法（双击专案根目录的「启动.bat」就会跑这个）：
  .venv\Scripts\python.exe scripts\serve.py             # 对外模式（预设）
  .venv\Scripts\python.exe scripts\serve.py --no-tunnel # 只开区网，照片不离开你家
  .venv\Scripts\python.exe scripts\serve.py --port 8080

关掉视窗或按 Ctrl+C = 伺服器与通道一起收掉。
"""

import argparse
import json
import os
import re
import shutil
import signal
import socket
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
for _s in (sys.stdout, sys.stderr):
    try:
        _s.reconfigure(encoding="utf-8")
    except (AttributeError, ValueError):
        pass
sys.path.insert(0, str(ROOT))
os.chdir(ROOT)

from app.config import settings  # noqa: E402

RUNTIME_FILE = ROOT / "data" / "runtime.json"
TUNNEL_LOG = ROOT / "data" / "cloudflared.log"
SERVER_LOG = ROOT / "data" / "server.log"
TUNNEL_URL_RE = re.compile(r"https://[a-z0-9-]+\.trycloudflare\.com")
CLOUDFLARED_CANDIDATES = [
    r"C:\Program Files (x86)\cloudflared\cloudflared.exe",
    r"C:\Program Files\cloudflared\cloudflared.exe",
]

BAR = "=" * 62


def kill_on_exit_job():
    """把子行程绑进一个 Windows Job Object。

    只靠 Ctrl+C 的处理函式不够：使用者直接按视窗右上角的 X、或行程被强制结束时，
    Python 根本来不及跑清理，伺服器就会变成看不见的孤儿继续对外开放。
    Job Object 是作业系统层级的保险 —— 启动器一消失，子行程一律跟着结束。
    """
    if os.name != "nt":
        return None
    import ctypes
    from ctypes import wintypes

    JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x2000
    JobObjectExtendedLimitInformation = 9

    class IO_COUNTERS(ctypes.Structure):
        _fields_ = [(n, ctypes.c_ulonglong) for n in
                    ("ReadOperationCount", "WriteOperationCount", "OtherOperationCount",
                     "ReadTransferCount", "WriteTransferCount", "OtherTransferCount")]

    class JOBOBJECT_BASIC_LIMIT_INFORMATION(ctypes.Structure):
        _fields_ = [("PerProcessUserTimeLimit", wintypes.LARGE_INTEGER),
                    ("PerJobUserTimeLimit", wintypes.LARGE_INTEGER),
                    ("LimitFlags", wintypes.DWORD),
                    ("MinimumWorkingSetSize", ctypes.c_size_t),
                    ("MaximumWorkingSetSize", ctypes.c_size_t),
                    ("ActiveProcessLimit", wintypes.DWORD),
                    ("Affinity", ctypes.POINTER(wintypes.ULONG)),
                    ("PriorityClass", wintypes.DWORD),
                    ("SchedulingClass", wintypes.DWORD)]

    class JOBOBJECT_EXTENDED_LIMIT_INFORMATION(ctypes.Structure):
        _fields_ = [("BasicLimitInformation", JOBOBJECT_BASIC_LIMIT_INFORMATION),
                    ("IoInfo", IO_COUNTERS),
                    ("ProcessMemoryLimit", ctypes.c_size_t),
                    ("JobMemoryLimit", ctypes.c_size_t),
                    ("PeakProcessMemoryUsed", ctypes.c_size_t),
                    ("PeakJobMemoryUsed", ctypes.c_size_t)]

    try:
        k32 = ctypes.WinDLL("kernel32", use_last_error=True)
        # 一定要宣告 restype：不宣告的话 ctypes 当成 int32，64 位元的 handle 会被截断，
        # 後面每一个呼叫都会默默失败（这就是第一版没作用的原因）。
        k32.CreateJobObjectW.restype = wintypes.HANDLE
        k32.OpenProcess.restype = wintypes.HANDLE
        k32.GetCurrentProcess.restype = wintypes.HANDLE
        k32.AssignProcessToJobObject.argtypes = [wintypes.HANDLE, wintypes.HANDLE]
        k32.SetInformationJobObject.argtypes = [wintypes.HANDLE, wintypes.DWORD,
                                                ctypes.c_void_p, wintypes.DWORD]

        job = k32.CreateJobObjectW(None, None)
        if not job:
            return None
        info = JOBOBJECT_EXTENDED_LIMIT_INFORMATION()
        info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
        if not k32.SetInformationJobObject(job, JobObjectExtendedLimitInformation,
                                           ctypes.byref(info), ctypes.sizeof(info)):
            return None
        # 把「自己」放进 job：之後开的子行程会自动继承，不必一个一个加。
        # 启动器一消失，job 关闭，整组跟着被作业系统收掉。
        if not k32.AssignProcessToJobObject(job, k32.GetCurrentProcess()):
            print("  （提醒：子行程保险机制没装上，请用 Ctrl+C 关闭而不要直接关视窗）")
            return None
        return job
    except Exception:
        return None


def adopt(job, proc):
    """保险的第二道：明确把子行程加进 job（继承失败时才会用到）。"""
    if not job:
        return
    try:
        import ctypes
        from ctypes import wintypes
        PROCESS_TERMINATE, PROCESS_SET_QUOTA = 0x0001, 0x0100
        k32 = ctypes.WinDLL("kernel32", use_last_error=True)
        k32.OpenProcess.restype = wintypes.HANDLE
        k32.AssignProcessToJobObject.argtypes = [wintypes.HANDLE, wintypes.HANDLE]
        handle = k32.OpenProcess(PROCESS_TERMINATE | PROCESS_SET_QUOTA, False, proc.pid)
        if handle:
            k32.AssignProcessToJobObject(job, handle)
            k32.CloseHandle(handle)
    except Exception:
        pass


def port_busy(port):
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        return s.connect_ex(("127.0.0.1", port)) == 0


def lan_ip():
    """本机在区网里的位址。连一个外部位址只是为了让系统选路由，不会真的送出封包。"""
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("8.8.8.8", 80))
        return s.getsockname()[0]
    except OSError:
        return "127.0.0.1"
    finally:
        s.close()


def find_cloudflared():
    found = shutil.which("cloudflared")
    if found:
        return found
    for path in CLOUDFLARED_CANDIDATES:
        if Path(path).is_file():
            return path
    return None


def wait_for_server(port, timeout=90):
    """等到伺服器真的应答为止 —— 模型载入要十几秒，丢出去就不管会印出还不能用的网址。"""
    import urllib.error
    import urllib.request
    deadline = time.time() + timeout
    url = f"http://127.0.0.1:{port}/api/stats"
    while time.time() < deadline:
        try:
            urllib.request.urlopen(url, timeout=3)
            return True
        except urllib.error.HTTPError:
            return True          # 401 也算活着（整站密码开着）
        except Exception:
            time.sleep(1)
    return False


def wait_for_tunnel_url(timeout=45):
    deadline = time.time() + timeout
    while time.time() < deadline:
        if TUNNEL_LOG.exists():
            m = TUNNEL_URL_RE.search(TUNNEL_LOG.read_text(encoding="utf-8", errors="ignore"))
            if m:
                return m.group(0)
        time.sleep(1)
    return None


def print_qr(url):
    try:
        import segno
    except ImportError:
        print("  （未安装 segno，跳过 QR code：.venv\Scripts\python.exe -m pip install segno）")
        return
    try:
        segno.make(url, error="m").terminal(out=sys.stdout, compact=True, border=2)
    except Exception as exc:
        print(f"  （QR code 画不出来：{exc}）")


def banner(port, ip, public_url, tunnel_wanted):
    pwd = settings.site_password or "（未设定 —— 任何人都进得来，请在 .env 设 SITE_PASSWORD）"
    print("\n" + BAR)
    print("  Event Face Matcher 已启动")
    print(BAR)
    if public_url:
        print("\n  [对外模式] 照片会经由 Cloudflare 中转，等於离开这台电脑。")
        print("             婚礼现场大家连同一个 WiFi 时，请改用 --no-tunnel。")
    elif tunnel_wanted:
        print("\n  [区网模式] 通道没开起来（见下方讯息），只有同一个 WiFi 连得到。")
    else:
        print("\n  [区网模式] 照片只在你的 WiFi 内传输，不会离开这台电脑。")

    print("\n  这台电脑：      http://127.0.0.1:%d" % port)
    print("  同一个 WiFi：   http://%s:%d" % (ip, port))
    if public_url:
        print("  外面也能连：    %s" % public_url)
    base = public_url or f"http://{ip}:{port}"

    if settings.site_access_token:
        qr_target = f"{base}/?k={settings.site_access_token}"
        print()
        print("  === 给来宾 ===")
        print("  手机扫下面这个 QR code 就直接进去了，不用输入任何东西。")
        print("  （钥匙藏在网址里，扫过之後会记住 %d 小时）" % settings.access_cookie_hours)
        print()
    else:
        qr_target = base
        print()
        print("  === 给来宾 ===")
        print("  扫 QR code 之後还要输入帐密（.env 里没设 SITE_ACCESS_TOKEN）：")
        print("    帐号：%s    密码：%s" % (settings.site_user, pwd))
        print()

    print_qr(qr_target)

    print()
    print("  === 给你自己（摄影师）===")
    print("  上传页：%s/admin" % base)
    print("  帐号：%s" % settings.site_user)
    print("  密码：%s" % pwd)
    print("  上传密钥（/admin 页面里填）：%s" % settings.admin_api_key)

    print("\n  关掉这个视窗或按 Ctrl+C = 网站关闭")
    print(BAR + "\n")


def main():
    ap = argparse.ArgumentParser(description="启动 Event Face Matcher")
    ap.add_argument("--no-tunnel", action="store_true", help="只开区网，照片不经过外部伺服器")
    ap.add_argument("--port", type=int, default=8000)
    ap.add_argument("--host", default="0.0.0.0")
    args = ap.parse_args()
    tunnel_wanted = not args.no_tunnel

    RUNTIME_FILE.parent.mkdir(parents=True, exist_ok=True)
    if port_busy(args.port):
        print(f"连接埠 {args.port} 已经有东西在跑了。")
        print("要嘛那是上一次没关乾净的伺服器，要嘛换一个 --port。")
        print("找出来并关掉：  powershell \"Get-NetTCPConnection -LocalPort %d -State Listen | "
              "ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }\"" % args.port)
        return 1

    job = kill_on_exit_job()
    procs = []

    def cleanup(*_):
        for p in procs:
            if p.poll() is None:
                p.terminate()
        for p in procs:
            try:
                p.wait(timeout=8)
            except subprocess.TimeoutExpired:
                p.kill()
        RUNTIME_FILE.unlink(missing_ok=True)

    signal.signal(signal.SIGINT, lambda *a: (cleanup(), sys.exit(0)))

    try:
        print("启动伺服器中…（第一次载入人脸模型要十几秒）")
        env = dict(os.environ, PYTHONIOENCODING="utf-8", EFM_LAUNCHER="1")
        server_out = open(SERVER_LOG, "wb")
        server = subprocess.Popen(
            [sys.executable, "-m", "uvicorn", "app.main:app", "--host", args.host,
             "--port", str(args.port)],
            cwd=str(ROOT), env=env, stdout=server_out, stderr=subprocess.STDOUT)
        adopt(job, server)
        procs.append(server)

        if not wait_for_server(args.port):
            print(f"\n伺服器没有在时限内启动。错误讯息在 {SERVER_LOG}：\n")
            print(SERVER_LOG.read_text(encoding="utf-8", errors="ignore")[-2000:])
            cleanup()
            return 1

        public_url = None
        if tunnel_wanted:
            exe = find_cloudflared()
            if not exe:
                print("找不到 cloudflared，改用区网模式。"
                      "（安装：winget install --id Cloudflare.cloudflared）")
            else:
                print("开启对外通道中…")
                TUNNEL_LOG.unlink(missing_ok=True)
                tunnel_out = open(TUNNEL_LOG, "wb")
                tunnel = subprocess.Popen(
                    [exe, "tunnel", "--url", f"http://localhost:{args.port}"],
                    stdout=tunnel_out, stderr=subprocess.STDOUT)
                adopt(job, tunnel)
                procs.append(tunnel)
                public_url = wait_for_tunnel_url()
                if not public_url:
                    print(f"通道没能在时限内建立，改用区网模式。日志：{TUNNEL_LOG}")

        ip = lan_ip()
        RUNTIME_FILE.write_text(json.dumps({
            "mode": "public" if public_url else "lan",
            "public_url": public_url,
            "lan_url": f"http://{ip}:{args.port}",
            "pid": os.getpid(),
            "started_at": time.strftime("%Y-%m-%d %H:%M:%S"),
        }, ensure_ascii=False), encoding="utf-8")

        banner(args.port, ip, public_url, tunnel_wanted)

        while True:
            for p in procs:
                if p.poll() is not None:
                    print("有行程结束了，收工。日志：%s / %s" % (SERVER_LOG, TUNNEL_LOG))
                    cleanup()
                    return 1
            time.sleep(1)
    except KeyboardInterrupt:
        pass
    finally:
        cleanup()
        print("已关闭。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
