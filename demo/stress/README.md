# Stress

A tiny codebase for Contrail load tests: many agents increment shared counters and append notes at once.
Every counter's final value must equal the number of landed intents that targeted it — no lost updates.
