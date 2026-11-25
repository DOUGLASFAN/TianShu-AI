"""Read-only environment inventory for S01-01; no installs or service changes.

Run with: py -3.12 scripts/check_environment.py --output docs/evidence/environment-2026-11-12.json
An exit code of zero means inventory finished, not that every dependency is ready.
"""

import argparse
import json
import locale
import platform
import shutil
import socket
import subprocess
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path


def decode(raw):
    if raw and raw.count(b"\x00") > len(raw) // 5:
        return raw.decode("utf-16-le", errors="replace").strip()
    for encoding in ("utf-8-sig", locale.getpreferredencoding(False), "gb18030"):
        try:
            return raw.decode(encoding).strip()
        except (UnicodeDecodeError, LookupError):
            pass
    return raw.decode("utf-8", errors="replace").strip()


def probe(command, timeout=12):
    executable = shutil.which(command[0])
    result = {"command": command, "executable": executable}
    if not executable:
        return dict(result, status="not_on_path")
    args = [executable, *command[1:]]
    if Path(executable).suffix.lower() in (".cmd", ".bat"):
        args = ["cmd.exe", "/d", "/c", *args]
    try:
        completed = subprocess.run(args, capture_output=True, timeout=timeout)
        return dict(result, status="ok" if completed.returncode == 0 else "failed",
                    exit_code=completed.returncode, stdout=decode(completed.stdout),
                    stderr=decode(completed.stderr))
    except subprocess.TimeoutExpired:
        return dict(result, status="timeout", timeout_seconds=timeout)
    except OSError as error:
        return dict(result, status="failed_to_start", error=str(error))


def installed_apps():
    import winreg
    matches = []
    errors = []
    targets = ("docker", "postgresql", "redis ", "redis-", "memurai", "google chrome", "microsoft edge")
    for hive, root_name in ((winreg.HKEY_LOCAL_MACHINE, "HKLM"), (winreg.HKEY_CURRENT_USER, "HKCU")):
        for view in (winreg.KEY_WOW64_64KEY, winreg.KEY_WOW64_32KEY):
            try:
                with winreg.OpenKey(hive, r"SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall", 0,
                                    winreg.KEY_READ | view) as root:
                    for index in range(winreg.QueryInfoKey(root)[0]):
                        try:
                            with winreg.OpenKey(root, winreg.EnumKey(root, index)) as app:
                                name = winreg.QueryValueEx(app, "DisplayName")[0]
                                if not name.lower().startswith(targets):
                                    continue
                                item = {"name": name, "registry_hive": root_name}
                                for field in ("DisplayVersion", "InstallLocation"):
                                    try:
                                        item[field] = winreg.QueryValueEx(app, field)[0]
                                    except OSError:
                                        item[field] = None
                                if item not in matches:
                                    matches.append(item)
                        except OSError:
                            continue
            except OSError as error:
                errors.append({"hive": root_name, "view": view, "error": str(error)})
    return {"matches": matches, "errors": errors,
            "scope": "Uninstall registry only; portable/custom installations can be absent."}


def tcp_probe(port):
    try:
        with socket.create_connection(("127.0.0.1", port), timeout=0.6):
            return {"port": port, "tcp_open": True, "protocol_verified": False}
    except OSError:
        return {"port": port, "tcp_open": False, "protocol_verified": False}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    commands = {
        "node": ["node", "--version"], "npm": ["npm.cmd", "--version"],
        "pnpm": ["pnpm.cmd", "--version"], "git": ["git", "--version"],
        "python_default": ["python", "--version"], "python_launcher": ["py", "-0p"],
        "python312": ["py", "-3.12", "--version"],
        "pip312": ["py", "-3.12", "-m", "pip", "--version"],
        "python312_modules": ["py", "-3.12", "-c",
                              "import sys,ssl,venv,ensurepip; print(sys.executable); print(ssl.OPENSSL_VERSION); print('venv and ensurepip import OK')"],
        "docker_client": ["docker", "--version"],
        "docker_server": ["docker", "info", "--format", "{{.ServerVersion}}"],
        "compose": ["docker", "compose", "version"],
        "postgres_client": ["psql", "--version"], "redis_client": ["redis-cli", "--version"],
        "wsl_status": ["wsl", "--status"], "wsl_distributions": ["wsl", "--list", "--quiet"],
        "services": ["powershell.exe", "-NoProfile", "-Command",
                     "$v=@(Get-Service -ErrorAction Stop | Where-Object {$_.Name -match 'docker|postgres|redis|memurai'} | Select-Object Name,Status); ConvertTo-Json -InputObject $v"],
    }
    checks = {key: probe(command) for key, command in commands.items()}
    apps = installed_apps() if sys.platform == "win32" else {"matches": [], "errors": []}
    browsers = []
    for app in apps["matches"]:
        if app["name"] not in ("Google Chrome", "Microsoft Edge"):
            continue
        executable = Path(app.get("InstallLocation") or "") / (
            "chrome.exe" if app["name"] == "Google Chrome" else "msedge.exe")
        browsers.append({"name": app["name"], "registered_version": app.get("DisplayVersion"),
                         "path": str(executable), "file_exists": executable.is_file(),
                         "webgl_verified": False, "browser_launch_verified": False})
    disks = {}
    for drive in ("C:/", "D:/"):
        if Path(drive).exists():
            usage = shutil.disk_usage(drive)
            disks[drive] = {"free_gib": round(usage.free / (1024 ** 3), 2)}
    report = {
        "task": "S01-01", "checked_at": datetime.now(timezone(timedelta(hours=8))).isoformat(),
        "result_meaning": "Inventory complete; missing tools are findings, not installed by this script.",
        "platform": {"system": platform.system(), "release": platform.release(),
                     "version": platform.version(), "machine": platform.machine()},
        "inventory_python": sys.version, "checks": checks, "installed_apps": apps,
        "browsers": browsers, "localhost_ports": [tcp_probe(p) for p in (5173, 8000, 5432, 6379)],
        "disk": disks,
        "limits": ["No packages installed, no services started, no environment variables exported.",
                   "Closed default ports and registry/PATH absence do not prove no custom installation exists.",
                   "No browser launch/WebGL, project build, DB authentication or container startup verified."],
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"task": report["task"], "output": str(args.output),
                      "checks": {key: value["status"] for key, value in checks.items()},
                      "browser_count": len(browsers)}, ensure_ascii=True))


if __name__ == "__main__":
    main()
