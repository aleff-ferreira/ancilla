#!/usr/bin/env python3
"""Turns the tour's recorded frames into video and finishes the other media.

  encode.py clip <name>...                a recorded clip's frames and their times -> <root>/<name>.mp4 at a steady 30 fps
  encode.py sheet <name>                  twelve thumbnails across a clip, to look at it without playing it
  encode.py strip <name> <from> <step> <cols> <rows>   thumbnails of one stretch of a clip
  encode.py final <out.mp4> [crf]         the clips in story order, encoded once (H.264 high profile, 30 fps, no audio)
  encode.py gif <in.mp4> <out.gif> <from> <seconds> [width fps colors]   an animated preview cut from a video
  encode.py card <in-2x.png> <out.png>    the social card, brought down to 1280x640

ffmpeg is FFMPEG or the one on PATH (it needs libx264). The root folder is TOUR_DIR, or ancilla-tour in the temp folder.
Pillow is needed for `card`.
"""
import json
import os
import shutil
import subprocess
import sys
import tempfile

FF = os.environ.get("FFMPEG") or shutil.which("ffmpeg")
ROOT = os.environ.get("TOUR_DIR", os.path.join(tempfile.gettempdir(), "ancilla-tour"))
ORDER = ["intro", "assistant", "ask", "report", "crew", "plan", "diffs", "usage", "outro"]


def run(cmd):
    if not FF:
        sys.exit("ffmpeg not found: put it on PATH or set FFMPEG")
    p = subprocess.run(cmd, capture_output=True, text=True)
    if p.returncode != 0:
        print(p.stderr[-1500:])
        sys.exit(p.returncode)
    return p


def timeline(data):
    """The frames of a recording with their times on one clock that only moves forward, and the time it ended.

    A recording made by the current tour-lib carries a monotonic time ("m") for each frame and nothing needs repairing. An
    older one has only the wall clock, and WSL2 now and then sets that back by about two seconds: one frame is then stamped
    earlier than the frame before it and every frame after is on the shifted clock. Reading the step as a stall would freeze
    the clip for the gap, and dropping the frames after it would lose them, so the clock is carried on from where it was.
    """
    frames = data["frames"]
    if "tEndM" in data and all("m" in f for f in frames):
        return [{**f, "t": f["m"]} for f in frames], data["tEndM"]
    stamped, offset = [], 0.0
    for f in frames:
        t = f["t"] + offset
        if stamped and t <= stamped[-1]["t"]:
            offset += stamped[-1]["t"] - t + 0.033
            t = stamped[-1]["t"] + 0.033
        stamped.append({**f, "t": t})
    return stamped, data["tEnd"] + offset


def clip(name):
    d = f"{ROOT}/{name}"
    data = json.load(open(f"{d}/frames.json"))
    frames, t_end = timeline(data)
    # Stretches the script asked to play faster (S.speed): a wait that only shows a spinner. Marks are on the monotonic clock.
    marks = sorted(data.get("marks", []), key=lambda k: k["m"]) if "tEndM" in data else []

    def pace(t):
        factor = 1.0
        for mark in marks:
            if mark["m"] <= t:
                factor = mark["factor"]
        return factor

    lines = []
    for i, f in enumerate(frames):
        nxt = frames[i + 1]["t"] if i + 1 < len(frames) else t_end
        lines.append(f"file '{f['file']}'")
        lines.append(f"duration {max(0.001, nxt - f['t']) / pace(f['t']):.4f}")
    lines.append(f"file '{frames[-1]['file']}'")
    open(f"{d}/list.txt", "w").write("\n".join(lines) + "\n")
    out = f"{ROOT}/{name}.mp4"
    # The frames are full-range JPEG (BT.601); the video is limited-range BT.709, as players expect of 1080p.
    vf = "fps=30,scale=1920:1080:flags=lanczos:in_range=full:out_range=limited:in_color_matrix=bt601:out_color_matrix=bt709,format=yuv420p"
    run([FF, "-y", "-hide_banner", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", f"{d}/list.txt", "-vf", vf,
         "-c:v", "libx264", "-preset", "medium", "-crf", "17", "-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709",
         "-r", "30", "-movflags", "+faststart", out])
    print(out, f"{os.path.getsize(out) / 1e6:.1f} MB", f"{len(frames)} frames over {t_end - frames[0]['t']:.1f} s")


def sheet(name, tiles=12):
    out = f"{ROOT}/{name}-sheet.png"
    data = json.load(open(f"{ROOT}/{name}/frames.json"))
    frames, t_end = timeline(data)
    dur = t_end - frames[0]["t"]
    run([FF, "-y", "-hide_banner", "-loglevel", "error", "-i", f"{ROOT}/{name}.mp4", "-vf",
         f"fps={tiles / max(dur, 1):.4f},scale=640:-1,tile=3x4:padding=6:color=0x202024", "-frames:v", "1", out])
    print(out, f"(one thumbnail per {dur / tiles:.1f} s)")


def strip(name, start, step, cols, rows):
    out = f"{ROOT}/{name}-strip.png"
    run([FF, "-y", "-hide_banner", "-loglevel", "error", "-ss", str(start), "-i", f"{ROOT}/{name}.mp4", "-vf",
         f"fps=1/{step},scale=640:-1,tile={cols}x{rows}:padding=6:color=0x202024", "-frames:v", "1", out])
    print(out)


def final(out, crf="26"):
    lst = f"{ROOT}/final-list.txt"
    open(lst, "w").write("".join(f"file '{ROOT}/{n}.mp4'\n" for n in ORDER))
    run([FF, "-y", "-hide_banner", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", lst,
         "-c:v", "libx264", "-preset", "slow", "-crf", str(crf), "-profile:v", "high", "-pix_fmt", "yuv420p", "-g", "60", "-bf", "3",
         "-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709", "-an", "-movflags", "+faststart", out])
    print(out, f"{os.path.getsize(out) / 1e6:.1f} MB")


def gif(src, out, start, seconds, width="960", fps="12", colors="128"):
    vf = (f"fps={fps},scale={width}:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors={colors}:stats_mode=diff[p];"
          "[b][p]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle")
    run([FF, "-y", "-hide_banner", "-loglevel", "error", "-ss", str(start), "-t", str(seconds), "-i", src, "-vf", vf, "-loop", "0", out])
    print(out, f"{os.path.getsize(out) / 1e6:.2f} MB")


def card(src, out):
    from PIL import Image
    Image.open(src).convert("RGB").resize((1280, 640), Image.LANCZOS).save(out, optimize=True)
    print(out, f"{os.path.getsize(out) // 1024} KB")


if __name__ == "__main__":
    cmd, args = sys.argv[1], sys.argv[2:]
    if cmd == "clip":
        [clip(n) for n in args]
    elif cmd == "sheet":
        [sheet(n) for n in args]
    elif cmd == "strip":
        strip(args[0], float(args[1]), float(args[2]), int(args[3]), int(args[4]))
    elif cmd == "final":
        final(*args)
    elif cmd == "gif":
        gif(*args)
    elif cmd == "card":
        card(*args)
    else:
        sys.exit(__doc__)
