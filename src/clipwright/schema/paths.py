"""Filesystem layout helpers for v2 projects.

A v2 project scopes per-segment artifacts by video. Every module that
writes to disk uses these helpers so the convention is enforced in one
place — adding a new artifact kind only requires changes here.

    project/
    ├── project.json
    ├── videos/<video_id>.json
    ├── sources/                                ← project-level, shared
    ├── voiceover/audio/<video_id>/<seg>.mp3
    ├── captions/<video_id>/<seg>/<frame>.png
    ├── out/segments/<video_id>/<seg>.mp4
    └── out/final/<video_id>.mp4
"""
from __future__ import annotations

from pathlib import Path


def videos_dir(project_dir: Path) -> Path:
    return Path(project_dir) / "videos"


def video_manifest_path(project_dir: Path, video_id: str) -> Path:
    return videos_dir(project_dir) / f"{video_id}.json"


def video_audio_dir(project_dir: Path, video_id: str) -> Path:
    return Path(project_dir) / "voiceover" / "audio" / video_id


def video_audio_mp3(project_dir: Path, video_id: str, seg_id: str) -> Path:
    return video_audio_dir(project_dir, video_id) / f"{seg_id}.mp3"


def video_audio_timestamps(project_dir: Path, video_id: str, seg_id: str) -> Path:
    return video_audio_dir(project_dir, video_id) / f"{seg_id}.timestamps.json"


def video_audio_cache(project_dir: Path, video_id: str, seg_id: str) -> Path:
    return video_audio_dir(project_dir, video_id) / f"{seg_id}.cache.json"


def video_captions_dir(project_dir: Path, video_id: str, seg_id: str) -> Path:
    return Path(project_dir) / "captions" / video_id / seg_id


def video_render_dir(project_dir: Path, video_id: str) -> Path:
    return Path(project_dir) / "out" / "segments" / video_id


def video_render_mp4(project_dir: Path, video_id: str, seg_id: str) -> Path:
    return video_render_dir(project_dir, video_id) / f"{seg_id}.mp4"


def video_render_cache(project_dir: Path, video_id: str, seg_id: str) -> Path:
    return video_render_dir(project_dir, video_id) / f"{seg_id}.mp4.cache.json"


def video_final_path(project_dir: Path, video_id: str) -> Path:
    return Path(project_dir) / "out" / "final" / f"{video_id}.mp4"


def video_chat_log(project_dir: Path, video_id: str, date: str) -> Path:
    """Per-video chat session log (one file per UTC date)."""
    return Path(project_dir) / "chat" / "sessions" / video_id / f"{date}.jsonl"


def video_script_path(project_dir: Path, video_id: str) -> Path:
    """Per-video voiceover script.json. Each video has its own script file
    because segment IDs are unique per-video, not globally."""
    return Path(project_dir) / "voiceover" / "scripts" / f"{video_id}.json"
