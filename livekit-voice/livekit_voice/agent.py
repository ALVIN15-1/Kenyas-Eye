from __future__ import annotations

import json
import logging
from pathlib import Path
from typing import Any

from livekit import agents, rtc
from livekit.agents import Agent, AgentSession, JobContext, WorkerOptions, cli, function_tool
from livekit.plugins import openai, silero

from livekit_voice.config import VoiceConfig
from livekit_voice.tool_bridge import BrowserToolBridge

log = logging.getLogger('gev.livekit_voice')


def load_tools(path: str) -> list[dict[str, Any]]:
    with Path(path).open('r', encoding='utf-8') as fh:
        tools = json.load(fh)
    if not isinstance(tools, list):
        raise ValueError(f'{path} must contain a JSON array')
    return tools


def load_instructions(path: str) -> str:
    p = Path(path)
    if p.exists():
        return p.read_text(encoding='utf-8').strip()
    return (
        "You are the God's Eye View voice copilot. Keep responses short. "
        "When a request changes the globe, call the matching tool first and only "
        "confirm after the browser returns a result. Never claim an action worked "
        "unless the tool result has ok=true."
    )


def build_browser_tools(bridge: BrowserToolBridge, tools: list[dict[str, Any]]):
    livekit_tools = []
    for schema in tools:
        name = schema.get('name')
        if not name:
            continue

        async def _browser_tool(_tool_name=name, **kwargs):
            return await bridge.call_tool(_tool_name, kwargs)

        livekit_tools.append(
            function_tool(
                _browser_tool,
                name=name,
                description=schema.get('description') or f'Run browser tool {name}',
                raw_schema=schema,
            )
        )
    return livekit_tools


def build_llm(cfg: VoiceConfig):
    if cfg.llm_provider == 'mock':
        return None
    return openai.LLM(
        model=cfg.llm_model,
        api_key=cfg.llm_api_key,
        base_url=cfg.llm_base_url,
        parallel_tool_calls=True,
    )


def build_stt(cfg: VoiceConfig):
    return openai.STT(
        model=cfg.stt_model,
        api_key=cfg.stt_api_key,
        base_url=cfg.stt_base_url,
    )


def build_tts(cfg: VoiceConfig):
    if cfg.tts_provider == 'mock':
        return None
    return openai.TTS(
        model=cfg.tts_model,
        voice=cfg.tts_voice,
        api_key=cfg.tts_api_key,
        base_url=cfg.tts_base_url,
    )


async def entrypoint(ctx: JobContext):
    cfg = VoiceConfig.from_env()
    await ctx.connect(auto_subscribe=agents.AutoSubscribe.SUBSCRIBE_ALL)

    def send_json(payload: dict[str, Any]):
        data = json.dumps(payload, separators=(',', ':'))
        ctx.room.local_participant.publish_data(data, reliable=True, topic='gev.tools')

    bridge = BrowserToolBridge(send_json=send_json, timeout_s=cfg.tool_timeout_s)

    @ctx.room.on('data_received')
    def _on_data(packet: rtc.DataPacket):
        if packet.topic != 'gev.tools':
            return
        try:
            payload = json.loads(packet.data.decode('utf-8'))
        except Exception:
            log.warning('Ignoring malformed LiveKit data packet', exc_info=True)
            return
        bridge.handle_json(payload)

    tools = build_browser_tools(bridge, load_tools(cfg.tools_path))
    agent = Agent(
        instructions=load_instructions(cfg.system_prompt_path),
        tools=tools,
        vad=silero.VAD.load(force_cpu=True),
        stt=build_stt(cfg),
        llm=build_llm(cfg),
        tts=build_tts(cfg),
        min_endpointing_delay=0.25,
        max_endpointing_delay=0.8,
        allow_interruptions=True,
    )
    session = AgentSession(max_tool_steps=4)
    await session.start(agent=agent, room=ctx.room)


if __name__ == '__main__':
    cfg = VoiceConfig.from_env()
    cli.run_app(
        WorkerOptions(
            entrypoint_fnc=entrypoint,
            ws_url=cfg.livekit_url,
            api_key=cfg.livekit_api_key,
            api_secret=cfg.livekit_api_secret,
            agent_name='gev-livekit-voice',
        )
    )
