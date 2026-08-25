import os

from livekit_voice.config import VoiceConfig


def test_voice_config_defaults_are_local_and_cpu_friendly(monkeypatch):
    for key in list(os.environ):
        if key.startswith('GEV_') or key.startswith('LIVEKIT_'):
            monkeypatch.delenv(key, raising=False)

    cfg = VoiceConfig.from_env()

    assert cfg.livekit_url == 'ws://livekit:7880'
    assert cfg.livekit_api_key == 'devkey'
    assert cfg.llm_provider == 'ollama'
    assert cfg.llm_model == 'qwen3:8b'
    assert cfg.stt_model == 'small'
    assert cfg.tts_provider == 'piper'
    assert cfg.tts_model == 'tts-1'
    assert cfg.tts_voice == 'alloy'
    assert cfg.room_prefix == 'gev-voice'


def test_voice_config_rejects_unknown_llm_provider(monkeypatch):
    monkeypatch.setenv('GEV_LIVEKIT_LLM_PROVIDER', 'wat')

    try:
        VoiceConfig.from_env()
    except ValueError as exc:
        assert 'GEV_LIVEKIT_LLM_PROVIDER' in str(exc)
    else:
        raise AssertionError('expected invalid provider to fail')
