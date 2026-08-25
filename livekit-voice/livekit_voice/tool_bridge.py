from __future__ import annotations

import asyncio
import inspect
import uuid
from dataclasses import dataclass, field
from typing import Any, Awaitable, Callable


class ToolTimeout(TimeoutError):
    pass


SendJson = Callable[[dict[str, Any]], Any | Awaitable[Any]]


@dataclass
class BrowserToolBridge:
    send_json: SendJson
    timeout_s: float = 20.0
    _pending: dict[str, asyncio.Future] = field(default_factory=dict, init=False)

    async def call_tool(self, name: str, arguments: dict[str, Any] | None = None) -> dict[str, Any]:
        call_id = f'gev-{uuid.uuid4().hex}'
        loop = asyncio.get_running_loop()
        future: asyncio.Future = loop.create_future()
        self._pending[call_id] = future

        payload = {
            'type': 'gev.tool_call',
            'call_id': call_id,
            'name': name,
            'arguments': arguments or {},
        }
        maybe_awaitable = self.send_json(payload)
        if inspect.isawaitable(maybe_awaitable):
            await maybe_awaitable

        try:
            return await asyncio.wait_for(future, timeout=self.timeout_s)
        except asyncio.TimeoutError as exc:
            raise ToolTimeout(f'timed out waiting for browser tool result: {name} ({call_id})') from exc
        finally:
            self._pending.pop(call_id, None)

    def handle_json(self, payload: dict[str, Any]) -> bool:
        if payload.get('type') != 'gev.tool_result':
            return False
        call_id = payload.get('call_id')
        future = self._pending.get(call_id)
        if not future or future.done():
            return False
        if 'error' in payload:
            future.set_result({'ok': False, 'error': str(payload['error'])})
        else:
            result = payload.get('result')
            future.set_result(result if isinstance(result, dict) else {'ok': True, 'result': result})
        return True
