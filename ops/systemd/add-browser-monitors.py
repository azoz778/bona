"""Create (or find) the Uptime Kuma push monitors "Bona daily post — tiktok" / "— linkedin" and store
their push URLs where the browser publisher reads them: ~/bona-data/daily/heartbeat-<channel>.url (0600).
Same shape as monitors 30/31 ("Bona daily post — instagram" / "— facebook"): Telegram on change, no retries.

  TikTok posts every day           -> 26 h backstop (93,600 s), like Instagram/Facebook.
  LinkedIn posts Sunday-Thursday   -> 76 h backstop (273,600 s): Thursday 09:30 to Sunday 10:30 is 73 h.

A run's own "down" (blocked by an uncertain post, or no post by the last timer run) alerts at once;
the backstop only catches runs that never happen. New monitors start PAUSED; pass --resume to start them.

Run with the Kuma tunnel open (docs/browser-publishing.md):
  ssh -f -N -L 13010:127.0.0.1:3010 hermes-vps
  uv run --exclude-newer 2026-10-09 --with uptime-kuma-api==1.2.1 python3 ops/systemd/add-browser-monitors.py [--resume]
"""
import os
import secrets
import string
import sys

from uptime_kuma_api import MonitorType, UptimeKumaApi

MONITORS = {"tiktok": 93600, "linkedin": 273600}
DATA = os.path.expanduser(os.environ.get("BONA_DATA", "~/bona-data"))
NOTIFICATION = "Telegram — Hermes bot → owner"


class Api(UptimeKumaApi):  # same override as add-homelab-monitors.py: new push monitors start paused with a 32-char token
    def _build_monitor_data(self, **kw):
        data = super()._build_monitor_data(**kw)
        if kw["type"] == MonitorType.PUSH:
            data["active"] = False
            data["pushToken"] = "".join(secrets.choice(string.ascii_letters + string.digits) for _ in range(32))
        return data


def read_env(path):
    env = {}
    with open(os.path.expanduser(path), encoding="utf-8") as handle:
        for line in handle:
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                key, value = line.split("=", 1)
                env[key] = value.strip("'\"")
    return env


def main():
    env = read_env("~/.secrets/uptime-kuma.env")
    api = Api(os.environ.get("KUMA_API_URL", "http://127.0.0.1:13010"), timeout=60)
    api.login(env["KUMA_USER"], env["KUMA_PASSWORD"])
    try:
        os.makedirs(os.path.join(DATA, "daily"), exist_ok=True)
        for channel, interval in MONITORS.items():
            name = f"Bona daily post — {channel}"
            monitor = next((m for m in api.get_monitors() if m["name"] == name), None)
            if monitor is None:
                # Only a new monitor needs the notification; an existing one keeps its own.
                nid = next((n["id"] for n in api.get_notifications() if n["name"] == NOTIFICATION), None)
                if nid is None:
                    sys.exit(f"Kuma has no notification named {NOTIFICATION!r}; {name!r} was not created (nothing else changed)")
                created = api.add_monitor(type=MonitorType.PUSH, name=name, interval=interval, maxretries=0,
                                          notificationIDList={nid: True})
                monitor = api.get_monitor(created["monitorID"])
            if "--resume" in sys.argv and not monitor["active"]:
                api.resume_monitor(monitor["id"])
            out = os.path.join(DATA, "daily", f"heartbeat-{channel}.url")
            fd = os.open(out, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
            with os.fdopen(fd, "w") as handle:
                handle.write(f"{env['KUMA_URL'].rstrip('/')}/api/push/{monitor['pushToken']}\n")
            os.chmod(out, 0o600)
            active = monitor["active"] or "--resume" in sys.argv
            print(f"{name}: id={monitor['id']} interval={monitor.get('interval')} active={active} (push URL in {out}, not shown)")
    finally:
        api.disconnect()


if __name__ == "__main__":
    main()
