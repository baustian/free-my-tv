"""Sharp frames for the news wall (web/wall.js): the latest picture of each YouTube live, for the TV's small tiles.

    python tools/wall_frames.py [--port 8097] [--every 15] [--height 480]

The TV plays one video at a time, and YouTube's own frames of a live (its storyboard) are 159 × 90. This takes a
frame from the live itself: yt-dlp gives the stream's HLS address (kept an hour), FFmpeg decodes one frame of its
newest segment. GET /frame/<video id>.jpg answers the latest one (404 until the first is ready); a video is followed
only while the TV asks for it, and dropped IDLE seconds after the last ask, so nothing runs while the wall is closed.
GET /status lists what it follows. The TV falls back to the storyboard when this doesn't answer (the computer off).

Needs yt-dlp, FFmpeg and a JavaScript runtime for yt-dlp (Deno): on Windows,
`winget install yt-dlp.yt-dlp Gyan.FFmpeg DenoLand.Deno`. Runs anywhere they do (a server on the internet too: then
wall_frames in config.properties is its address).
"""
import argparse
import glob
import json
import logging
import logging.handlers
import os
import re
import shutil
import subprocess
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

IDLE = 90             # seconds without asks before a video is dropped
URL_TTL = 3600        # the HLS address is good for hours; ask again after one
MAX_VIDEOS = 16
VIDEO_ID = re.compile(r'^[\w-]{11}$')
NO_WINDOW = 0x08000000 if os.name == 'nt' else 0   # CREATE_NO_WINDOW: no console flashing under pythonw

log = logging.getLogger('wall_frames')


def tool(name):
    """The tool on PATH, or where winget puts it (a task started at logon may not have the new PATH yet)."""
    found = shutil.which(name)
    if found:
        return found
    base = os.path.join(os.environ.get('LOCALAPPDATA', ''), 'Microsoft', 'WinGet', 'Packages')
    hits = glob.glob(os.path.join(base, '*', name + '.exe')) + glob.glob(os.path.join(base, '*', '*', 'bin', name + '.exe'))
    if hits:
        return hits[0]
    sys.exit('%s not found: winget install yt-dlp.yt-dlp Gyan.FFmpeg DenoLand.Deno' % name)


class Video(threading.Thread):
    """Follows one live: a new frame every `every` seconds while the TV asks for it."""

    def __init__(self, vid, opts):
        super().__init__(daemon=True)
        self.vid, self.opts = vid, opts
        self.asked = time.time()
        self.jpeg, self.at = None, 0
        self.hls, self.hls_at = None, 0
        self.error = ''

    def stream(self):
        if self.hls and time.time() - self.hls_at < URL_TTL:
            return self.hls
        env = dict(os.environ)
        env['PATH'] = os.path.dirname(self.opts.deno) + os.pathsep + env.get('PATH', '')
        out = subprocess.run([self.opts.ytdlp, '-g', '--no-warnings', '-f', 'bv*[height<=%d]/b[height<=%d]/bv*/b' % (self.opts.height, self.opts.height),
                              'https://www.youtube.com/watch?v=' + self.vid],
                             capture_output=True, text=True, timeout=60, env=env, creationflags=NO_WINDOW)
        lines = [l for l in out.stdout.splitlines() if l.startswith('http')]
        if not lines:
            raise RuntimeError('yt-dlp: ' + (out.stderr.strip().splitlines() or ['no address'])[-1])
        self.hls, self.hls_at = lines[-1], time.time()
        return self.hls

    def grab(self):
        out = subprocess.run([self.opts.ffmpeg, '-hide_banner', '-loglevel', 'error', '-live_start_index', '-1',
                              '-i', self.stream(), '-frames:v', '1', '-q:v', '4', '-f', 'image2pipe', '-vcodec', 'mjpeg', '-'],
                             capture_output=True, timeout=40, creationflags=NO_WINDOW)
        if out.returncode != 0 or not out.stdout:
            self.hls = None   # an expired or ended stream: a new address next time
            raise RuntimeError('ffmpeg: ' + out.stderr.decode('utf-8', 'replace').strip()[-200:])
        self.jpeg, self.at = out.stdout, time.time()

    def run(self):
        log.info('following %s', self.vid)
        while time.time() - self.asked < IDLE:
            started = time.time()
            try:
                self.grab()
                self.error = ''
            except Exception as e:  # keep following: the next round may work
                self.error = str(e)
                log.warning('%s: %s', self.vid, e)
            time.sleep(max(1.0, self.opts.every - (time.time() - started)))
        log.info('dropped %s (not asked for %d s)', self.vid, IDLE)
        with LOCK:
            if VIDEOS.get(self.vid) is self:
                del VIDEOS[self.vid]


VIDEOS = {}
LOCK = threading.Lock()
OPTS = None


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        path = self.path.split('?')[0]
        m = re.match(r'^/frame/([\w-]+)\.jpg$', path)
        if m and VIDEO_ID.match(m.group(1)):
            vid = m.group(1)
            with LOCK:
                v = VIDEOS.get(vid)
                if not v and len(VIDEOS) < MAX_VIDEOS:
                    v = VIDEOS[vid] = Video(vid, OPTS)
                    v.start()
            if v:
                v.asked = time.time()
            if v and v.jpeg:
                self.reply(200, 'image/jpeg', v.jpeg, {'X-Frame-Age': str(int(time.time() - v.at))})
            else:
                self.reply(404, 'text/plain', b'not yet')
        elif path == '/status':
            with LOCK:
                body = {vid: {'age': int(time.time() - v.at) if v.at else None, 'error': v.error}
                        for vid, v in VIDEOS.items()}
            self.reply(200, 'application/json', json.dumps(body, indent=1).encode('utf-8'))
        else:
            self.reply(404, 'text/plain', b'not found')

    def reply(self, code, kind, body, extra=None):
        self.send_response(code)
        self.send_header('Content-Type', kind)
        self.send_header('Content-Length', str(len(body)))
        # Each ask carries its own ?t=, so the TV may keep it: the tile preloads it, then shows it.
        self.send_header('Cache-Control', 'max-age=300')
        self.send_header('Access-Control-Allow-Origin', '*')
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, fmt, *args):
        pass


def main():
    global OPTS
    p = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    p.add_argument('--port', type=int, default=8097)
    p.add_argument('--every', type=float, default=15, help='seconds between frames of a live')
    p.add_argument('--height', type=int, default=480, help='the stream size to take frames from')
    p.add_argument('--log', default=os.path.join(os.environ.get('LOCALAPPDATA', os.path.expanduser('~')), 'Oraculo',
                                                 'wall_frames.log'))
    OPTS = p.parse_args()
    os.makedirs(os.path.dirname(OPTS.log), exist_ok=True)
    handlers = [logging.handlers.RotatingFileHandler(OPTS.log, maxBytes=1000000, backupCount=1, encoding='utf-8')]
    if sys.stdout:
        handlers.append(logging.StreamHandler(sys.stdout))
    logging.basicConfig(level=logging.INFO, format='%(asctime)s %(message)s', handlers=handlers)
    OPTS.ytdlp, OPTS.ffmpeg, OPTS.deno = tool('yt-dlp'), tool('ffmpeg'), tool('deno')
    log.info('wall frames on port %d, a frame every %g s at %dp', OPTS.port, OPTS.every, OPTS.height)
    ThreadingHTTPServer(('0.0.0.0', OPTS.port), Handler).serve_forever()


if __name__ == '__main__':
    main()
