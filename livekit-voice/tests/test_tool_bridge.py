import asyncio

import pytest

from livekit_voice.tool_bridge import BrowserToolBridge, ToolTimeout


@pytest.mark.asyncio
async def test_bridge_resolves_tool_result_by_call_id():
    sent = []
    bridge = BrowserToolBridge(send_json=sent.append, timeout_s=1.0)

    pending = asyncio.create_task(bridge.call_tool('fly_to_location', {'query': 'Tokyo'}))
    await asyncio.sleep(0)

    assert sent == [{
        'type': 'gev.tool_call',
        'call_id': sent[0]['call_id'],
        'name': 'fly_to_location',
        'arguments': {'query': 'Tokyo'},
    }]

    bridge.handle_json({
        'type': 'gev.tool_result',
        'call_id': sent[0]['call_id'],
        'result': {'ok': True, 'arrived': True},
    })

    assert await pending == {'ok': True, 'arrived': True}


@pytest.mark.asyncio
async def test_bridge_times_out_missing_browser_result():
    bridge = BrowserToolBridge(send_json=lambda payload: None, timeout_s=0.01)

    with pytest.raises(ToolTimeout):
        await bridge.call_tool('zoom_to_globe', {})
