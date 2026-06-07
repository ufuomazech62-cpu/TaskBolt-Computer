import os, sys, asyncio
sys.path.insert(0, '.')

with open(os.path.expanduser('~/.taskbolt/.env')) as f:
    for line in f:
        line = line.strip()
        if '=' in line and not line.startswith('#'):
            key, val = line.split('=', 1)
            os.environ[key] = val

from core import taskbolt_db as db
from core.composio_client import get_client as get_composio_client

db.init_db()
c = get_composio_client()
asyncio.run(c.auto_reconnect_active())

desc = c.get_tool_descriptions_for_prompt()
print('=== COMPOSIO PROMPT DESC ===')
print(desc[:2000] if desc else '(EMPTY!)')

schemas = c.get_openai_tool_schemas()
print(f'\n=== SCHEMAS: {len(schemas)} ===')
if schemas:
    print(f'First: {schemas[0]["function"]["name"]}')
    print(f'Desc: {schemas[0]["function"]["description"][:200]}')
