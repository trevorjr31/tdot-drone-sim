"""
Tests for compose.py without calling Claude (a fake client stands in).

  docker run --rm --entrypoint python tdot/px4-bridge:dev -m unittest compose_test -v
"""

import asyncio
import json
import unittest
from types import SimpleNamespace

import compose

EATON = {
    "summary": "Fly to the Eaton Centre, circle it, go two blocks north, then land.",
    "questions": [],
    "steps": [
        {**{k: None for k in compose.STEP_FIELDS}, "action": "fly_to", "place_kind": "name", "place": "Eaton Centre"},
        {**{k: None for k in compose.STEP_FIELDS}, "action": "circle", "place_kind": "name", "place": "Eaton Centre", "laps": 1},
        {**{k: None for k in compose.STEP_FIELDS}, "action": "move", "direction": "north", "distance": 2, "unit": "blocks"},
        {**{k: None for k in compose.STEP_FIELDS}, "action": "land"},
    ],
}


class FakeClient:
    """Answers like client.beta.messages.create, recording the request."""

    def __init__(self, text=None, stop_reason="end_turn"):
        self.request = None
        self.text = text
        self.stop_reason = stop_reason
        self.beta = SimpleNamespace(messages=SimpleNamespace(create=self.create))

    async def create(self, **kwargs):
        self.request = kwargs
        content = [SimpleNamespace(type="text", text=self.text)] if self.text is not None else []
        return SimpleNamespace(
            stop_reason=self.stop_reason,
            content=content,
            usage=SimpleNamespace(input_tokens=900, output_tokens=200),
        )


def run(coro):
    return asyncio.run(coro)


class ComposeTest(unittest.TestCase):
    def test_returns_the_plan_and_sends_the_right_request(self):
        client = FakeClient(json.dumps(EATON))
        context = {"inAir": False, "relAltM": 0, "plannerAltM": 30, "ceilingM": 120, "secret": "not sent"}
        plan = run(compose.compose_route(client, "  go to the eaton centre, circle around it, go two blocks north and then land ", context))
        self.assertEqual(plan, EATON)
        r = client.request
        self.assertEqual(r["model"], "claude-opus-5-5")
        self.assertEqual(r["fallbacks"], "default")
        self.assertEqual(r["betas"], ["server-side-fallback-2026-07-01"])
        self.assertEqual(r["output_config"]["effort"], "low")
        self.assertEqual(r["output_config"]["format"], {"type": "json_schema", "schema": compose.PLAN_SCHEMA})
        self.assertNotIn("thinking", r)  # always on for this model
        msg = r["messages"][0]["content"]
        self.assertIn("Request: go to the eaton centre, circle around it, go two blocks north and then land", msg)
        self.assertIn('"ceilingM": 120', msg)
        self.assertNotIn("secret", msg)

    def test_no_key(self):
        with self.assertRaisesRegex(compose.ComposeError, "API key"):
            run(compose.compose_route(None, "go north 100 m", {}))

    def test_empty_or_too_long(self):
        client = FakeClient(json.dumps(EATON))
        with self.assertRaisesRegex(compose.ComposeError, "Describe"):
            run(compose.compose_route(client, "   ", {}))
        with self.assertRaisesRegex(compose.ComposeError, "too long"):
            run(compose.compose_route(client, "go north " * 100, {}))
        self.assertIsNone(client.request)  # never sent

    def test_refusal(self):
        with self.assertRaisesRegex(compose.ComposeError, "declined"):
            run(compose.compose_route(FakeClient(None, "refusal"), "go north 100 m", {}))

    def test_bad_answers(self):
        for text in ("not json", json.dumps({"steps": "x", "questions": []}), json.dumps({**EATON, "steps": [{"action": "teleport"}]})):
            with self.assertRaises(compose.ComposeError):
                run(compose.compose_route(FakeClient(text), "go north 100 m", {}))

    def test_questions_come_back(self):
        answer = {"summary": "", "questions": ["Which Union: the station or the building?"], "steps": []}
        plan = run(compose.compose_route(FakeClient(json.dumps(answer)), "go to union", {}))
        self.assertEqual(plan["questions"], ["Which Union: the station or the building?"])

    def test_schema_requires_every_field(self):
        step = compose.PLAN_SCHEMA["properties"]["steps"]["items"]
        self.assertEqual(sorted(step["required"]), sorted(compose.STEP_FIELDS))
        self.assertFalse(step["additionalProperties"])


if __name__ == "__main__":
    unittest.main()
