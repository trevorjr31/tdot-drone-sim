"""
Routes described in words: asks Claude to turn the pilot's text into a step list.

The app sends "composeRoute" with the text and a little context (in the air or not, the
height, the ceiling); the bridge asks Claude here and returns the step list. Claude never
sees the map and never gives coordinates: it names places as the pilot did ("Eaton
Centre"), or a kind of place for "the nearest hospital", and the app looks them up and
works out the geometry (frontend/src/drone/routeCompose.ts, which mirrors this schema).

The API key stays here, never in the browser. Without ANTHROPIC_API_KEY the feature is
off: the status says "ai": false and the app hides the box.
"""

import json
import logging
import os

log = logging.getLogger("bridge")

MODEL = os.environ.get("COMPOSE_MODEL", "claude-opus-5-5")
MAX_TEXT_CHARS = 600
MAX_TOKENS = 8000
REQUEST_TIMEOUT_S = 60.0

# Kept in step with the app: ComposeStep in frontend/src/drone/routeCompose.ts and
# PLACE_CATEGORIES in frontend/src/places/nearby.ts (a frontend test checks these lists).
ACTIONS = ["fly_to", "move", "circle", "height", "hover", "land", "return_home"]
PLACE_KINDS = ["name", "nearest", "here"]
CATEGORIES = [
    "hospital", "police", "fire_station", "school", "university", "library",
    "park", "transit_station", "stadium", "museum", "shopping_mall", "helipad",
]
DIRECTIONS = [
    "north", "northeast", "east", "southeast", "south", "southwest", "west", "northwest",
    "forward", "back", "left", "right",
]
UNITS = ["m", "km", "blocks"]


def _nullable(schema: dict) -> dict:
    return {"anyOf": [schema, {"type": "null"}]}


STEP_FIELDS = {
    "action": {"type": "string", "enum": ACTIONS},
    "place_kind": _nullable({"type": "string", "enum": PLACE_KINDS}),
    "place": _nullable({"type": "string"}),
    "category": _nullable({"type": "string", "enum": CATEGORIES}),
    "direction": _nullable({"type": "string", "enum": DIRECTIONS}),
    "distance": _nullable({"type": "number"}),
    "unit": _nullable({"type": "string", "enum": UNITS}),
    "radius_m": _nullable({"type": "number"}),
    "laps": _nullable({"type": "integer"}),
    "clockwise": _nullable({"type": "boolean"}),
    "rel_alt_m": _nullable({"type": "number"}),
    "seconds": _nullable({"type": "number"}),
}

PLAN_SCHEMA = {
    "type": "object",
    "additionalProperties": False,
    "required": ["summary", "questions", "steps"],
    "properties": {
        "summary": {"type": "string"},
        "questions": {"type": "array", "items": {"type": "string"}},
        "steps": {
            "type": "array",
            "items": {
                "type": "object",
                "additionalProperties": False,
                "required": list(STEP_FIELDS),
                "properties": STEP_FIELDS,
            },
        },
    },
}

SYSTEM_PROMPT = f"""You turn a drone pilot's request into flight steps for a drone simulator over Toronto. The app does all the maps and geometry; your job is only to say what the pilot asked for, as steps, in their order.

Actions:
- fly_to: go to a place. place_kind "name" with place set to the name as the pilot said it ("Eaton Centre", "CN Tower", "Yonge and Dundas"); or place_kind "nearest" with category for "the nearest/closest X" ({", ".join(CATEGORIES)}).
- move: go a distance in a direction. direction is a compass direction, or forward/back/left/right from the way the drone is heading. distance and unit as the pilot gave them (unit "blocks" for city blocks).
- circle: circle round a place. place_kind "here" for the drone's current spot, or "name"/"nearest" as for fly_to. radius_m only if the pilot gave one (null: the app sizes it to the place). laps (default 1), clockwise (default true) only if said.
- height: fly the route at rel_alt_m metres above home (only before setting off).
- hover: wait in place for seconds.
- land: land where the drone is (only at the end).
- return_home: fly back home (only at the end).

Rules:
- Never invent coordinates or distances the pilot didn't give. Use only the actions above.
- "Circle around it" after going to a place: circle with that same place (same place_kind, place and category).
- Every field an action doesn't use is null.
- If the request is unclear (a place that could be several things, a missing distance, something the actions can't do), leave steps empty and ask in questions, briefly. Don't guess.
- If the request isn't about flying the drone, leave steps empty and say so in questions.
- summary restates the plan in one plain sentence, in the pilot's terms."""


class ComposeError(Exception):
    """A problem to show the pilot (no key, a refusal, Claude unavailable)."""


def make_client():
    """The Anthropic client, or None when there's no API key (the feature is off)."""
    if not os.environ.get("ANTHROPIC_API_KEY"):
        return None
    from anthropic import AsyncAnthropic  # imported here so the bridge runs without it when unused

    return AsyncAnthropic(timeout=REQUEST_TIMEOUT_S, max_retries=1)


def user_message(text: str, context: dict) -> str:
    ctx = {k: context.get(k) for k in ("inAir", "relAltM", "plannerAltM", "ceilingM") if k in context}
    return f"Drone context: {json.dumps(ctx)}\n\nRequest: {text}"


def check_text(text) -> str:
    if not isinstance(text, str) or not text.strip():
        raise ComposeError("Describe the route first")
    text = text.strip()
    if len(text) > MAX_TEXT_CHARS:
        raise ComposeError(f"That's too long: keep it under {MAX_TEXT_CHARS} characters")
    return text


def parse_plan(data) -> dict:
    """The plan from Claude's JSON, checked against the schema (structured outputs guarantee it; this is a backstop)."""
    if not isinstance(data, dict) or not isinstance(data.get("steps"), list) or not isinstance(data.get("questions"), list):
        raise ComposeError("Claude's answer wasn't a route")
    steps = []
    for s in data["steps"]:
        if not isinstance(s, dict) or s.get("action") not in ACTIONS:
            raise ComposeError("Claude's answer had a step the app doesn't know")
        steps.append({k: s.get(k) for k in STEP_FIELDS})
    return {
        "summary": str(data.get("summary") or ""),
        "questions": [str(q) for q in data["questions"]],
        "steps": steps,
    }


async def compose_route(client, text, context: dict | None) -> dict:
    """Asks Claude for the step list for `text`. Raises ComposeError with a message for the pilot."""
    if client is None:
        raise ComposeError("Text routes need an Anthropic API key (ANTHROPIC_API_KEY for the bridge)")
    text = check_text(text)
    import anthropic

    try:
        response = await client.beta.messages.create(
            model=MODEL,
            max_tokens=MAX_TOKENS,
            betas=["server-side-fallback-2026-07-01"],
            fallbacks="default",
            output_config={"effort": "low", "format": {"type": "json_schema", "schema": PLAN_SCHEMA}},
            system=SYSTEM_PROMPT,
            messages=[{"role": "user", "content": user_message(text, context or {})}],
        )
    except anthropic.AuthenticationError as e:
        raise ComposeError("The Anthropic API key was refused") from e
    except anthropic.RateLimitError as e:
        raise ComposeError("Claude is busy (rate limited); try again in a moment") from e
    except anthropic.APIConnectionError as e:
        raise ComposeError("Couldn't reach Claude (network)") from e
    except anthropic.APIStatusError as e:
        log.warning("Compose request failed: %s %s", e.status_code, e.message)
        raise ComposeError(f"Claude couldn't plan that (error {e.status_code})") from e

    if response.stop_reason == "refusal":
        raise ComposeError("Claude declined to plan that route")
    if response.stop_reason == "max_tokens":
        raise ComposeError("That route is too long to plan in one go")
    text_block = next((b.text for b in response.content if b.type == "text"), None)
    if text_block is None:
        raise ComposeError("Claude's answer wasn't a route")
    try:
        data = json.loads(text_block)
    except json.JSONDecodeError as e:
        raise ComposeError("Claude's answer wasn't a route") from e
    usage = response.usage
    log.info("Composed route: %d steps, %d questions (%s in / %s out tokens)",
             len(data.get("steps", [])), len(data.get("questions", [])), usage.input_tokens, usage.output_tokens)
    return parse_plan(data)
