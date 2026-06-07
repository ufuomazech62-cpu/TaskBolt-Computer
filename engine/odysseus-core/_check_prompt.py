import os, sys, asyncio
sys.path.insert(0, '.')

# Load env
with open(os.path.expanduser('~/.taskbolt/.env')) as f:
    for line in f:
        line = line.strip()
        if line.startswith('COMPOSIO_API_KEY=***            os.environ['COMPOSIO_API_KEY'] = line.split('=',1)[1].strip()
            break

from core import taskbolt_db as db
from core.composio_client import get_client as get_composio_client
from main import build_system_message

db.init_db()
c = get_composio_client()

# Simulate auto-reconnect
asyncio.run(c.auto_reconnect_active())

# Check prompt description
desc = c.get_tool_descriptions_for_prompt()
print('=== COMPOSIO PROMPT DESCRIPTION ===')
print(desc[:2000] if desc else '(EMPTY!)')
print()

# Check schemas
schemas = c.get_openai_tool_schemas()
print(f'=== SCHEMAS: {len(schemas)} tools ===')
if schemas:
    print(f'First tool: {schemas[0]["function"]["name"]}')
    print(f'Description: {schemas[0]["function"]["description"][:200]}')
print()

# Check full system message
sys_msg = build_system_message(user_message="check my email")
content = sys_msg["content"]
print(f'=== SYSTEM MESSAGE ({len(content)} chars) ===')
# Print last 2000 chars (where tools are)
print(content[-2000:])
