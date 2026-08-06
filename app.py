"""ReelWatchAI: local-only digital wellbeing alerts using Gradio + OpenCV."""
from __future__ import annotations

import datetime as dt
import sqlite3
import threading
import time
import winsound
from collections import deque
from pathlib import Path

import cv2
import gradio as gr
import numpy as np

ROOT = Path(__file__).parent
DB_PATH = ROOT / "wellbeing.db"
WINDOW_SECONDS = 120
CONTINUOUS_SECONDS = 300


class Monitor:
    def __init__(self):
        self.lock = threading.Lock()
        self.camera: cv2.VideoCapture | None = None
        self.running = False
        self.previous_gray: np.ndarray | None = None
        self.previous_y: float | None = None
        self.last_gesture_at = 0.0
        self.session_started = 0.0
        self.last_swipe_at = 0.0
        self.swipes: deque[float] = deque()
        self.alert_id: int | None = None
        self.alert_started = 0.0
        self.alert_reason = ""

    def start(self):
        with self.lock:
            if self.running:
                return "Camera is already monitoring."
            self.camera = cv2.VideoCapture(0, cv2.CAP_DSHOW)
            if not self.camera.isOpened():
                self.camera.release()
                self.camera = None
                return "Could not open webcam. Check that another app is not using it."
            self.camera.set(cv2.CAP_PROP_FRAME_WIDTH, 640)
            self.camera.set(cv2.CAP_PROP_FRAME_HEIGHT, 480)
            self.running = True
            self.previous_gray = None
            self.previous_y = None
            return "Monitoring your local webcam."

    def stop(self):
        with self.lock:
            self.running = False
            if self.camera:
                self.camera.release()
                self.camera = None
            self.previous_gray = None
            self.previous_y = None
            return "Camera monitoring stopped."

    def reset_session(self):
        self.session_started = 0.0
        self.last_swipe_at = 0.0
        self.swipes.clear()
        self.previous_y = None

    def add_swipe(self, now: float):
        if self.last_swipe_at and now - self.last_swipe_at > app_settings["timeout"]:
            self.reset_session()
        if not self.session_started:
            self.session_started = now
        self.last_swipe_at = now
        self.swipes.append(now)
        while self.swipes and now - self.swipes[0] > WINDOW_SECONDS:
            self.swipes.popleft()

    def detect_gesture(self, frame: np.ndarray) -> bool:
        """Detect substantial upward movement using frame differencing in OpenCV."""
        reduced = cv2.resize(frame, (160, 120))
        gray = cv2.GaussianBlur(cv2.cvtColor(reduced, cv2.COLOR_BGR2GRAY), (7, 7), 0)
        if self.previous_gray is None:
            self.previous_gray = gray
            return False
        diff = cv2.absdiff(gray, self.previous_gray)
        self.previous_gray = gray
        _, mask = cv2.threshold(diff, 28, 255, cv2.THRESH_BINARY)
        mask = cv2.morphologyEx(mask, cv2.MORPH_OPEN, np.ones((3, 3), np.uint8))
        contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        valid = [c for c in contours if cv2.contourArea(c) > 115]
        if not valid:
            return False
        contour = max(valid, key=cv2.contourArea)
        moments = cv2.moments(contour)
        if not moments["m00"]:
            return False
        y = moments["m01"] / moments["m00"]
        now = time.time()
        upward = self.previous_y is not None and y < self.previous_y - 13 and now - self.last_gesture_at > 0.7
        self.previous_y = y
        if upward:
            self.last_gesture_at = now
        return upward

    def next_frame(self):
        with self.lock:
            if not self.running or not self.camera:
                return None, False
            ok, frame = self.camera.read()
            if not ok:
                return None, False
            return frame, self.detect_gesture(frame)


monitor = Monitor()
app_settings = {"enabled": True, "threshold": 20, "timeout": 45, "volume": 80, "snooze_until": 0.0}


def init_db():
    with sqlite3.connect(DB_PATH) as conn:
        conn.execute("""CREATE TABLE IF NOT EXISTS alerts (
            id INTEGER PRIMARY KEY, timestamp TEXT NOT NULL, session_duration REAL NOT NULL,
            swipe_count INTEGER NOT NULL, swipe_rate REAL NOT NULL, reason TEXT NOT NULL,
            alert_duration REAL NOT NULL DEFAULT 0
        )""")


def log_alert(reason: str) -> int:
    duration = time.time() - monitor.session_started if monitor.session_started else 0
    rate = len(monitor.swipes) / max(duration / 60, 1 / 60)
    with sqlite3.connect(DB_PATH) as conn:
        cur = conn.execute("INSERT INTO alerts(timestamp, session_duration, swipe_count, swipe_rate, reason) VALUES(?,?,?,?,?)",
            (dt.datetime.now().isoformat(timespec="seconds"), duration, len(monitor.swipes), rate, reason))
        return cur.lastrowid


def finish_alert():
    if monitor.alert_id is None:
        return
    with sqlite3.connect(DB_PATH) as conn:
        conn.execute("UPDATE alerts SET alert_duration=? WHERE id=?", (time.time() - monitor.alert_started, monitor.alert_id))
    monitor.alert_id = None
    monitor.alert_started = 0.0


def warning_sound():
    def play():
        for _ in range(3):
            winsound.Beep(1050, 210)
            time.sleep(.12)
    threading.Thread(target=play, daemon=True).start()


def maybe_alert():
    if not app_settings["enabled"] or time.time() < app_settings["snooze_until"] or monitor.alert_id:
        return None
    duration = time.time() - monitor.session_started if monitor.session_started else 0
    reason = None
    if len(monitor.swipes) > app_settings["threshold"]:
        reason = "More than 20 upward swipes in two minutes"
    elif duration > CONTINUOUS_SECONDS:
        reason = "Continuous scrolling exceeded five minutes"
    if reason:
        monitor.alert_id = log_alert(reason)
        monitor.alert_started = time.time()
        monitor.alert_reason = reason
        warning_sound()
        return reason
    return None


def report_html():
    today = dt.date.today().isoformat()
    week = (dt.date.today() - dt.timedelta(days=6)).isoformat()
    with sqlite3.connect(DB_PATH) as conn:
        today_rows = conn.execute("SELECT timestamp, swipe_count, session_duration, reason FROM alerts WHERE date(timestamp)=? ORDER BY id DESC", (today,)).fetchall()
        week_rows = conn.execute("SELECT date(timestamp), count(*) FROM alerts WHERE date(timestamp)>=? GROUP BY date(timestamp)", (week,)).fetchall()
    count, total_swipes, seconds = len(today_rows), sum(r[1] for r in today_rows), sum(r[2] for r in today_rows)
    bars = dict(week_rows)
    labels = []
    for offset in range(6, -1, -1):
        day = dt.date.today() - dt.timedelta(days=offset)
        labels.append(f"<div class='bar-wrap'><i style='height:{max(3, bars.get(day.isoformat(), 0)*28)}px'></i><b>{bars.get(day.isoformat(), 0)}</b><small>{day.strftime('%a')}</small></div>")
    rows = "".join(f"<li><b>{r[3]}</b><span>{dt.datetime.fromisoformat(r[0]).strftime('%H:%M')} · {r[1]} swipes · {int(r[2]//60)} min</span></li>" for r in today_rows) or "<li class='muted'>No wellbeing alerts today. Keep it intentional.</li>"
    return f"""<div class='report'><div class='stats'><div><b>{count}</b><span>alerts today</span></div><div><b>{total_swipes}</b><span>swipes at alert</span></div><div><b>{int(seconds//60)}m</b><span>scroll time</span></div></div><h3>Weekly alerts</h3><div class='bars'>{''.join(labels)}</div><h3>Today’s activity</h3><ul>{rows}</ul></div>"""


def panel(alert=False):
    if alert:
        return f"<div class='alert'><strong>Take a short break</strong><p>You've been scrolling for a while. Consider pausing for a moment.</p><small>{monitor.alert_reason}</small></div>"
    if not monitor.running:
        return "<div class='state'><b>Camera off</b><span>Start monitoring to use your local webcam.</span></div>"
    if app_settings["snooze_until"] > time.time():
        return "<div class='state'><b>Alerts snoozed</b><span>Monitoring continues, but alerts are paused.</span></div>"
    return "<div class='state live'><b>Monitoring locally</b><span>OpenCV is watching for deliberate upward gestures.</span></div>"


def poll():
    frame, swipe = monitor.next_frame()
    if frame is None:
        return None, panel(), "0", "0/min", "0:00", report_html()
    if swipe:
        monitor.add_swipe(time.time())
    if monitor.last_swipe_at and time.time() - monitor.last_swipe_at > app_settings["timeout"]:
        monitor.reset_session()
    alert = maybe_alert()
    duration = time.time() - monitor.session_started if monitor.session_started else 0
    seconds = int(duration)
    rate = round(len(monitor.swipes) / max(duration / 60, 1 / 60)) if duration else 0
    color = (102, 117, 255) if monitor.alert_id else (85, 255, 196)
    cv2.rectangle(frame, (5, 5), (frame.shape[1]-6, frame.shape[0]-6), color, 8 if monitor.alert_id else 3)
    cv2.putText(frame, f"Swipes: {len(monitor.swipes)} | {seconds//60:02}:{seconds%60:02}", (22, 38), cv2.FONT_HERSHEY_SIMPLEX, .72, color, 2)
    return cv2.cvtColor(frame, cv2.COLOR_BGR2RGB), panel(bool(monitor.alert_id)), str(len(monitor.swipes)), f"{rate}/min", f"{seconds//60}:{seconds%60:02}", report_html()


def start_monitoring():
    return monitor.start(), panel(), report_html()


def stop_monitoring():
    finish_alert()
    return monitor.stop(), panel(), report_html()


def set_settings(enabled, threshold, timeout, volume):
    app_settings.update(enabled=enabled, threshold=int(threshold), timeout=int(timeout), volume=int(volume))
    return panel(bool(monitor.alert_id))


def snooze(minutes):
    finish_alert()
    app_settings["snooze_until"] = time.time() + minutes * 60
    monitor.reset_session()
    return panel(), report_html()


def dismiss():
    finish_alert()
    monitor.reset_session()
    return panel(), report_html()


CSS = """
body{background:#07111f}.gradio-container{max-width:1160px!important;color:#e9edf2!important}.hero{padding:18px 0}.hero h1{font-size:42px;margin:0;color:#e9edf2}.hero p,.muted{color:#91a0b2}.eyebrow{font-size:11px;letter-spacing:2px;color:#c4ff55}.state,.alert{border:1px solid #2b4969;border-radius:12px;padding:17px;background:#0e2035;color:#e9edf2}.state b,.state span{display:block}.state span{font-size:12px;color:#9dacbe;margin-top:5px}.live b{color:#c4ff55}.alert{border-color:#ff7566;background:#2a1720;animation:pulse .8s infinite}.alert strong{font-size:19px;color:#ffd1ca}.alert p{margin:7px 0}.alert small{color:#ffac9f}@keyframes pulse{50%{box-shadow:0 0 20px #ff756655}}.metric{border:1px solid #29445f;border-radius:12px;background:#0e2035;padding:16px;text-align:center}.metric b{font-size:30px;color:#c4ff55;display:block}.metric span{color:#99a9b9;font-size:12px}.report{background:#0e2035;border:1px solid #29445f;border-radius:12px;padding:17px}.stats{display:flex;gap:30px}.stats b,.stats span{display:block}.stats b{font-size:26px;color:#c4ff55}.stats span,li span{color:#94a5b7;font-size:11px}.report h3{font-size:13px;margin:20px 0 8px}.bars{height:90px;display:flex;align-items:end;gap:16px;border-bottom:1px solid #29445f}.bar-wrap{height:100%;width:28px;display:flex;flex-direction:column;justify-content:end;align-items:center;gap:3px}.bar-wrap i{width:20px;background:#c4ff55;border-radius:3px 3px 0 0}.bar-wrap b,.bar-wrap small{font-size:10px;color:#aab8c6}ul{padding:0;margin:0;list-style:none}li{padding:9px 0;border-top:1px solid #29445f}li b,li span{display:block}button.primary{background:#c4ff55!important;color:#112014!important;border:0!important}
"""


def build_app():
    with gr.Blocks(title="ReelWatchAI — Digital Wellbeing", css=CSS, theme=gr.themes.Base()) as ui:
        gr.HTML("<div class='hero'><p class='eyebrow'>LOCAL-ONLY DIGITAL WELLBEING</p><h1>ReelWatchAI</h1><p>OpenCV-powered personal wellbeing reminders. Video stays on your device.</p></div>")
        with gr.Row():
            with gr.Column(scale=7):
                camera_view = gr.Image(label="Local webcam preview", height=410, streaming=True)
                with gr.Row():
                    start = gr.Button("Start local camera", variant="primary")
                    stop = gr.Button("Stop camera")
                status = gr.Markdown("Ready to start local camera monitoring.")
                notice = gr.HTML(panel())
            with gr.Column(scale=5):
                with gr.Row():
                    swipe_metric = gr.HTML("<div class='metric'><b>0</b><span>total swipes</span></div>")
                    rate_metric = gr.HTML("<div class='metric'><b>0/min</b><span>average pace</span></div>")
                    time_metric = gr.HTML("<div class='metric'><b>0:00</b><span>session time</span></div>")
                gr.Markdown("### Personal boundaries")
                enabled = gr.Checkbox(label="Enable alerts", value=True)
                threshold = gr.Slider(5, 60, value=20, step=1, label="Swipe threshold in 2 minutes")
                timeout = gr.Dropdown([30, 45, 60, 120], value=45, label="New session after inactivity (seconds)")
                volume = gr.Slider(0, 100, value=80, step=5, label="Warning sound volume")
                gr.Markdown("### Snooze alerts")
                with gr.Row():
                    snooze5, snooze10, snooze30 = gr.Button("5 min"), gr.Button("10 min"), gr.Button("30 min")
                dismiss_button = gr.Button("I’ll take a break")
        gr.Markdown("## Wellbeing report")
        reports = gr.HTML(report_html())
        gr.Markdown("<p class='muted'>For personal wellbeing and productivity only. This app stays local and never contacts emergency services or other people.</p>")
        start.click(start_monitoring, outputs=[status, notice, reports])
        stop.click(stop_monitoring, outputs=[status, notice, reports])
        for input_component in (enabled, threshold, timeout, volume):
            input_component.change(set_settings, inputs=[enabled, threshold, timeout, volume], outputs=notice)
        snooze5.click(lambda: snooze(5), outputs=[notice, reports])
        snooze10.click(lambda: snooze(10), outputs=[notice, reports])
        snooze30.click(lambda: snooze(30), outputs=[notice, reports])
        dismiss_button.click(dismiss, outputs=[notice, reports])
        timer = gr.Timer(.20)
        timer.tick(poll, outputs=[camera_view, notice, swipe_metric, rate_metric, time_metric, reports])
    return ui


if __name__ == "__main__":
    init_db()
    build_app().launch(server_name="127.0.0.1", server_port=7860, inbrowser=True)
