from __future__ import annotations

from dataclasses import dataclass
import os

_ALLOWED_LLM_PROVIDERS = {'ollama', 'vllm', 'openai', 'mock'}
_ALLOWED_TTS_PROVIDERS = {'piper', 'mock'}


def _env(name: str, default: str) -> str:
    return os.getenv(name, default).strip() or default


@dataclass(frozen=True)
class VoiceConfig:
    livekit_url: str = 'ws://livekit:7880'
    livekit_api_key: str = 'devkey'
    livekit_api_secret: str = 'secret'
    room_prefix: str = 'gev-voice'
    llm_provider: str = 'ollama'
    llm_base_url: str = 'http://ollama:11434/v1'
    llm_model: str = 'qwen3:8b'
    llm_api_key: str = 'ollama'
    stt_base_url: str = 'http://whisper:9000/v1'
    stt_model: str = 'small'
    stt_api_key: str = 'local'
    tts_provider: str = 'piper'
    tts_base_url: str = 'http://tts:8000/v1'
    tts_model: str = 'tts-1'
    tts_voice: str = 'alloy'
    tts_api_key: str = 'local'
    tools_path: str = '/app/tools.json'
    system_prompt_path: str = '/app/system-prompt.txt'
    tool_timeout_s: float = 20.0

    @classmethod
    def from_env(cls) -> 'VoiceConfig':
        cfg = cls(
            livekit_url=_env('LIVEKIT_URL', cls.livekit_url),
            livekit_api_key=_env('LIVEKIT_API_KEY', cls.livekit_api_key),
            livekit_api_secret=_env('LIVEKIT_API_SECRET', cls.livekit_api_secret),
            room_prefix=_env('GEV_LIVEKIT_ROOM_PREFIX', cls.room_prefix),
            llm_provider=_env('GEV_LIVEKIT_LLM_PROVIDER', cls.llm_provider),
            llm_base_url=_env('GEV_LIVEKIT_LLM_BASE_URL', cls.llm_base_url),
            llm_model=_env('GEV_LIVEKIT_LLM_MODEL', cls.llm_model),
            llm_api_key=_env('GEV_LIVEKIT_LLM_API_KEY', cls.llm_api_key),
            stt_base_url=_env('GEV_LIVEKIT_STT_BASE_URL', cls.stt_base_url),
            stt_model=_env('GEV_LIVEKIT_STT_MODEL', cls.stt_model),
            stt_api_key=_env('GEV_LIVEKIT_STT_API_KEY', cls.stt_api_key),
            tts_provider=_env('GEV_LIVEKIT_TTS_PROVIDER', cls.tts_provider),
            tts_base_url=_env('GEV_LIVEKIT_TTS_BASE_URL', cls.tts_base_url),
            tts_model=_env('GEV_LIVEKIT_TTS_MODEL', cls.tts_model),
            tts_voice=_env('GEV_LIVEKIT_TTS_VOICE', cls.tts_voice),
            tts_api_key=_env('GEV_LIVEKIT_TTS_API_KEY', cls.tts_api_key),
            tools_path=_env('GEV_LIVEKIT_TOOLS_PATH', cls.tools_path),
            system_prompt_path=_env('GEV_LIVEKIT_SYSTEM_PROMPT_PATH', cls.system_prompt_path),
            tool_timeout_s=float(_env('GEV_LIVEKIT_TOOL_TIMEOUT_S', str(cls.tool_timeout_s))),
        )
        if cfg.llm_provider not in _ALLOWED_LLM_PROVIDERS:
            raise ValueError(
                f'GEV_LIVEKIT_LLM_PROVIDER must be one of {sorted(_ALLOWED_LLM_PROVIDERS)}, got {cfg.llm_provider!r}'
            )
        if cfg.tts_provider not in _ALLOWED_TTS_PROVIDERS:
            raise ValueError(
                f'GEV_LIVEKIT_TTS_PROVIDER must be one of {sorted(_ALLOWED_TTS_PROVIDERS)}, got {cfg.tts_provider!r}'
            )
        return cfg
